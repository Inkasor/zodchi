use crate::args::{self, Args};
use crate::checks::{self, CheckBatch, CheckOutcome, CheckSlot, CommandEnvironment, ProjectPaths};
use crate::git::Git;
use crate::journal::{self, Journal};
use crate::{input_common, Exit};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zodchi_core::{config::Config, util::{fail, iso, GatewayError, Result}};

pub const CONFIG: &str = ".zodchi/verify.json";
pub const LEGACY_SKILL: &str = ".claude/skills/verify/SKILL.md";
pub const PROJECT_SKILL: &str = ".agents/skills/verify/SKILL.md";
pub const NAME: &str = "verify";
pub const VERSION: &str = "1";
const STEP: &str = "verify";

#[derive(Clone, Copy)]
pub enum Selection {
    All,
    Checks,
    Verify,
}

#[derive(Clone, Debug, Default)]
pub struct ProjectSettings {
    pub cache: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub tools: Vec<String>,
}

impl ProjectSettings {
    fn configured(value: &Value, cache: &Path) -> Result<Self> {
        let mut settings = Self::from_json(value)?;
        expand_environment(&mut settings.env, "env", "{cache}", &cache.to_string_lossy())?;
        Ok(settings)
    }

    fn select_tools<'a>(
        &mut self,
        value: &Value,
        os: &str,
        commands: impl IntoIterator<Item = &'a str>,
        host: impl FnOnce(&BTreeMap<String, String>) -> Option<String>,
    ) {
        // This pair of Windows tools is needed by Rust GNU targets. Plain tools always remain required.
        if os == "windows" && self.tools.iter().any(|name| name == "cargo") && ["dlltool", "as"].iter().all(|&name| {
            value["tools"].as_array().is_some_and(|list| list.iter().any(|entry| entry["name"] == name && entry["os"] == "windows")
                && !list.iter().any(|entry| entry == name))
        }) && !commands.into_iter().any(selects_rust) && uses_msvc(&self.env, host)
        {
            self.tools.retain(|name| !matches!(name.as_str(), "dlltool" | "as"));
        }
    }

    pub fn load<'a>(git: &Git, base: &str, head: &str, paths: &ProjectPaths, commands: impl Iterator<Item = &'a String>) -> Result<Self> {
        match config_at(git, base)? {
            Some(value) => {
                let mut settings = Self::configured(&value, &paths.cache)?;
                settings.select_tools(&value, std::env::consts::OS, commands.map(String::as_str),
                    |env| rust_host(git, head, paths, env));
                Ok(settings)
            }
            None => Ok(Self::default()),
        }
    }

    pub fn from_json(value: &Value) -> Result<Self> {
        Ok(Self {
            tools: tools(value.get("tools"), std::env::consts::OS)?,
            cache: cache(value.get("cache"))?,
            env: environment(value.get("env"), "env", None)?,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "tools": self.tools, "cache": self.cache, "env": self.env })
    }
}

#[derive(Clone, Debug, Default)]
pub struct WriterSettings {
    pub env: BTreeMap<String, String>,
    pub cache: Option<PathBuf>,
}

impl WriterSettings {
    fn configured(value: &Value, project_cache: &Path, browser: Option<&str>) -> Result<Self> {
        let mut env = environment(value.get("writerEnv"), "writerEnv", browser)?;
        let mut cache = None;
        if env.values().any(|value| value.contains("{writerCache}")) {
            let path = project_cache.join("writer");
            let text = path.to_str().ok_or_else(|| GatewayError("The writer cache path must be Unicode.".into()))?;
            expand_environment(&mut env, "writerEnv", "{writerCache}", text)?;
            cache = Some(path);
        }
        Ok(Self { env, cache })
    }

    pub(crate) fn from_pin(plan: &Value, browser: Option<&str>) -> Result<Self> {
        let env = environment(plan.get("writerEnv"), "writerEnv", browser)?;
        let cache = plan.get("writerCache").map(|value| {
            value.as_str().filter(|path| valid_env_value(path)).map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.file_name().is_some_and(|name| name == "writer"))
                .ok_or_else(|| GatewayError("The pinned verification plan has an invalid writer cache path.".into()))
        }).transpose()?;
        Ok(Self { env, cache })
    }
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub setup: Vec<String>,
    pub setup_source: &'static str,
    pub checks: Vec<String>,
    pub verify: Vec<String>,
    project: ProjectSettings,
    writer: WriterSettings,
    pub check_source: &'static str,
    pub verify_source: &'static str,
    pub full_local: Vec<String>,
    pub full_in_ci: bool,
}

impl Plan {
    #[doc(hidden)]
    pub fn project(&self) -> &ProjectSettings {
        &self.project
    }

    #[doc(hidden)]
    pub fn writer(&self) -> &WriterSettings {
        &self.writer
    }

    pub fn legacy(args: &Args) -> Self {
        Self::from_commands(args.setup.clone(), args.checks.clone(), args.verify.clone())
    }

