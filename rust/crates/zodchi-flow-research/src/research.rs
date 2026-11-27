//! One native research round, with a snapshot of project material and an owner decision gate.

use crate::{
    research_lists as lists,
    research_material::{self as material, Privacy},
};
use serde_json::{json, Map, Value};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
use zodchi_core::{
    config::Config,
    job::{self, compose_prompt, LIMIT_PROMPT},
    role::{load_role, Overrides},
    util::{fail, is_key, iso, sha256_hex, write_json_atomic, GatewayError, Result},
};
use zodchi_flow_engine::{
    boundary::{cut, Launch},
    catalog::ProjectGate,
    executor, gateway,
    git::Git,
    input_common,
    journal::{new_run_id, Journal},
    models::{self, Pick},
    Exit,
};

pub const NAME: &str = "research";
const VERSION: &str = "1";
const OWNER: &str = "owner decisions";
const CONSTRAINTS: &str = include_str!("../../../../roles/research-constraints.schema.json");
const EXPERT: &str = include_str!("../../../../roles/research-expert.schema.json");
const FACTS: &str = include_str!("../../../../roles/research-fact-check.schema.json");
const MAX_CONSTRAINTS: usize = 20;
const MAX_CONSTRAINT_TEXT_CHARS: usize = 300;
const MAX_EXPERT_FACTS: usize = 12;
const MAX_EXPERT_TEXT_CHARS: usize = 600;
const SHORTENABLE_EXPERT_FIELDS: [(&str, &str); 2] = [("items", "text"), ("facts", "claim")];
const EXPERT_SHORTENING_MARKER: &str = " […]";
const MAX_PROPOSAL_GROUP_CHARS: usize = 80;
const MAX_CITATION_LINES: usize = 40;
const EXPERT_PROMPT_RESERVE: usize = 1024;
const CLAIM_NOT_SENT: &str = "The fact checker did not receive the complete claim.";
const ROLES: [(&str, &str); 3] = [
    ("constraintChecker", "research-constraints"),
    ("researchExpert", "research-expert"),
    ("factChecker", "research-fact-check"),
];

fn research_models(
    table: &Map<String, Value>,
    claude: &mut models::ClaudeGate,
    roles: &Value,
    codex: impl Fn() -> std::result::Result<(), String>,
) -> Result<Map<String, Value>> {
    let mut pair = Map::new();
    let mut skipped = Vec::new();
    for (key, role) in ROLES {
        let installed = &roles[role];
        if installed["mode"] != "expert" || installed["kind"] != "text" {
            return fail(format!("Install the expert text role {role}."));
        }
        let pick = claude.one_shot(table, key, Some(installed), &mut skipped, |pick| {
            if pick.provider == "codex" { codex() } else { Ok(()) }
        }).map_err(GatewayError)?;
        pair.insert(key.into(), pick.to_json());
    }
    if !skipped.is_empty() {
        pair.insert("skipped".into(), json!(skipped));
    }
    Ok(pair)
}

pub fn start(raw: &Value, launch: Option<Launch>, require_workflow: ProjectGate) -> Result<Exit> {
    match (prepare(raw, require_workflow), launch) {
        (Ok((id, journal)), Some(launch)) => launch(&journal, &id),
        (Ok((id, _)), None) => resume(&id, None, None),
        (Err(error), _) => Ok(Exit {
            code: 2,
            result: json!({"workflow":NAME,"refused":error.0,"approved":false}),
        }),
    }
}

