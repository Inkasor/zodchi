//! Where things are: the repository of the call, its job folder, the installed roles, the Codex program and the
//! subscriptions (Codex homes) the user listed.

use crate::util::{fail, Result};
use serde_json::Value;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// One subscription: a Codex home with its own sign-in. The user lists them in the order to use them.
#[derive(Debug, Clone)]
pub struct Account {
    pub name: String,
    pub codex_home: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Config {
    /// The repository the call is for; jobs live in its `.agent-tmp/gateway/<key>/`.
    pub root: Option<PathBuf>,
    pub jobs_dir: Option<PathBuf>,
    /// `~/.zodchi` (or `$ZODCHI_HOME`).
    pub home: PathBuf,
    pub roles_dir: PathBuf,
    /// The Codex program: a native executable, or the `codex.js` of the npm package run by Node.
    pub codex_bin: PathBuf,
    pub accounts: Vec<Account>,
}

/// An environment variable that is set and not empty: an empty value counts as unset.
fn var_set(name: &str) -> Option<std::ffi::OsString> {
    env::var_os(name).filter(|v| !v.is_empty())
}

pub fn user_home() -> PathBuf {
    var_set("USERPROFILE")
        .or_else(|| var_set("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn git_top(cwd: &Path) -> Option<PathBuf> {
    let out = Command::new("git").arg("-C").arg(cwd).args(["rev-parse", "--show-toplevel"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else { std::path::absolute(text).ok() }
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The Codex program. `ZODCHI_CODEX_BIN` wins; then a native `codex` on PATH; then the `codex.js` of the npm
/// package beside the Node on PATH (npm's `codex.cmd` is a shell script and is never run).
pub fn find_codex() -> PathBuf {
    if let Some(bin) = var_set("ZODCHI_CODEX_BIN") {
        return PathBuf::from(bin);
    }
    if let Some(native) = on_path(if cfg!(windows) { &["codex.exe"] } else { &["codex"] }) {
        // On POSIX npm links `codex` to codex.js; that is run through Node like the other case.
        return native;
    }
    if let Some(node) = on_path(if cfg!(windows) { &["node.exe"] } else { &["node"] }) {
        let dir = node.parent().unwrap_or(Path::new("."));
        for candidate in [
            dir.join("node_modules/@openai/codex/bin/codex.js"),
            dir.join("../lib/node_modules/@openai/codex/bin/codex.js"),
        ] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("codex")
}

/// The subscriptions, from `~/.zodchi/accounts.json`: `{"accounts": [{"name": "...", "codexHome": "..."}]}` in the
/// order to use them. Without the file there is one: `$CODEX_HOME`, or `~/.codex`.
pub fn load_accounts(home: &Path) -> Result<Vec<Account>> {
    let file = home.join("accounts.json");
    if !file.exists() {
        let codex_home = var_set("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".codex"));
        return Ok(vec![Account { name: "default".into(), codex_home }]);
    }
    let text = std::fs::read_to_string(&file)?;
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return fail(format!("{} is not JSON", file.display())),
    };
    let mut accounts = Vec::new();
    for (index, entry) in value.get("accounts").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let codex_home = entry.get("codexHome").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || codex_home.is_empty() || accounts.iter().any(|a: &Account| a.name == name) {
            return fail(format!("{}: account {} needs a unique name and a codexHome", file.display(), index + 1));
        }
        let expanded = if let Some(rest) = codex_home.strip_prefix("~/") { user_home().join(rest) } else { PathBuf::from(codex_home) };
        accounts.push(Account { name, codex_home: expanded });
    }
    if accounts.is_empty() {
        return fail(format!("{} lists no accounts", file.display()));
    }
    Ok(accounts)
}

impl Config {
    pub fn new(root: Option<&Path>) -> Result<Config> {
        let top = match root {
            Some(r) => Some(std::path::absolute(r)?),
            None => git_top(&env::current_dir()?),
        };
        let home = var_set("ZODCHI_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".zodchi"));
        let accounts = load_accounts(&home)?;
        Ok(Config {
            jobs_dir: top.as_ref().map(|t| t.join(".agent-tmp").join("gateway")),
            root: top,
            roles_dir: var_set("ZODCHI_ROLES").map(PathBuf::from).unwrap_or_else(|| home.join("roles")),
            home,
            codex_bin: find_codex(),
            accounts,
        })
    }

    pub fn account(&self, name: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.name == name)
    }
}