    fn from_commands(setup: Vec<String>, checks: Vec<String>, verify: Vec<String>) -> Self {
        Self {
            setup, setup_source: "args.setup", checks, verify,
            project: ProjectSettings::default(), writer: WriterSettings::default(),
            check_source: "checks", verify_source: "args.verify",
            full_local: vec![], full_in_ci: false,
        }
    }

    #[doc(hidden)]
    pub fn load(git: &Git, base: &str, args: &Args, paths: &ProjectPaths) -> Result<Self> {
        Self::legacy(args).configure(git, base, paths, Some(args), None, Selection::All)
    }

    fn for_commit(git: &Git, commit: &str, paths: &ProjectPaths, overrides: &Value, selection: Selection) -> Result<Self> {
        let fields = overrides.as_object()
            .ok_or_else(|| GatewayError("Verification args must be a JSON object.".into()))?;
        if let Some(key) = fields.keys().find(|key| !["setup", "checks", "verify", "tools", "env"].contains(&key.as_str())) {
            return fail(format!("Unknown verification argument: {key}"));
        }
        let commands = |name| args::commands(fields.get(name), name).map_err(GatewayError);
        let plan = Self::from_commands(commands("setup")?, commands("checks")?, commands("verify")?)
            .configure(git, commit, paths, None, Some(overrides), selection)?;
        if plan.checks.is_empty() && plan.verify.is_empty() && plan.full_local.is_empty() {
            return fail("No verification commands selected. Declare checks or verify in the project plan or --args.");
        }
        Ok(plan)
    }

    fn configure(mut self, git: &Git, base: &str, paths: &ProjectPaths, package: Option<&Args>, overrides: Option<&Value>, selection: Selection) -> Result<Self> {
        let configured = config_at(git, base)?;
        if configured.is_none() && self.verify.is_empty() && !matches!(selection, Selection::Checks) {
            for path in [PROJECT_SKILL, LEGACY_SKILL] {
                if git.exists_at(base, path)? {
                    return fail(format!("The repository has a verify skill ({path}); pass its commands as args.verify or declare them in {CONFIG}."));
                }
            }
        }
        let mut value = configured.unwrap_or_else(|| json!({}));
        if let Some(overrides) = overrides {
            if let Some(tools) = overrides.get("tools") {
                value["tools"] = tools.clone();
            }
            if let Some(extra) = overrides.get("env") {
                let mut env = environment(value.get("env"), "env", None)?;
                for (name, value) in environment(Some(extra), "env", None)? {
                    env.retain(|key, _| !key.eq_ignore_ascii_case(&name));
                    env.insert(name, value);
                }
                value["env"] = json!(env);
            }
        }
        let commands = |value, name| args::commands(value, name).map_err(|why| GatewayError(format!("{CONFIG}: {why}")));
        let setup = commands(value.get("setup"), "setup")?;
        let checks = commands(value.get("checks"), "checks")?;
        let verify = commands(value.get("verify"), "verify")?;
        self.project = ProjectSettings::configured(&value, &paths.cache)?;
        let browser = package.and_then(|args| args.browser.as_ref()).map(|(name, _)| name.as_str());
        let writer = WriterSettings::configured(&value, &paths.cache, browser)?;
        if package.is_some_and(|args| args.agent) {
            self.writer = writer;
        }
        if package.is_none_or(|args| args.agent) && self.setup.is_empty() && !setup.is_empty() {
            self.setup = setup;
            self.setup_source = "project.setup";
        }
        if self.checks.is_empty() && !checks.is_empty() {
            self.checks = checks;
            self.check_source = "project.checks";
        }
        if self.verify.is_empty() && !verify.is_empty() {
            self.verify = verify;
            self.verify_source = "project.verify";
        }
        if let Some(full) = value.get("full") {
            if full.as_object().is_none_or(|o| o.keys().any(|key| key != "run" && key != "commands")) {
                return fail(format!("{CONFIG}: full is an object with run and optional commands"));
            }
            let full_commands = commands(full.get("commands"), "full.commands")?;
            match full["run"].as_str() {
                Some("local") if !full_commands.is_empty() => self.full_local = full_commands,
                Some("ci") if full_commands.is_empty() => self.full_in_ci = true,
                _ => return fail(format!("{CONFIG}: full.run is local with commands, or ci with commands defined by CI")),
            }
        }
        match selection {
            Selection::Checks => {
                self.verify.clear();
                self.full_local.clear();
            }
            Selection::Verify => self.checks.clear(),
            Selection::All => {}
        }
        let setup_env = (!self.setup.is_empty() && !self.writer.env.is_empty()).then(|| self.setup_environment());
        self.project.select_tools(&value, std::env::consts::OS,
            self.setup.iter().chain(&self.checks).chain(&self.verify).chain(&self.full_local).map(String::as_str),
            |env| {
                // Setup can select a different Rust toolchain or target from the check commands.
                let host = |env: &BTreeMap<String, String>| rust_host(git, base, paths, env);
                if setup_env.as_ref().is_some_and(|setup| setup != env && !uses_msvc(setup, &host)) {
                    return None;
                }
                host(env)
            });
        Ok(self)
    }