fn prepare(raw: &Value, require_workflow: ProjectGate) -> Result<(String, Journal)> {
    let Some(fields) = raw.as_object() else {
        return fail("Unknown research input.");
    };
    if let Some(key) = fields.keys().find(|key| {
        ![
            "repo",
            "tmp",
            "label",
            "request",
            "questions",
            "attachments",
            "allowNoScrub",
            "maxLines",
            "models",
        ]
        .contains(&key.as_str())
    }) {
        return fail(format!("Unknown research input {key:?}."));
    }
    let label = raw["label"]
        .as_str()
        .filter(|label| is_key(label) && label.len() <= 40)
        .ok_or_else(|| GatewayError("args.label needs a short gateway key.".into()))?;
    let repo_input = material::path(&raw["repo"], "args.repo")?;
    let repo = fs::canonicalize(&repo_input)?;
    let tmp = material::path(&raw["tmp"], "args.tmp")?;
    let aliases = json!({"repo":raw["repo"], "tmp":raw["tmp"]});
    if tmp
        .ancestors()
        .any(|part| fs::symlink_metadata(part).is_ok_and(|meta| meta.file_type().is_symlink()))
    {
        return fail("The research folder crosses a link.");
    }
    let git = Git::new(&repo);
    if fs::canonicalize(git.run(&["rev-parse", "--show-toplevel"])?.trim())? != repo {
        return fail("args.repo must be the top of a Git checkout.");
    }
    require_workflow(&git, &git.rev("HEAD^{commit}")?, NAME)?;
    if git
        .output(
            &["check-ignore", "-q", "--", ".agent-tmp/gateway/"],
            &[("GIT_LITERAL_PATHSPECS", "0".into())],
            None,
        )?
        .status
        .code()
        != Some(0)
    {
        return fail("The research checkout must ignore .agent-tmp/.");
    }
    let cfg = Config::new(Some(&repo))?;
    let allow_empty = match raw.get("allowNoScrub") {
        None => false,
        Some(Value::Bool(allowed)) => *allowed,
        Some(_) => return fail("args.allowNoScrub must be a boolean."),
    };
    let max = match raw.get("maxLines") {
        None => 30,
        Some(limit) => limit
            .as_u64()
            .filter(|limit| (1..=200).contains(limit))
            .ok_or_else(|| GatewayError("args.maxLines is an integer between 1 and 200.".into()))?,
    };
    let snapshot = material::word_snapshot(&cfg, allow_empty)?;
    let privacy = Privacy::with_aliases(&cfg, &snapshot, &repo, &tmp, &aliases)?;
    if privacy.text(label) != label {
        return fail("The research label contains private text.");
    }
    let mut staged = material::stage(raw, &privacy)?;
    if ["list.json", "reply.json"]
        .iter()
        .any(|name| tmp.join(name).exists())
    {
        return fail("This folder contains an active legacy list or reply. Finish it before starting native research.");
    }
    let (ledger, current) = lists::ledger(&tmp.join("decisions.json"))?;
    let round = ledger["appliedRounds"].as_array().expect("validated").len() + 1;
    check_legacy(&tmp, round)?;
    check_legacy_receipt(&tmp, round, &current)?;
    staged["prior"] = json!(lists::for_model(&ledger, &privacy));
    check_expert_prompts(&staged, &privacy, max as usize)?;
    let overrides = match raw.get("models") {
        None => Map::new(),
        Some(Value::Object(overrides)) => overrides.clone(),
        Some(_) => return fail("args.models must be a model role table."),
    };
    let table = models::table(&cfg, &repo, &overrides).map_err(GatewayError)?;
    let mut claude = models::ClaudeGate::of(&table);
    let local_config = local_config(&cfg)?;
    let codex = models::local_codex(&cfg, "Research requires the local Codex gateway for Codex candidates.");
    let pair = research_models(&table, &mut claude, &local_config["roles"], codex)?;
    fs::create_dir_all(&tmp)?;
    let tmp = fs::canonicalize(tmp)?;
    let id = (0..16)
        .map(|_| new_run_id())
        .find(|id| privacy.text(id) == *id)
        .ok_or_else(|| {
            GatewayError("No usable research run identifier after sixteen draws.".into())
        })?;
    let pin = json!({"material":staged,"privacy":snapshot,"maxLines":max,"ledgerSha256":current,
        "localConfig":local_config,"pathAliases":aliases});
    let run = json!({
        "runId":id,"workflow":NAME,"version":VERSION,"release":env!("CARGO_PKG_VERSION"),"createdAt":iso(),
        "repo":repo,"tmp":tmp,"round":round,"label":label,"pair":pair,
        "inputs":{"argsSha256":input_common::args_digest(raw),"pin":pin,"pinSha256":sha256_hex(pin.to_string())},
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    Ok((id, journal))
}

// Record routing and role configuration without reading subscription credentials.
fn local_config(cfg: &Config) -> Result<Value> {
    let mut roles = Map::new();
    for (_, role) in ROLES {
        roles.insert(role.into(), load_role(cfg, role, &Overrides::default())?);
    }
    let accounts: Vec<_> = cfg
        .accounts
        .iter()
        .map(|account| json!({"name":account.name,"home":account.codex_home}))
        .collect();
    Ok(json!({"codex":cfg.codex_bin,"accounts":accounts,"roles":roles}))
}

fn same_local_config(current: &Value, pinned: &Value) -> bool {
    if current == pinned {
        return true;
    }
    // Older rounds pinned the shipped schema with both caps. Their saved requests keep that schema.
    let mut legacy = current.clone();
    let schema = &mut legacy["roles"]["research-expert"]["outputSchema"];
    if *schema != serde_json::from_str::<Value>(EXPERT).expect("research schema") {
        return false;
    }
    for (section, field) in SHORTENABLE_EXPERT_FIELDS {
        schema["properties"][section]["items"]["properties"][field]["maxLength"] =
            json!(MAX_EXPERT_TEXT_CHARS);
    }
    &legacy == pinned
}

fn check_legacy(tmp: &Path, round: usize) -> Result<()> {
    if tmp
        .join("rounds")
        .join(round.to_string())
        .join("list.json")
        .exists()
    {
        return fail("This folder contains a pending legacy list. Finish it before starting native research.");
    }
    Ok(())
}

fn check_legacy_receipt(tmp: &Path, round: usize, ledger_sha: &str) -> Result<()> {
    if round <= 1 {
        return Ok(());
    }
    let previous = tmp.join("rounds").join((round - 1).to_string());
    if !previous.exists() {
        return Ok(());
    }
    let receipt = fs::read(previous.join("reply.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let markdown = fs::read(tmp.join("decisions.md")).ok();
    if !receipt.as_ref().is_some_and(|reply| {
        reply["outcome"]["decisionsSha256"] == ledger_sha
            && markdown
                .as_ref()
                .is_some_and(|bytes| reply["outcome"]["decisionsMdSha256"] == sha256_hex(bytes))
    }) {
        return fail("The last legacy reply does not match the decision files. Replay that reply before starting research.");
    }
    Ok(())
}

fn lock(path: &Path, id: &str) -> Result<()> {
    // Publish a fully written owner in one filesystem operation. A cut while
    // writing the private sibling cannot leave an empty shared lock behind.
    let temporary = path.with_file_name(format!(".zodchi-research-{id}.lock.tmp"));
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(id.as_bytes())?;
    file.sync_all()?;
    drop(file);
    cut("research lock prepared");
    let published = fs::hard_link(&temporary, path);
    match published {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::read_to_string(path).ok().as_deref() != Some(id) {
                return fail("Another research round owns this folder. Resume it before opening a new round.");
            }
        }
        Err(error) => return Err(error.into()),
    }
    cut("research lock published");
    fs::remove_file(temporary)?;
    Ok(())
}

fn release(path: &Path, id: &str) -> Result<()> {
    match fs::read_to_string(path) {
        Ok(owner) if owner == id => fs::remove_file(path)?,
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

struct Research<'a> {
    journal: &'a mut Journal,
    cfg: &'a Config,
    run: &'a Value,
    privacy: Privacy,
    lock: PathBuf,
}

type WaveStop<'a> = (&'a str, String);

#[derive(Default)]
struct Wave<'a> {
    stop: Option<WaveStop<'a>>,
}

impl<'a> Wave<'a> {
    fn record(
        &mut self,
        index: usize,
        step: &'a str,
        result: std::result::Result<gateway::Step, gateway::CallError>,
        pending: &mut Vec<(usize, String)>,
        accept: impl FnOnce(Value) -> Result<Option<WaveStop<'static>>>,
    ) -> Result<()> {
        // A withheld claim stops new work, but a failure found while draining a peer takes precedence.
        let may_replace_stop = self
            .stop
            .as_ref()
            .is_none_or(|(_, reason)| reason == CLAIM_NOT_SENT);
        match result {
            Ok(gateway::Step::Done(value)) => {
                if let Some(stop) = accept(value)? {
                    if may_replace_stop {
                        self.stop = Some(stop);
                    }
                }
            }
            Ok(gateway::Step::Pending(key) | gateway::Step::Retryable(key)) => {
                pending.push((index, key))
            }
            Err(err) => {
                if may_replace_stop
                    || matches!(&err, gateway::CallError::Stop { at, .. } if at.starts_with("unknown outcome"))
                {
                    self.stop = Some((step, error(err)));
                }
            }
        }
        Ok(())
    }
}

impl Research<'_> {
    fn call(
        &mut self,
        step: &str,
        role: usize,
        schema: &str,
        prompt: &str,
        mode: gateway::LocalMode<'_>,
        allow_retry: bool,
    ) -> std::result::Result<gateway::Step, gateway::CallError> {
        let (name, gateway_role) = ROLES[role];
        let current = Config::new(self.cfg.root.as_deref())
            .and_then(|cfg| {
                if ROLES.iter().any(|(key, _)| self.run["pair"][key]["provider"] == "codex")
                    && executor::flow_server(&cfg).is_some()
                {
                    return fail("Research requires the original local Codex gateway.");
                }
                local_config(&cfg)
            })
            .map_err(|error| gateway::CallError::Stop {
                at: format!("configuration at {step}"),
                reason: error.0,
            })?;
        if !same_local_config(&current, &self.run["inputs"]["pin"]["localConfig"]) {
            return Err(gateway::CallError::Stop {
                at: format!("configuration at {step}"),
                reason: "The local Codex configuration changed. Restore it before resuming.".into(),
            });
        }
        let pick = Pick::from_json(&self.run["pair"][name]);
        let schema = serde_json::from_str(schema).expect("research schema");
        let id = self.run["runId"].as_str().expect("run id");
        let repo = Path::new(self.run["repo"].as_str().expect("repo"));
        let tmp = Path::new(self.run["tmp"].as_str().expect("tmp"));
        let fresh = Privacy::with_aliases(
            self.cfg,
            &self.run["inputs"]["pin"]["privacy"],
            repo,
            tmp,
            &self.run["inputs"]["pin"]["pathAliases"],
        )
        .map_err(|error| gateway::CallError::Stop {
            at: format!("privacy at {step}"),
            reason: error.0,
        })?;
        let header = format!("Step: {step} ({NAME} v{VERSION}, run {id})");
        let attempt = self.journal.attempt(step);
        // An existing intent uses its saved request. The gateway screens that
        // request before a retry, while reattachment itself sends no material.
        if self.journal.last("intent", step, attempt).is_none() {
            if fresh.text(&header) != header {
                return Err(gateway::CallError::Stop {
                    at: format!("privacy at {step}"),
                    reason: "A structural label is private.".into(),
                });
            }
            if gateway_role == "research-expert"
                && self.run["inputs"]["pin"]["material"]["attachments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|file| {
                        file["name"]
                            .as_str()
                            .is_none_or(|name| fresh.text(name) != name)
                    })
            {
                return Err(gateway::CallError::Stop {
                    at: format!("privacy at {step}"),
                    reason: "An attachment alias is now private.".into(),
                });
            }
        }
        self.privacy = fresh;
        let validate = |value: &Value| {
            if value.is_object() && public(value, &self.privacy) {
                Ok(())
            } else {
                Err(
                    "The research role must return a structured object without private text."
                        .into(),
                )
            }
        };
        let key = self
            .journal
            .last("intent", step, attempt)
            .and_then(|e| e["key"].as_str());
        if let Some(done) = self.journal.last("done", step, attempt) {
            // The gateway reuses this answer without validation. Apply current privacy
            // rules before building the owner list from it.
            if let Err(reason) = validate(&done["result"]) {
                let key = key.unwrap_or("");
                return Err(gateway::CallError::Stop {
                    at: format!("invalid answer at {step}"),
                    reason: format!("the answer of job {key} does not hold: {reason}"),
                });
            }
        } else if let Some(key) = key.filter(|_| pick.provider == "codex") {
            if job::job_dir(self.cfg, key)
                .ok()
                .and_then(|dir| job::read_job(&dir))
                .is_some_and(|job| job["status"] == "unknown")
            {
                return Err(gateway::CallError::Stop {
                    at: format!("unknown outcome at {step}"),
                    reason: format!("job {key} ended unknown and cannot be requested again"),
                });
            }
        }
        let call = gateway::Call {
            id,
            step,
            round: self.run["round"].as_u64().unwrap_or(1) as u32,
            role: gateway_role,
            pick: &pick,
            schema: &schema,
            prompt: format!("{header}\n\n{prompt}"),
            writer_workspace: None,
        };
        let scrub = |text: &str| self.privacy.text(text);
        if pick.provider == "claude" {
            // The local Codex scheduler submits a wave in parallel. Claude returns
            // its final receipt in the foreground, so there is nothing to drain.
            return executor::claude::ask_screened(self.journal, self.cfg, call, &scrub, allow_retry, validate)
                .map(gateway::Step::Done);
        }
        gateway::local_step(
            self.journal,
            self.cfg,
            call,
            mode,
            &scrub,
            validate,
        )
    }

    /// Only this process writes the journal. Drain issued keys before returning a
    /// workflow stop. A journal write error returns immediately for recovery on resume.
    fn wave<'a>(
        &mut self,
        role: usize,
        schema: &str,
        calls: &'a [(String, String)],
        mut accept: impl FnMut(usize, Value, &mut Self) -> Result<Option<WaveStop<'static>>>,
    ) -> Result<Option<WaveStop<'a>>> {
        let mut wave = Wave::default();
        let mut pending = Vec::new();
        for (index, (step, prompt)) in calls.iter().enumerate() {
            if wave.stop.is_some()
                && self
                    .journal
                    .last("intent", step, self.journal.attempt(step))
                    .is_none()
            {
                continue;
            }
            let result = self.call(step, role, schema, prompt, gateway::LocalMode::Schedule, wave.stop.is_none());
            wave.record(index, step, result, &mut pending, |value| {
                accept(index, value, self)
            })?;
        }
        loop {
            let mut retryable = Vec::new();
            for (index, key) in pending.drain(..) {
                let step = &calls[index].0;
                let result = self.call(step, role, schema, "", gateway::LocalMode::Drain(&key), false);
                wave.record(index, step, result, &mut retryable, |value| {
                    accept(index, value, self)
                })?;
            }
            if retryable.is_empty() || wave.stop.is_some() {
                return Ok(wave.stop);
            }
            for (index, key) in retryable {
                if wave.stop.is_some() {
                    break;
                }
                let step = &calls[index].0;
                let result = self.call(step, role, schema, "", gateway::LocalMode::Retry(&key), true);
                wave.record(index, step, result, &mut pending, |value| {
                    accept(index, value, self)
                })?;
            }
        }
    }

    fn base(&self) -> Value {
        json!({"runId":self.run["runId"],"workflow":NAME,"round":self.run["round"],"models":self.run["pair"],
            "journal":self.journal.dir,"approved":false})
    }

    fn finish(&mut self, result: Value) -> Result<Exit> {
        self.journal.write_value("result.json", &result)?;
        release(&self.lock, self.run["runId"].as_str().expect("run id"))?;
        cut("research lock released");
        finish_event(self.journal)?;
        Ok(exit(result))
    }

    fn stopped(&mut self, step: &str, reason: impl Into<String>) -> Result<Exit> {
        let mut result = self.base();
        let at = reason.into();
        let key = self
            .journal
            .last("intent", step, self.journal.attempt(step))
            .map(|e| e["key"].clone());
        result["stoppedAt"] = json!(step);
        result["reason"] = json!(at);
        result["jobKey"] = json!(key);
        if self.journal.file("facts.json").exists() {
            result["facts"] = json!(self.journal.file("facts.json"));
        }
        self.journal
            .append(json!({"kind":"stop","step":step,"stoppedAt":step,"what":at,"key":key}))?;
        self.finish(result)
    }
}

