//! zodchi-flow: workflows of zodchi run as code. `code-package` v1 is a state machine with a journal outside the
//! repository, package claims shared with the JavaScript workflows, a writer that answers with a structured patch
//! (no shell), checks run by the engine on an exported candidate tree, commits made by the engine only, and an
//! independent reviewer. Codex executors only, through the local gateway (zodchi-core). See docs/flow.md.

#![allow(clippy::result_large_err)]

pub mod args;
pub mod checks;
pub mod claims;
pub mod code_package;
pub mod executor;
pub mod gateway;
pub mod git;
pub mod journal;
pub mod models;
pub mod patch;

pub use code_package::{Exit, CUT_EXIT};

use serde_json::Value;
use zodchi_core::util::{fail, GatewayError, Result};

pub const USAGE: &str = "Usage: zodchi flow code-package --args <file.json>
       zodchi flow code-package --resume <run-id> [--args <file.json>] [--rerun <step>]
Runs the code-package workflow as code: gate, claim, write (a structured patch), checks, verify, commit, review,
close, at most args.rounds review rounds. Prints the result JSON. The journal is ~/.zodchi/flows/<run-id>/.
Exit code: 0 approved, 2 any other end (refused, stopped, changes requested), 1 a wrong call.";

/// `zodchi flow <workflow> ...`: the result of the run.
pub fn cli(args: &[String]) -> Result<Exit> {
    let Some(workflow) = args.first() else { return fail(USAGE) };
    if workflow != code_package::WORKFLOW {
        return fail(format!("No workflow {workflow:?} in zodchi flow; this version runs code-package.\n{USAGE}"));
    }
    let mut file = None;
    let mut resume = None;
    let mut rerun = None;
    let mut i = 1;
    while i < args.len() {
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
            Some(serde_json::from_str::<Value>(&text).map_err(|e| GatewayError(format!("The args {f} are not JSON: {e}")))?)
        }
        None => None,
    };
    match (resume, given) {
        (Some(id), given) => code_package::resume(&id, given.as_ref(), rerun.as_deref()),
        (None, Some(given)) => {
            if rerun.is_some() {
                return fail("--rerun goes with --resume <run-id>");
            }
            code_package::start(&given)
        }
        (None, None) => fail(USAGE),
    }
}
