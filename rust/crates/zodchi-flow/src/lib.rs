//! Rust workflows for the shared Zodchi CLI. The engine runs workflow steps, preserves their journals and keeps
//! code-package claims compatible with the legacy Claude Code workflow. See docs/flow.md.

#![allow(clippy::result_large_err)]

// Keep flow progress and local diagnostics out of the CLI's JSON stderr stream.
macro_rules! eprintln {
    ($($args:tt)*) => {
        if !crate::agent_requested() {
            ::std::eprintln!($($args)*);
        }
    };
}

mod acceptance;
mod accepted_media;
mod agent;
pub mod args;
mod asset_round;
mod boundary;
mod branch_review;
mod budget;
mod candidate;
mod package_source;
mod review_contract;
mod review_source;
mod catalog;
pub mod checks;
pub mod claims;
mod child_package;
mod cleanup;
pub mod code_package;
mod control;
mod design_brief;
mod design_material;
mod input;
mod input_common;
mod incident_adapter;
mod incident_draft;
mod incident_triage;
mod method_question;
mod ops_script;
mod research;
mod research_lists;
mod research_material;
pub mod executor;
pub mod gateway;
pub mod git;
pub mod journal;
pub mod models;
pub mod patch;
mod rubric_probe;
mod runs;
mod unity_check;
pub mod verify;
mod video;
mod video_manifest;
mod video_media;
mod video_metrics;
mod video_research;
mod voiceover;
mod workspace_audit;
mod youtube_publish;

pub use code_package::{Exit, CUT_EXIT};
pub use control::{sign_in_required, SignIn};

use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, IsTerminal},
};
use zodchi_core::config::{agent_requested, AGENT_ENV};
use zodchi_core::util::{fail, GatewayError, Result};

pub fn environment_keys() -> impl Iterator<Item = &'static str> {
    [
        AGENT_ENV, "ZODCHI_BASH", "ZODCHI_CHECK_SLOT_DIR", "ZODCHI_DENYLIST",
        "ZODCHI_FLOW_CUT", "ZODCHI_TEST_CHECK_SLOT_TMP", checks::DEFAULT_BROWSER_VARIABLE,
    ].into_iter().chain(checks::KEEP)
}

pub const USAGE: &str = "Usage: zodchi flow <workflow> --args <file.json> [--detach]
       zodchi flow code-package --args <file.json> --dry-run
       zodchi flow <workflow> --resume <run-id> [--args <file.json>] [--rerun <step>] [--detach]
       zodchi flow status <run-id>
       zodchi flow status <run-id> --handoff
       zodchi flow runs [--active]
       zodchi flow wait <run-id>... | --all [--timeout-min N]
       zodchi flow cancel <run-id> --reason <text>
       zodchi flow close <run-id> --reason <text>
       zodchi flow apply <run-id>
       zodchi flow cleanup [--apply] [--journals] [--retention-days <n>] [--claims]
       zodchi flow budget <run-id> [--add-calls <n>] [--add-minutes <n>]
       zodchi flow remark <run-id> --file <text>
       zodchi flow reply <run-id> --file <text> [--answered 1,2|all] [--no-new-decisions]
       zodchi flow reply <run-id> --allow-files <file.json> [--file <text>]
       zodchi flow video research --args <file.json>
       zodchi flow video publish <run-id> --file <file.json>
       zodchi flow video stats <run-id> --file <file.json>
       zodchi flow voiceover voices
       zodchi flow voiceover plan --args <file.json>
       zodchi flow youtube-publish connect --args <file.json>
       zodchi flow youtube-publish whoami --profile <name>
       zodchi flow list [--repo <directory>]
For a code-package evidence gap reply, use one <gap id>: <option> line per gap. Put supporting text below that line.
Prints the result JSON. The journal is ~/.zodchi/flows/<run-id>/.
Exit codes: 0 success, approved or closed by the owner, 1 a wrong call or command failure, 2 refused, stopped or not approved.
In agent mode, exit 3 means sign-in required. For flow wait, exit 3 also covers a timeout (status: timeout).";

fn compiled_catalog() -> Value {
    serde_json::from_str(include_str!("../../../../workflows/catalog.json"))
        .expect("workflow catalog")
}

fn require_workflow(git: &git::Git, base: &str, workflow: &str) -> Result<()> {
    catalog::require(git, base, workflow, &compiled_catalog())
}

