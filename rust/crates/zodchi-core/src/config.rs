//! Where things are: the repository of the call, its job folder, the installed roles, the Codex program and the
//! subscriptions (Codex homes) the user listed.

use crate::util::{fail, Result};
use serde_json::{json, Value};
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use crate::process::command_without_window;

// No cap by default (owner decision 2026-11-21): maxParallelJobs is an optional cap.
const DEFAULT_MAX_PARALLEL_JOBS: usize = usize::MAX;
const TENANT_MAX_PARALLEL_JOBS: usize = 2;

pub const AGENT_ENV: &str = "ZODCHI_AGENT";

pub fn agent_requested() -> bool {
    env::var_os(AGENT_ENV).is_some_and(|value| value == "1")
}

/// Use a fixed warning message for JSON and keep the original diagnostic for terminals.
pub fn cli_warning(
    agent: bool,
    kind: &'static str,
    message: &'static str,
    diagnostic: fmt::Arguments<'_>,
) {
    if agent {
        eprintln!("{}", json!({ "warning": { "kind": kind, "message": message } }));
    } else {
        eprintln!("{diagnostic}");
    }
}

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
    pub max_parallel_jobs: usize,
    /// A job root of its own, outside any repository (a user of the server): no Git, no ignore check.
    pub standalone: bool,
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

pub fn is_source_commit(commit: &str) -> bool {
    matches!(commit.len(), 40 | 64)
        && commit.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A DEV executable installed under its source revision can pin that revision in a new run.
pub fn dev_build_commit(home: &Path) -> Option<String> {
    let builds = std::fs::canonicalize(home.join("dev-builds")).ok()?;
    let binary = std::fs::canonicalize(env::current_exe().ok()?).ok()?;
    let root = binary.parent()?.parent()?;
    if root.parent()? != builds {
        return None;
    }
    let commit = root.file_name()?.to_str()?;
    is_source_commit(commit).then(|| commit.to_owned())
}

fn git_top(cwd: &Path) -> Option<PathBuf> {
    let out = command_without_window("git").arg("-C").arg(cwd).args(["rev-parse", "--show-toplevel"]).output().ok()?;
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

fn load_max_parallel_jobs(home: &Path, agent: bool) -> usize {
    let file = home.join("config.json");
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                cli_warning(
                    agent,
                    "config",
                    "Cannot read config.json. Using no limit on parallel jobs.",
                    format_args!("Cannot read config.json ({e}). Using no limit on parallel jobs."),
                );
            }
            return DEFAULT_MAX_PARALLEL_JOBS;
        }
    };
    let Ok(Value::Object(config)) = serde_json::from_slice(&bytes) else {
        let message = "Expected a JSON object in config.json. Using no limit on parallel jobs.";
        cli_warning(agent, "config", message, format_args!("{message}"));
        return DEFAULT_MAX_PARALLEL_JOBS;
    };
    let Some(value) = config.get("maxParallelJobs") else {
        return DEFAULT_MAX_PARALLEL_JOBS;
    };
    match value.as_u64().and_then(|n| usize::try_from(n).ok()) {
        Some(0) => DEFAULT_MAX_PARALLEL_JOBS,
        Some(limit) => limit,
        None => {
            let message = "Invalid maxParallelJobs in config.json. Expected a positive integer (0 means no limit). Using no limit on parallel jobs.";
            cli_warning(agent, "config", message, format_args!("{message}"));
            DEFAULT_MAX_PARALLEL_JOBS
        }
    }
}

fn local_roles(home: &Path) -> PathBuf {
    if let Some(path) = var_set("ZODCHI_ROLES") {
        return PathBuf::from(path);
    }
    let bundled = (|| {
        let executable = std::env::current_exe().ok()?;
        let directory = executable.parent()?.parent()?;
        let manifest = crate::util::read_stored(&directory.join("release.json"))?;
        if manifest["version"] != env!("CARGO_PKG_VERSION")
            || directory.join(manifest["cli"].as_str()?) != executable
        {
            return None;
        }
        let roles = directory.join("roles");
        roles.is_dir().then_some(roles)
    })();
    bundled.unwrap_or_else(|| home.join("roles"))
}

impl Config {
    /// Explicit non-Git directory for local expert jobs. Keep their journal in the user's Zodchi home.
    pub fn context(root: &Path) -> Result<Config> {
        Self::load_context(root, agent_requested())
    }

    pub fn new(root: Option<&Path>) -> Result<Config> {
        Self::load(root, agent_requested())
    }

    /// The CLI can also enable JSON warnings for redirected status --json.
    pub fn for_cli(root: Option<&Path>, context: Option<&Path>, agent: bool) -> Result<Config> {
        match (root, context) {
            (Some(_), Some(_)) => fail("--root and --context exclude each other."),
            (None, Some(path)) => Self::load_context(path, agent),
            _ => Self::load(root, agent),
        }
    }

    fn load_context(root: &Path, agent: bool) -> Result<Config> {
        let root = std::fs::canonicalize(root)?;
        if !root.is_dir() {
            return fail("A local gateway context must be a directory.");
        }
        let mut config = Self::load(Some(&root), agent)?;
        let digest = crate::util::sha256_hex(root.to_string_lossy().as_bytes());
        config.jobs_dir = Some(config.home.join("local-jobs").join(digest));
        config.standalone = true;
        Ok(config)
    }

    fn load(root: Option<&Path>, agent: bool) -> Result<Config> {
        let top = match root {
            Some(r) => Some(std::path::absolute(r)?),
            None => git_top(&env::current_dir()?),
        };
        let home = var_set("ZODCHI_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".zodchi"));
        let accounts = load_accounts(&home)?;
        Ok(Config {
            jobs_dir: top.as_ref().map(|t| t.join(".agent-tmp").join("gateway")),
            root: top,
            roles_dir: local_roles(&home),
            max_parallel_jobs: load_max_parallel_jobs(&home, agent),
            home,
            codex_bin: find_codex(),
            accounts,
            standalone: false,
        })
    }

    /// The Config of one user of the server, and nothing else: jobs in `<data>/users/<id>/jobs`, the only account
    /// `<data>/users/<id>/codex-home`. It never reads `accounts.json` and needs no repository. Fails closed: a user id
    /// outside `[a-z0-9-]{1,40}` or a data folder that cannot be made absolute builds no Config.
    pub fn tenant(data_root: &Path, user_id: &str) -> Result<Config> {
        if !crate::util::is_user_id(user_id) {
            return fail(format!("Not a user id: {user_id:?}; a user id is 1-40 characters a-z 0-9 -."));
        }
        let data = std::path::absolute(data_root)?;
        let user = data.join("users").join(user_id);
        let home = var_set("ZODCHI_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".zodchi"));
        Ok(Config {
            root: None,
            jobs_dir: Some(user.join("jobs")),
            max_parallel_jobs: TENANT_MAX_PARALLEL_JOBS,
            roles_dir: var_set("ZODCHI_ROLES").map(PathBuf::from).unwrap_or_else(|| home.join("roles")),
            home,
            codex_bin: find_codex(),
            accounts: vec![Account { name: user_id.to_string(), codex_home: user.join("codex-home") }],
            standalone: true,
        })
    }

    pub fn account(&self, name: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.name == name)
    }
}