fn public(value: &Value, privacy: &Privacy) -> bool {
    match value {
        Value::String(text) => !privacy.answer_is_private(text),
        Value::Object(fields) => fields.iter().all(|(key, value)| match value {
            // A scalar credential field can split the name and value of an assignment.
            Value::String(text) => !privacy.answer_is_private(&format!("{key}= {text}")),
            Value::Number(number) => !privacy.answer_is_private(&format!("{key}= {number}")),
            _ => !privacy.answer_is_private(key) && public(value, privacy),
        }),
        Value::Array(values) => values.iter().all(|value| public(value, privacy)),
        _ => true,
    }
}

fn attachment_lines(staged: &Value, privacy: &Privacy) -> BTreeMap<String, Vec<String>> {
    staged["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| {
            let alias = file["name"].as_str().expect("safe attachment name");
            let text = privacy.text(file["text"].as_str().unwrap_or(""));
            (alias.into(), text.lines().map(String::from).collect())
        })
        .collect()
}

fn numbered_attachments(attachments: &BTreeMap<String, Vec<String>>) -> Vec<(String, Vec<u8>)> {
    attachments
        .iter()
        .map(|(name, rows)| {
            let numbered = rows
                .iter()
                .enumerate()
                .map(|(n, line)| format!("{}: {line}", n + 1))
                .collect::<Vec<_>>()
                .join("\n");
            (name.clone(), numbered.into_bytes())
        })
        .collect()
}

