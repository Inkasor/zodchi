//! Roles: what a call is (kind, mode, model, effort, frame, schema, tools). A role is a JSON file; its frame and
//! schema lie beside it. The checked role is a JSON object whose field order is part of the job's request hash, so
//! it is built in the same order as the reference gateway builds it.

use crate::config::Config;
use crate::util::{fail, is_role_name, GatewayError, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const KINDS: [&str; 3] = ["text", "image", "decisions"];
const QUESTION_TYPES: [&str; 3] = ["predicate", "choice", "score"];
const ROLE_FIELDS: [&str; 15] = [
    "description", "extends", "kind", "mode", "model", "effort", "frame", "schema", "questions", "timeoutMin",
    "sandbox", "mcpServers", "features", "config", "keepThread",
];
const WORK_FIELDS: [&str; 5] = ["sandbox", "mcpServers", "features", "config", "keepThread"];
/// What a role may never set through `config`: the account, the provider, approvals and what its own fields decide.
const CONFIG_DENIED: [&str; 13] = [
    "forced_login_method", "model_provider", "model_providers", "approval_policy", "sandbox_mode", "notify", "model",
    "features", "profile", "profiles", "projects", "chatgpt_base_url", "openai_base_url",
];
const MCP_POLICY_TAILS: [&str; 5] =
    ["enabled_tools", "disabled_tools", "default_tools_approval_mode", "tool_timeout_sec", "startup_timeout_sec"];
/// Every effort Codex names for some model; which of them a model lists is its own matter.
pub const EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const RUBRIC_FIELDS: [&str; 2] = ["expect", "known"];
const CONFIDENT: f64 = 0.9;
const SLACK: f64 = 1e-9;
const OUTCOMES: [&str; 4] = ["fail", "unclear", "known", "pass"];

pub const LIMIT_INSTRUCTIONS: usize = 64 * 1024;
pub const LIMIT_SCHEMA: usize = 64 * 1024;
pub const LIMIT_QUESTIONS: usize = 400;
pub const LIMIT_QUESTION_BYTES: usize = 1024 * 1024;

fn default_minutes(mode: &str) -> f64 {
    if mode == "work" { 60.0 } else { 30.0 }
}
fn max_minutes(mode: &str) -> f64 {
    if mode == "work" { 240.0 } else { 60.0 }
}

fn read_text(file: &Path, what: &str) -> Result<String> {
    fs::read_to_string(file).map_err(|_| GatewayError(format!("Cannot read {what}: {}", file.display())))
}

fn read_json(file: &Path, what: &str) -> Result<Value> {
    let text = read_text(file, what)?;
    serde_json::from_str(&text).map_err(|_| GatewayError(format!("{what} is not JSON: {}", file.display())))
}

/// A number as JavaScript would print it: whole numbers without a fraction.
pub fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 { json!(value as i64) } else { json!(value) }
}

/// Where a role name is looked up, first match wins: the repository's own roles (`.zodchi/roles`, then the
/// `.codex/gateway` folder the reference gateway used), then the roles zodchi installed.
pub fn role_dirs(cfg: &Config) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(root) = &cfg.root {
        dirs.push(root.join(".zodchi").join("roles"));
        dirs.push(root.join(".codex").join("gateway"));
    }
    dirs.push(cfg.roles_dir.clone());
    dirs
}

fn role_file(cfg: &Config, reference: &str) -> Result<PathBuf> {
    if reference.is_empty() {
        return fail("--role is required: the gateway never picks a role, a model or an effort itself");
    }
    if reference.to_ascii_lowercase().ends_with(".json") {
        return Ok(std::path::absolute(reference).unwrap_or_else(|_| PathBuf::from(reference)));
    }
    if !is_role_name(reference) {
        return fail("--role is a role name (a-z 0-9 -) or the path of a role file ending in .json");
    }
    let dirs = role_dirs(cfg);
    for dir in &dirs {
        let file = dir.join(format!("{reference}.json"));
        if file.exists() {
            return Ok(file);
        }
    }
    let looked: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
    fail(format!("No role {reference}: looked in {}.", looked.join(", ")))
}

