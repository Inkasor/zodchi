//! Validation for trusted, committed candidate test programs.

/// Use the ordinary Windows spelling expected by Node browser launchers while
/// retaining the already verified executable target.
pub(super) fn node_path(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
        let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
        if wide.starts_with(&unc) {
            let mut ordinary = vec![b'\\' as u16, b'\\' as u16];
            ordinary.extend_from_slice(&wide[unc.len()..]);
            return std::ffi::OsString::from_wide(&ordinary).into();
        }
        if wide.starts_with(&prefix) {
            return std::ffi::OsString::from_wide(&wide[prefix.len()..]).into();
        }
    }
    path.to_path_buf()
}
use super::plan;
use crate::{checks, git::Git, video_media as media};
use serde_json::{json, Value};
use std::{fs, path::Path};
use zodchi_core::util::{fail, Result};

pub(super) fn browser_plan(raw: &Value, repo: &Path) -> Result<Value> {
    let browser = &raw["browser"];
    media::fields(browser, &["node", "executable", "variable"], "browser")?;
    let variable = browser.get("variable").map(|v| media::text(v, "browser.variable"))
        .transpose()?.unwrap_or("ZODCHI_ACCEPTANCE_CHROMIUM");
    if variable.len() > 128 || !variable.bytes().enumerate().all(|(i, b)| {
        b == b'_' || b.is_ascii_uppercase() || (i > 0 && b.is_ascii_digit())
    }) || checks::KEEP.iter().any(|key| key.eq_ignore_ascii_case(variable))
        || variable == "ZODCHI_ACCEPTANCE_FRAMES" {
        return fail("browser.variable must be a distinct uppercase environment variable name.");
    }
    let node = if let Some(node) = browser.get("node") {
        plan::pin(repo, node, "browser.node")?
    } else {
        media::pin(&fs::canonicalize(plan::from_path("node")?)?)?
    };
    Ok(json!({ "node": node, "executable": plan::pin(repo, &browser["executable"], "browser.executable")?, "variable": variable }))
}

pub(super) fn scenario(git: &Git, head: &str, raw: &Value) -> Result<Value> {
    plan::relative(&raw["test"], "scenario.test")?;
    let path = media::text(&raw["test"], "scenario.test")?;
    let entry = git.entry_at(head, path)?;
    if !entry.is_some_and(|(mode, kind, _)| kind == "blob" && (mode == "100644" || mode == "100755")) {
        return fail("scenario.test must be a regular file in the pinned commit.");
    }
    let frames = match raw.get("frames") {
        Some(value) => plan::list(value, "scenario.frames", 0, 32)?,
        None => &[],
    };
    for (i, frame) in frames.iter().enumerate() {
        plan::relative(frame, "frame")?;
        let name = media::text(frame, "frame")?;
        if name.contains('/') || frames[..i].contains(frame) {
            return fail("Frames must be distinct direct filenames.");
        }
    }
    let mut result = raw.clone();
    result["frames"] = json!(frames);
    result["timeoutSeconds"] = json!(plan::seconds(&raw["timeoutSeconds"], 120, 1200, "timeoutSeconds")?);
    Ok(result)
}

/// Create a private Git checkout with the actual commit as HEAD and only local object reads.
pub(super) fn checkout(repo: &Path, dir: &Path, head: &str, tree: &str) -> Result<()> {
    fs::create_dir(dir)?;
    crate::code_package::cut("acceptance checkout staging");
    let snapshot = Git::new(repo).init_snapshot(dir)?;
    snapshot.run(&["reset", "--hard", "--quiet", "--no-recurse-submodules", head])?;
    check_checkout(dir, head, tree)
}

/// Generated files must be ignored; tracked modifications and untracked files invalidate evidence.
pub(super) fn check_checkout(dir: &Path, head: &str, tree: &str) -> Result<()> {
    let git = Git::new(dir);
    if git.rev("HEAD^{commit}")? != head || git.rev("HEAD^{tree}")? != tree || !git.dirty()?.is_empty() {
        return fail("The candidate checkout no longer matches its pinned commit and tree.");
    }
    Ok(())
}

pub(super) fn setup(raw: &Value) -> Result<Value> {
    let commands = match raw.get("setup") {
        Some(value) => plan::list(value, "setup", 0, 32)?,
        None => &[],
    };
    for command in commands {
        if media::text(command, "setup command")?.len() > 8192 {
            return fail("A setup command cannot exceed 8192 bytes.");
        }
    }
    if !commands.is_empty() { checks::preflight()?; }
    Ok(json!(commands))
}
