//! The design-brief effects: pinned sources, validated model output and publication of the approved Markdown.

use crate::{
    boundary::Launch, catalog::ProjectGate,
    review_contract, design_material, executor, gateway,
    journal::{self, Journal},
    models::{self, Pick},
    Exit,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use zodchi_core::{
    config::Config,
    job::{self, compose_prompt},
    role::{load_role, Overrides},
    util::{fail, iso, sha256_hex, GatewayError, Result},
};

pub const NAME: &str = "design-brief";
const VERSION: &str = "2";
const VERSION_ONE_DIGEST: &str = "a65a6ed024f68fe54d475a3879dd3de0a4d741de444ed1af1506dd7235347547";
const PLAN: &str = include_str!("../flows/design-brief/v1/plan.json");
const FACTS: &str = include_str!("../flows/design-brief/v1/facts.json");
const DRAFT: &str = include_str!("../flows/design-brief/v1/draft.json");
const REQUIRED_HEADINGS: [&str; 2] = ["## Review boundary", "## Checks"];
const ROLES: [&str; 2] = ["flow-brief", "architecture-review"];

pub fn start(raw: &Value, launch: Option<Launch>, require_workflow: ProjectGate) -> Result<Exit> {
    match prepare(raw, require_workflow) {
        Ok((id, journal)) => {
            if let Some(launch) = launch {
                launch(&journal, &id)
            } else {
                resume(&id, None, None)
            }
        }
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({ "workflow": NAME, "approved": false, "refused": error.0 }),
        }),
    }
}

fn prepare(raw: &Value, require_workflow: ProjectGate) -> Result<(String, Journal)> {
    let fields = raw
        .as_object()
        .ok_or_else(|| GatewayError("design-brief needs a JSON object.".into()))?;
    if let Some(key) = fields.keys().find(|key| {
        ![
            "label",
            "goal",
            "repos",
            "out",
            "tmp",
            "questions",
            "context",
            "template",
            "publicRepo",
            "allowPrivateWords",
            "gatewayRepo",
            "models",
        ]
        .contains(&key.as_str())
    }) {
        return fail(format!("Unknown design-brief argument {key}."));
    }
    let label = raw["label"]
        .as_str()
        .filter(|label| zodchi_core::util::is_key(label) && label.len() <= 64)
        .ok_or_else(|| GatewayError("design-brief needs a short args.label.".into()))?;
    if raw
        .get("publicRepo")
        .is_some_and(|value| !value.is_boolean())
    {
        return fail("args.publicRepo is true or false.");
    }
    let out = design_material::absolute(&raw["out"], "args.out")?;
    let prior = output(&out)?;
    let mark = format!("<!-- design-brief: {label} -->");
    if prior
        .as_ref()
        .is_some_and(|text| text.lines().next() != Some(mark.as_str()))
    {
        return fail("The requested output already belongs to another file.");
    }
    let material = design_material::capture(raw, &Config::new(None)?)?;
    let selected = &material["sources"][0];
    let target = design_material::absolute(&selected["root"], "target repository")?;
    require_workflow(
        &crate::git::Git::new(&target),
        selected["head"].as_str().expect("captured source commit"),
        NAME,
    )?;
    let root = design_material::absolute(
        raw.get("gatewayRepo")
            .unwrap_or(&material["sources"][0]["root"]),
        "gatewayRepo",
    )?;
    let git = crate::git::Git::new(&root);
    if fs::canonicalize(git.run(&["rev-parse", "--show-toplevel"])?.trim())?
        != fs::canonicalize(&root)?
    {
        return fail("The gateway repository must be the root of a Git checkout.");
    }
    let cfg = Config::context(&root)?;
    let overrides = match raw.get("models") {
        None => Map::new(),
        Some(Value::Object(roles)) => roles.clone(),
        Some(_) => return fail("args.models is an object of role settings."),
    };
    let table = models::table(&cfg, &root, &overrides).map_err(GatewayError)?;
    let server = executor::flow_server(&cfg);
    let codex = if let Some(url) = server {
        executor::server::Server::new(cfg.clone(), url)
            .preflight(&ROLES)
            .map_err(|error| error.0)
    } else {
        for name in ROLES {
            load_role(&cfg, name, &Overrides::default())?;
        }
        models::codex_usable(&job::account(&cfg))
    };
    let mut claude = models::ClaudeGate::of(&table);
    let mut pair = Map::new();
    let mut skipped = Vec::new();
    for role in ["writer", "researcher", "architect"] {
        let candidate_role = if role == "architect" && !overrides.contains_key("architect") {
            "reviewer"
        } else {
            role
        };
        let candidates = models::candidates(&table, candidate_role).map_err(GatewayError)?;
        let pick = candidates
            .into_iter()
            .find_map(|mut pick| {
                let same_as_writer = role == "architect" && pair.get("writer").is_some_and(|writer: &Value| {
                    writer["provider"] == pick.provider && writer["model"] == pick.model
                });
                let available = if same_as_writer {
                    Err("the same model as the writer".into())
                } else {
                    match pick.provider.as_str() {
                        "codex" if !pick.model.is_empty() => codex.clone().map(|_| String::new()),
                        "claude" => claude.usable(&pick),
                        _ => Err("needs a Codex or Claude candidate with a model".into()),
                    }
                };
                match available {
                    Ok(account) => {
                        pick.account = account;
                        Some(pick)
                    }
                    Err(reason) => {
                        skipped.push(format!("{role} {}/{}: {reason}", pick.provider, pick.model));
                        None
                    }
                }
            })
            .ok_or_else(|| {
                GatewayError(format!(
                    "No available {role} for design-brief. {}",
                    skipped.join("; ")
                ))
            })?;
        pair.insert(role.into(), pick.to_json());
    }
    pair.insert("skipped".into(), json!(skipped));
    let material = serde_json::to_string(&material).expect("serializable design inputs");
    let id = journal::new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"), "createdAt": iso(),
        "repo": root, "jobScope": "context", "label": label, "out": out, "marker": mark, "previousOutput": prior.as_deref().map(sha256_hex),
        "pair": pair, "inputs": { "args": raw, "materialSha256": sha256_hex(&material) },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    journal.write_text("material.json", &material)?;
    Ok((id, journal))
}

