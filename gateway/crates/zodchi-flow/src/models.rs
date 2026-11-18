//! The writer/reviewer pair of a run, resolved once at the gate from the role table (`~/.zodchi/models.json`, the
//! repository's `.zodchi/models.json`, then `args.models`; a later table replaces a role of an earlier one) and
//! pinned for the run. Codex candidates run through the gateway; Claude candidates run through the local Claude Code
//! CLI, only when the person enabled it (`"claude": true` in `~/.zodchi/flow.json`) and only after a preflight at the
//! gate. The writer and the reviewer are distinct provider/model identities. Every candidate passed over is recorded
//! with its reason. A Claude pick carries the account Claude Code was signed in with at the gate (a digest), and every
//! Claude call checks it again.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::util::{iso, now_ms, parse_iso_ms, read_stored, write_json_atomic};

use crate::executor::claude;

#[derive(Clone, Debug)]
pub struct Pick {
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// The account a Claude pick was authorized with at the gate (`claude::account_of`); empty for Codex.
    pub account: String,
}

impl Pick {
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "provider": self.provider, "model": self.model, "effort": self.effort });
        if !self.account.is_empty() {
            v["account"] = json!(self.account);
        }
        v
    }
    pub fn from_json(v: &Value) -> Pick {
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        Pick { provider: s("provider"), model: s("model"), effort: s("effort"), account: s("account") }
    }
    fn name(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

pub const WRITER_ROLE: &str = "expertWriter";
pub const REVIEWER_ROLE: &str = "reviewer";

/// The entry of the role table that carries this machine's Claude setting to `resolve`; not a role.
pub const CLAUDE_ENTRY: &str = "@claude";

fn roles_of(file: &Path) -> Result<Map<String, Value>, String> {
    let Ok(text) = std::fs::read_to_string(file) else { return Ok(Map::new()) };
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("{} is not JSON", file.display()))?;
    Ok(v.get("roles").and_then(Value::as_object).cloned().unwrap_or_default())
}

/// The role table of the run: home, repository, args; each later source replaces whole roles. Whether Claude may
/// run comes from the person's own `flow.json`, never from a table or the args: whatever a table says under
/// `CLAUDE_ENTRY` is replaced.
pub fn table(cfg: &Config, repo: &Path, args_models: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut t = roles_of(&cfg.home.join("models.json"))?;
    t.extend(roles_of(&repo.join(".zodchi").join("models.json"))?);
    t.extend(args_models.clone());
    t.insert(CLAUDE_ENTRY.into(), json!({ "enabled": claude_enabled(cfg), "home": cfg.home.to_string_lossy() }));
    Ok(t)
}