fn expert_prompt(
    staged: &Value,
    question: &Value,
    privacy: &Privacy,
    attached: &[(String, Vec<u8>)],
    limits: &str,
    line_limit: usize,
) -> Result<(String, String)> {
    let title = privacy.text(question["title"].as_str().unwrap_or(""));
    if title.chars().count() > 80 || title.contains('\n') {
        return fail("The renewed question title is too long.");
    }
    let question_text = privacy.text(question["text"].as_str().unwrap_or(""));
    let request = privacy.text(staged["request"].as_str().unwrap_or(""));
    let decisions = privacy.text(&staged["prior"].to_string());
    let header = format!(
        "Question\n{title}\n{question_text}\n\nRequest\n{request}\n\nDecisions\n{decisions}\n\n\
         Unconfirmed constraints\n{limits}\n\nReturn at least one item and use at most {line_limit} combined items and assumptions. \
         Return at most {MAX_EXPERT_FACTS} facts. Keep each text and claim nonblank and at most {MAX_EXPERT_TEXT_CHARS} characters, \
         and each group at most {MAX_PROPOSAL_GROUP_CHARS} characters. Cite attached line ranges of at most {MAX_CITATION_LINES} lines."
    );
    let prompt = compose_prompt(&header, attached)?;
    if prompt.len() + EXPERT_PROMPT_RESERVE > LIMIT_PROMPT {
        return fail("The question and attachments exceed the prompt size.");
    }
    Ok((title, prompt))
}

fn check_expert_prompts(staged: &Value, privacy: &Privacy, max_lines: usize) -> Result<()> {
    let questions = staged["questions"].as_array().expect("staged questions");
    if max_lines < questions.len() {
        return fail(format!(
            "args.maxLines ({max_lines}) must be at least the number of questions ({}).",
            questions.len()
        ));
    }
    let attached = numbered_attachments(&attachment_lines(staged, privacy));
    for question in questions {
        // Unconfirmed constraints and owner updates are available only at runtime.
        expert_prompt(
            staged,
            question,
            privacy,
            &attached,
            "",
            max_lines / questions.len(),
        )?;
    }
    Ok(())
}

