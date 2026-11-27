//! The CLI bindings for installed workflows.

use crate::{
    boundary::Launch,
    catalog,
    control::SignIn,
    git::Git,
    input::{Reply, ReplyPolicy, ReplyRun},
    journal::{Journal, StatusHooks},
    Exit,
};
use serde_json::Value;
use std::{path::Path, sync::OnceLock};
use zodchi_core::util::{fail, Result};

#[path = "asset_round.rs"]
mod asset_round_entry;
#[path = "branch_review.rs"]
mod branch_review_entry;
#[path = "candidate_acceptance.rs"]
mod candidate_acceptance_entry;
#[path = "code_package.rs"]
pub(crate) mod code_package_entry;
#[path = "design_brief.rs"]
mod design_brief_entry;
#[path = "incident_triage.rs"]
mod incident_triage_entry;
#[path = "method_question.rs"]
mod method_question_entry;
#[path = "ops_script.rs"]
mod ops_script_entry;
#[path = "player_acceptance.rs"]
mod player_acceptance_entry;
#[path = "release_acceptance.rs"]
mod release_acceptance_entry;
#[path = "research.rs"]
mod research_entry;
#[path = "rubric_probe.rs"]
mod rubric_probe_entry;
#[path = "unity_check.rs"]
mod unity_check_entry;
#[path = "video.rs"]
mod video_entry;
#[path = "voiceover.rs"]
mod voiceover_entry;
#[path = "workspace_audit.rs"]
mod workspace_audit_entry;
#[path = "youtube_publish.rs"]
mod youtube_publish_entry;

pub(crate) use zodchi_flow_code_package::PinnedClaim as ShutdownClaim;

type Start = fn(&Value, Option<Launch>) -> Result<Exit>;
type Resume = fn(&str, Option<&Value>, Option<&str>) -> Result<Exit>;
type Handoff = fn(&str, &Value, &Value, &Value, &Path) -> Value;
type ReplyHook = fn(&mut Journal, &ReplyRun<'_>, &Reply<'_>) -> Result<Exit>;
type RemarkHook = fn(&Journal, &str, &str, &mut Value) -> Result<bool>;
type ShutdownFiles = for<'a> fn(&'a Journal, &Value) -> Option<(&'a str, Value)>;
type PinClaim = for<'a> fn(&'a Value, &str) -> Result<Option<ShutdownClaim<'a>>>;

pub(crate) struct ShutdownHooks {
    pin_claim: PinClaim,
    pub findings: fn(&[Value]) -> Option<Vec<String>>,
    pub unknown_files: ShutdownFiles,
    pub candidate: fn(&Value, &str) -> Option<Value>,
}

pub(crate) struct Entry {
    name: &'static str,
    catalog_version: &'static str,
    start: Start,
    resume: Resume,
    pub dry_run: Option<fn(&Value) -> Result<Exit>>,
    pub special: Option<fn(&[String]) -> Option<Result<Exit>>>,
    pub requests_consent: Option<fn(&[String]) -> bool>,
    status: StatusHooks,
    pub handoff_from_run: Option<Handoff>,
    pub handoff_from_status: Option<Handoff>,
    pub project_handoff: Option<fn(&Value, &Value, &mut Value)>,
    pub finished_approved: Option<fn(&Value) -> bool>,
    pub waiting_decision: Option<fn(&Value) -> bool>,
    pub reply_policy: ReplyPolicy,
    pub handle_reply: Option<ReplyHook>,
    pub remark: Option<RemarkHook>,
    pub allows_paid_worker: bool,
    pub worker_error: Option<&'static str>,
    pub stop_sign_in: Option<fn(&Value) -> Option<SignIn>>,
    pub allows_budget_extension: bool,
    pub shutdown: Option<ShutdownHooks>,
}

const NO_STATUS: StatusHooks = StatusHooks {
    check_result: None,
    details: None,
    stop_details: None,
};

impl Entry {
    const fn new(
        name: &'static str,
        catalog_version: &'static str,
        start: Start,
        resume: Resume,
    ) -> Self {
        Self {
            name,
            catalog_version,
            start,
            resume,
            dry_run: None,
            special: None,
            requests_consent: None,
            status: NO_STATUS,
            handoff_from_run: None,
            handoff_from_status: None,
            project_handoff: None,
            finished_approved: None,
            waiting_decision: None,
            reply_policy: ReplyPolicy::TEXT,
            handle_reply: None,
            remark: None,
            allows_paid_worker: false,
            worker_error: None,
            stop_sign_in: None,
            allows_budget_extension: false,
            shutdown: None,
        }
    }
}

