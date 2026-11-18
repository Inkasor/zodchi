//! The writer/reviewer pair of a run, resolved once at the gate from the role table (`~/.zodchi/models.json`, the
//! repository's `.zodchi/models.json`, then `args.models`; a later table replaces a role of an earlier one) and
//! pinned for the run. This version runs Codex candidates only, through the gateway; the writer and the reviewer are
//! distinct models. Every candidate passed over is recorded with its reason.

use serde_json::{json, Map, Value};
use std::path::Path;
use zodchi_core::config::Config;

#[derive(Clone, Debug)]
pub struct Pick {
    pub provider: String,
    pub model: String,
    pub effort: String,
}

impl Pick {
    pub fn to_json(&self) -> Value {
        json!({ "provider": self.provider, "model": self.model, "effort": self.effort })
    }
    pub fn from_json(v: &Value) -> Pick {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        Pick { provider: s("provider"), model: s("model"), effort: s("effort") }
    }
    fn name(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

pub const WRITER_ROLE: &str = "expertWriter";
pub const REVIEWER_ROLE: &str = "reviewer";

fn roles_of(file: &Path) -> Result<Map<String, Value>, String> {
    let Ok(text) = std::fs::read_to_string(file) else { return Ok(Map::new()) };
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("{} is not JSON", file.display()))?;
    Ok(v.get("roles").and_then(Value::as_object).cloned().unwrap_or_default())
}

/// The role table of the run: home, repository, args; each later source replaces whole roles.
pub fn table(cfg: &Config, repo: &Path, args_models: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut t = roles_of(&cfg.home.join("models.json"))?;
    t.extend(roles_of(&repo.join(".zodchi").join("models.json"))?);
    t.extend(args_models.clone());
    Ok(t)
}

fn candidates(table: &Map<String, Value>, role: &str) -> Result<Vec<Pick>, String> {
    let Some(list) = table.get(role).and_then(|r| r.get("candidates")).and_then(Value::as_array) else {
        return Err(format!("Role {role} is not in the role table (~/.zodchi/models.json, .zodchi/models.json or args.models)"));
    };
    Ok(list.iter().map(|c| {
        let mut p = Pick::from_json(c);
        if p.effort.is_empty() {
            p.effort = "medium".into();
        }
        p
    }).collect())
}

/// Whether the Codex subscription can take calls now, from `zodchi account`: signed in, ordinary usage allowed and
/// limit left. The reason when it cannot.
pub fn codex_usable(account: &Value) -> Result<(), String> {
    let used = |w: &Value| w.get("usedPercent").and_then(Value::as_f64).unwrap_or(0.0);
    if account["connected"] != json!(true) {
        return Err("Codex is not signed in (zodchi account)".into());
    }
    if account["ordinaryUsageAllowed"] == json!(false) || used(&account["primary"]) >= 100.0 || used(&account["secondary"]) >= 100.0 {
        return Err("the Codex subscription has no limit left (zodchi account)".into());
    }
    Ok(())
}

/// The first writer candidate, in table order, that has an independent reviewer candidate; the first such reviewer.
/// Returns the pair and every candidate skipped with its reason, or the refusal with those reasons.
pub fn resolve(table: &Map<String, Value>, codex: &Result<(), String>) -> Result<(Pick, Pick, Vec<String>), String> {
    let writers = candidates(table, WRITER_ROLE)?;
    let reviewers = candidates(table, REVIEWER_ROLE)?;
    let mut skipped = Vec::new();
    let usable = |p: &Pick| -> Result<(), String> {
        if p.provider == "claude" {
            return Err("Claude is not an executor of zodchi flow in this version (Codex only)".into());
        }
        if p.provider != "codex" || p.model.is_empty() {
            return Err("not a Codex candidate with a model".into());
        }
        codex.clone()
    };
    for w in &writers {
        if let Err(why) = usable(w) {
            skipped.push(format!("{WRITER_ROLE} {}: {why}", w.name()));
            continue;
        }
        let mut reasons = Vec::new();
        for r in &reviewers {
            if r.provider == w.provider && r.model == w.model {
                reasons.push(format!("{REVIEWER_ROLE} {}: the same model as the writer", r.name()));
                continue;
            }
            if let Err(why) = usable(r) {
                reasons.push(format!("{REVIEWER_ROLE} {}: {why}", r.name()));
                continue;
            }
            skipped.extend(reasons);
            return Ok((w.clone(), r.clone(), skipped));
        }
        skipped.push(format!("{WRITER_ROLE} {}: no independent reviewer ({})", w.name(), reasons.join("; ")));
    }
    Err(format!("No writer/reviewer pair of distinct Codex models: {}", skipped.join("; ")))
}