pub fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    let version = run["version"].as_str().unwrap_or("");
    if run["workflow"] != NAME
        || !matches!(version, "1" | VERSION)
        || given.is_some_and(|value| value != &run["inputs"]["args"])
    {
        return fail(format!(
            "Run {id} does not match this design-brief command."
        ));
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        if rerun.is_some() {
            return fail("This brief has finished.");
        }
        return finish(&mut journal, result);
    }
    if let Some(step) = rerun {
        if !journal
            .last_event()
            .is_some_and(|event| event["kind"] == "stop" && event["step"] == step)
        {
            return fail("Retry must name the stopped step.");
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }
    if version == "1" {
        journal.verify_legacy_workflow(&run, VERSION_ONE_DIGEST)?;
    }
    let material = journal.read_verified("material.json", &run["inputs"]["materialSha256"])?;
    let material: Value = serde_json::from_str(&material)
        .map_err(|e| GatewayError(format!("Cannot read pinned design inputs: {e}")))?;
    let repo = design_material::absolute(&run["repo"], "recorded gateway repository")?;
    let cfg = if run["jobScope"] == "context" {
        Config::context(&repo)?
    } else {
        // Earlier brief journals still address the jobs they submitted in the checkout.
        Config::new(Some(&repo))?
    };
    let mut steps = journal.completed_steps();
    let owner = OwnerDecisions::from_journal(&journal);
    for name in ["draft", "fix"] {
        if let Some(draft) = steps.get_mut(name) {
            owner.reconcile(name, draft);
        }
    }
    let context = json!({ "workflow": NAME, "runId": id, "journal": journal.dir, "label": run["label"], "models": run["pair"] });

    loop {
        let call = match next_step(&material, &steps)? {
            Next::Call(call) => call,
            Next::Wait(step) => {
                return wait_for_owner(&mut journal, &run, step, &steps[step], context)
            }
            Next::Finish(outcome) => {
                return save_result(&mut journal, &run, &steps, context, outcome)
            }
        };
        let step = call.name().to_string();
        match model_step(&mut journal, &cfg, &material, &run, &steps, &owner, call) {
            Ok(data) => {
                steps.insert(step, data);
            }
            Err(error) => {
                let (at, reason) = match error {
                    gateway::CallError::Stop { at, reason } => (at, reason),
                    gateway::CallError::Context { .. } => (
                        format!("context too large at {step}"),
                        "The pinned attachments exceed the gateway limit.".into(),
                    ),
                };
                if at == format!("source input at {step}") {
                    if !journal.last_event().is_some_and(|event| event["kind"] == "waiting" && event["step"] == step) {
                        journal.append(json!({ "kind": "waiting", "step": step, "question": reason }))?;
                    }
                    let mut result = context;
                    result["status"] = json!("waiting");
                    result["question"] = json!(reason);
                    return Ok(Exit { code: 2, result });
                }
                journal.append(
                    json!({ "kind": "stop", "step": step, "stoppedAt": at, "what": reason }),
                )?;
                let mut result = context;
                result["approved"] = json!(false);
                result["stoppedAt"] = json!(at);
                result["infra"] = json!(reason);
                return Ok(Exit { code: 2, result });
            }
        }
    }
}