fn error(error: gateway::CallError) -> String {
    match error {
        gateway::CallError::Stop { at, reason } => format!("{at}. {reason}"),
        gateway::CallError::Context { bytes } => {
            format!("Research material has {bytes} bytes and exceeds the prompt limit.")
        }
    }
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || retry.is_some()
        || given.is_some_and(|args| !input_common::args_match(&run["inputs"], args))
    {
        return fail(
            "Resume with the original research run ID. A new paid attempt requires a new run.",
        );
    }
    let _run_lock = journal.lock()?;
    journal.load()?;
    let repo = run["repo"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| GatewayError("No research checkout in the journal.".into()))?;
    let tmp = run["tmp"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| GatewayError("No research folder in the journal.".into()))?;
    let cfg = Config::new(Some(repo))?;
    let pin = &run["inputs"]["pin"];
    if run["inputs"]["pinSha256"] != sha256_hex(pin.to_string()) {
        return fail("The pinned research input does not match its digest.");
    }
    let lock_path = tmp.join(".zodchi-research.lock");
    if let Some(result) = journal.read_value("result.json") {
        release(&lock_path, id)?;
        finish_event(&mut journal)?;
        return Ok(exit(result));
    }
    let (_, ledger_sha) = lists::ledger(&tmp.join("decisions.json"))?;
    let had_list = journal.read_value("list.json").is_some();
    if !had_list && pin["ledgerSha256"] != ledger_sha {
        return fail("Decisions changed before research started.");
    }
    lock(&lock_path, id)?;
    if !had_list {
        if let Err(error) = check_legacy(tmp, run["round"].as_u64().unwrap_or(0) as usize) {
            release(&lock_path, id)?;
            return Err(error);
        }
        if let Err(error) = check_legacy_receipt(
            tmp,
            run["round"].as_u64().unwrap_or(0) as usize,
            &ledger_sha,
        ) {
            release(&lock_path, id)?;
            return Err(error);
        }
    }
    let privacy = Privacy::with_aliases(&cfg, &pin["privacy"], repo, tmp, &pin["pathAliases"])?;
    let mut research = Research {
        journal: &mut journal,
        cfg: &cfg,
        run: &run,
        privacy,
        lock: lock_path,
    };
    if let Some(list) = research.journal.read_value("list.json") {
        return decide(&mut research, tmp, pin, &list);
    }
    let staged = &pin["material"];
    let prior = staged["prior"].as_array().expect("staged prior decisions");
    let constraints_text = research.privacy.text(&format!(
        "Check constraints for this request and the known decisions. Return at most {MAX_CONSTRAINTS} constraints. \
         Keep each constraint text nonblank and at most {MAX_CONSTRAINT_TEXT_CHARS} characters.\n\nRequest\n{}\n\nQuestions\n{}\n\nDecisions\n{}",
        staged["request"].as_str().unwrap_or(""), staged["questions"], staged["prior"]
    ));
    let check = [("constraints".into(), constraints_text)];
    let mut constraints = Value::Null;
    if let Some((step, reason)) = research.wave(0, CONSTRAINTS, &check, |_, answer, _| {
        constraints = answer;
        Ok(None)
    })? {
        return research.stopped(step, reason);
    }
    let Some(rows) = constraints["constraints"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_CONSTRAINTS)
    else {
        return research.stopped(
            "constraints",
            "The constraint check needs at most twenty rows.",
        );
    };
    if constraints["complete"] != true {
        return research.stopped(
            "constraints",
            "The constraint checker did not finish reading the request.",
        );
    }
    let mut limits = Vec::new();
    for row in rows {
        let text = row["text"].as_str().filter(|text| {
            !text.trim().is_empty() && text.chars().count() <= MAX_CONSTRAINT_TEXT_CHARS
        });
        let Some(text) = text else {
            return research.stopped("constraints", "A constraint needs bounded text.");
        };
        let entry = prior.iter().find(|entry| entry["id"] == row["decision"]);
        let status = row["status"].as_str().unwrap_or("");
        match status {
            "contradicts"
                if entry.is_some_and(|entry| {
                    matches!(entry["state"].as_str(), Some("accepted" | "rejected"))
                }) =>
            {
                return research.stopped(
                    "constraints",
                    "A constraint contradicts an existing decision.",
                );
            }
            "confirmed" if entry.is_some_and(|entry| entry["state"] == "accepted") => {}
            "confirmed" | "contradicts" | "unconfirmed" => limits.push(text.to_owned()),
            _ => return research.stopped("constraints", "Unknown constraint status."),
        }
    }
    let prompt_limits = limits
        .iter()
        .map(|text| research.privacy.text(text))
        .collect::<Vec<_>>()
        .join("\n");
    let attachments = attachment_lines(staged, &research.privacy);
    let attached = numbered_attachments(&attachments);
    let mut lines = Vec::new();
    let mut facts = Vec::new();
    let mut mechanical = Vec::new();
    let questions = staged["questions"].as_array().expect("staged questions");
    let round = run["round"].as_u64().expect("round");
    let limit = pin["maxLines"].as_u64().unwrap_or(30) as usize;
    let mut calls = Vec::new();
    let mut titles = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let (title, prompt) = match expert_prompt(
            staged,
            question,
            &research.privacy,
            &attached,
            &prompt_limits,
            (limit / questions.len()).max(1),
        ) {
            Ok(material) => material,
            Err(error) => return research.stopped("prompts", error.0),
        };
        calls.push((format!("ask q{}", index + 1), prompt));
        titles.push(title);
    }
    for (wave_index, wave) in calls.chunks(2).enumerate() {
        let mut collected = BTreeMap::new();
        let mut line_count = lines.len();
        let stop = research.wave(1, EXPERT, wave, |offset, answer, research| {
            let index = wave_index * 2 + offset;
            let mut answer = match collect_answer(
                &answer,
                index + 1,
                &titles[index],
                prior,
                &attachments,
                &research.privacy,
            ) {
                Ok(answer) => answer,
                Err(error) => return Ok(Some(("collect", error.0))),
            };
            // Record accepted answers before a peer or the round budget can stop collection.
            for event in answer.shortened.drain(..) {
                // A resume can collect the same saved answer after a cut between records.
                if !research.journal.events().iter().any(|recorded| {
                    recorded["kind"] == event["kind"]
                        && recorded["question"] == event["question"]
                        && recorded["section"] == event["section"]
                        && recorded["line"] == event["line"]
                }) {
                    research.journal.append(event)?;
                }
            }
            line_count += answer.lines.len();
            if line_count > limit {
                return Ok(Some((
                    "collect",
                    "The proposals and assumptions exceed the round line budget.".into(),
                )));
            }
            collected.insert(offset, answer);
            Ok(None)
        })?;
        if let Some((step, reason)) = stop {
            return research.stopped(step, reason);
        }
        for answer in collected.into_values() {
            for mut proposal in answer.lines {
                let n = lines.len() + 1;
                proposal["n"] = json!(n);
                proposal["id"] = json!(format!("{round}.{n}"));
                lines.push(proposal);
            }
            facts.extend(answer.facts);
            mechanical.extend(answer.mechanical);
        }
    }
    // Preserve validated claims for the owner while applying inbound scrubbing to the checker copy.
    let mut prompt_facts = facts.clone();
    for fact in &mut prompt_facts {
        let claim = fact["claim"].as_str().expect("fact claim");
        fact["claim"] = json!(research.privacy.text(claim));
    }
    let mut reports = Vec::new();
    let mut extra_ids = Vec::new();
    let mut cursor = 0;
    let mut number = 0;
    while cursor < facts.len() {
        let suffix = gateway::owner_suffix(research.journal, &cfg, &[])?;
        let suffix_size = research.privacy.text(&suffix).len();
        let mut calls = Vec::new();
        let mut batches = Vec::new();
        while calls.len() < 2 && cursor < facts.len() {
            let step = format!("check f{}", number + 1);
            let header = format!("Step: {step} ({NAME} v{VERSION}, run {id})\n\n");
            // A cut after scheduling must attach the answer to the same fact IDs,
            // even if a new owner remark changes the space available for fresh batches.
            let attempt = research.journal.attempt(&step);
            let issued = research.journal.last("intent", &step, attempt).is_some();
            let plan = research
                .journal
                .last("fact batch", &step, attempt)
                .filter(|_| issued);
            let batch = if let Some(plan) = plan {
                let count = plan["count"].as_u64().unwrap_or(0) as usize;
                let start = plan["start"].as_u64().unwrap_or(u64::MAX) as usize;
                if start < cursor
                    || start > facts.len()
                    || count == 0
                    || count > 15
                    || count > facts.len() - start
                {
                    return fail("Invalid saved fact batch.");
                }
                for skipped in &facts[cursor..start] {
                    reports.push(oversize_fact(skipped));
                }
                cursor = start;
                &facts[cursor..cursor + count]
            } else {
                let remaining = &facts[cursor..];
                let capacity = LIMIT_PROMPT.saturating_sub(header.len() + suffix_size);
                // Runs opened by the count-only batcher have an intent but no batch record.
                let count = if issued {
                    remaining.len().min(15)
                } else {
                    fact_batch_len(&prompt_facts[cursor..], capacity)
                };
                if count == 0 {
                    reports.push(oversize_fact(&facts[cursor]));
                    cursor += 1;
                    continue;
                }
                research.journal.append(json!({"kind":"fact batch","step":step,"attempt":attempt,"start":cursor,"count":count}))?;
                &remaining[..count]
            };
            let prompt = serde_json::to_string_pretty(&prompt_facts[cursor..cursor + batch.len()])
                .expect("facts JSON");
            calls.push((step, prompt));
            batches.push(batch);
            cursor += batch.len();
            number += 1;
        }
        let failure = research.wave(2, FACTS, &calls, |offset, answer, research| {
            let submitted = submitted_fact_batch(research.journal, &calls[offset].0)
                .unwrap_or_default();
            let verdicts =
                collect_verdicts(batches[offset], &answer, &mut reports, &mut extra_ids, |fact| {
                    let claim = fact["claim"].as_str().expect("fact claim");
                    let normalized = claim.lines().collect::<Vec<_>>().join("\n");
                    submitted.iter().any(|sent| sent["id"] == fact["id"] && sent["claim"] == normalized)
                });
            Ok(verdicts.err())
        })?;
        if let Some((step, reason)) = failure {
            write_unchecked_report(
                &research,
                &reports,
                &facts,
                &mechanical,
                &extra_ids,
                &reason,
            )?;
            return research.stopped(step, reason);
        }
    }
    let report = json!({"verdicts":reports,"facts":facts,"mechanicalNotFound":mechanical,"extraIds":extra_ids});
    research.journal.write_value("facts.json", &report)?;
    if reports.iter().any(|row| row["verdict"] == "unchecked") {
        return research.stopped("facts", "A cited excerpt exceeds the prompt limit.");
    }
    let list = json!({"round":round,"lines":lines,"unconfirmed":limits,"facts":report});
    let mut markdown = lists::markdown(round, &lines);
    if !limits.is_empty() {
        markdown.push_str("\n## Неподтверждённые ограничения\n");
        for limit in &limits {
            markdown.push_str(&format!("\n- {limit}\n"));
        }
    }
    if !mechanical.is_empty() || reports.iter().any(|row| row["verdict"] == "not found") {
        markdown.push_str("\n## Факты не найдены\n");
        for row in &mechanical {
            markdown.push_str(&format!(
                "\n- {} — {}\n",
                row["claim"].as_str().unwrap_or(""),
                row["reason"].as_str().unwrap_or("")
            ));
        }
        for row in reports.iter().filter(|row| row["verdict"] == "not found") {
            markdown.push_str(&format!(
                "\n- {} — {}\n",
                row["id"].as_str().unwrap_or(""),
                row["note"].as_str().unwrap_or("")
            ));
        }
    }
    research.journal.write_text("list.md", &markdown)?;
    research.journal.write_value("list.json", &list)?;
    decide(&mut research, tmp, pin, &list)
}