const RUN_FLAGS: &[(&str, &str)] = &[
    ("--args", "json-file"),
    ("--resume", "run-id"),
    ("--rerun", "step"),
    ("--detach", "boolean"),
    ("--dry-run", "boolean"),
];

const HELP_FLAGS: [&str; 2] = ["--help", "-h"];

fn workflows(catalog: &Value) -> &[Value] {
    catalog["workflows"].as_array().expect("workflows")
}

#[derive(Default)]
struct UsageCommand<'a> {
    flags: BTreeMap<&'a str, &'a str>,
    subcommands: BTreeMap<&'a str, Self>,
}

impl UsageCommand<'_> {
    fn describe(self, name: &str) -> Value {
        let flags: Vec<_> = self.flags.into_iter()
            .map(|(name, kind)| json!({ "name": name, "valueKind": kind }))
            .collect();
        let subcommands: Vec<_> = self.subcommands.into_iter()
            .map(|(name, command)| command.describe(name))
            .collect();
        json!({ "name": name, "flags": flags, "subcommands": subcommands })
    }
}

// Controls with dedicated parsers already publish their forms in the usage diagnostic.
fn documented_commands<'a>(usage: &'a str, prefix: &str) -> BTreeMap<&'a str, UsageCommand<'a>> {
    let mut commands = BTreeMap::new();
    for line in usage.lines() {
        let line = line.trim_start();
        let line = line.strip_prefix("Usage: ").unwrap_or(line);
        let Some(form) = line.strip_prefix(prefix) else { continue };
        let mut words = form.split_whitespace().peekable();
        let is_command = |word: &str| word.starts_with(|c: char| c.is_ascii_lowercase());
        let Some(name) = words.next().filter(|word| is_command(word)) else { continue };
        let mut command: &mut UsageCommand<'_> = commands.entry(name).or_default();
        while let Some(&word) = words.peek().filter(|word| is_command(word)) {
            words.next();
            command = command.subcommands.entry(word).or_default();
        }
        while let Some(word) = words.next() {
            let word = word.trim_matches(['[', ']']);
            if !word.starts_with("--") {
                continue;
            }
            let value = words.peek().map(|word| word.trim_end_matches(']'));
            let kind = match value {
                Some("<n>") => "integer",
                Some("N") => "number",
                Some("<file.json>") => "json-file",
                Some("<directory>") => "directory",
                Some("<text>") if word == "--file" => "text-file",
                Some(kind @ ("<text>" | "<name>")) => kind.trim_matches(['<', '>']),
                Some("1,2|all") => "decision-list",
                _ => "boolean",
            };
            command.flags.insert(word, kind);
            if kind != "boolean" {
                words.next();
            }
        }
    }
    commands
}

/// Command and workflow options from this installation's catalog and parser.
pub fn usage() -> Value {
    let mut commands = documented_commands(USAGE, "zodchi flow ");
    let catalog = compiled_catalog();
    for entry in workflows(&catalog) {
        let name = entry["name"].as_str().expect("workflow name");
        let command = commands.entry(name).or_default();
        command.flags.extend(RUN_FLAGS.iter().copied().filter(|(flag, _)| {
            *flag != "--dry-run" || name == code_package::WORKFLOW
        }));
        command.flags.extend(HELP_FLAGS.map(|name| (name, "boolean")));
    }
    commands.entry("cleanup").or_default().flags.extend(HELP_FLAGS.map(|name| (name, "boolean")));
    let mut subcommands: Vec<_> = commands.into_iter()
        .map(|(name, command)| command.describe(name))
        .collect();
    subcommands.push(json!({ "name": "_worker", "flags": [], "subcommands": [], "internal": true }));
    let flags: Vec<_> = HELP_FLAGS.iter().map(|name| json!({ "name": name, "valueKind": "boolean" })).collect();
    json!({ "name": "flow", "flags": flags, "subcommands": subcommands })
}

#[derive(Default)]
struct RunOptions<'a> {
    file: Option<&'a str>,
    resume: Option<&'a str>,
    rerun: Option<&'a str>,
    detach: bool,
    dry_run: bool,
}