enum ModelStep<'a> {
    Plan,
    Facts { name: String, question: &'a Value },
    Draft,
    Fix,
    Review,
    ReviewFix,
}

impl ModelStep<'_> {
    fn name(&self) -> &str {
        match self {
            Self::Plan => "plan",
            Self::Facts { name, .. } => name,
            Self::Draft => "draft",
            Self::Fix => "fix",
            Self::Review => "review",
            Self::ReviewFix => "review fix",
        }
    }

    fn role(&self) -> &'static str {
        match self {
            Self::Plan | Self::Facts { .. } => "researcher",
            Self::Draft | Self::Fix => "writer",
            Self::Review | Self::ReviewFix => "architect",
        }
    }
}

struct Outcome {
    draft: &'static str,
    review: &'static str,
    approved: bool,
}

#[derive(Default)]
struct OwnerDecisions {
    answered: Vec<String>,
    pending: Vec<Value>,
    pending_step: Option<String>,
    closed: bool,
}

impl OwnerDecisions {
    fn from_journal(journal: &Journal) -> Self {
        let mut state = Self::default();
        let mut waiting = None;
        for event in journal.events() {
            if event["kind"] == "waiting" && event["decisions"].is_array() {
                waiting = Some(event);
            }
            let Some(reply) = event["ownerAnswer"].as_str() else { continue };
            let Some(wait) = waiting.take().filter(|wait| wait["step"] == event["step"]) else { continue };
            let decisions = wait["decisions"].as_array().expect("waiting decisions");
            state.closed |= event["noNewDecisions"] == true;
            state.pending.clear();
            state.pending_step = event["step"].as_str().map(String::from);
            if let Some(confirmed) = event["answeredDecisions"].as_array() {
                state.answered.extend(confirmed.iter().filter_map(Value::as_str).map(String::from));
                state.pending = decisions.iter().filter(|decision| !state.is_answered(decision)).cloned().collect();
            } else if let [decision] = decisions.as_slice() {
                let matches = decision["options"].as_array().is_some_and(|options|
                    options.iter().any(|option| option.as_str() == Some(reply.trim())));
                if matches {
                    if let Some(question) = decision["question"].as_str() {
                        state.answered.push(question.to_string());
                    }
                }
            }
        }
        state
    }

    fn is_answered(&self, decision: &Value) -> bool {
        let key = decision_key(decision["question"].as_str().unwrap_or(""));
        self.answered.iter().any(|question| decision_key(question) == key)
    }

    fn pending_for(&self, step: &str) -> &[Value] {
        if self.pending_step.as_deref() == Some(step) { &self.pending } else { &[] }
    }

