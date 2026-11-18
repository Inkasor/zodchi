//! The arguments of `zodchi flow code-package`: the supported subset of the JavaScript workflow's arguments, checked
//! before anything is claimed. An option this version does not support is refused, never ignored.

use crate::claims::{fold, norm};
use serde_json::{json, Map, Value};

#[derive(Clone, Debug)]
pub struct Args {
    pub label: String,
    pub brief: String,
    pub repo: String,
    /// The repository path normalized (forward slashes, no dot segments).
    pub repo_norm: String,
    /// The claimed files, relative to the repository, in the case given.
    pub files: Vec<String>,
    pub rounds: u32,
    pub fixes: u32,
    pub checks: Vec<String>,
    pub verify: Vec<String>,
    pub protect: Vec<String>,
    pub allow_check_changes: Vec<String>,
    pub models: Map<String, Value>,
    pub extend_claim: bool,
    pub check_timeout_min: f64,
}

const SUPPORTED: [&str; 16] = [
    "label", "brief", "repo", "files", "tmp", "mode", "rounds", "fixes", "checks", "verify", "protect", "allowCheckChanges",
    "models", "commit", "extendClaim", "checkTimeoutMin",
];

const UNSUPPORTED: [(&str, &str); 6] = [
    ("hard", "a hard writer is chosen in the role table (expertWriter) in this version"),
    ("continuations", "the writer answers in one turn; there is nothing to continue"),
    ("branch", "the run commits on the branch that is checked out; switch to it first"),
    ("fixIgnore", "add \".agent-tmp/\" to .gitignore and commit it first"),
    ("closeShouldFix", "nit findings stay in openFindings in this version"),
    ("rerun", "use --resume <run-id> --rerun <step>"),
];

/// A path of the repository, relative to it, in the case given; refuses one outside it.
pub fn rel(repo_norm: &str, path: &str) -> Result<String, String> {
    let s = path.replace('\\', "/");
    let absolute = s.starts_with('/') || (s.len() >= 3 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic());
    let full = norm(&if absolute { s.clone() } else { format!("{repo_norm}/{s}") }).map_err(|e| e.0)?;
    if fold(repo_norm, &full) == fold(repo_norm, repo_norm) {
        return Err(format!("path {path} is the repository itself, not a file in it"));
    }
    if !fold(repo_norm, &full).starts_with(&(fold(repo_norm, repo_norm) + "/")) {
        return Err(format!("path {path} is outside the repository"));
    }
    Ok(full[repo_norm.len() + 1..].to_string())
}

fn commands(value: Option<&Value>, name: &str) -> Result<Vec<String>, String> {
    let list = match value {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) => a.clone(),
        Some(other) => vec![other.clone()],
    };
    let mut out = Vec::new();
    for item in list {
        match &item {
            Value::String(s) if !s.trim().is_empty() => out.push(s.clone()),
            Value::Object(o) => {
                let cmd = o.get("cmd").and_then(Value::as_str).unwrap_or("");
                let pass = o.get("pass").and_then(Value::as_str).unwrap_or("exit code 0");
                if cmd.trim().is_empty() || o.keys().any(|k| k != "cmd" && k != "pass") {
                    return Err(format!("args.{name}: an entry is a command string or {{\"cmd\": ...}}"));
                }
                if pass != "exit code 0" {
                    return Err(format!("args.{name}: the engine judges a command by its exit code only; \"pass\": {pass:?} is not supported (make the command exit non-zero on failure)"));
                }
                out.push(cmd.to_string());
            }
            _ => return Err(format!("args.{name}: an entry is a command string or {{\"cmd\": ...}}")),
        }
    }
    Ok(out)
}

fn strings(value: Option<&Value>, name: &str) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::String(s)) => Ok(vec![s.clone()]),
        Some(Value::Array(a)) => a.iter().map(|v| v.as_str().map(String::from).ok_or(format!("args.{name} is a list of strings"))).collect(),
        Some(_) => Err(format!("args.{name} is a list of strings")),
    }
}

fn count(value: Option<&Value>, name: &str, default: u32, min: u32, max: u32) -> Result<u32, String> {
    match value {
        None | Some(Value::Null) => Ok(default),
        Some(v) => match v.as_u64() {
            Some(n) if n >= min as u64 && n <= max as u64 => Ok(n as u32),
            _ => Err(format!("args.{name} is a whole number from {min} to {max}")),
        },
    }
}