fn raw_role(file: &Path) -> Result<Map<String, Value>> {
    let raw = read_json(file, "The role")?;
    let Value::Object(map) = raw else {
        return fail(format!("The role is not a JSON object: {}", file.display()));
    };
    for field in map.keys() {
        if !ROLE_FIELDS.contains(&field.as_str()) {
            return fail(format!("Unknown field \"{field}\" in the role {}", file.display()));
        }
    }
    Ok(map)
}

/// Overrides of one call: they replace what the role says.
#[derive(Default, Clone)]
pub struct Overrides {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub timeout_min: Option<f64>,
    pub questions: Option<Value>,
}

/// Resolves --role into what the model call gets. A repository role may extend an installed role: its fields
/// replace the shared ones, `config` is merged and the frames are joined, the shared one first. A facts file of the
/// repository (`.zodchi/facts.md`, or `.codex/gateway/facts.md`) is appended to the frame of every role.
pub fn load_role(cfg: &Config, reference: &str, overrides: &Overrides) -> Result<Value> {
    let file = role_file(cfg, reference)?;
    let own = raw_role(&file)?;
    let here = file.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut base: Option<Map<String, Value>> = None;
    let mut merged = own.clone();
    if let Some(extends) = own.get("extends") {
        let name = extends.as_str().unwrap_or("");
        let base_file = cfg.roles_dir.join(format!("{name}.json"));
        let same = std::path::absolute(&base_file).ok() == std::path::absolute(&file).ok();
        if !is_role_name(name) || same || !base_file.exists() {
            return fail(format!(
                "Role {} extends \"{name}\", which is not an installed shared role.",
                file.display()
            ));
        }
        let shared = raw_role(&base_file)?;
        if shared.contains_key("extends") {
            return fail(format!("Shared role {name} extends another role; one level only."));
        }
        let mut combined = shared.clone();
        for (k, v) in &own {
            combined.insert(k.clone(), v.clone());
        }
        if shared.contains_key("config") || own.contains_key("config") {
            let mut config = shared.get("config").and_then(Value::as_object).cloned().unwrap_or_default();
            for (k, v) in own.get("config").and_then(Value::as_object).cloned().unwrap_or_default() {
                config.insert(k, v);
            }
            combined.insert("config".into(), Value::Object(config));
        }
        merged = combined;
        base = Some(shared);
    }
    let mut frames = Vec::new();
    if let Some(frame) = base.as_ref().and_then(|b| b.get("frame")).and_then(Value::as_str) {
        frames.push(read_text(&cfg.roles_dir.join(frame), "the frame")?);
    }
    if let Some(frame) = own.get("frame").and_then(Value::as_str) {
        frames.push(read_text(&here.join(frame), "the frame")?);
    }
    if let Some(root) = &cfg.root {
        for facts in [root.join(".zodchi").join("facts.md"), root.join(".codex").join("gateway").join("facts.md")] {
            if facts.exists() {
                frames.push(read_text(&facts, "the facts of the repository")?);
                break;
            }
        }
    }
    let schema = match (own.get("schema"), base.as_ref().and_then(|b| b.get("schema"))) {
        (Some(s), _) => Some(here.join(s.as_str().unwrap_or(""))),
        (None, Some(s)) => Some(cfg.roles_dir.join(s.as_str().unwrap_or(""))),
        _ => None,
    };
    let questions_file = match (own.get("questions"), base.as_ref().and_then(|b| b.get("questions"))) {
        (Some(s), _) => Some(here.join(value_text(s))),
        (None, Some(s)) => Some(cfg.roles_dir.join(value_text(s))),
        _ => None,
    };
    let mut role = merged.clone();
    if let Some(model) = &overrides.model {
        role.insert("model".into(), json!(model));
    }
    if let Some(effort) = &overrides.effort {
        role.insert("effort".into(), json!(effort));
    }
    if let Some(minutes) = overrides.timeout_min {
        role.insert("timeoutMin".into(), js_number(minutes));
    }
    let name = file.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    role.insert("name".into(), json!(name));
    let instructions: Vec<String> = frames.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    role.insert("instructions".into(), json!(instructions.join("\n\n")));
    role.insert(
        "outputSchema".into(),
        match schema {
            Some(f) => read_json(&f, "The schema")?,
            None => Value::Null,
        },
    );
    // The questions the caller gives replace those of the role.
    let questions = match &overrides.questions {
        Some(q) => q.clone(),
        None => match questions_file {
            Some(f) => read_json(&f, "The list of questions")?,
            None => Value::Null,
        },
    };
    role.insert("questions".into(), questions);
    let mut checked = check_role(&Value::Object(role))?;
    let map = checked.as_object_mut().expect("checked role is an object");
    map.insert("description".into(), merged.get("description").cloned().unwrap_or(json!("")));
    map.insert("source".into(), json!(file.display().to_string()));
    Ok(checked)
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn is_model(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_name(text: &str, extra: &[u8]) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

/// Checks a resolved role and returns it in its stored form. `submit` runs it again on whatever it is given.
pub fn check_role(role: &Value) -> Result<Value> {
    let name = role.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let bad = |message: &str| -> GatewayError {
        GatewayError(format!("Role {}: {message}", if name.is_empty() { "?" } else { &name }))
    };
    if !is_role_name(&name) {
        return fail("A role needs a name: a-z 0-9 -");
    }
    let get = |k: &str| role.get(k).filter(|v| !v.is_null());
    let kind = get("kind").and_then(Value::as_str).unwrap_or("text");
    if get("kind").is_some() && !get("kind").unwrap().is_string() || !KINDS.contains(&kind) {
        return Err(bad(&format!("kind is {}", KINDS.join(", "))));
    }
    let mode = get("mode").and_then(Value::as_str).unwrap_or("");
    if mode != "expert" && mode != "work" {
        return Err(bad("mode is \"expert\" or \"work\""));
    }
    if kind != "text" && mode != "expert" {
        return Err(bad(&format!("a role of the kind {kind} is an expert: it has no tools")));
    }
    let model = get("model").map(value_text).unwrap_or_default();
    if !is_model(&model) {
        return Err(bad("model is required"));
    }
    let effort = get("effort").cloned();
    if kind == "decisions" {
        if effort.is_some() {
            return Err(bad("a decisions role has no effort: the Decisions API takes none"));
        }
    } else if !effort.as_ref().and_then(Value::as_str).map(|e| EFFORTS.contains(&e)).unwrap_or(false) {
        return Err(bad(&format!("effort is one of {}", EFFORTS.join(", "))));
    }
    let instructions = match role.get("instructions") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(bad(&format!("the frame is larger than {} KB", LIMIT_INSTRUCTIONS / 1024))),
    };
    if instructions.len() > LIMIT_INSTRUCTIONS {
        return Err(bad(&format!("the frame is larger than {} KB", LIMIT_INSTRUCTIONS / 1024)));
    }
    let output_schema = get("outputSchema").cloned().unwrap_or(Value::Null);
    if !output_schema.is_null() && kind != "text" {
        let what = if kind == "image" { "an image" } else { "a decisions" };
        return Err(bad(&format!("a schema belongs to a text role; the answer of {what} role has its own form")));
    }
    if !output_schema.is_null() && (!output_schema.is_object() || output_schema.to_string().len() > LIMIT_SCHEMA) {
        return Err(bad("the schema is a JSON object of at most 64 KB"));
    }
    let questions = get("questions").cloned().unwrap_or(Value::Null);
    if !questions.is_null() && kind != "decisions" {
        return Err(bad("questions belong to a decisions role"));
    }
    if !questions.is_null() {
        check_questions(&questions).map_err(|m| bad(&m))?;
    }
    let timeout = match get("timeoutMin") {
        None => Some(default_minutes(mode)),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        Some(_) => None,
    };
    let timeout = match timeout {
        Some(t) if t.is_finite() && t * 60_000.0 >= 1000.0 && t <= max_minutes(mode) => t,
        _ => {
            let what = if mode == "work" { "a work" } else { "an expert" };
            return Err(bad(&format!("the time limit of {what} call is at most {} minutes", max_minutes(mode))));
        }
    };
    let mut checked = Map::new();
    checked.insert("name".into(), json!(name));
    checked.insert("kind".into(), json!(kind));
    checked.insert("mode".into(), json!(mode));
    checked.insert("model".into(), get("model").cloned().unwrap_or(json!(model)));
    checked.insert("effort".into(), if kind == "decisions" { Value::Null } else { effort.unwrap_or(Value::Null) });
    checked.insert("instructions".into(), json!(instructions));
    checked.insert("outputSchema".into(), output_schema);
    checked.insert("timeoutMin".into(), js_number(timeout));
    if kind == "decisions" {
        checked.insert("questions".into(), questions);
    }
    if mode == "expert" {
        for field in WORK_FIELDS {
            if get(field).is_some() {
                return Err(bad(&format!("{field} belongs to a work role; an expert has no tools")));
            }
        }
        return Ok(Value::Object(checked));
    }
    let sandbox = get("sandbox").and_then(Value::as_str).unwrap_or("");
    if sandbox != "read-only" && sandbox != "workspace-write" {
        return Err(bad("sandbox is \"read-only\" or \"workspace-write\""));
    }
    let servers = get("mcpServers").cloned().unwrap_or(json!([]));
    let Some(list) = servers.as_array() else { return Err(bad("mcpServers is a list of MCP server names")) };
    let mut unique: Vec<Value> = Vec::new();
    for server in list {
        let text = value_text(server);
        if !is_name(&text, b"_-") {
            return Err(bad("mcpServers is a list of MCP server names"));
        }
        if !unique.contains(server) {
            unique.push(server.clone());
        }
    }
    let features = get("features").cloned().unwrap_or(json!({}));
    let enable = features.get("enable").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]));
    let disable = features.get("disable").filter(|v| !v.is_null()).cloned().unwrap_or(json!([]));
    for list in [&enable, &disable] {
        let ok = list.as_array().map(|items| {
            items.iter().all(|f| {
                let t = value_text(f);
                !t.is_empty() && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
        });
        if ok != Some(true) {
            return Err(bad("features.enable and features.disable are lists of Codex feature names"));
        }
    }
    let overrides = get("config").cloned().unwrap_or(json!({}));
    let Some(config) = overrides.as_object() else {
        return Err(bad("config is an object of Codex settings with dotted keys"));
    };
    for key in config.keys() {
        let head = key.split('.').next().unwrap_or("");
        if CONFIG_DENIED.contains(&head) {
            return Err(bad(&format!("config may not set {key}")));
        }
        if head == "mcp_servers" && !mcp_policy(key) {
            return Err(bad(&format!(
                "config may only narrow the tools of a listed MCP server (enabled_tools, disabled_tools); {key} is not that"
            )));
        }
    }
    let keep = get("keepThread").cloned();
    if keep.as_ref().is_some_and(|k| !k.is_boolean()) {
        return Err(bad("keepThread is true or false"));
    }
    checked.insert("sandbox".into(), json!(sandbox));
    checked.insert("mcpServers".into(), Value::Array(unique));
    checked.insert("features".into(), json!({ "enable": enable, "disable": disable }));
    checked.insert("config".into(), overrides.clone());
    // Only `true` is stored, so a role without the field keeps its stored form, and the key of a job.
    if keep == Some(Value::Bool(true)) {
        checked.insert("keepThread".into(), json!(true));
    }
    Ok(Value::Object(checked))
}

fn mcp_policy(key: &str) -> bool {
    let parts: Vec<&str> = key.split('.').collect();
    parts.len() == 3 && parts[0] == "mcp_servers" && is_name(parts[1], b"_-") && MCP_POLICY_TAILS.contains(&parts[2])
}

fn check_questions(questions: &Value) -> std::result::Result<(), String> {
    let Some(list) = questions.as_array().filter(|l| !l.is_empty() && l.len() <= LIMIT_QUESTIONS) else {
        return Err(format!("questions is a list of 1 to {LIMIT_QUESTIONS} questions"));
    };
    let mut names = Vec::new();
    for (index, question) in list.iter().enumerate() {
        let at = format!("question {}", index + 1);
        if !question.is_object() {
            return Err(format!("{at} is not an object"));
        }
        let kind = question.get("type").and_then(Value::as_str).unwrap_or("");
        if !QUESTION_TYPES.contains(&kind) {
            return Err(format!("{at}: type is {}", QUESTION_TYPES.join(", ")));
        }
        let name = question.get("name").and_then(Value::as_str).unwrap_or("");
        if name.trim().is_empty() || names.contains(&name) {
            return Err(format!("{at}: name is required and is not repeated"));
        }
        names.push(name);
        let asks = question.get("instructions");
        let present = match asks {
            Some(Value::String(s)) => !s.trim().is_empty(),
            Some(Value::Array(a)) => !a.is_empty(),
            _ => false,
        };
        if !present {
            return Err(format!("{at}: instructions are required"));
        }
        check_expectation(question, &at)?;
    }
    if questions.to_string().len() > LIMIT_QUESTION_BYTES {
        return Err(format!("the questions are larger than {} KB", LIMIT_QUESTION_BYTES / 1024));
    }
    Ok(())
}

fn check_expectation(question: &Value, at: &str) -> std::result::Result<(), String> {
    let expect = question.get("expect");
    if let Some(known) = question.get("known") {
        if !known.as_str().is_some_and(|k| !k.trim().is_empty()) || expect.is_none() {
            return Err(format!("{at}: known names the open task of a question that has expect"));
        }
    }
    let Some(expect) = expect else { return Ok(()) };
    match question.get("type").and_then(Value::as_str) {
        Some("predicate") => {
            if !expect.is_boolean() {
                return Err(format!("{at}: expect of a predicate is true or false"));
            }
        }
        Some("choice") => {
            let values: Vec<Value> = question
                .get("choices")
                .and_then(Value::as_array)
                .map(|c| c.iter().map(|c| c.get("value").cloned().unwrap_or(Value::Null)).collect())
                .unwrap_or_default();
            let expected: Vec<Value> = match expect {
                Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            let mut distinct_values = values.clone();
            distinct_values.dedup();
            let distinct_values = {
                let mut seen: Vec<Value> = Vec::new();
                for v in &values {
                    if !seen.contains(v) {
                        seen.push(v.clone());
                    }
                }
                seen.len()
            };
            let mut seen: Vec<&Value> = Vec::new();
            let mut repeated = false;
            for e in &expected {
                if seen.contains(&e) {
                    repeated = true;
                }
                seen.push(e);
            }
            if expected.is_empty()
                || expected.iter().any(|v| !v.is_string() || !values.contains(v))
                || repeated
                || expected.len() >= distinct_values
            {
                return Err(format!("{at}: expect of a choice is one of its values or a list of some of them"));
            }
        }
        _ => return Err(format!("{at}: expect belongs to a predicate or a choice; a score has no verdict")),
    }
    Ok(())
}

fn is_probability(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|p| (0.0..=1.0).contains(p))
}

/// The probability that the answer to a question is the expected one, or None when the answers do not say.
fn agreement_with(question: &Value, answers: &[Value]) -> Option<f64> {
    let name = question.get("name");
    let found: Vec<&Value> = answers.iter().filter(|a| a.get("name") == name).collect();
    if found.len() != 1 || found[0].get("type") != question.get("type") {
        return None;
    }
    let answer = found[0];
    let expect = question.get("expect")?;
    if question.get("type").and_then(Value::as_str) == Some("predicate") {
        let p = is_probability(answer.get("probability"))?;
        return Some(if expect.as_bool() == Some(true) { p } else { 1.0 - p });
    }
    let given = answer.get("probabilities").and_then(Value::as_array).cloned().unwrap_or_default();
    let choices = question.get("choices").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut by_value: Vec<(Value, Option<&Value>)> = Vec::new();
    for entry in &given {
        let value = entry.get("value").cloned().unwrap_or(Value::Null);
        if let Some(slot) = by_value.iter_mut().find(|(v, _)| *v == value) {
            slot.1 = entry.get("probability");
        } else {
            by_value.push((value, entry.get("probability")));
        }
    }
    let lookup = |v: &Value| by_value.iter().find(|(k, _)| k == v).and_then(|(_, p)| is_probability(*p));
    if given.len() != choices.len()
        || by_value.len() != given.len()
        || choices.iter().any(|c| lookup(c.get("value").unwrap_or(&Value::Null)).is_none())
    {
        return None;
    }
    let expected: Vec<Value> = match expect {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    Some(expected.iter().map(|v| lookup(v).unwrap_or(0.0)).sum())
}

/// Compares the answers with what the rubric expects; see the reference gateway for the rules. None when no
/// question has `expect`.
pub fn verdict(questions: &Value, answers: &[Value]) -> Option<Value> {
    let rated: Vec<Value> = questions
        .as_array()?
        .iter()
        .filter(|q| q.get("expect").is_some())
        .map(|question| {
            let agreement = agreement_with(question, answers);
            let sure = match agreement {
                None => "unclear",
                Some(a) if a >= CONFIDENT - SLACK => "pass",
                Some(a) if a <= 1.0 - CONFIDENT + SLACK => "fail",
                Some(_) => "unclear",
            };
            let known = question.get("known").and_then(Value::as_str);
            let outcome = if known.is_some() && sure != "pass" { "known" } else { sure };
            let mut entry = Map::new();
            entry.insert("name".into(), question.get("name").cloned().unwrap_or(Value::Null));
            entry.insert("outcome".into(), json!(outcome));
            entry.insert("expect".into(), question.get("expect").cloned().unwrap_or(Value::Null));
            entry.insert(
                "agreement".into(),
                agreement.map(|a| js_number((a * 1000.0).round() / 1000.0)).unwrap_or(Value::Null),
            );
            if let Some(k) = known {
                entry.insert("known".into(), json!(k));
            }
            Value::Object(entry)
        })
        .collect();
    if rated.is_empty() {
        return None;
    }
    let outcome = OUTCOMES.iter().find(|o| rated.iter().any(|r| r.get("outcome").and_then(Value::as_str) == Some(o)));
    Some(json!({ "outcome": outcome, "questions": rated }))
}

/// The questions as the API gets them: what the rubric expects is not a part of the question.
pub fn asked_questions(questions: &Value) -> Value {
    Value::Array(
        questions
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|q| {
                        let mut m = q.as_object().cloned().unwrap_or_default();
                        for f in RUBRIC_FIELDS {
                            m.remove(f);
                        }
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// The roles a call from this repository can name: its own first, then the installed ones.
pub fn roles(cfg: &Config) -> Vec<Value> {
    let mut found: Vec<(String, Value)> = Vec::new();
    for dir in role_dirs(cfg) {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for entry in names {
            if !entry.ends_with(".json") || entry.ends_with(".schema.json") || entry.ends_with(".questions.json") {
                continue;
            }
            let name = entry.trim_end_matches(".json").to_string();
            if found.iter().any(|(n, _)| *n == name) {
                continue;
            }
            let path = dir.join(&entry);
            let row = match load_role(cfg, &path.display().to_string(), &Overrides::default()) {
                Ok(role) => {
                    let mut m = Map::new();
                    m.insert("role".into(), json!(name));
                    for k in ["kind", "mode", "model", "effort", "timeoutMin"] {
                        m.insert(k.into(), role.get(k).cloned().unwrap_or(Value::Null));
                    }
                    if role.get("mode").and_then(Value::as_str) == Some("work") {
                        m.insert("sandbox".into(), role.get("sandbox").cloned().unwrap_or(Value::Null));
                        m.insert("mcpServers".into(), role.get("mcpServers").cloned().unwrap_or(json!([])));
                        m.insert("keepThread".into(), json!(role.get("keepThread") == Some(&json!(true))));
                    }
                    m.insert("description".into(), role.get("description").cloned().unwrap_or(json!("")));
                    m.insert("source".into(), role.get("source").cloned().unwrap_or(Value::Null));
                    Value::Object(m)
                }
                Err(error) => json!({ "role": name, "error": error.0 }),
            };
            found.push((name, row));
        }
    }
    found.into_iter().map(|(_, v)| v).collect()
}
