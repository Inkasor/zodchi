//! Rust workflows for the shared Zodchi CLI. The engine runs workflow steps, preserves their journals and keeps
//! code-package claims compatible with the legacy Claude Code workflow. See docs/flow.md.

#![allow(clippy::result_large_err)]

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

use serde_json::Value;
use zodchi_core::util::{fail, GatewayError, Result};

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
       zodchi flow reply <run-id> --allow-files <file.json>
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
Exit code: 0 approved, 2 any other end (refused, stopped, changes requested), 1 a wrong call.";

fn compiled_catalog() -> Value {
    serde_json::from_str(include_str!("../../../../workflows/catalog.json"))
        .expect("workflow catalog")
}

fn require_workflow(git: &git::Git, base: &str, workflow: &str) -> Result<()> {
    catalog::require(git, base, workflow, &compiled_catalog())
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
        [flag] if flag == "--help" || flag == "-h" => return Ok(Exit { code: 0, result: serde_json::json!({ "usage": USAGE, "catalog": compiled_catalog() }) }),
        [name, flag] if flag == "--help" || flag == "-h" => {
            let catalog = compiled_catalog();
            let entry = catalog["workflows"].as_array().expect("workflows").iter()
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
        [command, id, flag, file] if command == "reply" && flag == "--allow-files" => return input::allow_scope(id, file),
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
        [workflow, command, flag, file] if workflow == youtube_publish::NAME && command == "connect" && flag == "--args" => {
            return youtube_publish::connect(&video_media::read_json(std::path::Path::new(file))?);
        }
        [workflow, command, flag, profile] if workflow == youtube_publish::NAME && command == "whoami" && flag == "--profile" => {
            return youtube_publish::whoami(profile);
        }
        _ => {}
    }
    if ![code_package::WORKFLOW, branch_review::NAME, design_brief::NAME, incident_triage::NAME, method_question::NAME, ops_script::NAME, research::NAME, rubric_probe::NAME, unity_check::NAME, workspace_audit::NAME, asset_round::NAME, video::NAME, voiceover::NAME, acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE, youtube_publish::NAME].contains(&workflow.as_str()) {
        return fail(format!("No workflow {workflow:?} in zodchi flow. Run zodchi flow list for the catalog.\n{USAGE}"));
    }
    let mut file = None;
    let mut resume = None;
    let mut rerun = None;
    let mut detach = false;
    let mut dry_run = false;
    let mut i = 1;
    while i < args.len() {
        let switch = match args[i].as_str() {
            "--detach" if !detach => Some(&mut detach),
            "--dry-run" if !dry_run => Some(&mut dry_run),
            _ => None,
        };
        if let Some(switch) = switch {
            *switch = true;
            i += 1;
            continue;
        }
        let value = args.get(i + 1).cloned();
        match (args[i].as_str(), value) {
            ("--args", Some(v)) => file = Some(v),
            ("--resume", Some(v)) => resume = Some(v),
            ("--rerun", Some(v)) => rerun = Some(v),
            _ => return fail(format!("Unexpected argument: {}\n{USAGE}", args[i])),
        }
        i += 2;
    }
    if dry_run && (resume.is_some() || detach) {
        return fail("--dry-run cannot be used with --resume or --detach.");
    }
    let given = match &file {
        Some(f) => {
            let text = std::fs::read_to_string(f).map_err(|_| GatewayError(format!("Cannot read the args {f}")))?;
            Some(serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).map_err(|e| GatewayError(format!("The args {f} are not JSON: {e}")))?)
        }
        None => None,
    };
    match (resume, given) {
        (Some(id), given) => control::resume(workflow, &id, given.as_ref(), rerun.as_deref(), detach),
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
