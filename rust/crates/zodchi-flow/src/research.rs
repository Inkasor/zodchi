//! One native research round, with a snapshot of project material and an owner decision gate.

use crate::{
    control, gateway,
    git::Git,
    input,
    journal::Journal,
    models::{self, Pick},
    research_lists as lists,
    research_material::{self as material, Privacy},
    Exit,
};
use serde_json::{json, Map, Value};
use std::{
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

pub const NAME: &str = "research";
const VERSION: &str = "1";
const OWNER: &str = "owner decisions";
const CONSTRAINTS: &str = include_str!("../../../../roles/research-constraints.schema.json");
const EXPERT: &str = include_str!("../../../../roles/research-expert.schema.json");
const FACTS: &str = include_str!("../../../../roles/research-fact-check.schema.json");
const ROLES: [(&str, &str); 3] = [
    ("constraintChecker", "research-constraints"),
    ("researchExpert", "research-expert"),
    ("factChecker", "research-fact-check"),
];

pub fn start(raw: &Value, detach: bool) -> Result<Exit> {
    match prepare(raw) {
        Ok((id, journal)) if detach => control::launch(&journal, &id, None),
        Ok((id, _)) => resume(&id, None, None),
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({"workflow":NAME,"refused":error.0,"approved":false}),
        }),
    }
}