/// Whether the person enabled Claude as an executor: `"claude": true` in `~/.zodchi/flow.json` (`$ZODCHI_HOME`
/// respected). Anything else, an absent or unreadable file included, is "not enabled".
pub fn claude_enabled(cfg: &Config) -> bool {
    std::fs::read_to_string(cfg.home.join("flow.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| v.get("claude") == Some(&json!(true)))
}

fn candidates(table: &Map<String, Value>, role: &str) -> Result<Vec<Pick>, String> {
    let Some(list) = table.get(role).and_then(|r| r.get("candidates")).and_then(Value::as_array) else {
        return Err(format!("Role {role} is not in the role table (~/.zodchi/models.json, .zodchi/models.json or args.models)"));
    };
    Ok(list.iter().map(|c| {
        let mut p = Pick::from_json(c);
        p.account = String::new(); // only the gate binds an account, never a table
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

/// How long a passed preflight of one CLI version, model and effort is taken as it is.
const PREFLIGHT_FRESH_MS: i128 = 24 * 3600 * 1000;
const PREFLIGHT_LIMIT: Duration = Duration::from_secs(180);
/// The prompt of the tiny structured call; it carries nothing of the run.
const PREFLIGHT_PROMPT: &str = "Step: preflight (zodchi flow)\n\nThis call only checks that the model answers in the asked form. Answer {\"ok\": true}.";

/// The preflight of Claude on this machine at the gate, before anything is claimed: the program runs
/// (`claude --version`), it is signed in with a Claude subscription (`claude auth status`), and a tiny structured
/// call with the candidate's model and effort answers in its schema. The call is skipped when one of this CLI
/// version, account, model and effort passed less than a day ago (`claude-preflight.json` in the zodchi home). Each
/// model is checked once per gate; the program and the sign-in once. A usable candidate comes with the account it
/// is bound to.
pub struct ClaudeGate {
    enabled: bool,
    home: PathBuf,
    /// The program, its version and the account binding of its sign-in.
    program: Option<Result<(claude::Program, String, String), String>>,
    picks: HashMap<(String, String), Result<String, String>>,
}

impl ClaudeGate {
    pub fn of(table: &Map<String, Value>) -> ClaudeGate {
        let entry = table.get(CLAUDE_ENTRY);
        ClaudeGate {
            enabled: entry.and_then(|e| e.get("enabled")) == Some(&json!(true)),
            home: PathBuf::from(entry.and_then(|e| e.get("home")).and_then(Value::as_str).unwrap_or("")),
            program: None,
            picks: HashMap::new(),
        }
    }

    /// Whether a Claude candidate may run: the account it is bound to, or the reason when it may not.
    pub fn usable(&mut self, p: &Pick) -> Result<String, String> {
        if !self.enabled || self.home.as_os_str().is_empty() {
            return Err("Claude is not an executor of this run: not enabled (\"claude\": true in ~/.zodchi/flow.json)".into());
        }
        // The model goes into the request's role, which takes a plain model name: anything else would pass the
        // preflight and fail only at the first step.
        let plain = |s: &str| s.len() <= 64 && s.starts_with(|c: char| c.is_ascii_alphanumeric()) && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c));
        if !plain(&p.model) {
            return Err("a Claude candidate needs a plain model name (letters, digits, . - _)".into());
        }
        let k = (p.model.clone(), p.effort.clone());
        if let Some(r) = self.picks.get(&k) {
            return r.clone();
        }
        let r = self.check(p).map_err(|why| format!("Claude preflight: {why}"));
        self.picks.insert(k, r.clone());
        r
    }

    fn scratch(&self) -> Result<PathBuf, String> {
        let dir = self.home.join("claude-preflight").join(format!("{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        Ok(dir)
    }

    fn check(&mut self, p: &Pick) -> Result<String, String> {
        if self.program.is_none() {
            let found = claude::find_program().and_then(|program| {
                let dir = self.scratch()?;
                let r = claude::version(&program, &dir).and_then(|v| claude::signed_in(&program, &dir).map(|a| (v, a)));
                let _ = std::fs::remove_dir_all(&dir);
                r.map(|(v, a)| (program, v, a))
            });
            self.program = Some(found);
        }
        let (program, version, account) = self.program.clone().expect("set above")?;
        let cache = self.home.join("claude-preflight.json");
        let id = format!("{version}|{account}|{}|{}", p.model, p.effort);
        let passed = read_stored(&cache).and_then(|c| c.get(&id).and_then(Value::as_str).and_then(parse_iso_ms));
        if passed.is_some_and(|at| (0..PREFLIGHT_FRESH_MS).contains(&(now_ms() - at))) {
            return Ok(account);
        }
        let dir = self.scratch()?;
        let schema = json!({ "type": "object", "additionalProperties": false, "required": ["ok"], "properties": { "ok": { "type": "boolean", "const": true } } });
        let text = claude::message("", PREFLIGHT_PROMPT, &schema);
        let r = claude::call(&program, &dir, &p.model, &p.effort, &text, &schema, PREFLIGHT_LIMIT, || Ok(()));
        let _ = std::fs::remove_dir_all(&dir);
        match r {
            Ok(_) => {
                let mut c = read_stored(&cache).filter(Value::is_object).unwrap_or_else(|| json!({}));
                c[id.as_str()] = json!(iso());
                let _ = write_json_atomic(&cache, &c);
                Ok(account)
            }
            Err((_, why, _)) => Err(format!("{} with effort {} did not answer a tiny structured call: {why}", p.model, p.effort)),
        }
    }
}

/// The first writer candidate, in table order, that has an independent reviewer candidate; the first such reviewer.
/// A Codex candidate needs the Codex subscription usable (`codex`); a Claude candidate needs Claude enabled and its
/// preflight passed, run only for the candidates the walk reaches; a Claude pick comes back bound to the account of
/// its preflight. Returns the pair and every candidate skipped with its reason, or the refusal with those reasons.
pub fn resolve(table: &Map<String, Value>, codex: &Result<(), String>) -> Result<(Pick, Pick, Vec<String>), String> {
    let writers = candidates(table, WRITER_ROLE)?;
    let reviewers = candidates(table, REVIEWER_ROLE)?;
    let mut gate = ClaudeGate::of(table);
    let mut skipped = Vec::new();
    let mut usable = |p: &Pick| -> Result<String, String> {
        match p.provider.as_str() {
            "claude" => gate.usable(p),
            "codex" if !p.model.is_empty() => codex.clone().map(|_| String::new()),
            _ => Err("not a Codex or Claude candidate with a model".into()),
        }
    };
    for w in &writers {
        let w_account = match usable(w) {
            Ok(a) => a,
            Err(why) => {
                skipped.push(format!("{WRITER_ROLE} {}: {why}", w.name()));
                continue;
            }
        };
        let mut reasons = Vec::new();
        for r in &reviewers {
            if r.provider == w.provider && r.model == w.model {
                reasons.push(format!("{REVIEWER_ROLE} {}: the same model as the writer", r.name()));
                continue;
            }
            let r_account = match usable(r) {
                Ok(a) => a,
                Err(why) => {
                    reasons.push(format!("{REVIEWER_ROLE} {}: {why}", r.name()));
                    continue;
                }
            };
            skipped.extend(reasons);
            let (mut w, mut r) = (w.clone(), r.clone());
            (w.account, r.account) = (w_account, r_account);
            return Ok((w, r, skipped));
        }
        skipped.push(format!("{WRITER_ROLE} {}: no independent reviewer ({})", w.name(), reasons.join("; ")));
    }
    Err(format!("No writer/reviewer pair of distinct models: {}", skipped.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(enabled: bool) -> Map<String, Value> {
        let v = json!({
            "expertWriter": { "candidates": [{ "provider": "claude", "model": "opus", "effort": "high" }, { "provider": "codex", "model": "w" }] },
            "reviewer": { "candidates": [{ "provider": "codex", "model": "w" }, { "provider": "codex", "model": "r", "effort": "high" }] },
            "@claude": { "enabled": enabled, "home": "" },
        });
        v.as_object().unwrap().clone()
    }

    #[test]
    fn claude_disabled_gives_a_codex_pair() {
        let (w, r, skipped) = resolve(&table(false), &Ok(())).unwrap();
        assert_eq!((w.model.as_str(), r.model.as_str(), w.effort.as_str()), ("w", "r", "medium"));
        assert_eq!(w.to_json(), json!({ "provider": "codex", "model": "w", "effort": "medium" }), "a Codex pick carries no account");
        assert!(skipped[0].starts_with("expertWriter claude/opus: Claude is not an executor of this run: not enabled"), "{skipped:?}");
        assert!(skipped.iter().any(|s| s.contains("reviewer codex/w: the same model as the writer")));
    }

    #[test]
    fn no_pair_is_refused_with_reasons() {
        let mut t = table(false);
        t.insert("reviewer".into(), json!({ "candidates": [{ "provider": "codex", "model": "w" }, { "provider": "other", "model": "x" }] }));
        let why = resolve(&t, &Ok(())).unwrap_err();
        assert!(why.starts_with("No writer/reviewer pair of distinct models") && why.contains("not a Codex or Claude candidate"), "{why}");
        let why = resolve(&table(false), &Err("Codex is not signed in".into())).unwrap_err();
        assert!(why.contains("codex/w: Codex is not signed in"), "{why}");
    }

    #[test]
    fn an_account_is_bound_only_by_the_gate() {
        let claude = Pick { provider: "claude".into(), model: "opus".into(), effort: "high".into(), account: "claude-0123456789abcdef".into() };
        assert_eq!(Pick::from_json(&claude.to_json()).account, claude.account, "the binding survives run.json");
        let mut t = table(false);
        t.insert(WRITER_ROLE.into(), json!({ "candidates": [{ "provider": "codex", "model": "w", "account": "claude-forged" }] }));
        let (w, _, _) = resolve(&t, &Ok(())).unwrap();
        assert_eq!(w.account, "", "a table cannot bind an account");
    }

    #[test]
    fn an_enabled_claude_without_a_home_is_skipped() {
        let (w, _, skipped) = resolve(&table(true), &Ok(())).unwrap();
        assert_eq!(w.provider, "codex");
        assert!(skipped[0].contains("claude/opus: Claude is not an executor"), "{skipped:?}");
    }

    #[test]
    fn a_claude_model_the_role_cannot_carry_is_skipped_before_any_program_runs() {
        let mut t = table(true);
        t.insert(CLAUDE_ENTRY.into(), json!({ "enabled": true, "home": "unused-home" }));
        t.insert(WRITER_ROLE.into(), json!({ "candidates": [{ "provider": "claude", "model": "opus[1m]" }, { "provider": "codex", "model": "w" }] }));
        let (w, _, skipped) = resolve(&t, &Ok(())).unwrap();
        assert_eq!(w.provider, "codex");
        assert!(skipped[0].contains("claude/opus[1m]: a Claude candidate needs a plain model name"), "{skipped:?}");
    }
}