fn submitted_fact_batch(journal: &Journal, step: &str) -> Option<Vec<Value>> {
    // The saved request includes the final gateway scrub and is reused across a cut.
    let intent = journal.last("intent", step, journal.attempt(step))?;
    let request = journal.read_value(intent["request"].as_str()?)?;
    if intent["digest"] != sha256_hex(request.to_string()) {
        return None;
    }
    let (_, body) = request["prompt"].as_str()?.split_once("\n\n")?;
    // The JSON array can be followed by owner updates.
    serde_json::Deserializer::from_str(body).into_iter().next()?.ok()
}

fn collect_verdicts(
    batch: &[Value],
    answer: &Value,
    reports: &mut Vec<Value>,
    extra_ids: &mut Vec<String>,
    claim_sent: impl Fn(&Value) -> bool,
) -> std::result::Result<(), (&'static str, String)> {
    let mut unresolved = false;
    let mut contradicted = false;
    let mut withheld_claim = false;
    let mut rows_by_id = BTreeMap::new();
    for row in answer["verdicts"].as_array().into_iter().flatten() {
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        if batch.iter().any(|fact| fact["id"] == id) {
            rows_by_id
                .entry(id)
                .and_modify(|value| *value = None)
                .or_insert(Some(row));
        } else {
            extra_ids.push(id.to_owned());
        }
    }
    for fact in batch {
        let id = fact["id"].as_str().expect("fact ID");
        if !claim_sent(fact) {
            reports.push(json!({"id":id, "verdict":"unchecked", "note":CLAIM_NOT_SENT}));
            withheld_claim = true;
            continue;
        }
        let verdict = rows_by_id.remove(id).flatten().filter(|row| {
            matches!(
                row["verdict"].as_str(),
                Some("supported" | "contradicted" | "not found")
            ) && row["note"]
                .as_str()
                .is_some_and(|note| !note.trim().is_empty())
        });
        if let Some(row) = verdict {
            contradicted |= row["verdict"] == "contradicted";
            reports.push(row.clone());
        } else {
            let note = "The checker must return one verdict with a valid note for this fact.";
            reports.push(json!({"id":id, "verdict":"unchecked", "note":note}));
            unresolved = true;
        }
    }
    if contradicted {
        Err((
            "facts contradicted",
            "A checked fact contradicts the research answer.".into(),
        ))
    } else if unresolved {
        Err(("facts", "Every batched fact needs one verdict.".into()))
    } else if withheld_claim {
        Err(("facts", CLAIM_NOT_SENT.into()))
    } else {
        Ok(())
    }
}

fn oversize_fact(fact: &Value) -> Value {
    json!({"id":fact["id"], "verdict":"unchecked", "note":"The cited excerpt exceeds the prompt limit."})
}

fn fact_batch_len(facts: &[Value], capacity: usize) -> usize {
    (1..=facts.len().min(15))
        .take_while(|count| {
            serde_json::to_vec_pretty(&facts[..*count])
                .expect("facts JSON")
                .len()
                <= capacity
        })
        .count()
}

fn write_unchecked_report(
    research: &Research<'_>,
    reports: &[Value],
    facts: &[Value],
    mechanical: &[Value],
    extra_ids: &[String],
    reason: &str,
) -> Result<()> {
    let mut verdicts = reports.to_vec();
    for fact in facts {
        if !reports.iter().any(|row| row["id"] == fact["id"]) {
            verdicts.push(json!({"id": fact["id"], "verdict": "unchecked", "note": reason}));
        }
    }
    research.journal.write_value(
        "facts.json",
        &json!({
            "verdicts": verdicts, "facts": facts, "mechanicalNotFound": mechanical, "extraIds": extra_ids
        }),
    )?;
    Ok(())
}

#[derive(Default)]
struct CollectedAnswer {
    lines: Vec<Value>,
    facts: Vec<Value>,
    mechanical: Vec<Value>,
    shortened: Vec<Value>,
}

impl CollectedAnswer {
    fn expert_text<'a>(
        &mut self,
        record: &'a Value,
        question: usize,
        section: &str,
        line: usize,
        invalid: impl FnOnce() -> GatewayError,
    ) -> Result<Cow<'a, str>> {
        let field = if section == "facts" { "claim" } else { "text" };
        let Some(text) = record[field].as_str().filter(|text| !text.trim().is_empty()) else {
            return Err(invalid());
        };
        let original_chars = text.chars().count();
        if original_chars <= MAX_EXPERT_TEXT_CHARS {
            return Ok(Cow::Borrowed(text));
        }
        if !SHORTENABLE_EXPERT_FIELDS.contains(&(section, field)) {
            return Err(invalid());
        }
        // Keep rejecting a too-long record that also violates the executor's schema.
        let schema: Value = serde_json::from_str(EXPERT).expect("research schema");
        if zodchi_core::claude::conforms(record, &schema["properties"][section]["items"], "answer")
            .is_err()
        {
            return Err(invalid());
        }
        let keep = MAX_EXPERT_TEXT_CHARS - EXPERT_SHORTENING_MARKER.chars().count();
        let (end, _) = text.char_indices().nth(keep).expect("overlong expert text");
        self.shortened.push(json!({
            "kind": "expert line shortened",
            "step": "collect",
            "question": question,
            "section": section,
            "line": line,
            "originalChars": original_chars,
            "originalText": text,
        }));
        Ok(Cow::Owned(format!("{}{EXPERT_SHORTENING_MARKER}", &text[..end])))
    }
}

fn collect_answer(
    answer: &Value,
    q: usize,
    title: &str,
    prior: &[Value],
    attachments: &BTreeMap<String, Vec<String>>,
    privacy: &Privacy,
) -> Result<CollectedAnswer> {
    let mut collected = CollectedAnswer::default();
    for (key, kind) in [("items", "proposal"), ("assumptions", "assumption")] {
        let records = answer[key]
            .as_array()
            .ok_or_else(|| GatewayError(format!("Question {q} has no {key} array.")))?;
        if key == "items" && records.is_empty() {
            return fail(format!("Question {q} has no proposals."));
        }
        for (index, record) in records.iter().enumerate() {
            let text = collected.expert_text(record, q, key, index + 1, || {
                GatewayError(format!("Question {q} has an invalid {key} line."))
            })?;
            let group = record["group"]
                .as_str()
                .filter(|group| !group.trim().is_empty())
                .unwrap_or(title);
            if group.chars().count() > MAX_PROPOSAL_GROUP_CHARS {
                return fail("The proposal group is too long.");
            }
            let mut row = json!({"kind":kind,"group":group,"text":text});
            if key == "items" {
                let mut replacements = Vec::new();
                for id in record["replaces"].as_array().into_iter().flatten() {
                    let entry = prior
                        .iter()
                        .find(|entry| {
                            entry["id"] == *id
                                && matches!(entry["state"].as_str(), Some("open" | "accepted"))
                        })
                        .ok_or_else(|| {
                            GatewayError("A proposal replaces an unavailable decision.".into())
                        })?;
                    replacements.push(
                        json!({"id":id,"text":privacy.text(entry["text"].as_str().unwrap_or(""))}),
                    );
                }
                row["replaces"] = json!(replacements);
            } else {
                row["why"] = json!(record["why"].as_str().unwrap_or(""));
            }
            collected.lines.push(row);
        }
    }
    let rows = answer["facts"]
        .as_array()
        .filter(|rows| rows.len() <= MAX_EXPERT_FACTS)
        .ok_or_else(|| GatewayError(format!("Question {q} needs at most twelve facts.")))?;
    for (i, row) in rows.iter().enumerate() {
        let claim = collected.expert_text(row, q, "facts", i + 1, || {
            GatewayError("A fact needs bounded claim text.".into())
        })?;
        let source = row["source"]
            .as_str()
            .ok_or_else(|| GatewayError("A fact needs a citation.".into()))?;
        let Some((name, excerpt)) = cite(source, attachments) else {
            collected.mechanical.push(json!({"claim":claim, "source":privacy.text(source),
                "reason":"The cited attachment or line range does not exist or exceeds the permitted range."}));
            continue;
        };
        let id = format!("F{q}.{}", i + 1);
        let source = format!("{name}:{}", source.rsplit_once(':').unwrap().1);
        if privacy.text(&id) != id || privacy.text(&source) != source {
            return fail("A citation contains private structural text.");
        }
        collected
            .facts
            .push(json!({"id":id,"claim":claim,"source":source,"excerpt":excerpt}));
    }
    Ok(collected)
}

