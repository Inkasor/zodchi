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
    #[doc(hidden)]
    pub fn name(&self) -> String {
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

/// The role table of the run: shipped defaults, home, repository and args; later sources replace whole roles. Whether Claude may
/// run comes from the person's own `flow.json`, never from a table or the args: whatever a table says under
/// `CLAUDE_ENTRY` is replaced.
pub fn table(cfg: &Config, repo: &Path, args_models: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let defaults: Value = serde_json::from_str(include_str!("../../../../models.json")).expect("the shipped role table is JSON");
    let mut t = defaults["roles"].as_object().expect("the shipped role table has roles").clone();
    t.extend(roles_of(&cfg.home.join("models.json"))?);
    t.extend(roles_of(&repo.join(".zodchi").join("models.json"))?);
    t.extend(args_models.clone());
    t.insert(CLAUDE_ENTRY.into(), json!({ "enabled": claude_enabled(cfg), "home": cfg.home.to_string_lossy() }));
    Ok(t)
}

pub use zodchi_core::claude::enabled as claude_enabled;

pub fn candidates(table: &Map<String, Value>, role: &str) -> Result<Vec<Pick>, String> {
    let Some(list) = table.get(role).and_then(|r| r.get("candidates")).and_then(Value::as_array) else {
        return Err(format!("Role {role} is not in the role table (~/.zodchi/models.json, .zodchi/models.json or args.models)"));
    };
    Ok(list.iter().map(|c| {
        let mut p = Pick::from_json(c);
        p.account = String::new(); // only the gate binds an account, never a table
        if p.effort.is_empty() {
            p.effort = if p.provider == "claude" && zodchi_core::claude::is_haiku(&p.model) {
                "high"
            } else {
                "medium"
            }.into();
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

/// Whether the local Codex gateway can take calls now: the subscription has limit left, or the limit is used up and
/// `flow.json` allows credits and the account has credits.
pub fn local_codex_usable(cfg: &Config) -> Result<(), String> {
    let account = zodchi_core::job::account(cfg);
    let usable = codex_usable(&account);
    if usable.is_err() && account["connected"] == json!(true) && crate::executor::flow_credits(cfg) {
        let wallet = &account["credits"];
        if wallet["hasCredits"] == json!(true) || wallet["unlimited"] == json!(true) {
            return Ok(());
        }
        return Err("the Codex subscription has no limit left and no credits (zodchi account)".into());
    }
    usable
}

/// Check the local subscription only if the walk reaches a Codex candidate, at most once per gate.
pub fn local_codex<'a>(cfg: &'a Config, server_refusal: &'static str) -> impl Fn() -> Result<(), String> + 'a {
    let availability = std::cell::OnceCell::new();
    move || availability.get_or_init(|| {
        if crate::executor::flow_server(cfg).is_some() {
            Err(server_refusal.into())
        } else {
            local_codex_usable(cfg)
        }
    }).clone()
}

/// How long a passed preflight of one CLI version, model and effort is taken as it is.
const PREFLIGHT_FRESH_MS: i128 = 24 * 3600 * 1000;
const PREFLIGHT_LIMIT: Duration = Duration::from_secs(180);
/// The prompt of the tiny structured call; it carries nothing of the run.
const PREFLIGHT_PROMPT: &str = "Step: preflight (zodchi flow)\n\nThis call only checks that the model answers in the asked form. Answer {\"ok\": true}.";

#[derive(Clone, Debug)]
pub enum ResolveError {
    Unavailable(String),
    // A preview cannot safely choose a fallback while this candidate's availability is unknown.
    PreflightRequired(String),
}

impl ResolveError {
    fn reason(self) -> String {
        match self {
            Self::Unavailable(why) | Self::PreflightRequired(why) => why,
        }
    }
}

/// The preflight of Claude on this machine at the gate, before anything is claimed: the program runs
/// (`claude --version`), it is signed in with a Claude subscription (`claude auth status`), and a tiny structured
/// call with the candidate's model and effort answers in its schema. The call is skipped when one of this CLI
/// version, account, model and effort passed less than a day ago (`claude-preflight.json` in the zodchi home). Each
/// model is checked once per gate; the program and the sign-in once. A usable candidate comes with the account it
/// is bound to.
pub struct ClaudeGate {
    enabled: bool,
    home: PathBuf,
    dry_run: bool,
    /// The program, its version and the account binding of its sign-in.
    program: Option<Result<(claude::Program, String, String), String>>,
    picks: HashMap<(String, String), Result<String, ResolveError>>,
}

impl ClaudeGate {
    pub fn of(table: &Map<String, Value>) -> ClaudeGate {
        let entry = table.get(CLAUDE_ENTRY);
        ClaudeGate {
            enabled: entry.and_then(|e| e.get("enabled")) == Some(&json!(true)),
            home: PathBuf::from(entry.and_then(|e| e.get("home")).and_then(Value::as_str).unwrap_or("")),
            dry_run: false,
            program: None,
            picks: HashMap::new(),
        }
    }

    /// Resolve a one-shot role in table order. Check workflow restrictions before running a preflight.
    /// Some roles have historically used the installed Codex role if the table has no entry.
    #[doc(hidden)]
    pub fn one_shot(
        &mut self,
        table: &Map<String, Value>,
        role: &str,
        fallback: Option<&Value>,
        skipped: &mut Vec<String>,
        mut check: impl FnMut(&Pick) -> Result<(), String>,
    ) -> Result<Pick, String> {
        let candidates = match fallback {
            Some(installed) if !table.contains_key(role) => vec![Pick::from_json(&json!({
                "provider": "codex", "model": installed["model"], "effort": installed["effort"],
            }))],
            _ => candidates(table, role)?,
        };
        let first_skip = skipped.len();
        for mut pick in candidates {
            let usable = check(&pick).and_then(|()| match pick.provider.as_str() {
                "claude" => self.usable(&pick),
                "codex" if !pick.model.is_empty() => Ok(String::new()),
                _ => Err("needs a Codex or Claude candidate with a model".into()),
            });
            match usable {
                Ok(account) => {
                    pick.account = account;
                    return Ok(pick);
                }
                Err(reason) => skipped.push(format!("{role} {}: {reason}", pick.name())),
            }
        }
        let reasons = &skipped[first_skip..];
        if reasons.is_empty() {
            Err(format!("No candidate for {role}."))
        } else {
            Err(format!("No available candidate for {role}. {}", reasons.join("; ")))
        }
    }

    /// Whether a Claude candidate may run: the account it is bound to, or the reason when it may not.
    pub fn usable(&mut self, p: &Pick) -> Result<String, String> {
        self.check_candidate(p).map_err(ResolveError::reason)
    }

    fn check_candidate(&mut self, p: &Pick) -> Result<String, ResolveError> {
        if !self.enabled || self.home.as_os_str().is_empty() {
            return Err(ResolveError::Unavailable("Claude is not an executor of this run: not enabled (\"claude\": true in ~/.zodchi/flow.json)".into()));
        }
        // The model goes into the request's role, which takes a plain model name: anything else would pass the
        // preflight and fail only at the first step.
        let plain = |s: &str| s.len() <= 64 && s.starts_with(|c: char| c.is_ascii_alphanumeric()) && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c));
        if !plain(&p.model) {
            return Err(ResolveError::Unavailable("a Claude candidate needs a plain model name (letters, digits, . - _)".into()));
        }
        let k = (p.model.clone(), p.effort.clone());
        if let Some(r) = self.picks.get(&k) {
            return r.clone();
        }
        let r = self.check(p);
        self.picks.insert(k, r.clone());
        r
    }

    fn scratch(&self) -> Result<PathBuf, String> {
        let dir = self.home.join("claude-preflight").join(format!("{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        Ok(dir)
    }

    fn check(&mut self, p: &Pick) -> Result<String, ResolveError> {
        let unavailable = |why| ResolveError::Unavailable(format!("Claude preflight: {why}"));
        if self.program.is_none() {
            let found = claude::find_program().and_then(|program| {
                // Version and sign-in are read-only probes. A preview runs them outside the checkout without scratch.
                let dir = if self.dry_run { std::env::temp_dir() } else { self.scratch()? };
                let r = claude::version(&program, &dir).and_then(|v| claude::signed_in(&program, &dir).map(|a| (v, a)));
                if !self.dry_run {
                    let _ = std::fs::remove_dir_all(&dir);
                }
                r.map(|(v, a)| (program, v, a))
            });
            self.program = Some(found);
        }
        let (program, version, account) = self.program.clone().expect("set above").map_err(unavailable)?;
        let cache = self.home.join("claude-preflight.json");
        let id = format!("{version}|{account}|{}|{}", p.model, p.effort);
        let passed = read_stored(&cache).and_then(|c| c.get(&id).and_then(Value::as_str).and_then(parse_iso_ms));
        if passed.is_some_and(|at| (0..PREFLIGHT_FRESH_MS).contains(&(now_ms() - at))) {
            return Ok(account);
        }
        if self.dry_run {
            return Err(ResolveError::PreflightRequired(format!(
                "--dry-run needs a fresh Claude preflight receipt for {} with effort {}. Checking this candidate would require a new model call.",
                p.model, p.effort,
            )));
        }
        let dir = self.scratch().map_err(unavailable)?;
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
            Err((_, why, _)) => Err(unavailable(format!("{} with effort {} did not answer a tiny structured call: {why}", p.model, p.effort))),
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn test_one_shot_gate(roles: &[&str], enabled: bool) -> (Map<String, Value>, ClaudeGate) {
    let mut table = Map::new();
    for role in roles {
        table.insert((*role).into(), json!({ "candidates": [
            { "provider": "claude", "model": "opus", "effort": "high", "account": "untrusted" },
            { "provider": "codex", "model": "fallback" },
        ] }));
    }
    table.insert(CLAUDE_ENTRY.into(), json!({ "enabled": enabled, "home": "test-home" }));
    let mut gate = ClaudeGate::of(&table);
    // Exercise the real gate's opt-in and ordering with a cached result, without spawning a program.
    gate.picks.insert(("opus".into(), "high".into()), Ok("claude-0123456789abcdef".into()));
    (table, gate)
}

/// The first writer candidate, in table order, that has an independent reviewer candidate; the first such reviewer.
/// A Codex candidate needs the Codex subscription usable (`codex`); a Claude candidate needs Claude enabled and its
/// preflight passed, run only for the candidates the walk reaches; a Claude pick comes back bound to the account of
/// its preflight. Returns the pair and every candidate skipped with its reason, or the refusal with those reasons.
pub fn resolve(table: &Map<String, Value>, codex: &Result<(), String>, writer_role: &str, local_writer: bool, prior_writers: &[String]) -> Result<(Pick, Pick, Vec<String>), String> {
    resolve_pair(table, codex, writer_role, local_writer, prior_writers, false).map_err(ResolveError::reason)
}

pub fn resolve_pair(
    table: &Map<String, Value>, codex: &Result<(), String>, writer_role: &str, local_writer: bool,
    prior_writers: &[String], dry_run: bool,
) -> Result<(Pick, Pick, Vec<String>), ResolveError> {
    let writers = candidates(table, writer_role).map_err(ResolveError::Unavailable)?;
    let reviewers = candidates(table, REVIEWER_ROLE).map_err(ResolveError::Unavailable)?;
    let mut gate = ClaudeGate::of(table);
    gate.dry_run = dry_run;
    let mut skipped = Vec::new();
    let mut usable = |p: &Pick| -> Result<String, ResolveError> {
        match p.provider.as_str() {
            "claude" => gate.check_candidate(p),
            "codex" if !p.model.is_empty() => codex.clone().map(|_| String::new()).map_err(ResolveError::Unavailable),
            _ => Err(ResolveError::Unavailable("not a Codex or Claude candidate with a model".into())),
        }
    };
    for w in &writers {
        if local_writer && w.provider != "codex" {
            skipped.push(format!("{writer_role} {}: agent mode uses the local Codex workspace", w.name()));
            continue;
        }
        let w_account = match usable(w) {
            Ok(a) => a,
            Err(ResolveError::Unavailable(why)) => {
                skipped.push(format!("{writer_role} {}: {why}", w.name()));
                continue;
            }
            Err(required @ ResolveError::PreflightRequired(_)) => return Err(required),
        };
        let mut reasons = Vec::new();
        for r in &reviewers {
            if r.provider == w.provider && r.model == w.model {
                reasons.push(format!("{REVIEWER_ROLE} {}: the same model as the writer", r.name()));
                continue;
            }
            if prior_writers.contains(&format!("{}/{}", r.provider, r.model)) {
                reasons.push(format!("{REVIEWER_ROLE} {}: authored part of the inherited candidate", r.name()));
                continue;
            }
            let r_account = match usable(r) {
                Ok(a) => a,
                Err(ResolveError::Unavailable(why)) => {
                    reasons.push(format!("{REVIEWER_ROLE} {}: {why}", r.name()));
                    continue;
                }
                Err(required @ ResolveError::PreflightRequired(_)) => return Err(required),
            };
            skipped.extend(reasons);
            let (mut w, mut r) = (w.clone(), r.clone());
            (w.account, r.account) = (w_account, r_account);
            return Ok((w, r, skipped));
        }
        skipped.push(format!("{writer_role} {}: no independent reviewer ({})", w.name(), reasons.join("; ")));
    }
    Err(ResolveError::Unavailable(format!("No writer/reviewer pair of distinct models: {}", skipped.join("; "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Map<String, Value> {
        let v = json!({
            "expertWriter": { "candidates": [{ "provider": "claude", "model": "opus", "effort": "high" }, { "provider": "codex", "model": "w" }] },
            "reviewer": { "candidates": [{ "provider": "codex", "model": "w" }, { "provider": "codex", "model": "r", "effort": "high" }] },
            "@claude": { "enabled": false, "home": "" },
        });
        v.as_object().unwrap().clone()
    }

    #[test]
    fn no_pair_is_refused_with_reasons() {
        let mut t = table();
        t.insert("reviewer".into(), json!({ "candidates": [{ "provider": "codex", "model": "w" }, { "provider": "other", "model": "x" }] }));
        let why = resolve(&t, &Ok(()), WRITER_ROLE, false, &[]).unwrap_err();
        assert!(why.starts_with("No writer/reviewer pair of distinct models") && why.contains("not a Codex or Claude candidate"), "{why}");
        let why = resolve(&table(), &Err("Codex is not signed in".into()), WRITER_ROLE, false, &[]).unwrap_err();
        assert!(why.contains("codex/w: Codex is not signed in"), "{why}");
    }

    #[test]
    fn an_account_is_bound_only_by_the_gate() {
        let mut t = table();
        t.insert(WRITER_ROLE.into(), json!({ "candidates": [{ "provider": "codex", "model": "w", "account": "claude-forged" }] }));
        let (w, _, _) = resolve(&t, &Ok(()), WRITER_ROLE, false, &[]).unwrap();
        assert_eq!(w.account, "", "a table cannot bind an account");
    }

    #[test]
    fn a_claude_model_the_role_cannot_carry_is_skipped_before_any_program_runs() {
        let mut t = table();
        t.insert(CLAUDE_ENTRY.into(), json!({ "enabled": true, "home": "unused-home" }));
        t.insert(WRITER_ROLE.into(), json!({ "candidates": [{ "provider": "claude", "model": "opus[1m]" }, { "provider": "codex", "model": "w" }] }));
        let (w, _, skipped) = resolve(&t, &Ok(()), WRITER_ROLE, false, &[]).unwrap();
        assert_eq!(w.provider, "codex");
        assert!(skipped[0].contains("claude/opus[1m]: a Claude candidate needs a plain model name"), "{skipped:?}");
    }
}