fn prepare(raw: &Value) -> Result<(String, Journal)> {
    if raw.as_object().is_none_or(|row| {
        row.keys().any(|key| {
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
        })
    }) {
        return fail("Unknown research input.");
    }
    let label = raw["label"]
        .as_str()
        .filter(|label| is_key(label) && label.len() <= 40)
        .ok_or_else(|| GatewayError("args.label needs a short gateway key.".into()))?;
    let repo = fs::canonicalize(material::path(&raw["repo"], "args.repo")?)?;
    let tmp = material::path(&raw["tmp"], "args.tmp")?;
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
    crate::catalog::require(&git, &git.rev("HEAD^{commit}")?, NAME)?;
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
    if crate::executor::flow_server(&cfg).is_some() {
        return fail("The native research roles currently require the local Codex gateway.");
    }
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
    let privacy = Privacy::new(&cfg, &snapshot, &repo, &tmp)?;
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
    let overrides = match raw.get("models") {
        None => Map::new(),
        Some(Value::Object(overrides)) => overrides.clone(),
        Some(_) => return fail("args.models must be a model role table."),
    };
    let table = models::table(&cfg, &repo, &overrides).map_err(GatewayError)?;
    let mut pair = Map::new();
    for (key, role) in ROLES {
        let installed = load_role(&cfg, role, &Overrides::default())?;
        if installed["mode"] != "expert" || installed["kind"] != "text" {
            return fail(format!("Install the expert text role {role}."));
        }
        let value = if table.contains_key(key) {
            models::candidates(&table, key)
                .map_err(GatewayError)?
                .into_iter()
                .find(|candidate| candidate.provider == "codex")
                .ok_or_else(|| GatewayError(format!("No Codex model is available for {key}.")))?
                .to_json()
        } else {
            json!({"provider":"codex","model":installed["model"],"effort":installed["effort"]})
        };
        pair.insert(key.into(), value);
    }
    models::codex_usable(&job::account(&cfg)).map_err(GatewayError)?;
    fs::create_dir_all(&tmp)?;
    let tmp = fs::canonicalize(tmp)?;
    let id = (0..16)
        .map(|_| crate::journal::new_run_id())
        .find(|id| privacy.text(id) == *id)
        .ok_or_else(|| {
            GatewayError("No usable research run identifier after sixteen draws.".into())
        })?;
    let pin = json!({"material":staged,"privacy":snapshot,"maxLines":max,"ledgerSha256":current,
        "localConfig":local_config(&cfg)?});
    let run = json!({
        "runId":id,"workflow":NAME,"version":VERSION,"release":env!("CARGO_PKG_VERSION"),"createdAt":iso(),
        "repo":repo,"tmp":tmp,"round":round,"label":label,"pair":pair,
        "inputs":{"argsSha256":input::args_digest(raw),"pin":pin,"pinSha256":sha256_hex(pin.to_string())},
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    Ok((id, journal))
}

// Record routing and role configuration without reading subscription credentials.
fn local_config(cfg: &Config) -> Result<Value> {
    if crate::executor::flow_server(cfg).is_some() {
        return fail("Research requires the original local Codex gateway.");
    }
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
    crate::code_package::cut("research lock prepared");
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
    crate::code_package::cut("research lock published");
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

#[derive(Default)]
struct Wave<'a> {
    stop: Option<(&'a str, String)>,
}

impl<'a> Wave<'a> {
    fn record(
        &mut self,
        index: usize,
        step: &'a str,
        result: std::result::Result<gateway::Step, gateway::CallError>,
        pending: &mut Vec<(usize, String)>,
        accept: impl FnOnce(Value) -> std::result::Result<(), (&'static str, String)>,
    ) {
        match result {
            Ok(gateway::Step::Done(value)) => {
                if let Err(stop) = accept(value) {
                    self.stop.get_or_insert(stop);
                }
            }
            Ok(gateway::Step::Pending(key) | gateway::Step::Retryable(key)) => {
                pending.push((index, key))
            }
            Err(err) => {
                if self.stop.is_none()
                    || matches!(&err, gateway::CallError::Stop { at, .. } if at.starts_with("unknown outcome"))
                {
                    self.stop = Some((step, error(err)));
                }
            }
        }
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
    ) -> std::result::Result<gateway::Step, gateway::CallError> {
        let (name, gateway_role) = ROLES[role];
        let current = Config::new(self.cfg.root.as_deref())
            .and_then(|cfg| local_config(&cfg))
            .map_err(|error| gateway::CallError::Stop {
                at: format!("configuration at {step}"),
                reason: error.0,
            })?;
        if current != self.run["inputs"]["pin"]["localConfig"] {
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
        let fresh = Privacy::new(self.cfg, &self.run["inputs"]["pin"]["privacy"], repo, tmp)
            .map_err(|error| gateway::CallError::Stop {
                at: format!("privacy at {step}"),
                reason: error.0,
            })?;
        let header = format!("Step: {step} ({NAME} v{VERSION}, run {id})");
        let attempt = self.journal.attempt(step);
        if self.journal.last("intent", step, attempt).is_none() && fresh.text(&header) != header {
            return Err(gateway::CallError::Stop {
                at: format!("privacy at {step}"),
                reason: "A structural label is private.".into(),
            });
        }
        self.privacy = fresh;
        if self.journal.last("done", step, attempt).is_none() {
            if let Some(intent) = self.journal.last("intent", step, attempt) {
                if let Some(key) = intent["key"].as_str() {
                    if job::job_dir(self.cfg, key)
                        .ok()
                        .and_then(|dir| job::read_job(&dir))
                        .is_some_and(|job| job["status"] == "unknown")
                    {
                        return Err(gateway::CallError::Stop {
                            at: format!("unknown outcome at {step}"),
                            reason: format!(
                                "job {key} ended unknown and cannot be requested again"
                            ),
                        });
                    }
                }
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
        gateway::local_step(
            self.journal,
            self.cfg,
            call,
            mode,
            &|text| self.privacy.text(text),
            |value| {
                if value.is_object() && public(value, &self.privacy) {
                    Ok(())
                } else {
                    Err(
                        "The research role must return a structured object without private text."
                            .into(),
                    )
                }
            },
        )
    }

    /// Only this process writes the journal. Submit the wave first, then drain every
    /// issued key before the caller validates the wave or decides to stop the run.
    fn wave<'a>(
        &mut self,
        role: usize,
        schema: &str,
        calls: &'a [(String, String)],
        mut accept: impl FnMut(
            usize,
            Value,
            &Privacy,
        ) -> std::result::Result<(), (&'static str, String)>,
    ) -> Option<(&'a str, String)> {
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
            let result = self.call(step, role, schema, prompt, gateway::LocalMode::Schedule);
            wave.record(index, step, result, &mut pending, |value| {
                accept(index, value, &self.privacy)
            });
        }
        loop {
            let mut retryable = Vec::new();
            for (index, key) in pending.drain(..) {
                let step = &calls[index].0;
                let result = self.call(step, role, schema, "", gateway::LocalMode::Drain(&key));
                wave.record(index, step, result, &mut retryable, |value| {
                    accept(index, value, &self.privacy)
                });
            }
            if retryable.is_empty() || wave.stop.is_some() {
                return wave.stop;
            }
            for (index, key) in retryable {
                if wave.stop.is_some() {
                    break;
                }
                let step = &calls[index].0;
                let result = self.call(step, role, schema, "", gateway::LocalMode::Retry(&key));
                wave.record(index, step, result, &mut pending, |value| {
                    accept(index, value, &self.privacy)
                });
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
        crate::code_package::cut("research lock released");
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
        Value::String(text) => privacy.text(text) == text.lines().collect::<Vec<_>>().join("\n"),
        Value::Object(fields) => fields.values().all(|value| public(value, privacy)),
        Value::Array(values) => values.iter().all(|value| public(value, privacy)),
        _ => true,
    }
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
        || given.is_some_and(|args| !input::args_match(&run["inputs"], args))
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
    let privacy = Privacy::new(&cfg, &pin["privacy"], repo, tmp)?;
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
        "Check constraints for this request and the known decisions.\n\nRequest\n{}\n\nQuestions\n{}\n\nDecisions\n{}",
        staged["request"].as_str().unwrap_or(""), staged["questions"], staged["prior"]
    ));
    let check = [("constraints".into(), constraints_text)];
    let mut constraints = Value::Null;
    if let Some((step, reason)) = research.wave(0, CONSTRAINTS, &check, |_, answer, _| {
        constraints = answer;
        Ok(())
    }) {
        return research.stopped(step, reason);
    }
    let Some(rows) = constraints["constraints"]
        .as_array()
        .filter(|rows| rows.len() <= 20)
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
        let text = row["text"]
            .as_str()
            .filter(|text| !text.trim().is_empty() && text.chars().count() <= 300);
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
            "confirmed" | "contradicts" | "unconfirmed" => limits.push(research.privacy.text(text)),
            _ => return research.stopped("constraints", "Unknown constraint status."),
        }
    }
    let mut attachments: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for file in staged["attachments"].as_array().into_iter().flatten() {
        let alias = file["name"].as_str().expect("safe attachment name");
        if research.privacy.text(alias) != alias {
            return research.stopped("prompts", "An attachment alias is now private.");
        }
        let text = research.privacy.text(file["text"].as_str().unwrap_or(""));
        attachments.insert(alias.into(), text.lines().map(String::from).collect());
    }
    let mut lines = Vec::new();
    let mut facts = Vec::new();
    let mut mechanical = Vec::new();
    let questions = staged["questions"].as_array().expect("staged questions");
    let round = run["round"].as_u64().expect("round");
    let limit = pin["maxLines"].as_u64().unwrap_or(30) as usize;
    let mut calls = Vec::new();
    let mut titles = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let step = format!("ask q{}", index + 1);
        let title = research
            .privacy
            .text(question["title"].as_str().unwrap_or(""));
        if title.chars().count() > 80 || title.contains('\n') {
            return research.stopped("prompts", "The renewed question title is too long.");
        }
        let question_text = research
            .privacy
            .text(question["text"].as_str().unwrap_or(""));
        let request = research
            .privacy
            .text(staged["request"].as_str().unwrap_or(""));
        let decisions = research.privacy.text(&staged["prior"].to_string());
        let header = format!(
            "Question\n{title}\n{question_text}\n\nRequest\n{request}\n\nDecisions\n{decisions}\n\n\
             Unconfirmed constraints\n{}\n\nUse at most {} combined items and assumptions. Cite attached line ranges.",
             limits.join("\n"),(limit/questions.len()).max(1)
        );
        let attached: Vec<_> = attachments
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
            .collect();
        let prompt = compose_prompt(&header, &attached)?;
        if prompt.len() + 1024 > LIMIT_PROMPT {
            return research.stopped(
                "prompts",
                "The question and attachments exceed the prompt size.",
            );
        }
        calls.push((step, prompt));
        titles.push(title);
    }
    for (wave_index, wave) in calls.chunks(2).enumerate() {
        let mut collected = BTreeMap::new();
        let mut line_count = lines.len();
        let stop = research.wave(1, EXPERT, wave, |offset, answer, privacy| {
            let index = wave_index * 2 + offset;
            let (mut proposals, mut cited, mut missing) = (Vec::new(), Vec::new(), Vec::new());
            collect_answer(
                &mut proposals,
                &mut cited,
                &mut missing,
                &answer,
                index + 1,
                &titles[index],
                prior,
                &attachments,
                privacy,
            )
            .map_err(|err| ("collect", err.0))?;
            line_count += proposals.len();
            if line_count > limit {
                return Err((
                    "collect",
                    "The proposals and assumptions exceed the round line budget.".into(),
                ));
            }
            collected.insert(offset, (proposals, cited, missing));
            Ok(())
        });
        if let Some((step, reason)) = stop {
            return research.stopped(step, reason);
        }
        for (proposals, cited, missing) in collected.into_values() {
            for mut proposal in proposals {
                let n = lines.len() + 1;
                proposal["n"] = json!(n);
                proposal["id"] = json!(format!("{round}.{n}"));
                lines.push(proposal);
            }
            facts.extend(cited);
            mechanical.extend(missing);
        }
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
                    fact_batch_len(remaining, capacity)
                };
                if count == 0 {
                    reports.push(oversize_fact(&facts[cursor]));
                    cursor += 1;
                    continue;
                }
                research.journal.append(json!({"kind":"fact batch","step":step,"attempt":attempt,"start":cursor,"count":count}))?;
                &remaining[..count]
            };
            calls.push((
                step,
                serde_json::to_string_pretty(batch).expect("facts JSON"),
            ));
            batches.push(batch);
            cursor += batch.len();
            number += 1;
        }
        let failure = research.wave(2, FACTS, &calls, |offset, answer, _| {
            collect_verdicts(batches[offset], &answer, &mut reports, &mut extra_ids)
        });
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

fn collect_verdicts(
    batch: &[Value],
    answer: &Value,
    reports: &mut Vec<Value>,
    extra_ids: &mut Vec<String>,
) -> std::result::Result<(), (&'static str, String)> {
    let mut unresolved = false;
    let mut contradicted = false;
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

fn collect_answer(
    lines: &mut Vec<Value>,
    facts: &mut Vec<Value>,
    mechanical: &mut Vec<Value>,
    answer: &Value,
    q: usize,
    title: &str,
    prior: &[Value],
    attachments: &BTreeMap<String, Vec<String>>,
    privacy: &Privacy,
) -> Result<()> {
    for (key, kind) in [("items", "proposal"), ("assumptions", "assumption")] {
        let records = answer[key]
            .as_array()
            .ok_or_else(|| GatewayError(format!("Question {q} has no {key} array.")))?;
        if key == "items" && records.is_empty() {
            return fail(format!("Question {q} has no proposals."));
        }
        for record in records {
            let text = record["text"]
                .as_str()
                .filter(|text| !text.trim().is_empty() && text.chars().count() <= 600)
                .ok_or_else(|| GatewayError(format!("Question {q} has an invalid {key} line.")))?;
            let group = record["group"]
                .as_str()
                .filter(|group| !group.trim().is_empty())
                .unwrap_or(title);
            if group.chars().count() > 80 {
                return fail("The proposal group is too long.");
            }
            let mut row = json!({"kind":kind,"group":group,"text":privacy.text(text)});
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
                row["why"] = json!(privacy.text(record["why"].as_str().unwrap_or("")));
            }
            lines.push(row);
        }
    }
    let rows = answer["facts"]
        .as_array()
        .filter(|rows| rows.len() <= 12)
        .ok_or_else(|| GatewayError(format!("Question {q} needs at most twelve facts.")))?;
    for (i, row) in rows.iter().enumerate() {
        let claim = row["claim"]
            .as_str()
            .filter(|text| !text.trim().is_empty() && text.chars().count() <= 600)
            .ok_or_else(|| GatewayError("A fact needs bounded claim text.".into()))?;
        let source = row["source"]
            .as_str()
            .ok_or_else(|| GatewayError("A fact needs a citation.".into()))?;
        let Some((name, excerpt)) = cite(source, attachments) else {
            mechanical.push(json!({"claim":privacy.text(claim), "source":privacy.text(source),
                "reason":"The cited attachment or line range does not exist or exceeds the permitted range."}));
            continue;
        };
        let id = format!("F{q}.{}", i + 1);
        let source = format!("{name}:{}", source.rsplit_once(':').unwrap().1);
        if privacy.text(&id) != id || privacy.text(&source) != source {
            return fail("A citation contains private structural text.");
        }
        facts.push(json!({"id":id,"claim":privacy.text(claim),"source":source,"excerpt":excerpt}));
    }
    Ok(())
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
    if first > last || last > lines.len() || last - first >= 40 {
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
pub(crate) fn reply_text(journal: &Journal, cfg: &Config, run: &Value, file: &Path) -> Result<String> {
    if !journal.last_event().is_some_and(|event| event["step"] == OWNER) {
        return fail("The research round must be waiting for owner decisions.");
    }
    let repo = material::path(&run["repo"], "research checkout")?;
    let tmp = material::path(&run["tmp"], "research folder")?;
    let pin = &run["inputs"]["pin"];
    if run["inputs"]["pinSha256"] != sha256_hex(pin.to_string()) {
        return fail("The pinned research input does not match its digest.");
    }
    let privacy = Privacy::new(cfg, &pin["privacy"], &repo, &tmp)?;
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
        crate::code_package::cut("research decisions");
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
    fn fact_batch_counts_serialized_bytes_and_caps_the_number_of_rows() {
        let facts = vec![json!({"id":"F1.1","excerpt":"quoted \"row\"\n第二行"}); 16];
        let two_rows = serde_json::to_vec_pretty(&facts[..2]).unwrap().len();
        assert_eq!(fact_batch_len(&facts, two_rows), 2);
        assert_eq!(fact_batch_len(&facts, two_rows - 1), 1);
        assert_eq!(fact_batch_len(&facts, 1), 0);
        assert_eq!(fact_batch_len(&facts, LIMIT_PROMPT), 15);
    }

    #[test]
    fn extra_ids_do_not_block_a_complete_batch() {
        let expected = [json!({"id":"F1.1"})];
        let answer = json!({"verdicts":[
            {"id":"F1.2","verdict":"contradicted","note":"outside the batch"},
            {"id":"F1.1","verdict":"supported","note":"the quoted line"}
        ]});
        let mut reports = Vec::new();
        let mut extras = Vec::new();
        collect_verdicts(&expected, &answer, &mut reports, &mut extras).unwrap();
        assert_eq!(reports, [answer["verdicts"][1].clone()]);
        assert_eq!(extras, ["F1.2"]);
    }

    #[test]
    fn partial_checker_answer_retains_the_contradiction_and_marks_only_unresolved_ids() {
        let expected: Vec<_> = (1..=4).map(|n| json!({"id":format!("F1.{n}")})).collect();
        let answer = json!({"verdicts":[
            {"id":"F1.4","verdict":"contradicted","note":"line four disagrees"},
            {"id":"F1.1","verdict":"supported","note":"line one agrees"},
            {"id":"F1.2","verdict":"supported","note":"first response"},
            {"id":"F1.2","verdict":"not found","note":"second response"}
        ]});
        let mut reports = Vec::new();
        let mut extras = Vec::new();
        let (step, _) = collect_verdicts(&expected, &answer, &mut reports, &mut extras).unwrap_err();
        assert_eq!(step, "facts contradicted");
        assert_eq!(reports.len(), 4);
        assert_eq!(reports[0], answer["verdicts"][1]);
        assert_eq!(reports[1]["verdict"], "unchecked");
        assert_eq!(reports[2]["verdict"], "unchecked");
        assert_eq!(reports[3], answer["verdicts"][0]);
    }

    #[test]
    fn fresh_request_scrubs_owner_context_and_drain_preserves_the_failed_key() {
        let dir = std::env::temp_dir().join(crate::journal::new_run_id());
        let repo = dir.join("repo");
        let tmp = repo.join("research-notes");
        let mut cfg = Config::tenant(&dir, "fixture").unwrap();
        cfg.home = dir.join("home");
        cfg.roles_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../roles");
        let mut journal = Journal::create(&cfg.home, "wave", &json!({"runId":"wave"})).unwrap();
        let word = "opening-only-word";
        let snapshot = json!({"salt":"fixture","entries":[{"len":word.len(), "hash":sha256_hex(format!("fixture:{word}"))}]});
        let privacy = Privacy::new(&cfg, &snapshot, &repo, &tmp).unwrap();
        journal
            .write_value(
                "remarks/owner.json",
                &json!({"text":format!("Use oak.\n{word}\n<repo>/research-notes")}),
            )
            .unwrap();
        let pick =
            Pick::from_json(&json!({"provider":"codex", "model":"fixture", "effort":"medium"}));
        let schema = serde_json::from_str(EXPERT).unwrap();
        let call = || gateway::Call {
            id: "wave",
            step: "ask q2",
            round: 1,
            role: "research-expert",
            pick: &pick,
            schema: &schema,
            prompt: "Step: ask q2".into(),
            writer_workspace: None,
        };
        // Stop after the gateway saves the request. This fixture has no submission directory.
        cfg.jobs_dir = None;
        assert!(gateway::local_step(
            &mut journal,
            &cfg,
            call(),
            gateway::LocalMode::Schedule,
            &|text| privacy.text(text),
            |_| Ok(())
        )
        .is_err());
        let intent = journal.last("intent", "ask q2", 1).unwrap();
        let stored = journal
            .read_value(intent["request"].as_str().unwrap())
            .unwrap();
        let prompt = stored["prompt"].as_str().unwrap();
        assert!(prompt.contains("Use oak.") && prompt.contains("<research>"));
        assert!(!prompt.contains(word) && !prompt.contains("research-notes"));
        let key = intent["key"].as_str().unwrap().to_owned();
        cfg.jobs_dir = Some(dir.join("jobs"));
        let job_dir = job::job_dir(&cfg, &key).unwrap();
        fs::create_dir_all(&job_dir).unwrap();
        write_json_atomic(
            &job_dir.join("final.json"),
            &json!({"key":key,"status":"failed","turnRequestedAt":null,"turnStartedAt":null}),
        )
        .unwrap();
        let drained = gateway::local_step(
            &mut journal,
            &cfg,
            call(),
            gateway::LocalMode::Drain(&key),
            &|text| privacy.text(text),
            |_| Ok(()),
        );
        assert!(matches!(drained, Ok(gateway::Step::Retryable(failed)) if failed == key));
        let denied = gateway::local_step(
            &mut journal,
            &cfg,
            call(),
            gateway::LocalMode::Retry(&key),
            &|text| text.replace("Use oak.", "[private text removed]"),
            |_| Ok(()),
        );
        assert!(matches!(denied, Err(gateway::CallError::Stop { at, .. }) if at == "privacy at ask q2"));
        assert_eq!(journal.all("intent", "ask q2", 1).len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepted_reply_applies_even_when_private_lines_expand() {
        let dir = std::env::temp_dir().join(crate::journal::new_run_id());
        let tmp = dir.as_path();
        let mut cfg = Config::tenant(tmp, "fixture").unwrap();
        cfg.home = tmp.join("home");
        let pin = json!({"privacy":{"salt":"test","entries":[]},"ledgerSha256":sha256_hex([])});
        let run = json!({"runId":"owner","round":1,"repo":tmp,"tmp":tmp,
            "inputs":{"pin":pin,"pinSha256":sha256_hex(pin.to_string())}});
        let list = json!({"round":1,"lines":[{"id":"1.1","n":1,"text":"Shelf"}]});
        let mut journal = Journal::create(&cfg.home, "owner", &run).unwrap();
        journal
            .append(json!({"kind":"waiting","step":OWNER,"decisions":list["lines"]}))
            .unwrap();
        let file = tmp.join("reply.json");
        let correction = "sk-x\n".repeat(40) + "Keep the public line.";
        write_json_atomic(&file, &json!([{"n":1,"verdict":"fix","text":correction}])).unwrap();
        let reply = reply_text(&journal, &cfg, &run, &file).unwrap();
        let expected = "[private text removed]\n".repeat(40) + "Keep the public line.";
        assert_eq!(lists::parse_reply(&reply).unwrap()[0]["text"], expected);
        journal
            .append(json!({"kind":"rerun","step":OWNER,"ownerAnswer":reply}))
            .unwrap();
        let privacy = Privacy::new(&cfg, &pin["privacy"], tmp, tmp).unwrap();
        let mut research = Research {
            journal: &mut journal,
            cfg: &cfg,
            run: &run,
            privacy,
            lock: tmp.join("lock"),
        };
        assert_eq!(decide(&mut research, tmp, &pin, &list).unwrap().code, 0);
        let (ledger, _) = lists::ledger(&tmp.join("decisions.json")).unwrap();
        assert_eq!(ledger["entries"][0]["text"], expected);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn structured_reply_keeps_long_fixes_and_applies_deferred_targets() {
        let dir = std::env::temp_dir().join(crate::journal::new_run_id());
        let mut cfg = Config::tenant(&dir, "fixture").unwrap();
        cfg.home = dir.join("home");
        let pin = json!({"privacy":{"salt":"fixture","entries":[]}});
        let run = json!({"workflow":NAME, "runId":"owner", "round":2, "repo":dir, "tmp":dir,
            "inputs":{"pin":pin,"pinSha256":sha256_hex(pin.to_string())}});
        let mut journal = Journal::create(&cfg.home, "owner", &run).unwrap();
        let ledger = json!({"version":1, "appliedRounds":[1], "entries":[
            {"id":"1.1","state":"accepted","text":"Original shelf","decidedInRound":1}
        ]});
        write_json_atomic(&dir.join("decisions.json"), &ledger).unwrap();
        let mut lines: Vec<_> = (1..=5)
            .map(|n| json!({"n":n, "id":format!("2.{n}"), "text":"New shelf"}))
            .collect();
        lines[4]["replaces"] = json!([{"id":"1.1","text":"Original shelf"}]);
        journal
            .append(json!({"kind":"waiting","step":OWNER,"decisions":lines}))
            .unwrap();
        let actions: Vec<_> = (1..=4)
            .map(|n| json!({"n":n,"verdict":"fix","text":"x".repeat(600)}))
            .collect();
        let file = dir.join("reply.json");
        write_json_atomic(&file, &json!(actions)).unwrap();
        let answer = reply_text(&journal, &cfg, &run, &file).unwrap();
        let actions = lists::parse_reply(&answer).unwrap();
        let ledger = lists::apply(ledger, &actions, 2, &lines).unwrap();
        for entry in &ledger["entries"].as_array().unwrap()[1..5] {
            assert_eq!(entry["text"], "x".repeat(600));
        }
        assert_eq!(ledger["entries"][5]["state"], "open");
        let ledger = lists::apply(
            ledger,
            &[json!({"id":"2.5","verdict":"accept"})],
            3,
            &[],
        )
        .unwrap();
        assert_eq!(ledger["entries"][0]["supersededBy"], "2.5");
        assert_eq!(ledger["entries"][5]["state"], "accepted");
        fs::remove_dir_all(dir).unwrap();
    }
}
