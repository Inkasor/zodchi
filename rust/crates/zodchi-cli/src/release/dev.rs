use super::{bundle, managed};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use zodchi_core::{
    config::{dev_build_commit, is_source_commit},
    util::{fail, sha256_hex, write_json_atomic, GatewayError, Result},
};

const SELECTED: &str = "dev-current.json";
const LAUNCHER_RECEIPT: &str = "dev-launcher.json";

fn executable(home: &Path, commit: &str, version: &str) -> Result<PathBuf> {
    if !is_source_commit(commit) {
        return fail("The DEV build needs a full Git commit ID.");
    }
    let root = home.join("dev-builds").join(commit);
    bundle::executable(&root, version)
        .map_err(|error| GatewayError(format!("DEV build {commit}: {error}")))
}

fn identity(home: &Path, version: &str, commit: &str, binary: &Path) -> Result<Value> {
    Ok(json!({
        "channel": "dev", "version": version, "sourceCommit": commit, "cli": binary,
        "journalHome": home, "cliSha256": sha256_hex(fs::read(binary)?),
    }))
}

pub(super) fn current(home: &Path) -> Result<Option<Value>> {
    let path = home.join(SELECTED);
    if path.is_file() {
        let selection = bundle::read_json(&path)?;
        let target = selected_executable(home, &selection)?;
        return identity(
            home,
            selection["version"].as_str().unwrap_or_default(),
            selection["sourceCommit"].as_str().unwrap_or_default(),
            &target,
        )
        .map(Some);
    }
    Ok(None)
}

fn selected_executable(home: &Path, selection: &Value) -> Result<PathBuf> {
    if selection["channel"] != "dev" {
        return fail("Invalid DEV selection.");
    }
    executable(
        home,
        selection["sourceCommit"].as_str().unwrap_or_default(),
        selection["version"].as_str().unwrap_or_default(),
    )
}

pub(super) fn route(home: &Path, args: &[String]) -> Result<Option<PathBuf>> {
    let path = home.join(SELECTED);
    if !path.is_file() {
        return Ok(None);
    }
    if let Some(id) = managed::existing_run(args) {
        let run = managed::run_record(home, id)?;
        if let Some(commit) = run["buildCommit"].as_str() {
            return executable(home, commit, run["release"].as_str().unwrap_or_default()).map(Some);
        }
        if let Some(binary) = managed::retained_release(home, &run)? {
            return Ok(Some(binary));
        }
    }
    selected_executable(home, &bundle::read_json(&path)?).map(Some)
}

fn install_launcher(home: &Path, binary: &Path) -> Result<PathBuf> {
    let launcher = managed::launcher(home);
    let launcher_dir = launcher.parent().expect("launcher in bin");
    fs::create_dir_all(launcher_dir)?;
    let receipt = home.join(LAUNCHER_RECEIPT);
    if receipt.is_file() {
        let state = bundle::read_json(&receipt)?;
        if state["sha256"] != sha256_hex(fs::read(&launcher)?) {
            return fail(format!(
                "The DEV launcher at {} has changed.",
                launcher.display()
            ));
        }
        return Ok(launcher);
    }
    let digest = sha256_hex(fs::read(binary)?);
    if launcher.exists() && sha256_hex(fs::read(&launcher)?) != digest {
        let backup = if cfg!(windows) {
            "zodchi-before-dev.exe"
        } else {
            "zodchi-before-dev"
        };
        bundle::copy_launcher(&launcher, &launcher_dir.join(backup))?;
    }
    let temp = tempfile::Builder::new()
        .prefix(".prepare-dev-")
        .tempdir_in(launcher_dir)?;
    let staged = temp
        .path()
        .join(launcher.file_name().expect("launcher filename"));
    fs::copy(binary, &staged)?;
    fs::rename(staged, &launcher).map_err(|error| {
        GatewayError(format!(
            "Cannot replace the launcher at {}: {error}",
            launcher.display()
        ))
    })?;
    write_json_atomic(&receipt, &json!({ "sha256": digest }))?;
    Ok(launcher)
}

pub(super) fn activate(file: &Path, digest: &str) -> Result<Value> {
    let home = managed::home()?;
    let archive = bundle::load_archive(file, digest)?;
    fs::create_dir_all(&home)?;
    let Some(_lock) = managed::try_lock(&home)? else {
        return fail("Another release installation is working.");
    };
    let (root, commit) = archive.install_dev(&home)?;
    let version = archive.version();
    let binary = bundle::executable(&root, version)?;
    managed::validate(&binary, version)?;
    let launcher = install_launcher(&home, &binary)?;
    let mut selected = identity(&home, version, &commit, &binary)?;
    write_json_atomic(&home.join(SELECTED), &selected)?;
    selected["launcher"] = json!(launcher);
    Ok(selected)
}

pub(super) fn report() -> Result<Value> {
    let executable = env::current_exe()?;
    if let Some(home) = executable.parent().and_then(Path::parent) {
        if executable == managed::launcher(home) {
            if let Some(current) = current(home)? {
                return Ok(current);
            }
            if let Some(current) = managed::current(home)? {
                return Ok(current);
            }
        }
    }
    let home = managed::home()?;
    if let Some(commit) = dev_build_commit(&home) {
        return identity(&home, bundle::VERSION, &commit, &executable);
    }
    Ok(
        json!({ "channel": "direct", "version": bundle::VERSION, "cli": executable, "journalHome": home }),
    )
}
