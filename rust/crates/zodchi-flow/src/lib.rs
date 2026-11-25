//! Rust workflows for the shared Zodchi CLI. The engine runs workflow steps, preserves their journals and keeps
//! code-package claims compatible with the legacy Claude Code workflow. See docs/flow.md.

#![allow(clippy::result_large_err)]

mod acceptance;
mod agent;
pub mod args;
mod asset_round;
mod branch_review;
mod budget;
mod candidate;
mod package_source;
mod review_source;
mod catalog;
pub mod checks;
pub mod claims;
pub mod code_package;
mod control;
mod design_brief;
mod design_material;
mod input;
mod method_question;
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
       zodchi flow <workflow> --resume <run-id> [--args <file.json>] [--rerun <step>] [--detach]
       zodchi flow status <run-id>
       zodchi flow status <run-id> --handoff
       zodchi flow apply <run-id>
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
Prints the result JSON. The journal is ~/.zodchi/flows/<run-id>/.
Exit code: 0 approved, 2 any other end (refused, stopped, changes requested), 1 a wrong call.";

/// `zodchi flow <workflow> ...`: the result of the run.
pub fn cli(args: &[String]) -> Result<Exit> {
    let Some(workflow) = args.first() else { return fail(USAGE) };
    match args {
        [flag] if flag == "--help" || flag == "-h" => return Ok(Exit { code: 0, result: serde_json::json!({ "usage": USAGE, "catalog": catalog::all() }) }),
        [name, flag] if flag == "--help" || flag == "-h" => {
            let catalog = catalog::all();
            let entry = catalog["workflows"].as_array().expect("workflows").iter()
                .find(|item| item["name"] == name.as_str())
                .ok_or_else(|| GatewayError(format!("No workflow {name:?} in zodchi flow. Run zodchi flow list for the catalog.")))?;
            return Ok(Exit { code: 0, result: entry.clone() });
        }
        [command] if command == "list" => return Ok(Exit { code: 0, result: catalog::all() }),
        [command, flag, root] if command == "list" && flag == "--repo" => {
            return Ok(Exit { code: 0, result: catalog::project(std::path::Path::new(root))? });
        }
        [command, id] if command == "status" => return control::status(id),
        [command, id, flag] if command == "status" && flag == "--handoff" => return control::handoff(id),
        [command, id] if command == "apply" => return candidate::apply(id),
        [command, id, rest @ ..] if command == "budget" => return budget::extend(id, rest),
        [command, id, flag, file] if command == "remark" && flag == "--file" => {
            return input::remark(id, file);
        }
        [command, id, flag, file] if command == "reply" && flag == "--allow-files" => return input::allow_scope(id, file),
        [command, id, rest @ ..] if command == "reply" => return input::reply(id, rest),
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
    if ![code_package::WORKFLOW, branch_review::NAME, design_brief::NAME, method_question::NAME, research::NAME, rubric_probe::NAME, unity_check::NAME, workspace_audit::NAME, asset_round::NAME, video::NAME, voiceover::NAME, acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE, youtube_publish::NAME].contains(&workflow.as_str()) {
        return fail(format!("No workflow {workflow:?} in zodchi flow. Run zodchi flow list for the catalog.\n{USAGE}"));
    }
    let mut file = None;
    let mut resume = None;
    let mut rerun = None;
    let mut detach = false;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--detach" && !detach {
            detach = true;
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
            if workflow == research::NAME {
                research::start(&given, detach)
            } else if workflow == branch_review::NAME {
                branch_review::start(&given, detach)
            } else if workflow == design_brief::NAME {
                design_brief::start(&given, detach)
            } else if workflow == method_question::NAME {
                method_question::start(&given, detach)
            } else if workflow == rubric_probe::NAME {
                rubric_probe::start(&given, detach)
            } else if workflow == unity_check::NAME {
                unity_check::start(&given, detach)
            } else if workflow == workspace_audit::NAME {
                workspace_audit::start(&given, detach)
            } else if workflow == asset_round::NAME {
                asset_round::start(&given, detach)
            } else if workflow == video::NAME {
                video::start(&given, detach)
            } else if workflow == voiceover::NAME {
                voiceover::start(&given, detach)
            } else if workflow == youtube_publish::NAME {
                youtube_publish::start(&given)
            } else if [acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE].contains(&workflow.as_str()) {
                acceptance::start(workflow, &given, detach)
            } else if detach {
                code_package::start_detached(&given)
            } else {
                code_package::start(&given)
            }
        }
        (None, None) => fail(USAGE),
    }
}