fn run_options(tail: &[String]) -> Result<RunOptions<'_>> {
    let mut parsed = RunOptions::default();
    let mut options = tail.iter().map(String::as_str);
    while let Some(flag) = options.next() {
        let value_kind = RUN_FLAGS.iter().find(|(name, _)| *name == flag).map(|(_, kind)| *kind);
        match (value_kind, flag) {
            (Some("boolean"), "--detach") if !parsed.detach => parsed.detach = true,
            (Some("boolean"), "--dry-run") if !parsed.dry_run => parsed.dry_run = true,
            (Some("json-file"), _) => parsed.file = Some(options.next().ok_or_else(|| unexpected(flag))?),
            (Some("run-id"), _) => parsed.resume = Some(options.next().ok_or_else(|| unexpected(flag))?),
            (Some("step"), _) => parsed.rerun = Some(options.next().ok_or_else(|| unexpected(flag))?),
            _ => return Err(unexpected(flag)),
        }
    }
    if parsed.dry_run && (parsed.resume.is_some() || parsed.detach) {
        return fail("--dry-run cannot be used with --resume or --detach.");
    }
    Ok(parsed)
}

fn unexpected(flag: &str) -> GatewayError {
    GatewayError(format!("Unexpected argument: {flag}\n{USAGE}"))
}

/// Recognize a start before selecting the release that will resolve the workflow name.
pub fn starts_run(args: &[String]) -> bool {
    let Some((workflow, tail)) = args.split_first() else { return false };
    // The launcher may predate workflows in the next release.
    if !workflow.starts_with(|c: char| c.is_ascii_lowercase())
        || !workflow.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || matches!(workflow.as_str(),
            "cleanup" | "runs" | "wait" | "cancel" | "close" | "list" | "status"
                | "apply" | "budget" | "remark" | "reply")
    {
        return false;
    }
    run_options(tail).is_ok_and(|options| {
        options.file.is_some_and(|file| !file.is_empty() && !file.starts_with("--"))
            && options.resume.is_none() && options.rerun.is_none() && !options.dry_run
    })
}

/// Whether the arguments after `flow` include the preview switch. The launcher checks this before any updates.
pub fn requests_dry_run(args: &[String]) -> bool {
    let mut options = args.iter().skip(1);
    while let Some(arg) = options.next() {
        match arg.as_str() {
            "--dry-run" => return true,
            "--args" | "--resume" | "--rerun" | "--file" | "--allow-files" | "--profile" | "--repo" | "--reason" => {
                options.next();
            }
            _ => {}
        }
    }
    false
}

/// Whether a flow call opens the interactive YouTube consent prompt.
pub fn requests_consent(args: &[String]) -> bool {
    matches!(args, [workflow, command, flag, _]
        if workflow == youtube_publish::NAME && command == "connect" && flag == "--args")
}

/// Open the attached terminal even when the standard streams are redirected.
pub fn controlling_terminal() -> io::Result<fs::File> {
    let name = if cfg!(windows) { "CONOUT$" } else { "/dev/tty" };
    let terminal = fs::OpenOptions::new().read(true).write(true).open(name)?;
    if !terminal.is_terminal() {
        return Err(io::Error::new(io::ErrorKind::NotConnected, "No controlling terminal."));
    }
    Ok(terminal)
}