    #[doc(hidden)]
    pub fn setup_environment(&self) -> BTreeMap<String, String> {
        let mut env = self.project.env.clone();
        for (name, value) in &self.writer.env {
            if cfg!(windows) {
                env.retain(|existing, _| !existing.eq_ignore_ascii_case(name));
            }
            env.insert(name.clone(), value.clone());
        }
        env
    }

    pub fn to_json(&self) -> Value {
        let mut plan = self.project.to_json();
        if !self.writer.env.is_empty() {
            plan["writerEnv"] = json!(self.writer.env);
        }
        if let Some(cache) = &self.writer.cache {
            plan["writerCache"] = json!(cache);
        }
        plan["setup"] = json!(self.setup);
        plan["setupSource"] = json!(self.setup_source);
        plan["checks"] = json!(self.checks);
        plan["verify"] = json!(self.verify);
        plan["checkSource"] = json!(self.check_source);
        plan["verifySource"] = json!(self.verify_source);
        plan["fullLocal"] = json!(self.full_local);
        plan["fullInCi"] = json!(self.full_in_ci);
        plan
    }

    pub fn from_run(run: &Value, args: &Args) -> Result<Self> {
        let Some(plan) = run.get("verificationPlan") else { return Ok(Self::legacy(args)) };
        Self::from_pin(plan, args.browser.as_ref().map(|(name, _)| name.as_str()))
    }

    fn from_pin(plan: &Value, browser: Option<&str>) -> Result<Self> {
        let commands = |key| {
            let list = plan.get(key).and_then(Value::as_array)
                .ok_or_else(|| GatewayError(format!("The pinned verification plan has no {key} list.")))?;
            list.iter().map(|command| {
                command.as_str().filter(|s| !s.trim().is_empty()).map(String::from)
                    .ok_or_else(|| GatewayError(format!("The pinned verification plan has an invalid {key} command.")))
            }).collect::<Result<Vec<_>>>()
        };
        // Runs created before writer setup was introduced have neither of these fields.
        let setup = if plan.get("setup").is_some() { commands("setup")? } else { vec![] };
        let setup_source = match plan["setupSource"].as_str() {
            Some("project.setup") => "project.setup",
            Some("args.setup") => "args.setup",
            None if setup.is_empty() => "args.setup",
            _ => return fail("The pinned verification plan has no valid setup source."),
        };
        let check_source = match plan["checkSource"].as_str() {
            Some("checks") => "checks",
            Some("project.checks") => "project.checks",
            _ => return fail("The pinned verification plan has no valid check source."),
        };
        let verify_source = match plan["verifySource"].as_str() {
            Some("args.verify") => "args.verify",
            Some("project.verify") => "project.verify",
            _ => return fail("The pinned verification plan has no valid verify source."),
        };
        let full_in_ci = plan["fullInCi"].as_bool().ok_or_else(|| GatewayError("The pinned verification plan has no CI policy.".into()))?;
        Ok(Self {
            setup, setup_source,
            checks: commands("checks")?, verify: commands("verify")?, project: ProjectSettings::from_json(plan)?, check_source, verify_source,
            writer: WriterSettings::from_pin(plan, browser)?,
            full_local: commands("fullLocal")?, full_in_ci,
        })
    }
}