    fn reconcile(&self, step: &str, draft: &mut Value) {
        let pending = self.pending_for(step);
        if draft["ownerDecisionsReconciled"] == true ||
            (self.answered.is_empty() && pending.is_empty() && !self.closed) {
            return;
        }
        let Some(decisions) = draft["ownerDecisions"].as_array_mut() else { return };
        decisions.retain(|decision| !self.is_answered(decision));
        for pending in pending {
            let key = decision_key(pending["question"].as_str().unwrap_or(""));
            if !decisions.iter().any(|decision| decision_key(decision["question"].as_str().unwrap_or("")) == key) {
                decisions.push(pending.clone());
            }
        }
        if self.closed && !decisions.is_empty() {
            let assumptions = decisions.drain(..).map(|decision| {
                let question = decision["question"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
                if let Some(default) = decision["default"].as_str() {
                    let proposed = default.split_whitespace().collect::<Vec<_>>().join(" ");
                    format!("- {question} Provisional assumption is {proposed}.")
                } else {
                    format!("- {question} The choice remains open.")
                }
            }).collect::<Vec<_>>().join("\n");
            draft["markdown"] = json!(format!("{}\n\n## Assumptions\n\n{assumptions}", draft_markdown(draft)));
        }
        draft["ownerDecisionsReconciled"] = json!(true);
    }
}

fn decision_key(question: &str) -> String {
    let folded = question.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let end = [" (ответ владельца", " — ответ владельца", " - ответ владельца", " (owner's answer", " — owner answer"]
        .into_iter().filter_map(|suffix| folded.find(suffix)).min().unwrap_or(folded.len());
    folded[..end].trim_end_matches([' ', '?', '.', ':']).to_string()
}

enum Next<'a> {
    Call(ModelStep<'a>),
    Wait(&'static str),
    Finish(Outcome),
}

fn next_step<'a>(material: &'a Value, steps: &'a Map<String, Value>) -> Result<Next<'a>> {
    let questions = if material["needsPlan"] == true {
        let Some(plan) = steps.get("plan") else {
            return Ok(Next::Call(ModelStep::Plan));
        };
        &plan["questions"]
    } else {
        &material["questions"]
    };
    let questions = questions
        .as_array()
        .ok_or_else(|| GatewayError("The journal has no research question list.".into()))?;
    for (index, question) in questions.iter().enumerate() {
        let name = format!("facts {}", index + 1);
        if !steps.contains_key(&name) {
            return Ok(Next::Call(ModelStep::Facts { name, question }));
        }
    }
    for (draft_name, review_name, write, review) in [
        ("draft", "review", ModelStep::Draft, ModelStep::Review),
        ("fix", "review fix", ModelStep::Fix, ModelStep::ReviewFix),
    ] {
        let Some(draft) = steps.get(draft_name) else {
            return Ok(Next::Call(write));
        };
        if draft["ownerDecisions"]
            .as_array()
            .is_some_and(|decisions| !decisions.is_empty())
        {
            return Ok(Next::Wait(draft_name));
        }
        let Some(verdict) = steps.get(review_name) else {
            return Ok(Next::Call(review));
        };
        let approved = verdict["verdict"] == "approved"
            && review_contract::blocking_findings(verdict).next().is_none();
        if approved || verdict["verdict"] == "blocked" || draft_name == "fix" {
            return Ok(Next::Finish(Outcome {
                draft: draft_name,
                review: review_name,
                approved,
            }));
        }
    }
    unreachable!("the final review produces an outcome")
}

fn wait_for_owner(
    journal: &mut Journal,
    run: &Value,
    step: &str,
    draft: &Value,
    mut result: Value,
) -> Result<Exit> {
    let markdown = brief(run, draft);
    let path = journal.write_text(&format!("{step}.md"), &markdown)?;
    let questions = &draft["ownerDecisions"];
    let prompt = questions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["question"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if !journal
        .last_event()
        .is_some_and(|event| event["kind"] == "waiting" && event["step"] == step && event["decisions"] == *questions)
    {
        journal.append(
            json!({ "kind": "waiting", "step": step, "attempt": journal.attempt(step),
            "question": prompt, "decisions": questions, "draft": path }),
        )?;
    }
    result["status"] = json!("waiting");
    result["question"] = json!(prompt);
    result["ownerDecisions"] = questions.clone();
    result["draft"] = json!(path);
    Ok(Exit { code: 2, result })
}

fn model_step(
    journal: &mut Journal,
    cfg: &Config,
    material: &Value,
    run: &Value,
    steps: &Map<String, Value>,
    owner: &OwnerDecisions,
    call: ModelStep<'_>,
) -> std::result::Result<Value, gateway::CallError> {
    let step = call.name();
    let role = call.role();
    let id = run["runId"].as_str().unwrap_or("");
    let pick = Pick::from_json(&run["pair"][role]);
    let stop = |error: GatewayError| gateway::CallError::Stop {
        at: format!("infrastructure at {step}"),
        reason: error.0,
    };
    if pick.model.is_empty() {
        return Err(stop(GatewayError(
            "The workflow did not select a configured role.".into(),
        )));
    }
    let version = run["version"].as_str().unwrap_or(VERSION);
    let mut preamble = format!("Step: {step} ({NAME} v{version}, run {id})\n\n");
    let mut attachments = Vec::new();
    let mut sources = BTreeMap::new();
    let material_sources = material["sources"].as_array().expect("pinned Git sources");
    let places = design_material::places(cfg, material_sources);
    let scrubber = design_material::scrubber(cfg, material).map_err(stop)?;
    let clean =
        |text: &str| design_material::clean(&scrubber, text, &places, material["public"] == true);
    let mut schema = DRAFT;
    let mut gateway_role = ROLES[0];
    match &call {
        ModelStep::Plan => {
            schema = PLAN;
            preamble.push_str("Choose available aliases for each supplied question, keeping its text and order, or propose three to five research questions if the list is empty. Use context-N.md for attached extracts when they provide the relevant evidence. Large files are off the list. Return an empty files array for a question that needs an owner extract.");
            attachments.push((
                "questions.json".into(),
                material["questions"].to_string().into_bytes(),
            ));
            let inventory = material["inventory"]
                .as_array()
                .expect("pinned file inventory");
            let mut shown = String::new();
            for alias in material["extracts"].as_object().into_iter().flatten().map(|(alias, _)| alias) {
                shown.push_str(alias);
                shown.push('\n');
            }
            for file in inventory.iter().filter_map(Value::as_str) {
                if shown.len() + file.len() > 96 * 1024 {
                    break;
                }
                shown.push_str(file);
                shown.push('\n');
            }
            attachments.push(("available-files.txt".into(), shown.into_bytes()));
        }
        ModelStep::Facts { question, .. } => {
            schema = FACTS;
            preamble.push_str("Answer the attached question from the supplied files. For each fact give the file alias, the displayed line number and a verbatim excerpt from that one visible line. Leave the displayed number out of the quote and preserve characters including backticks. Report withheld lines in unknowns.");
            attachments.push(("question.json".into(), question.to_string().into_bytes()));
            let (files, omitted) = recorded_sources(journal, cfg, material, step, question).map_err(stop)?;
            if files.is_empty() {
                let details = if omitted.is_empty() { String::new() } else { format!(" {}", omitted.join(" ")) };
                return Err(gateway::CallError::Stop { at: format!("source input at {step}"),
                    reason: format!("{} Supply a short source extract with flow reply --file, then resume.{details}", question["question"].as_str().unwrap_or("No readable source was found.")) });
            }
            if !omitted.is_empty() {
                attachments.push(("unavailable-sources.txt".into(), omitted.join("\n").into_bytes()));
            }
            preamble.push_str(" A context or owner-source alias cites the supplied extract rather than the complete Git file.");
            sources = files;
            for (file, text) in &sources {
                let numbered = text
                    .lines()
                    .enumerate()
                    .map(|(index, line)| format!("{} {line}", index + 1))
                    .collect::<Vec<_>>()
                    .join("\n");
                attachments.push((file.clone(), numbered.into_bytes()));
            }
        }
        ModelStep::Draft | ModelStep::Fix => {
            preamble.push_str(&format!(
                "Draft one implementable code package. Start the `markdown` field with a `# <title>` line. Use the exact English standalone headings `{}` and `{}` even when the brief is written in another language. Return the Markdown body. Flow supplies the file marker. Include the goal, repo files, concrete steps, and limits. Describe checks that measure behavior. Cite the verified facts and note evidence gaps. Put settled owner decisions in the brief. Only include unresolved questions in ownerDecisions, and return an empty array when none remain. For each open choice give at least two options and copy one option verbatim into default, without an explanation. Refer to people by role.",
                REQUIRED_HEADINGS[0], REQUIRED_HEADINGS[1],
            ));
            if owner.closed {
                preamble.push_str(" The owner closed the decision round. Record any open point as an assumption in the brief and return an empty ownerDecisions array.");
            }
            let pending = owner.pending_for(step);
            if !owner.answered.is_empty() || !pending.is_empty() {
                let decisions = json!({ "answered": owner.answered, "pending": pending });
                attachments.push(("owner-decisions.json".into(), decisions.to_string().into_bytes()));
            }
            if matches!(call, ModelStep::Fix) {
                attachments.push(("draft.md".into(), draft_markdown(&steps["draft"]).into_bytes()));
                let feedback = cleaned_values(&steps["review"], &clean);
                attachments.push(("review.json".into(), feedback.to_string().into_bytes()));
            }
        }
        ModelStep::Review | ModelStep::ReviewFix => {
            schema = review_contract::REVIEW_SCHEMA;
            gateway_role = ROLES[1];
            preamble.push_str("Independently review this brief against the goal and pinned evidence. Flag unsupported facts, ambiguous outcomes, broad scope, and checks that miss the intended behavior.");
            let name = if matches!(call, ModelStep::ReviewFix) {
                "fix"
            } else {
                "draft"
            };
            attachments.push(("brief.md".into(), draft_markdown(&steps[name]).into_bytes()));
        }
    }
    if schema == DRAFT || schema == review_contract::REVIEW_SCHEMA {
        let findings: Vec<&Value> = steps
            .iter()
            .filter(|(name, _)| name.starts_with("facts "))
            .map(|(_, data)| data)
            .collect();
        attachments.push((
            "facts.json".into(),
            json!(findings).to_string().into_bytes(),
        ));
    }
    let using_extract = sources.keys().any(|name| material["extracts"].get(name).is_some());
    let base = if using_extract {
        material["researchContext"].as_str().or_else(|| material["context"].as_str())
    } else {
        material["context"].as_str()
    }.unwrap_or("");
    let prompt = compose_prompt(&format!("{preamble}\n\n{base}"), &attachments).map_err(stop)?;
    let schema_json = serde_json::from_str(schema).expect("the shipped schema is JSON");
    gateway::ask_normalizing(
        journal,
        cfg,
        gateway::Call {
            id,
            step,
            round: 1,
            role: gateway_role,
            pick: &pick,
            schema: &schema_json,
            prompt,
            writer_workspace: None,
        },
        |answer| {
            match schema {
                PLAN => validate_plan(material, answer),
                FACTS => {
                    design_material::retain_verified_facts(answer, &sources)?;
                    screen_unknowns(answer, &clean);
                    Ok(())
                }
                DRAFT => {
                    normalize_draft(answer)?;
                    owner.reconcile(step, answer);
                    Ok(())
                }
                _ => review_contract::check_review(answer),
            }?;
            if schema != review_contract::REVIEW_SCHEMA && cleaned_values(answer, &clean) != *answer {
                return Err(
                    "The answer contains material that would change during screening.".into(),
                );
            }
            Ok(())
        },
    )
}

fn screen_unknowns(answer: &mut Value, clean: &impl Fn(&str) -> String) {
    let unknowns = answer["unknowns"].as_array_mut().expect("validated unknowns");
    let original = unknowns.len();
    unknowns.retain(|item| cleaned_values(item, clean) == *item);
    let withheld = original - unknowns.len();
    if withheld > 0 {
        unknowns.push(json!("Some unresolved points were withheld by screening."));
        answer["withheldUnknowns"] = json!(withheld);
    }
}

fn cleaned_values(value: &Value, clean: &impl Fn(&str) -> String) -> Value {
    match value {
        Value::String(text) => {
            let trim = text.trim_end_matches(['\r', '\n']);
            let screened = clean(trim);
            if screened == trim.replace("\r\n", "\n") {
                value.clone()
            } else {
                json!(screened)
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| cleaned_values(item, clean))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, value)| (name.clone(), cleaned_values(value, clean)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn recorded_sources(
    journal: &mut Journal,
    cfg: &Config,
    material: &Value,
    step: &str,
    question: &Value,
) -> Result<(BTreeMap<String, String>, Vec<String>)> {
    let attempt = journal.attempt(step);
    let name = format!("sources/{}-{attempt}.json", gateway::slug(step));
    if let Some(saved) = journal.last("sources", step, attempt) {
        let data = journal.read_verified(&name, &saved["digest"])?;
        let files = serde_json::from_str(&data).map_err(|error| GatewayError(format!("Invalid saved sources: {error}")))?;
        let omitted = saved["omitted"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        return Ok((files, omitted));
    }
    let (mut files, omitted) = design_material::question_sources(cfg, material, question)?;
    if let Some(answer) = journal.events().iter().rev().find(|event| event["kind"] == "rerun" && event["step"] == step)
        .and_then(|event| event["ownerAnswer"].as_str())
    {
        let scrubber = design_material::scrubber(cfg, material)?;
        let places = design_material::places(cfg, material["sources"].as_array().expect("pinned sources"));
        let answer = design_material::clean(&scrubber, answer, &places, material["public"] == true);
        if answer.lines().any(|line| !line.trim().is_empty() && crate::input_common::withheld_lines(line) == 0) {
            files.insert("owner-source.md".into(), answer);
        }
    }
    let data = serde_json::to_string(&files).expect("source map is JSON");
    journal.write_text(&name, &data)?;
    journal.append(
        json!({ "kind": "sources", "step": step, "attempt": attempt, "digest": sha256_hex(&data), "omitted": omitted }),
    )?;
    Ok((files, omitted))
}

fn validate_plan(material: &Value, answer: &Value) -> std::result::Result<(), String> {
    let given = material["questions"].as_array().expect("pinned questions");
    let inventory = material["inventory"].as_array().expect("pinned inventory");
    let Some(planned) = answer["questions"].as_array().filter(|list| {
        if given.is_empty() {
            (3..=5).contains(&list.len())
        } else {
            list.len() == given.len()
        }
    }) else {
        return Err("The plan returned a different number of questions.".into());
    };
    for (index, item) in planned.iter().enumerate() {
        let question = item["question"].as_str().unwrap_or("");
        let files = item["files"].as_array();
        if question.trim().is_empty()
            || files.is_none_or(|files| files.iter().any(|file| file.as_str().is_none_or(|alias| {
                !inventory.contains(file) && material["extracts"].get(alias).is_none() && material["oversized"].get(alias).is_none()
            })))
        {
            return Err(
                "The plan needs a question and available file aliases for every slot.".into(),
            );
        }
        if let Some(requested) = given.get(index) {
            if requested["question"] != question
                || requested["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|file| !files.expect("has files").contains(file))
            {
                return Err(
                    "The plan changed a supplied question or removed its required sources.".into(),
                );
            }
        }
    }
    Ok(())
}

fn normalize_draft(answer: &mut Value) -> std::result::Result<(), String> {
    let text = normalize_headings(answer["markdown"].as_str().unwrap_or("").trim());
    if !text
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("# "))
        || REQUIRED_HEADINGS.iter().any(|heading| {
            !text
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case(heading))
        })
    {
        return Err(format!(
            "The Markdown must start with a `# <title>` line and include the standalone headings `{}` and `{}`.",
            REQUIRED_HEADINGS[0], REQUIRED_HEADINGS[1],
        ));
    }
    answer["markdown"] = json!(text);
    let Some(decisions) = answer["ownerDecisions"].as_array_mut() else {
        return Err("The draft needs ownerDecisions.".into());
    };
    for item in decisions {
        let Some(options) = item["options"].as_array().filter(|options| options.len() >= 2 && options.iter().all(Value::is_string)) else {
            return Err("Each owner decision needs at least two options.".into());
        };
        if !item["question"].is_string() {
            return Err("Each owner decision needs a question.".into());
        }
        if !options.contains(&item["default"]) {
            // The owner still chooses from the supplied options. An ambiguous suggestion is not a choice.
            item["default"] = Value::Null;
        }
    }
    Ok(())
}

fn normalize_headings(text: &str) -> String {
    let mut fenced = false;
    text.lines().map(|line| {
        let heading = line.trim();
        if heading.starts_with("```") || heading.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced || !heading.starts_with("## ") {
            return line;
        }
        match heading.to_lowercase().as_str() {
            "## проверки" => REQUIRED_HEADINGS[1],
            "## граница ревью" | "## границы ревью" => REQUIRED_HEADINGS[0],
            _ => line,
        }
    }).collect::<Vec<_>>().join("\n")
}

fn draft_markdown(draft: &Value) -> String {
    draft["markdown"]
        .as_str()
        .unwrap_or("")
        .trim()
        .replace("\r\n", "\n")
}

fn brief(run: &Value, draft: &Value) -> String {
    format!(
        "{}\n{}\n",
        run["marker"].as_str().unwrap_or(""),
        draft_markdown(draft)
    )
}

fn output(path: &Path) -> Result<Option<String>> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return fail("The requested brief path crosses a link.");
        }
    }
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn save_result(
    journal: &mut Journal,
    run: &Value,
    steps: &Map<String, Value>,
    mut result: Value,
    decision: Outcome,
) -> Result<Exit> {
    let text = brief(run, &steps[decision.draft]);
    let digest = sha256_hex(&text);
    let candidate = journal.write_text("candidate.md", &text)?;
    result["review"] = steps[decision.review].clone();
    result["reviewedSha256"] = json!(digest);
    result["candidate"] = json!(candidate);
    result["facts"] = json!(steps
        .iter()
        .filter(|(name, _)| name.starts_with("facts "))
        .map(|(_, facts)| facts["facts"].as_array().map(Vec::len).unwrap_or(0))
        .sum::<usize>());
    result["rejectedFacts"] = json!(steps
        .iter()
        .filter(|(name, _)| name.starts_with("facts "))
        .map(|(_, facts)| facts["rejectedFacts"].as_array().map(Vec::len).unwrap_or(0))
        .sum::<usize>());
    result["approved"] = json!(decision.approved);
    result["verdict"] = json!(if decision.approved {
        "approved"
    } else {
        "changes_requested"
    });
    if decision.approved {
        let path = Path::new(run["out"].as_str().unwrap_or(""));
        let current = output(path)?.as_deref().map(sha256_hex);
        if current.as_deref() != Some(&digest) {
            if json!(current) != run["previousOutput"] {
                result["approved"] = json!(false);
                result["verdict"] = json!("blocked");
                result["stoppedAt"] = json!("publish brief: the existing output has changed");
            } else {
                journal.append(json!({ "kind": "publishing", "step": "publish brief", "attempt": 1, "digest": digest }))?;
                if let Err(error) = publish(path, &text, current.is_some()) {
                    let at = "infrastructure at publish brief";
                    journal.append(json!({ "kind": "stop", "step": "publish brief", "stoppedAt": at, "what": error.0 }))?;
                    result["approved"] = json!(false);
                    result["stoppedAt"] = json!(at);
                    result["infra"] = json!(error.0);
                    return Ok(Exit { code: 2, result });
                }
                crate::boundary::cut("publish design brief");
            }
        }
        if result["approved"] == true {
            result["path"] = json!(path);
        }
    }
    journal.write_value("result.json", &result)?;
    finish(journal, result)
}

pub(crate) fn publish(path: &Path, text: &str, replace: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| GatewayError("The brief has no parent directory.".into()))?;
    fs::create_dir_all(parent)?;
    let staged = parent.join(format!(".zodchi-brief-{:016x}.tmp", rand::random::<u64>()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staged)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if replace {
        fs::rename(&staged, path)?;
    } else {
        let written = fs::hard_link(&staged, path);
        let _ = fs::remove_file(&staged);
        written?;
    }
    Ok(())
}

fn finish(journal: &mut Journal, result: Value) -> Result<Exit> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({ "kind": "finished", "step": "result" }))?;
    }
    Ok(Exit {
        code: if result["approved"] == true { 0 } else { 2 },
        result,
    })
}