fn cite<'a>(
    source: &'a str,
    attachments: &BTreeMap<String, Vec<String>>,
) -> Option<(&'a str, String)> {
    let (name, range) = source.rsplit_once(':')?;
    let name = name.strip_prefix("attach/").unwrap_or(name);
    let (first, last) = range.split_once('-').unwrap_or((range, range));
    let number = |text: &str| {
        if text.starts_with('0') || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            None
        } else {
            text.parse::<usize>().ok().filter(|n| *n > 0)
        }
    };
    let first = number(first)?;
    let last = number(last)?;
    let lines = attachments.get(name)?;
    if first > last || last > lines.len() || last - first >= MAX_CITATION_LINES {
        return None;
    }
    let a = first.saturating_sub(3);
    let b = (last + 2).min(lines.len());
    Some((
        name,
        lines[a..b]
            .iter()
            .enumerate()
            .map(|(i, line)| format!("{}: {line}", a + i + 1))
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}

/// A research reply may contain a correction for every line of the owner's list.
pub fn reply_text(journal: &Journal, cfg: &Config, run: &Value, file: &Path) -> Result<String> {
    if !journal.last_event().is_some_and(|event| event["step"] == OWNER) {
        return fail("The research round must be waiting for owner decisions.");
    }
    let repo = material::path(&run["repo"], "research checkout")?;
    let tmp = material::path(&run["tmp"], "research folder")?;
    let pin = &run["inputs"]["pin"];
    if run["inputs"]["pinSha256"] != sha256_hex(pin.to_string()) {
        return fail("The pinned research input does not match its digest.");
    }
    let privacy = Privacy::with_aliases(cfg, &pin["privacy"], &repo, &tmp, &pin["pathAliases"])?;
    // Includes 200 fixes of 600 characters even with JSON surrogate-pair escapes.
    let raw = material::bounded(file, 2 * 1024 * 1024, "research reply")?;
    let mut actions = lists::parse_reply(&raw)?;
    // Bound the owner's input once. Redaction can expand a short private line.
    if actions
        .iter()
        .filter_map(|action| action["text"].as_str())
        .any(|text| text.chars().count() > 600)
    {
        return fail("A correction may contain at most 600 characters.");
    }
    lists::scrub_corrections(&mut actions, &privacy);
    let lines = journal
        .last_event()
        .and_then(|e| e["decisions"].as_array())
        .ok_or_else(|| GatewayError("The waiting round has no decision list.".into()))?;
    let (ledger, _) = lists::ledger(&tmp.join("decisions.json"))?;
    lists::apply(
        ledger,
        &actions,
        run["round"].as_u64().expect("round"),
        lines,
    )?;
    Ok(serde_json::to_string(&actions).expect("owner decisions JSON"))
}

fn decide(research: &mut Research<'_>, tmp: &Path, pin: &Value, list: &Value) -> Result<Exit> {
    let mut result = research.base();
    result["list"] = json!(research.journal.file("list.md"));
    result["facts"] = json!(research.journal.file("facts.json"));
    result["unconfirmed"] = list["unconfirmed"].clone();
    let answer = research
        .journal
        .events()
        .iter()
        .rev()
        .find(|event| event["step"] == OWNER && event["ownerAnswer"].is_string())
        .and_then(|event| event["ownerAnswer"].as_str())
        .map(String::from);
    let wait = |research: &mut Research<'_>, mut result: Value, question: &str| -> Result<Exit> {
        if research
            .journal
            .last_event()
            .is_none_or(|event| event["kind"] != "waiting")
        {
            research.journal.append(
                json!({"kind":"waiting","step":OWNER,"question":question,"draft":result["list"],"decisions":list["lines"]}),
            )?;
        }
        result["status"] = json!("waiting");
        result["question"] = json!(question);
        Ok(exit(result))
    };
    let Some(reply) = answer else {
        return wait(research,result,"Reply with a JSON array of accept, drop or fix verdicts. Each verdict names a current number n or an earlier open id.");
    };
    let file = tmp.join("decisions.json");
    let (ledger, digest) = lists::ledger(&file)?;
    let intent = research
        .journal
        .last("intent", "apply decisions", 1)
        .cloned();
    let next = if intent
        .as_ref()
        .is_some_and(|event| event["newSha256"] == sha256_hex(ledger.to_string()))
    {
        ledger
    } else {
        if pin["ledgerSha256"] != digest {
            return fail("Decisions changed after the round opened.");
        }
        let lines = list["lines"]
            .as_array()
            .ok_or_else(|| GatewayError("The owner list has no lines.".into()))?;
        let round = list["round"].as_u64().unwrap_or(0);
        let next = match lists::parse_reply(&reply).and_then(|mut actions| {
            lists::scrub_corrections(&mut actions, &research.privacy);
            lists::apply(ledger, &actions, round, lines)
        }) {
            Ok(clean) => clean,
            Err(err) => return wait(research, result, &err.0),
        };
        let checksum = sha256_hex(next.to_string());
        if let Some(intent) = intent {
            if intent["newSha256"] != checksum {
                return fail("The owner reply differs from the saved write intent.");
            }
        } else {
            research.journal.append(
                json!({"kind":"intent","step":"apply decisions","attempt":1,"newSha256":checksum}),
            )?;
        }
        write_json_atomic(&file, &next)?;
        cut("research decisions");
        next
    };
    let summary = research.journal.write_text(
        "decisions.md",
        &lists::ledger_markdown(&next, &research.privacy),
    )?;
    result["approved"] = json!(true);
    result["decisions"] = json!(file);
    result["decisionsMarkdown"] = json!(summary);
    result["round"] = list["round"].clone();
    research.finish(result)
}

fn finish_event(journal: &mut Journal) -> Result<()> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({"kind":"finished","step":"result"}))?;
    }
    Ok(())
}