/// Resolve the ref and pin its plan before either the caller or a detached worker runs it.
pub fn prepare(reference: &str, repo: Option<&Path>, overrides: &Value, selection: Selection) -> Result<(String, Journal)> {
    let directory = repo.map(Path::to_path_buf).map_or_else(std::env::current_dir, Ok)?;
    let top = Git::new(&directory).run(&["rev-parse", "--show-toplevel"])?;
    let git = Git::new(Path::new(top.trim_end_matches(['\r', '\n'])));
    let commit = git.rev(&format!("{reference}^{{commit}}"))
        .map_err(|_| GatewayError(format!("Cannot resolve {reference:?} to a commit.")))?;
    let tree = git.rev(&format!("{commit}^{{tree}}"))?;
    let cfg = Config::new(Some(&git.root))?;
    let home = std::path::absolute(&cfg.home)?;
    let paths = ProjectPaths::new(&home, &git)?;
    let plan = Plan::for_commit(&git, &commit, &paths, overrides, selection)?;
    let id = journal::new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": git.root, "commit": commit, "tree": tree,
        "verificationPlan": plan.to_json(), "inputs": { "args": overrides },
    });
    let journal = Journal::create(&home, &id, &run)?;
    Ok((id, journal))
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let cfg = Config::new(None)?;
    let home = std::path::absolute(&cfg.home)?;
    let (mut journal, run) = Journal::open(&home, id)?;
    if run["workflow"] != NAME || run["version"] != VERSION
        || given.is_some_and(|args| !input_common::args_match(&run["inputs"], args))
    {
        return fail(format!("Run {id} does not match this verify command."));
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        if retry.is_some() {
            return fail(format!("Run {id} has finished."));
        }
        return finish(&mut journal, result, true);
    }
    if let Some(step) = retry {
        if step != STEP || !journal.last_event().is_some_and(|event| event["kind"] == "stop" && event["step"] == step) {
            return fail("--rerun must name the stopped verify step.");
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }

    let pinned = |field| run[field].as_str()
        .ok_or_else(|| GatewayError(format!("The verification run has no pinned {field}.")));
    let git = Git::new(Path::new(pinned("repo")?));
    let commit = pinned("commit")?;
    let tree = pinned("tree")?;
    let plan = Plan::from_pin(&run["verificationPlan"], None)?;
    let paths = ProjectPaths::new(&home, &git)?;
    let mut places = input_common::places(&cfg, &[json!({ "root": git.root })]);
    places.extend(paths.private_places());
    let scrubber = input_common::Scrubber::new(&cfg)?;
    let attempt = journal.attempt(STEP);
    let outcome = run_checks(&mut journal, &home, &git, commit, tree, &paths, &plan, attempt);
    let (evidence, stop) = match outcome {
        Ok(CheckOutcome::Finished { evidence, .. }) => (evidence, None),
        Ok(CheckOutcome::Unknown(why)) | Err(GatewayError(why)) => {
            let evidence = journal.all("check ended", STEP, attempt).into_iter()
                .filter_map(|event| event.get("result").cloned()).collect();
            (evidence, Some(scrubber.text(&why, &places)))
        }
    };
    let passed = stop.is_none() && !evidence.is_empty() && checks::passed(&evidence);
    let budget = 32 * 1024 / 6 / evidence.len().max(1);
    let commands: Vec<_> = evidence.iter().map(|item| {
        let log = Path::new(item["log"].as_str().unwrap_or(""));
        let output = checks::review_output(log, budget, |raw| scrubber.text(raw, &places));
        let source = if item["source"] == "project.full" { json!("verify") } else { item["source"].clone() };
        json!({
            "command": scrubber.text(item["command"].as_str().unwrap_or(""), &places),
            "source": source, "exitCode": item["exitCode"], "ms": item["ms"], "log": item["log"],
            "output": output, "note": scrubber.text(item["note"].as_str().unwrap_or(""), &places),
        })
    }).collect();
    let receipt: Vec<_> = commands.iter().filter(|_| stop.is_none())
        .map(|row| json!({ "command": row["command"], "exitCode": row["exitCode"], "output": row["output"] })).collect();
    let mut result = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "journal": journal.dir,
        "verdict": if passed { "passed" } else { "failed" }, "commit": commit, "tree": tree,
        "commands": commands, "receipt": { "head": commit, "tree": tree, "commands": receipt },
    });
    if let Some(why) = stop {
        result["stoppedAt"] = json!(STEP);
        result["infra"] = json!(why);
        journal.append(json!({ "kind": "stop", "step": STEP, "stoppedAt": STEP, "what": why }))?;
        return Ok(Exit { result, code: 2 });
    }
    finish(&mut journal, result, false)
}

#[allow(clippy::too_many_arguments)]
fn run_checks(journal: &mut Journal, home: &Path, git: &Git, commit: &str, tree: &str, paths: &ProjectPaths, plan: &Plan, attempt: u32) -> Result<CheckOutcome> {
    checks::preflight()?;
    checks::preflight_tools(&plan.project.tools)?;
    let mut slot = CheckSlot::acquire(home, journal, STEP, attempt)?;
    checks::reap_unended(journal)?;
    let logs = journal.file(&format!("logs/verify-{attempt}"));
    let batch = CheckBatch {
        step: STEP, round: 1, attempt, tree, head: Some(commit), logs: &logs, limit: Duration::from_secs(3600),
        environment: CommandEnvironment { repo: Some(&git.root), extra: Some(&plan.project.env) },
        checks: ("checks", &plan.checks),
        verify: ("verify", &plan.verify),
    };
    batch.run_prepared(&mut slot, journal, paths, &plan.project.cache, checks::AdditionalChecks {
        setup: &plan.setup, full: &plan.full_local,
    }, |staging| {
        let snapshot = git.init_snapshot(staging)?;
        snapshot.run(&["reset", "--hard", "--quiet", "--no-recurse-submodules", commit])?;
        Ok(())
    })
}

fn finish(journal: &mut Journal, result: Value, saved: bool) -> Result<Exit> {
    if !saved {
        journal.write_value("result.json", &result)?;
    }
    if journal::finished_event(journal.events(), Some(&result)).is_none() {
        journal.append(json!({ "kind": "finished", "step": STEP, "verdict": result["verdict"] }))?;
    }
    let code = if result["verdict"] == "passed" { 0 } else { 2 };
    Ok(Exit { result, code })
}

