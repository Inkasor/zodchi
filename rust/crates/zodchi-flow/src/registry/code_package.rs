use super::{require_workflow, Entry, Launch, ShutdownClaim, ShutdownHooks, StatusHooks, NO_STATUS};
use crate::{
    control,
    input::{self, Reply, ReplyPolicy, ReplyRun},
    journal::Journal,
    Exit,
};
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_code_package as package;

pub(crate) use package::start_child;

pub(super) const ENTRY: Entry = Entry {
    dry_run: Some(|args| package::dry_run(args, require_workflow)),
    status: StatusHooks {
        details: Some(package::credits),
        ..NO_STATUS
    },
    handle_reply: Some(handle_reply),
    remark: Some(package::queue_remark),
    allows_budget_extension: true,
    shutdown: Some(ShutdownHooks {
        pin_claim: |run, id| ShutdownClaim::for_shutdown(run, id),
        findings: package::recorded_findings,
        unknown_files: package::unknown_shutdown_files,
        candidate: package::shutdown_candidate,
    }),
    ..Entry::new(
        package::WORKFLOW,
        package::VERSION,
        start_entry,
        package::resume,
    )
};

/// Starts a new run from its arguments: the gate, then the journal, the claim and the machine.
pub fn start(args: &Value) -> Result<Exit> {
    package::start(args, require_workflow)
}

pub fn start_detached(args: &Value) -> Result<Exit> {
    package::start_detached(args, control::launch_start, require_workflow)
}

fn start_entry(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    if launch.is_some() {
        start_detached(args)
    } else {
        start(args)
    }
}

fn handle_reply(journal: &mut Journal, target: &ReplyRun<'_>, reply: &Reply<'_>) -> Result<Exit> {
    package::handle_reply(
        journal,
        package::ReplyInput {
            id: target.id,
            config: target.config,
            run: target.run,
            file: reply.file,
            allow_files: reply.allow_files,
            answered: reply.answered,
            no_new_decisions: reply.no_new_decisions,
        },
        &package::ReplyHooks {
            check_reply_open: input::check_reply_open,
            no_scope_wait: input::no_scope_wait,
            read_input: input::read_input,
            private_places: input::private_places,
            record_answer: input::record_answer,
        },
        |journal, file, approval| {
            input::record_standard_reply(journal, target, file, reply, ReplyPolicy::TEXT, approval)
        },
    )
}