pub fn parse(a: &Value) -> Result<Args, String> {
    let Some(o) = a.as_object() else { return Err("the args are a JSON object".into()) };
    for (k, why) in UNSUPPORTED {
        if o.get(k).is_some_and(|v| !v.is_null() && v != &json!(false)) {
            return Err(format!("args.{k} is not supported by zodchi flow code-package v1: {why}"));
        }
    }
    for k in o.keys() {
        if !SUPPORTED.contains(&k.as_str()) && !UNSUPPORTED.iter().any(|(u, _)| u == k) {
            return Err(format!("args.{k} is not an option of zodchi flow code-package v1"));
        }
    }
    let text = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    for k in ["label", "brief", "repo"] {
        if text(k).trim().is_empty() {
            return Err(format!("code-package needs args.{k}"));
        }
    }
    let label = text("label");
    if label.len() > 40 || !label.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return Err("args.label may hold letters, digits, \".\", \"_\" and \"-\" only, at most 40".into());
    }
    if let Some(mode) = o.get("mode").filter(|v| !v.is_null()) {
        if mode != &json!("expert") {
            return Err("args.mode: zodchi flow writes through an expert patch only (\"expert\"); agent mode stays with the JavaScript workflow".into());
        }
    }
    if o.get("commit").is_some_and(|v| v != &json!(true)) {
        return Err("args.commit: only true is supported; the engine commits each checked round (it never pushes)".into());
    }
    let repo = text("repo");
    let repo_abs = std::path::absolute(&repo).map_err(|e| format!("args.repo: {e}"))?;
    let repo_norm = norm(&repo_abs.display().to_string()).map_err(|e| e.0)?;
    let mut files: Vec<String> = Vec::new();
    for f in strings(o.get("files"), "files")? {
        let r = rel(&repo_norm, &f)?;
        if !files.iter().any(|x| x.to_lowercase() == r.to_lowercase()) {
            files.push(r);
        }
    }
    if files.is_empty() {
        return Err("code-package needs args.files: the files the package may change".into());
    }
    let protect = strings(o.get("protect"), "protect")?.iter().map(|p| rel(&repo_norm, p).map(|r| r.to_lowercase())).collect::<Result<Vec<_>, _>>()?;
    let allow_raw = match o.get("allowCheckChanges") {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        other => strings(other, "allowCheckChanges")?,
    };
    let allow_check_changes = allow_raw.iter().map(|p| rel(&repo_norm, p).map(|r| r.to_lowercase())).collect::<Result<Vec<_>, _>>()?;
    let models = match o.get("models") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err("args.models is an object of roles".into()),
    };
    if o.get("extendClaim").is_some_and(|v| !v.is_boolean()) {
        return Err("args.extendClaim is true or false".into());
    }
    let check_timeout_min = match o.get("checkTimeoutMin") {
        None | Some(Value::Null) => 60.0,
        Some(v) => match v.as_f64() {
            Some(n) if n.is_finite() && n > 0.0 && n <= 600.0 => n,
            _ => return Err("args.checkTimeoutMin is a number of minutes up to 600".into()),
        },
    };
    Ok(Args {
        label,
        brief: text("brief"),
        repo: repo_abs.display().to_string(),
        repo_norm,
        files,
        rounds: count(o.get("rounds"), "rounds", 3, 1, 10)?,
        fixes: count(o.get("fixes"), "fixes", 1, 0, 5)?,
        checks: commands(o.get("checks"), "checks")?,
        verify: commands(o.get("verify"), "verify")?,
        protect,
        allow_check_changes,
        models,
        extend_claim: o.get("extendClaim") == Some(&json!(true)),
        check_timeout_min,
    })
}

/// Protected checks: an existing file under test/, tests/, e2e/ or .claude/skills/verify/, REVIEW.md, or under a
/// path of args.protect.
pub fn is_protected(args: &Args, rel_path: &str) -> bool {
    let l = rel_path.to_lowercase();
    let dirs: Vec<&str> = l.split('/').collect();
    dirs[..dirs.len() - 1].iter().any(|d| ["test", "tests", "e2e"].contains(d))
        || l == "review.md"
        || l.starts_with(".claude/skills/verify/")
        || args.protect.iter().any(|p| l == *p || l.starts_with(&format!("{p}/")))
}