/// Attach a finished verify receipt to another commit with the same tree in the same checkout.
pub fn run_evidence(journal: &Journal, run: &Value, id: &str, repo: &Path, tree: &str) -> Result<Option<Value>> {
    if run["workflow"] != NAME || run["runId"] != id {
        return fail(format!("Run {id} is not a verify run."));
    }
    let pinned_repo = run["repo"].as_str().filter(|path| Path::new(path).is_absolute())
        .and_then(|path| std::fs::canonicalize(path).ok());
    if pinned_repo.as_deref() != Some(std::fs::canonicalize(repo)?.as_path()) {
        return fail(format!("Run {id} belongs to a different checkout."));
    }
    let events = journal.snapshot()?;
    let Some(result) = journal.read_value("result.json").filter(|result| {
        journal::finished_event(&events, Some(result)).is_some()
            && result["runId"] == id && result["verdict"] == "passed"
            && result["tree"] == tree && run["tree"] == tree && run["commit"] == result["commit"]
            && result["receipt"]["tree"] == tree && result["receipt"]["head"] == result["commit"]
    }) else { return Ok(None) };
    let commands = &result["receipt"]["commands"];
    if !commands.as_array().is_some_and(|rows| !rows.is_empty() && checks::passed(rows)) {
        return Ok(None);
    }
    Ok(Some(json!({ "runId": id, "tree": tree, "commit": result["commit"], "commands": commands })))
}

fn config_at(git: &Git, base: &str) -> Result<Option<Value>> {
    let Some(bytes) = git.show(base, CONFIG)? else {
        if git.exists_at(base, CONFIG)? {
            return fail(format!("{CONFIG} in the base must be a regular file"));
        }
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| GatewayError(format!("{CONFIG}: {e}")))?;
    let Some(fields) = value.as_object() else {
        return fail(format!("{CONFIG} must be an object"));
    };
    if let Some(key) = fields.keys().find(|key| !["setup", "checks", "verify", "full", "tools", "cache", "env", "writerEnv"].contains(&key.as_str())) {
        return fail(format!("{CONFIG}: unexpected field {key:?}"));
    }
    Ok(Some(value))
}

fn tools(value: Option<&Value>, current_os: &str) -> Result<Vec<String>> {
    let Some(value) = value else { return Ok(vec![]) };
    let invalid = || GatewayError(format!("{CONFIG}.tools must list command names on PATH, or objects with name and os (windows, linux or macos)."));
    let mut selected = Vec::new();
    for tool in value.as_array().ok_or_else(invalid)? {
        let (name, os) = match tool {
            Value::String(name) => (name.as_str(), None),
            Value::Object(object) if object.len() == 2 => {
                let name = tool["name"].as_str().ok_or_else(invalid)?;
                let os = tool["os"].as_str().filter(|os| matches!(*os, "windows" | "linux" | "macos")).ok_or_else(invalid)?;
                (name, Some(os))
            }
            _ => return Err(invalid()),
        };
        if !name.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) {
            return Err(invalid());
        }
        if os.is_none_or(|os| os == current_os) {
            selected.push(name.to_string());
        }
    }
    Ok(selected)
}

fn env_value<'a>(env: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    // Windows environment names are case-insensitive, including under Git Bash.
    env.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