fn exit(result: Value) -> Exit {
    Exit {
        code: if result["approved"] == true { 0 } else { 2 },
        result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_uses_usable_claude_candidates_and_records_disabled_candidates() {
        let keys = ROLES.map(|(key, _)| key);
        let installed = Value::Object(ROLES.into_iter().map(|(_, role)| {
            (role.into(), json!({"mode":"expert","kind":"text"}))
        }).collect());
        for enabled in [true, false] {
            let (table, mut gate) = models::test_one_shot_gate(&keys, enabled);
            let pair = research_models(&table, &mut gate, &installed, || {
                assert!(!enabled, "a Claude-only round does not need Codex");
                Ok(())
            }).unwrap();
            for (index, key) in keys.iter().enumerate() {
                assert_eq!(pair[*key]["provider"], if enabled { "claude" } else { "codex" });
                if enabled {
                    assert_eq!(pair[*key]["account"], "claude-0123456789abcdef");
                } else {
                    assert!(pair["skipped"][index].as_str().unwrap().contains(&format!("{key} claude/opus: Claude is not an executor of this run: not enabled")));
                }
            }
        }
    }

    #[test]
    fn answer_privacy_checks_pinned_words_and_paths() {
        let dir = std::env::temp_dir().join(crate::journal::new_run_id());
        let repo = dir.join("repo");
        let tmp = dir.join("notes");
        let mut cfg = Config::tenant(&dir, "fixture").unwrap();
        cfg.home = dir.join("home");
        let word = "pinned-private-word";
        let snapshot = json!({"salt":"fixture","entries":[
            {"len":word.len(), "hash":sha256_hex(format!("fixture:{word}"))}
        ]});
        let privacy = Privacy::new(&cfg, &snapshot, &repo, &tmp).unwrap();

        assert!(public(
            &json!({
                "items":[{"text":"Use an access token in an httpOnly cookie."}],
                "facts":[{"claim":"The header is documented.", "source":"1-auth:2"}]
            }),
            &privacy
        ));
        assert!(!public(&json!({"items":[{"text":word}]}), &privacy));
        assert!(!public(
            &json!({"items":[{"token":"fixture-value"}]}),
            &privacy
        ));
        assert!(!public(
            &json!({"items":[{"password":123456}]}),
            &privacy
        ));
        assert!(!public(
            &json!({"items":[{"password":"=fixture-value"}]}),
            &privacy
        ));
        for path in [&repo, &tmp, &cfg.home] {
            let answer = json!({"items":[{"text":format!("Found at {}", path.display())}]});
            assert!(!public(&answer, &privacy));
        }
    }

    fn prompt_privacy() -> Privacy {
        let dir = std::env::temp_dir().join(crate::journal::new_run_id());
        let mut cfg = Config::tenant(&dir, "fixture").unwrap();
        cfg.home = dir.join("home");
        let snapshot = json!({"salt":"fixture","entries":[]});
        Privacy::new(&cfg, &snapshot, &dir.join("repo"), &dir.join("notes")).unwrap()
    }

    #[test]
    fn prepare_requires_a_line_for_each_question() {
        let staged = json!({"request":"Plan the shelves.", "prior":[], "attachments":[],
            "questions":[{"title":"One","text":"Width?"},{"title":"Two","text":"Height?"}]});
        let privacy = prompt_privacy();
        assert_eq!(
            check_expert_prompts(&staged, &privacy, 1).unwrap_err().0,
            "args.maxLines (1) must be at least the number of questions (2)."
        );
        assert!(check_expert_prompts(&staged, &privacy, 2).is_ok());
    }

    #[test]
    fn prepare_checks_the_assembled_prompt_for_every_question() {
        let privacy = prompt_privacy();
        let question = json!({"title":"One","text":"Width?"});
        let mut staged = json!({
            "request":"r".repeat(100_000),
            "prior":[{"id":"1.1","state":"accepted","text":"d".repeat(4_000)}],
            "attachments":[
                {"name":"1-measures.txt","text":"a".repeat(190_000)},
                {"name":"2-drawing.txt","text":"b".repeat(190_000)}
            ],
            "questions":[question.clone()],
        });
        assert!(check_expert_prompts(&staged, &privacy, 2).is_ok());
        staged["questions"] = json!([question, {"title":"Two","text":"q".repeat(45_000)}]);
        assert_eq!(
            check_expert_prompts(&staged, &privacy, 2).unwrap_err().0,
            "The question and attachments exceed the prompt size."
        );
    }

    #[test]
    fn prepare_names_an_unknown_key() {
        let error = prepare(&json!({"maxLine": 2}), crate::require_workflow).err().unwrap();
        assert_eq!(error.0, r#"Unknown research input "maxLine"."#);
    }

    #[test]
    fn research_role_schemas_match_validated_limits() {
        let expert: Value = serde_json::from_str(EXPERT).unwrap();
        let fields = &expert["properties"];
        assert_eq!(fields["facts"]["maxItems"], MAX_EXPERT_FACTS);
        for (section, field) in SHORTENABLE_EXPERT_FIELDS {
            let schema = &fields[section]["items"]["properties"][field];
            assert_eq!(schema["type"], "string");
            assert!(schema.get("maxLength").is_none());
        }
        assert_eq!(
            fields["assumptions"]["items"]["properties"]["text"]["maxLength"],
            MAX_EXPERT_TEXT_CHARS
        );
        assert_eq!(
            fields["items"]["items"]["properties"]["group"]["maxLength"],
            MAX_PROPOSAL_GROUP_CHARS
        );
        let constraints: Value = serde_json::from_str(CONSTRAINTS).unwrap();
        let constraints = &constraints["properties"]["constraints"];
        assert_eq!(constraints["maxItems"], MAX_CONSTRAINTS);
        assert_eq!(
            constraints["items"]["properties"]["text"]["maxLength"],
            MAX_CONSTRAINT_TEXT_CHARS
        );
    }

    #[test]
    fn fact_batch_counts_serialized_bytes_and_caps_the_number_of_rows() {
        let facts = vec![json!({"id":"F1.1","excerpt":"quoted \"row\"\n第二行"}); 16];
        let two_rows = serde_json::to_vec_pretty(&facts[..2]).unwrap().len();
        assert_eq!(fact_batch_len(&facts, two_rows), 2);
        assert_eq!(fact_batch_len(&facts, two_rows - 1), 1);
        assert_eq!(fact_batch_len(&facts, 1), 0);
        assert_eq!(fact_batch_len(&facts, LIMIT_PROMPT), 15);
    }

    #[test]
    fn a_checked_peer_contradiction_takes_precedence_over_a_withheld_claim() {
        let mut wave = Wave::default();
        let mut pending = Vec::new();
        wave.record(
            0,
            "check f1",
            Ok(gateway::Step::Done(Value::Null)),
            &mut pending,
            |_| Ok(Some(("facts", CLAIM_NOT_SENT.into()))),
        )
        .unwrap();
        wave.record(
            1,
            "check f2",
            Ok(gateway::Step::Done(Value::Null)),
            &mut pending,
            |_| Ok(Some(("facts contradicted", "A checked fact contradicts the research answer.".into()))),
        )
        .unwrap();
        assert_eq!(wave.stop.unwrap().0, "facts contradicted");
    }
}