/// `zodchi flow <workflow> ...`: the result of the run.
pub fn cli(args: &[String]) -> Result<Exit> {
    let Some(workflow) = args.first() else { return fail(USAGE) };
    if workflow != code_package::WORKFLOW && requests_dry_run(args) {
        return fail("--dry-run is supported only by code-package.");
    }
    match workflow.as_str() {
        "cleanup" => return cleanup::cli(&args[1..]),
        "runs" => return runs::list(&args[1..]),
        "wait" => return runs::wait(&args[1..]),
        "cancel" | "close" => {
            let [_, id, flag, reason] = args else { return fail(USAGE) };
            if flag != "--reason" {
                return fail(USAGE);
            }
            return control::stop_run(id, reason, workflow == "cancel");
        }
        _ => {}
    }
    match args {
        [flag] if HELP_FLAGS.contains(&flag.as_str()) => return Ok(Exit { code: 0, result: serde_json::json!({ "usage": USAGE, "catalog": compiled_catalog() }) }),
        [name, flag] if HELP_FLAGS.contains(&flag.as_str()) => {
            let catalog = compiled_catalog();
            let entry = workflows(&catalog).iter()
                .find(|item| item["name"] == name.as_str())
                .ok_or_else(|| GatewayError(format!("No workflow {name:?} in zodchi flow. Run zodchi flow list for the catalog.")))?;
            return Ok(Exit { code: 0, result: entry.clone() });
        }
        [command] if command == "list" => return Ok(Exit { code: 0, result: compiled_catalog() }),
        [command, flag, root] if command == "list" && flag == "--repo" => {
            return Ok(Exit { code: 0, result: catalog::project(std::path::Path::new(root), compiled_catalog)? });
        }
        [command, id] if command == "status" => return control::status(id),
        [command, id, flag] if command == "status" && flag == "--handoff" => return control::handoff(id),
        [command, id] if command == "apply" => return candidate::apply(id),
        [command, id, rest @ ..] if command == "budget" => return control::extend_budget(id, rest),
        [command, id, flag, file] if command == "remark" && flag == "--file" => {
            return input::remark(id, file);
        }
        [command, id, rest @ ..] if command == "reply" => return input::reply(id, rest, control::reply_policy),
        [command, id] if command == "_worker" => return control::worker(id, None),
        [command, id, rerun] if command == "_worker" => return control::worker(id, Some(rerun)),
        [workflow, command, flag, file] if workflow == video::NAME && command == "research" && flag == "--args" => {
            return video_research::capture(&video_media::read_json(std::path::Path::new(file))?);
        }
        [workflow, command, id, flag, file] if workflow == video::NAME && ["publish", "stats"].contains(&command.as_str()) && flag == "--file" => {
            let payload = video_media::read_json(std::path::Path::new(file))?;
            return if command == "publish" { video::record_publication(id, &payload) } else { video::record_stats(id, &payload) };
        }
        [workflow, command] if workflow == voiceover::NAME && command == "voices" => return Ok(voiceover::voices()),
        [workflow, command, flag, file] if workflow == voiceover::NAME && command == "plan" && flag == "--args" => {
            return voiceover::preview(&video_media::read_json(std::path::Path::new(file))?);
        }
        [_, _, _, file] if requests_consent(args) => {
            return youtube_publish::connect(&video_media::read_json(std::path::Path::new(file))?);
        }
        [workflow, command, flag, profile] if workflow == youtube_publish::NAME && command == "whoami" && flag == "--profile" => {
            return youtube_publish::whoami(profile);
        }
        _ => {}
    }
    if !workflows(&compiled_catalog()).iter().any(|entry| entry["name"] == workflow.as_str()) {
        return fail(format!("No workflow {workflow:?} in zodchi flow. Run zodchi flow list for the catalog.\n{USAGE}"));
    }
    let RunOptions { file, resume, rerun, detach, dry_run } = run_options(&args[1..])?;
    let given = match file {
        Some(f) => {
            let text = std::fs::read_to_string(f).map_err(|_| GatewayError(format!("Cannot read the args {f}")))?;
            Some(serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).map_err(|e| GatewayError(format!("The args {f} are not JSON: {e}")))?)
        }
        None => None,
    };
    match (resume, given) {
        (Some(id), given) => control::resume(workflow, id, given.as_ref(), rerun, detach),
        (None, Some(given)) => {
            if rerun.is_some() {
                return fail("--rerun goes with --resume <run-id>");
            }
            if dry_run {
                return control::dry_run_package(&given);
            }
            let launch = detach.then_some(control::launch_start as boundary::Launch);
            let exit = if workflow == research::NAME {
                research::start(&given, launch, require_workflow)
            } else if workflow == ops_script::NAME {
                ops_script::start(&given, launch)
            } else if workflow == branch_review::NAME {
                branch_review::start(&given, launch, require_workflow)
            } else if workflow == design_brief::NAME {
                design_brief::start(&given, launch, require_workflow)
            } else if workflow == incident_triage::NAME {
                incident_triage::start(&given, launch, require_workflow)
            } else if workflow == method_question::NAME {
                method_question::start(&given, launch, require_workflow)
            } else if workflow == rubric_probe::NAME {
                rubric_probe::start(&given, launch, require_workflow)
            } else if workflow == unity_check::NAME {
                unity_check::start(&given, launch, require_workflow)
            } else if workflow == workspace_audit::NAME {
                workspace_audit::start(&given, launch)
            } else if workflow == asset_round::NAME {
                asset_round::start(&given, launch, require_workflow, &control::ASSET_CHILDREN)
            } else if workflow == video::NAME {
                video::start(&given, launch)
            } else if workflow == voiceover::NAME {
                voiceover::start(&given, launch)
            } else if workflow == youtube_publish::NAME {
                youtube_publish::start(&given)
            } else if [acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE].contains(&workflow.as_str()) {
                acceptance::start(workflow, &given, launch, require_workflow)
            } else if detach {
                code_package::start_detached(&given)
            } else {
                code_package::start(&given)
            }?;
            Ok(cleanup::after_run(exit))
        }
        (None, None) => fail(USAGE),
    }
}