fn msvc_target(target: &str) -> bool {
    target.ends_with("-windows-msvc")
        && target.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn uses_msvc(env: &BTreeMap<String, String>, host: impl FnOnce(&BTreeMap<String, String>) -> Option<String>) -> bool {
    // Cargo can build both target crates and host-side build scripts or proc macros.
    env_value(env, "CARGO_BUILD_TARGET").is_none_or(msvc_target) && host(env).is_some_and(|host| msvc_target(&host))
}

const RUST_COMPILER_ENV: &[&str] = &[
    "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
];

fn selects_rust(command: &str) -> bool {
    // Shell commands can choose their own target, configuration or toolchain. Leave the requirements in place
    // when the command names an override whose effective value the launcher cannot establish.
    let mut words = command.split(|ch: char| ch.is_whitespace() || matches!(ch, '&' | '|' | ';' | '(' | ')'))
        .filter(|word| !word.is_empty())
        .map(|word| word.trim_matches(['"', '\'']));
    while let Some(word) = words.next() {
        let config = if word == "--config" { Some(words.next().unwrap_or_default()) } else { word.strip_prefix("--config=") };
        if config.is_some_and(|argument| !profile_override(argument))
            || word == "--target" || word.starts_with("--target=")
            || word.starts_with('+')
            || word.split_once('=').is_some_and(|(key, _)| {
                let key = key.to_ascii_uppercase();
                matches!(key.as_str(), "CARGO_BUILD_TARGET" | "RUSTUP_TOOLCHAIN") || RUST_COMPILER_ENV.contains(&key.as_str())
            }) {
            return true;
        }
    }
    false
}

fn profile_override(argument: &str) -> bool {
    // A literal assignment to a dotted profile key cannot configure Cargo's compiler or target.
    // Config files, shell expansions and other keys are unresolved here.
    let Some((key, value)) = argument.trim_matches(['"', '\'']).split_once('=') else { return false };
    let Some(key) = key.strip_prefix("profile.") else { return false };
    let bare = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    key.contains('.') && key.split('.').all(bare) && bare(value.trim_matches(['"', '\'']))
}

fn rust_host(git: &Git, tree: &str, paths: &ProjectPaths, env: &BTreeMap<String, String>) -> Option<String> {
    let pinned_toolchain = env_value(env, "RUSTUP_TOOLCHAIN").is_some_and(|toolchain| !toolchain.is_empty());
    if RUST_COMPILER_ENV.iter().any(|name| env_value(env, name).is_some_and(|value| !value.is_empty())) {
        return None;
    }
    let files = git.run(&["ls-tree", "-r", "--name-only", "-z", tree]).ok()?;
    if files.split('\0').any(|path| {
        let path = path.to_ascii_lowercase();
        cargo_config(&path) || (!pinned_toolchain && matches!(path.rsplit('/').next(), Some("rust-toolchain" | "rust-toolchain.toml")))
    }) {
        return None;
    }
    let parent = paths.check_root();
    let in_scope = parent.ancestors().flat_map(|dir| [dir.join(".cargo/config"), dir.join(".cargo/config.toml")]);
    let cargo_home = std::env::var_os("CARGO_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|| zodchi_core::config::user_home().join(".cargo"));
    if in_scope.chain([cargo_home.join("config"), cargo_home.join("config.toml")]).any(|file| file.exists()) {
        return None;
    }
    // Probe outside the live repository, whose uncommitted toolchain files and directory overrides are
    // absent from the verification export. The pinned variables are the ones the check shell receives.
    let cwd = parent.ancestors().find(|dir| dir.is_dir())?;
    let out = rust_version_command(cwd, env).output().ok()?;
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).lines().find_map(|line| line.strip_prefix("host: ")).map(String::from)
}

fn rust_version_command(cwd: &Path, env: &BTreeMap<String, String>) -> std::process::Command {
    let mut command = zodchi_core::process::command_without_window("rustc");
    checks::keep_environment(&mut command);
    command.arg("-vV").current_dir(cwd).envs(env).stdin(std::process::Stdio::null());
    command
}

fn cargo_config(path: &str) -> bool {
    path.rsplit_once('/').is_some_and(|(parent, name)| {
        matches!(name, "config" | "config.toml") && (parent == ".cargo" || parent.ends_with("/.cargo"))
    })
}

const MAX_ENTRIES: usize = 16;

fn cache(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value else { return Ok(vec![]) };
    let invalid = || GatewayError(format!("{CONFIG}.cache must list up to {MAX_ENTRIES} relative folders without dot segments or Git metadata."));
    let list = value.as_array().filter(|list| list.len() <= MAX_ENTRIES).ok_or_else(invalid)?;
    list.iter().map(|entry| {
        let entry = entry.as_str().ok_or_else(invalid)?.replace('\\', "/");
        let path = entry.trim_end_matches('/');
        if path.contains([':', '<', '>', '"', '|', '?', '*']) || path.chars().any(char::is_control)
            || path.split('/').any(|part| part.is_empty() || part.ends_with(['.', ' ']) || part.eq_ignore_ascii_case(".git"))
            || Path::new(path).is_absolute() {
            return Err(invalid());
        }
        Ok(path.to_string())
    }).collect()
}

fn valid_env_value(value: &str) -> bool {
    !value.contains(['\0', '\r', '\n', '\u{0085}', '\u{2028}', '\u{2029}'])
}

fn expand_environment(env: &mut BTreeMap<String, String>, field: &str, placeholder: &str, path: &str) -> Result<()> {
    for value in env.values_mut() {
        *value = value.replace(placeholder, path);
        if !valid_env_value(value) {
            return fail(format!("{CONFIG}.{field} expands to a value containing a newline or NUL."));
        }
    }
    Ok(())
}

fn environment(value: Option<&Value>, field: &str, reserved: Option<&str>) -> Result<BTreeMap<String, String>> {
    let Some(value) = value else { return Ok(BTreeMap::new()) };
    let invalid = || GatewayError(format!("{CONFIG}.{field} must be an object with up to {MAX_ENTRIES} entries."));
    let object = value.as_object().filter(|object| object.len() <= MAX_ENTRIES).ok_or_else(invalid)?;
    let mut seen = BTreeSet::new();
    let mut env = BTreeMap::new();
    for (name, value) in object {
        let upper = name.to_ascii_uppercase();
        if name.is_empty() || !name.bytes().enumerate().all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
            || checks::KEEP.contains(&upper.as_str()) || upper == "LOG_DIR" || upper.starts_with("ZODCHI_")
            || reserved.is_some_and(|reserved| name.eq_ignore_ascii_case(reserved)) || !seen.insert(upper) {
            return fail(format!("{CONFIG}.{field} contains an invalid, reserved or duplicate name {name:?}."));
        }
        let value = value.as_str().filter(|value| valid_env_value(value))
            .ok_or_else(|| GatewayError(format!("{CONFIG}.{field} value for {name:?} must be text without newlines or NUL.")))?;
        env.insert(name.clone(), value.to_string());
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_apply_only_on_the_declared_os() {
        let list = json!(["node", {"name": "dlltool", "os": "windows"}, {"name": "pkg-config", "os": "linux"}]);
        assert_eq!(tools(Some(&list), "windows").unwrap(), ["node", "dlltool"]);
        assert_eq!(tools(Some(&list), "linux").unwrap(), ["node", "pkg-config"]);
        assert_eq!(tools(Some(&list), "macos").unwrap(), ["node"]);
        for invalid in [
            json!("node"), json!([""]), json!(["./node"]), json!([{"name": "node"}]),
            json!([{"name": "node", "os": "win32"}]), json!([{"name": "node", "os": "windows", "extra": true}]),
            json!([{"name": "-node", "os": "linux"}]),
        ] {
            assert!(tools(Some(&invalid), "windows").is_err(), "{invalid}");
        }
    }

    #[test]
    fn windows_rust_tools_follow_the_pinned_toolchain_and_target() {
        const GNU: &str = "x86_64-pc-windows-gnu";
        const MSVC: &str = "x86_64-pc-windows-msvc";
        let probe = |default| move |variables: &BTreeMap<String, String>| {
            let toolchain = env_value(variables, "RUSTUP_TOOLCHAIN").unwrap_or(default);
            Some(toolchain.trim_start_matches("stable-").to_string())
        };
        for (default, override_toolchain, waived) in [(MSVC, GNU, false), (GNU, MSVC, true)] {
            let env = environment(Some(&json!({ "RUSTUP_TOOLCHAIN": format!("stable-{override_toolchain}") })), "env", None).unwrap();
            assert_eq!(uses_msvc(&env, probe(default)), waived);
        }
        let env = environment(Some(&json!({ "cargo_build_target": GNU })), "env", None).unwrap();
        assert!(!uses_msvc(&env, probe(MSVC)));
        let env = environment(Some(&json!({ "CARGO_BUILD_TARGET": "aarch64-pc-windows-msvc" })), "env", None).unwrap();
        assert!(uses_msvc(&env, probe(MSVC)));
        assert!(!uses_msvc(&env, probe(GNU)));
        assert!(selects_rust("cd rust && cargo test '--target=x86_64-pc-windows-gnu'"));
        assert!(selects_rust("cargo +stable-x86_64-pc-windows-gnu build"));
        assert!(!selects_rust("cargo build --profile flow-check --target-dir cache"));
    }

    #[test]
    fn windows_tool_selection_allows_literal_profile_overrides_with_msvc() {
        const MSVC: &str = "x86_64-pc-windows-msvc";
        let value = json!({ "tools": ["cargo", "node", {"name": "dlltool", "os": "windows"}, {"name": "as", "os": "windows"}] });
        let release = "cargo build --release --locked --manifest-path rust/Cargo.toml \
            --config profile.release.lto=false --config profile.release.codegen-units=16";
        let msvc_tools = ["cargo", "node"];
        let gnu_tools = ["cargo", "node", "dlltool", "as"];
        let cases = [
            (release, MSVC, true),
            (r#"cargo build '--config=profile.release.codegen-units=16' --config 'profile.release.lto="thin"'"#, MSVC, true),
            (release, "x86_64-pc-windows-gnu", false),
            ("cargo build --config profile.release.lto=false --target x86_64-pc-windows-gnu", MSVC, false),
            ("cargo build --config 'build.target=\"x86_64-pc-windows-gnu\"'", MSVC, false),
            ("cargo build --config=build.rustc='\"custom-rustc\"'", MSVC, false),
            ("cargo build --config profile.release.toml", MSVC, false),
            ("cargo build --config profile.release.lto=false --config \"$CARGO_CONFIG\"", MSVC, false),
            ("cargo build --config profile.release.lto=$OPTIONS", MSVC, false),
        ];
        for (command, host, waive_gnu_tools) in cases {
            let mut settings = ProjectSettings { tools: tools(value.get("tools"), "windows").unwrap(), ..ProjectSettings::default() };
            settings.select_tools(&value, "windows", [command], |_| Some(host.into()));
            let expected = if waive_gnu_tools { msvc_tools.as_slice() } else { gnu_tools.as_slice() };
            assert_eq!(settings.tools, expected, "{command} on {host}");
        }
    }

    #[test]
    fn rust_probe_passes_the_effective_verification_environment() {
        let pin = json!({ "env": { "RUSTUP_TOOLCHAIN": "stable-x86_64-pc-windows-gnu", "CARGO_BUILD_TARGET": "x86_64-pc-windows-gnu" } });
        let env = ProjectSettings::from_json(&pin).unwrap().env;
        let cwd = Path::new("flow-checks");
        let probe = rust_version_command(cwd, &env);
        assert_eq!(probe.get_current_dir(), Some(cwd));
        for (name, value) in &env {
            assert!(probe.get_envs().any(|(key, actual)| key == name.as_str()
                && actual.is_some_and(|actual| actual == value.as_str())), "{name} did not reach the probe");
        }
    }

    #[test]
    fn settings_round_trip_and_older_pins_default_to_empty() {
        let value = json!({ "cache": ["rust/target", "one\\two/"], "env": { "CARGO_TARGET_DIR": "{cache}/build", "Test_2": "two words" }, "tools": ["cargo"] });
        let cache = Path::new("flow-cache").join("test repo");
        let settings = ProjectSettings::configured(&value, &cache).unwrap();
        assert_eq!(settings.cache, ["rust/target", "one/two"]);
        assert_eq!(settings.env["Test_2"], "two words");
        assert_eq!(settings.env["CARGO_TARGET_DIR"], format!("{}/build", cache.display()));
        let pin = settings.to_json();
        let replayed = ProjectSettings::from_json(&pin).unwrap();
        assert_eq!(replayed.to_json(), pin);
        let older = ProjectSettings::from_json(&json!({"tools": ["cargo"]})).unwrap();
        assert!(older.cache.is_empty() && older.env.is_empty());
    }

    #[test]
    fn cache_and_env_refuse_unsafe_or_oversized_values() {
        for invalid in [
            json!("rust/target"), json!([""]), json!(["/target"]), json!([r"\target"]), json!(["rust/../target"]),
            json!(["rust/."]), json!([".git/index"]), json!(["rust/.GiT"]),
            json!(["rust/target:1"]), json!(["rust/target."]), json!([true]), json!(vec!["target"; 17]),
        ] {
            assert!(cache(Some(&invalid)).is_err(), "{invalid}");
        }
        for invalid in [
            json!(["VAR=1"]), json!({"1VAR": "x"}), json!({"MY-VAR": "x"}), json!({"PATH": "x"}),
            json!({"path": "x"}), json!({"cargo_home": "x"}), json!({"log_dir": "x"}),
            json!({"zodchi_bash": "x"}), json!({"A": "x", "a": "y"}), json!({"A": true}),
            json!({"A": "\r"}), json!({"A": "\n"}), json!({"A": "\0"}), json!({"A": "\u{2028}"}),
            json!((0..17).map(|i| (format!("V{i}"), "x")).collect::<BTreeMap<_, _>>()),
        ] {
            assert!(environment(Some(&invalid), "env", None).is_err(), "{invalid}");
            assert!(WriterSettings::configured(&json!({ "writerEnv": invalid }), Path::new("cache"), None).is_err(), "{invalid}");
        }
    }

    #[test]
    fn writer_environment_reserves_the_configured_browser_name() {
        for name in ["APP_TEST_CHROME", "app_test_chrome"] {
            let value = json!({ "writerEnv": { (name): "other" } });
            let cache = Path::new("cache");
            assert!(WriterSettings::configured(&value, cache, Some("APP_TEST_CHROME")).is_err());
            assert!(WriterSettings::from_pin(&value, Some("APP_TEST_CHROME")).is_err());
            let settings = WriterSettings::configured(&value, cache, None).unwrap();
            assert_eq!(settings.env[name], "other");
            assert!(settings.cache.is_none());
        }
    }

    #[test]
    fn writer_environment_expands_and_pins_the_writer_cache() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
        let args = args::parse(&json!({ "label": "writer-env", "mode": "agent", "brief": "brief.md",
            "repo": repo, "files": ["Cargo.toml"] })).unwrap();
        let value = json!({
            "env": { "CHECK_OUTPUT": "{cache}/build", "CARGO_BUILD_JOBS": "6" },
            "writerEnv": { "CARGO_TARGET_DIR": "{writerCache}/target", "CARGO_BUILD_JOBS": "4" },
        });
        let home = repo.join("zodchi home");
        let cache = home.join("flow-cache").join("repo-slug");
        let writer_cache = cache.join("writer");
        let mut plan = Plan::legacy(&args);
        let old_run = json!({ "verificationPlan": plan.to_json() });
        let older = Plan::from_run(&old_run, &args).unwrap();
        assert!(older.writer.env.is_empty() && older.writer.cache.is_none());
        plan.project = ProjectSettings::configured(&value, &cache).unwrap();
        plan.writer = WriterSettings::configured(&value, &cache, None).unwrap();
        let pinned = plan.to_json();
        let replayed = Plan::from_run(&json!({ "verificationPlan": pinned }), &args).unwrap();
        assert_eq!(replayed.to_json(), pinned);
        assert_eq!(replayed.writer.cache.as_deref(), Some(writer_cache.as_path()));
        assert_eq!(replayed.writer.env["CARGO_TARGET_DIR"], format!("{}/target", writer_cache.display()));
        assert_eq!(replayed.writer.env["CARGO_BUILD_JOBS"], "4");
        assert_eq!(replayed.project.env["CHECK_OUTPUT"], format!("{}/build", cache.display()));
        assert_eq!(replayed.project.env["CARGO_BUILD_JOBS"], "6");
        assert!(!replayed.project.env.contains_key("CARGO_TARGET_DIR"));
        let setup_env = replayed.setup_environment();
        assert_eq!(setup_env["CHECK_OUTPUT"], replayed.project.env["CHECK_OUTPUT"]);
        assert_eq!(setup_env["CARGO_TARGET_DIR"], replayed.writer.env["CARGO_TARGET_DIR"]);
        assert_eq!(setup_env["CARGO_BUILD_JOBS"], "4");

        let bad_path = cache.join("with\nnewline");
        assert!(WriterSettings::configured(&value, &bad_path, None).is_err());
    }
}