static ENTRIES: &[&Entry] = &[
    &research_entry::ENTRY,
    &code_package_entry::ENTRY,
    &incident_triage_entry::ENTRY,
    &design_brief_entry::ENTRY,
    &branch_review_entry::ENTRY,
    &method_question_entry::ENTRY,
    &rubric_probe_entry::ENTRY,
    &asset_round_entry::ENTRY,
    &unity_check_entry::ENTRY,
    &workspace_audit_entry::ENTRY,
    &video_entry::ENTRY,
    &voiceover_entry::ENTRY,
    &youtube_publish_entry::ENTRY,
    &candidate_acceptance_entry::ENTRY,
    &release_acceptance_entry::ENTRY,
    &player_acceptance_entry::ENTRY,
    &ops_script_entry::ENTRY,
];

pub(crate) fn get(name: &str) -> Option<&'static Entry> {
    ENTRIES.iter().copied().find(|entry| entry.name == name)
}

pub(crate) fn for_run(run: &Value) -> Option<&'static Entry> {
    run["workflow"].as_str().and_then(get)
}

fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: Value = serde_json::from_str(catalog::SHIPPED).expect("workflow catalog");
        for item in catalog["workflows"].as_array().expect("workflows") {
            if let Some(entry) = item["name"].as_str().and_then(get) {
                assert_eq!(
                    item["version"].as_str(),
                    Some(entry.catalog_version),
                    "workflow {:?} version in the shipped catalog",
                    entry.name,
                );
            }
        }
        catalog
    })
}

pub(crate) fn compiled_catalog() -> Value {
    catalog().clone()
}

pub(crate) fn catalog_entries() -> &'static [Value] {
    catalog()["workflows"].as_array().expect("workflows")
}

pub(crate) fn catalog_entry(name: &str) -> Option<&'static Value> {
    catalog_entries().iter().find(|item| item["name"] == name)
}

pub(crate) fn require_workflow(git: &Git, base: &str, name: &str) -> Result<()> {
    catalog::require(git, base, name, catalog())
}

pub(crate) fn start(entry: Option<&Entry>, given: &Value, launch: Option<Launch>) -> Result<Exit> {
    // The catalog admits starts. A catalog-only name has always used the package starter.
    (entry.unwrap_or(&code_package_entry::ENTRY).start)(given, launch)
}

pub(crate) fn resume(
    name: &str,
    id: &str,
    given: Option<&Value>,
    rerun: Option<&str>,
) -> Result<Exit> {
    let Some(entry) = get(name) else {
        return fail(format!(
            "Workflow {name:?} is not available in this installation."
        ));
    };
    (entry.resume)(id, given, rerun)
}

pub(crate) fn status_hooks() -> StatusHooks {
    StatusHooks {
        check_result: Some(|run, result| {
            match for_run(run).and_then(|entry| entry.status.check_result) {
                Some(check) => check(run, result),
                None => result,
            }
        }),
        details: Some(|run, events, result| {
            if let Some(project) = for_run(run).and_then(|entry| entry.status.details) {
                project(run, events, result);
            }
        }),
        stop_details: Some(|run, last, result| {
            if let Some(project) = for_run(run).and_then(|entry| entry.status.stop_details) {
                project(run, last, result);
            }
        }),
    }
}

pub(crate) fn shutdown_claim<'a>(run: &'a Value, id: &str) -> Result<Option<ShutdownClaim<'a>>> {
    match for_run(run).and_then(|entry| entry.shutdown.as_ref()) {
        Some(hooks) => (hooks.pin_claim)(run, id),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_catalog_matches_shipped_catalog() {
        let shipped: Value = serde_json::from_str(catalog::SHIPPED).expect("workflow catalog");
        assert_eq!(compiled_catalog().to_string(), shipped.to_string());
        for entry in ENTRIES {
            let item = catalog_entry(entry.name).unwrap_or_else(|| {
                panic!("workflow {:?} is missing from the shipped catalog", entry.name)
            });
            assert_eq!(item["version"].as_str(), Some(entry.catalog_version), "{}", entry.name);
        }
    }
}
