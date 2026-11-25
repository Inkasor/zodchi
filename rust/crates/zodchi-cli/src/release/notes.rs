use super::{bundle, managed};
use serde_json::{json, Value};
use std::{env, fs};
use zodchi_core::{
    config::{dev_build_commit, is_source_commit},
    util::Result,
};

pub(super) fn report(hook: bool) -> Result<Value> {
    let home = managed::home()?;
    let executable = env::current_exe()?;
    let mut channel = "direct";
    let mut version = bundle::VERSION.to_owned();
    let mut revision = dev_build_commit(&home);
    if revision.is_some() {
        channel = "dev";
    } else if let Ok(Some(selected)) = managed::current(&home) {
        let same = selected["cli"]
            .as_str()
            .and_then(|p| fs::canonicalize(p).ok())
            .zip(fs::canonicalize(&executable).ok())
            .is_some_and(|(a, b)| a == b);
        if same {
            channel = "stable";
            version = selected["version"]
                .as_str()
                .unwrap_or(bundle::VERSION)
                .to_owned();
            revision = executable
                .parent()
                .and_then(|p| p.parent())
                .and_then(|root| {
                    bundle::read_json(&root.join("marketplace/plugins/zodchi/zodchi-build.json"))
                        .ok()
                })
                .and_then(|v| {
                    v["sourceCommit"]
                        .as_str()
                        .filter(|s| is_source_commit(s))
                        .map(str::to_owned)
                });
        }
    }
    let notes: Value =
        serde_json::from_str(include_str!("../../../../../install/release-notes.json"))
            .expect("valid curated release notes");
    if hook {
        let build = revision
            .as_deref()
            .map(|r| format!(" ({})", &r[..7]))
            .unwrap_or_default();
        let highlights = notes["highlights"]
            .as_array()
            .expect("highlights")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        Ok(
            json!({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": format!("Zodchi {channel} {version}{build}. {highlights}")}}),
        )
    } else {
        Ok(
            json!({"channel": channel, "version": version, "sourceCommit": revision, "highlights": notes["highlights"]}),
        )
    }
}
