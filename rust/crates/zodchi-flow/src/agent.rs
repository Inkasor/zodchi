//! The agent edits a private export. Only changes the engine can match to the claimed paths and the original
//! worktree blobs are proposed for application. The writer's report is not used as a list of filesystem changes.

use crate::{git::Git, input_common::Scrubber, patch, verify::WriterSettings};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use zodchi_core::util::{fail, GatewayError, Result};

pub const ROLE: &str = "flow-work";
pub const SCHEMA: &str = include_str!("../../../../roles/package-result.schema.json");

pub(crate) fn check_writer_role(role: &Value) -> Result<()> {
    if role["mode"] != "work"
        || role["sandbox"] != "workspace-write"
        || role["mcpServers"] != json!([])
    {
        return fail(
            "Agent mode requires a work role with workspace-write and an empty MCP server list.",
        );
    }
    Ok(())
}

pub(crate) fn create_writer_cache(settings: &WriterSettings) -> Result<()> {
    if let Some(cache) = &settings.cache {
        fs::create_dir_all(cache)
            .map_err(|error| GatewayError(format!("Cannot create the writer cache: {error}")))?;
    }
    Ok(())
}

pub(crate) fn describe_writer_environment(
    prompt: &mut String,
    settings: &WriterSettings,
    scrubber: &Scrubber,
    private_places: &[(String, &str)],
) {
    let names = settings
        .env
        .keys()
        .map(String::as_str)
        .filter(|name| scrubber.text(name, private_places) == *name)
        .collect::<Vec<_>>();
    if !names.is_empty() {
        let names = names.join(", ");
        prompt.push_str(&format!("\n\nConfigured writer shell variables are {names}."));
    }
}

pub fn prepare(
    source: &Git,
    root: &Path,
    head: &str,
    files: &[String],
    exec: &[String],
    scratch: &Path,
) -> Result<Value> {
    let mut original = BTreeMap::new();
    for path in files {
        if !patch::plain(path)
            || !patch::no_links(&source.root, path)
            || source.tracked_link(head, path)?
        {
            return fail(format!("Writer workspace cannot safely copy {path}."));
        }
        original.insert(path, source.blob_of_file(path)?);
    }
    let tree = source.candidate_tree(head, files, exec, scratch)?;
    source.export(&tree, root, scratch)?;
    let writer = Git::new(root);
    writer.run(&["init", "-q", "--template=", "-b", "flow-writer"])?;
    source.copy_fork_marker(&writer)?;
    writer.run(&["add", "-f", "-A", "--", "."])?;
    writer.run(&[
        "-c",
        "user.name=Zodchi",
        "-c",
        "user.email=flow@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--no-verify",
        "--allow-empty",
        "-m",
        "Flow writer workspace",
    ])?;
    if !writer.test(&["diff", "--quiet", "--exit-code"])? {
        return fail("The writer export differs from its local Git baseline.");
    }
    let mut before = BTreeMap::new();
    for path in files {
        if source.blob_of_file(path)? != original[path] {
            return fail(format!(
                "{path} changed while the writer's snapshot was prepared."
            ));
        }
        let exported = writer.blob_of_file(path)?;
        before.insert(
            path,
            json!({ "original": original[path], "exported": exported }),
        );
    }
    Ok(json!({ "before": before, "tree": tree, "workspace": root }))
}

pub fn workspace(receipt: &Value) -> Result<PathBuf> {
    receipt["workspace"]
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .ok_or_else(|| {
            GatewayError(
                "The saved writer workspace is missing. Its recorded model calls were kept.".into(),
            )
        })
}

pub enum Changes {
    Scoped(Vec<patch::Change>),
    Outside(Vec<String>),
}

pub fn changes(root: &Path, source: &Git, snapshot: &Value, files: &[String]) -> Result<Changes> {
    let git = Git::new(root);
    let outside: Vec<_> = git
        .dirty()?
        .into_iter()
        .filter(|path| patch::claimed_as(files, path).is_none())
        .collect();
    if !outside.is_empty() {
        return Ok(Changes::Outside(outside));
    }
    let mut changes = Vec::new();
    let mut source_dirty = None;
    for path in files {
        if !patch::no_links(root, path) {
            return fail(format!(
                "The agent replaced {path} with a link or added a link on its way."
            ));
        }
        let before = &snapshot["before"][path];
        let bytes = match fs::read(root.join(path)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let after = bytes
            .as_ref()
            .map(|bytes| source.blob_of(bytes))
            .transpose()?;
        let original = if before.is_object() {
            if after.as_deref() == before["exported"].as_str() {
                continue;
            }
            before["original"].as_str().map(String::from)
        } else {
            // This path was approved after the snapshot. The live path must still be clean and agree with
            // the same candidate tree the agent saw. Work already staged by a different package stays put.
            if source_dirty.is_none() {
                source_dirty = Some(source.dirty()?);
            }
            let tree = snapshot["tree"].as_str().unwrap_or("");
            if patch::claimed_as(source_dirty.as_ref().expect("loaded dirty paths"), path).is_some()
                || !patch::no_links(&source.root, path)
                || source.tracked_link("HEAD", path)?
                || source.entry_at(tree, path)? != source.entry_at("HEAD", path)?
            {
                return fail(format!(
                    "Approved path {path} changed in the checkout since the writer snapshot."
                ));
            }
            source.blob_of_file(path)?
        };
        let op = match (&original, &bytes) {
            (None, Some(_)) => "create",
            (Some(_), None) => "delete",
            (Some(_), Some(_)) => "modify",
            (None, None) => continue,
        };
        changes.push(patch::Change {
            op: op.into(),
            path: path.clone(),
            from: None,
            base_blob: original,
            content: bytes,
            edits: None,
        });
    }
    if git
        .run(&["diff", "HEAD", "--summary", "--no-renames"])?
        .lines()
        .any(|line| line.starts_with(" mode change "))
    {
        return fail(
            "The agent changed a file mode. Set permissions as a separate reviewed change.",
        );
    }
    Ok(Changes::Scoped(changes))
}

pub fn validate(value: &Value) -> std::result::Result<(), String> {
    match value["status"].as_str() {
        Some("done" | "more" | "question" | "blocked")
            if value["summary"].is_string() && value["questions"].is_array() =>
        {
            Ok(())
        }
        _ => Err("the agent report requires status, summary and questions".into()),
    }
}
