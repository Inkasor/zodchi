//! The checks of a round, run by the engine itself: each command with bash, in order and each to its end, in an
//! exported copy of the candidate tree, with an environment cut down to
//! what programs need to start (no tokens, keys or credentials from the caller's environment). The real exit code
//! and the log of each command are recorded.
//!
//! Known limit of this version: nothing isolates the network or the file system; a command can still reach the
//! network and read what the user can read. Recorded in docs/flow.md.

use crate::{claims, git::Git, journal::{self, Journal}};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, Metadata, OpenOptions, TryLockError};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zodchi_core::process::{command_without_window, process_start, stop_process};
use zodchi_core::util::{fail, pause, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};

/// What a check command may see of the caller's environment: where programs and the user's tool chains are, the
/// temporary folder and the locale. Nothing else passes.
pub const KEEP: [&str; 30] = [
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USER", "USERNAME", "LOGNAME", "CARGO_HOME", "RUSTUP_HOME",
];

pub const DEFAULT_BROWSER_VARIABLE: &str = "ZODCHI_ACCEPTANCE_CHROMIUM";

/// A browser override must leave inherited check variables and the frame output directory available.
pub fn valid_browser_variable(variable: &str) -> bool {
    !variable.is_empty()
        && variable.len() <= 128
        && variable.bytes().enumerate().all(|(i, b)| {
            b == b'_' || b.is_ascii_uppercase() || (i > 0 && b.is_ascii_digit())
        })
        && !KEEP.iter().any(|key| key.eq_ignore_ascii_case(variable))
        && variable != "ZODCHI_ACCEPTANCE_FRAMES"
}

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub fn browser_variable_cases() -> Vec<(String, bool)> {
    let mut cases = vec![
        (DEFAULT_BROWSER_VARIABLE.into(), true),
        ("APP_TEST_CHROME".into(), true),
        ("_APP0".into(), true),
        ("A".repeat(128), true),
        ("PATH".into(), false),
        ("path".into(), false),
        ("TEMP".into(), false),
        ("ZODCHI_ACCEPTANCE_FRAMES".into(), false),
        ("1ABC".into(), false),
        ("A-B".into(), false),
        (String::new(), false),
        ("A".repeat(129), false),
    ];

    // Cover two-letter project prefixes uniformly for compatibility with existing pins.
    for first in 'A'..='Z' {
        for second in 'A'..='Z' {
            cases.push((format!("{first}{second}_TEST_CHROME"), true));
        }
    }
    cases
}

/// bash: `ZODCHI_BASH`, else on Windows the bash of Git for Windows (never the WSL launcher in System32), else
/// `bash` on PATH.
pub fn find_bash() -> PathBuf {
    if let Some(b) = std::env::var_os("ZODCHI_BASH").filter(|v| !v.is_empty()) {
        return PathBuf::from(b);
    }
    if cfg!(windows) {
        if let Ok(out) = command_without_window("git").arg("--exec-path").output() {
            // <git>/mingw64/libexec/git-core (or usr/libexec/git-core): bash is <git>/bin/bash.exe or <git>/usr/bin/bash.exe.
            let exec = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            for up in exec.ancestors().skip(1).take(4) {
                for c in [up.join("bin").join("bash.exe"), up.join("usr").join("bin").join("bash.exe")] {
                    if c.is_file() {
                        return c;
                    }
                }
            }
        }
    }
    PathBuf::from("bash")
}

pub fn preflight() -> Result<()> {
    let program = find_bash();
    if cfg!(windows) && !program.is_file() {
        return zodchi_core::util::fail("Git Bash is required to run the configured checks. Install Git for Windows or set ZODCHI_BASH to the Bash executable.");
    }
    let mut command = command_without_window(&program);
    command.args(["-c", "exit 0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let status = match command.status() {
        Ok(status) if status.success() => return Ok(()),
        Ok(status) => status.to_string(),
        Err(error) => error.to_string(),
    };
    fail(format!("The configured checks require Bash, but {} could not run ({status}).", program.display()))
}

pub fn preflight_tools(tools: &[String]) -> Result<()> {
    if tools.is_empty() { return Ok(()); }
    let out = command_without_window(find_bash())
        .args(["-c", "for tool; do command -v \"$tool\" >/dev/null || printf '%s\\n' \"$tool\"; done", "zodchi-tool-check"])
        .args(tools).stdin(Stdio::null()).output()?;
    let missing = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() { return zodchi_core::util::fail("Could not inspect the verification tools on PATH."); }
    let missing: Vec<_> = missing.lines().collect();
    if !missing.is_empty() {
        let hint = if cfg!(windows) && missing.iter().any(|name| matches!(*name, "dlltool" | "as")) {
            " Put a folder containing dlltool.exe and as.exe on PATH for the Windows GNU Rust toolchain, or use the MSVC Rust toolchain."
        } else { " Install them and make them available on PATH." };
        return fail(format!("Verification environment is missing required tools: {}.{hint}", missing.join(", ")));
    }
    Ok(())
}

fn slot_directory(variable: &str) -> Option<PathBuf> {
    std::env::var_os(variable).filter(|path| !path.is_empty()).map(PathBuf::from)
}

struct SlotFiles {
    lock: File,
    receipt: PathBuf,
}

fn open_slot_in(dir: &Path) -> io::Result<SlotFiles> {
    fs::create_dir_all(dir)?;
    let dir = fs::canonicalize(dir)?;
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(dir.join("check-slot.lock"))?;
    Ok(SlotFiles { lock, receipt: dir.join("check-slot.json") })
}

fn open_check_slot() -> Result<Vec<SlotFiles>> {
    if let Some(dir) = slot_directory("ZODCHI_CHECK_SLOT_DIR") {
        return Ok(vec![open_slot_in(&std::path::absolute(dir)?)?]);
    }
    open_default_check_slot()
}

#[cfg(windows)]
fn open_default_check_slot() -> Result<Vec<SlotFiles>> {
    use std::os::windows::fs::OpenOptionsExt;

    // Always take the per-user lock first, including when this token can write to ProgramData.
    let local = slot_directory("LOCALAPPDATA")
        .ok_or_else(|| GatewayError("The per-user check slot requires LOCALAPPDATA to be set.".into()))?;
    let mut files = vec![open_slot_in(&local.join("zodchi/locks"))?];
    if let Some(dir) = slot_directory("ProgramData").map(|path| path.join("zodchi/locks")) {
        let shared = (|| {
            fs::create_dir_all(&dir)?;
            // The lock file can be writable even when its directory cannot publish a receipt.
            let probe = dir.join(format!(".probe-{:016x}", rand::random::<u64>()));
            OpenOptions::new().write(true).create_new(true)
                .custom_flags(0x0400_0000) // FILE_FLAG_DELETE_ON_CLOSE
                .open(probe)?;
            open_slot_in(&dir)
        })();
        match shared {
            Ok(shared) if shared.receipt != files[0].receipt => files.push(shared),
            Ok(_) => {}
            Err(error) if matches!(error.kind(), ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem) => {}
            Err(error) => return fail(format!("Cannot open the check slot in {}: {error}", dir.display())),
        }
    }
    Ok(files)
}

#[cfg(unix)]
fn open_default_check_slot() -> Result<Vec<SlotFiles>> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};

    let uid = unsafe { libc::geteuid() };
    // Desktop sessions and scheduled jobs of the same user must share both the lock and its receipt.
    // E2E fixtures can redirect /tmp while exercising this selector inside a check that already holds the slot.
    let tmp = slot_directory("ZODCHI_TEST_CHECK_SLOT_TMP").unwrap_or_else(|| PathBuf::from("/tmp"));
    let dir = tmp.join(format!("zodchi-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let meta = fs::symlink_metadata(&dir)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return fail(format!("The check slot requires a private directory owned by the current user: {}", dir.display()));
    }
    Ok(vec![open_slot_in(&dir)?])
}

fn read_slot_receipt(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some)
            .map_err(|error| GatewayError(format!("Cannot read the check slot receipt {}: {error}", path.display()))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn live_slot_owners() -> Result<Vec<Value>> {
    let mut owners = Vec::new();
    for files in open_check_slot()? {
        if let Some(owner) = read_slot_receipt(&files.receipt)?.filter(is_current_holder) {
            owners.push(owner);
        }
    }
    Ok(owners)
}

/// The kernel lock is the authority. The adjacent receipt can be read while a Windows file lock is held.
/// It names the holder and, until a command is settled, the child to stop before any other run can use the slot.
pub struct CheckSlot {
    files: Vec<SlotFiles>,
    owner: Value,
}

impl CheckSlot {
    pub fn acquire(home: &Path, journal: &mut Journal, step: &str, attempt: u32) -> Result<Self> {
        Self::acquire_open(home, journal, step, attempt, open_check_slot()?)
    }

    fn acquire_open(home: &Path, journal: &mut Journal, step: &str, attempt: u32, opened: Vec<SlotFiles>) -> Result<Self> {
        let home = std::path::absolute(home)?;
        // A default directory or override can already select this home's original slot.
        let legacy = open_slot_in(&home.join("locks"))?;
        let legacy = (!opened.iter().any(|files| files.receipt == legacy.receipt)).then_some(legacy);
        let locks = opened.into_iter().map(|files| (files, None))
            .chain(legacy.map(|files| (files, Some(home.as_path()))));
        let mut contended = false;
        let mut waiting = false;
        let mut take = |lock: &File, receipt: &Path, legacy_home: Option<&Path>, journal: &mut Journal| -> Result<()> {
            loop {
                match lock.try_lock() {
                    Ok(()) => return Ok(()),
                    Err(TryLockError::Error(error)) => return Err(error.into()),
                    Err(TryLockError::WouldBlock) => {
                        contended = true;
                        if let Some(mut owner) = (!waiting).then(|| read_stored(receipt)).flatten()
                            .filter(|owner| is_current_holder(owner) && owner["runId"].is_string())
                        {
                            if let Some(home) = legacy_home.filter(|_| owner["home"].is_null()) {
                                owner["home"] = json!(home.display().to_string());
                            }
                            record_slot_wait(journal, step, attempt, Some(&owner))?;
                            waiting = true;
                        }
                        pause(100);
                    }
                }
            }
        };
        let pid = std::process::id();
        let repo = journal.read_value("run.json").and_then(|run| repo_slug(run["repo"].as_str()?).ok());
        let owner = json!({ "runId": journal.dir.file_name().and_then(|n| n.to_str()),
            "home": home.display().to_string(), "repoSlug": repo, "step": step,
            "pid": pid, "start": process_start(pid), "child": null });
        let mut slot = Self { files: Vec::new(), owner };
        let mut recover = Vec::new();
        // The home-local lock comes last. Name this run while it waits, keeping any unsettled child recoverable.
        for (files, legacy_home) in locks {
            take(&files.lock, &files.receipt, legacy_home, journal)?;
            let mut previous = read_slot_receipt(&files.receipt)?.unwrap_or(Value::Null);
            if previous["child"].is_null() {
                slot.publish_acquired(files)?;
            } else {
                recover.push((files, previous["child"].take()));
            }
        }
        // Recover under all applicable locks. A prior engine may have mirrored one child to several receipts.
        let mut settled_children = Vec::new();
        for (files, child) in recover {
            if !settled_children.contains(&child) {
                settle_process(&child, child["step"].as_str().unwrap_or(step))?;
                settled_children.push(child);
            }
            slot.publish_acquired(files)?;
        }
        // A previous holder can finish before its receipt is observed.
        if contended && !waiting {
            record_slot_wait(journal, step, attempt, None)?;
        }
        journal.append(json!({ "kind": "check slot acquired", "step": step, "attempt": attempt }))?;
        Ok(slot)
    }

    pub fn record(&mut self, journal: &mut Journal, step: &str, attempt: u32, phase: Phase, pid: u32, job: Option<&str>) -> Result<()> {
        let event = json!({ "step": step, "attempt": attempt, "pid": pid });
        match phase {
            Phase::Started => self.record_start(journal, event, pid, job),
            Phase::Ended => self.record_end(journal, event),
        }
    }

    fn set_repository(&mut self, paths: &ProjectPaths) -> Result<()> {
        let repo = paths.parent.file_name().and_then(|name| name.to_str()).expect("repository slug");
        if self.owner["repoSlug"] != repo {
            self.owner["repoSlug"] = json!(repo);
            self.publish_owner()?;
        }
        Ok(())
    }

    fn record_start(&mut self, journal: &mut Journal, mut event: Value, pid: u32, job: Option<&str>) -> Result<()> {
        let start = process_start(pid).ok_or_else(|| GatewayError(format!("Cannot identify check process {pid} before opening its gate.")))?;
        event["kind"] = json!("check started");
        event["pid"] = json!(pid);
        event["start"] = json!(start);
        event["job"] = json!(job);
        // The gate is still closed. Publish the identity before telling the child to run.
        self.owner["child"] = json!({ "pid": pid, "start": start, "step": event["step"], "job": job });
        self.publish_owner()?;
        journal.append(event)
    }

    fn record_end(&mut self, journal: &mut Journal, mut event: Value) -> Result<()> {
        event["kind"] = json!("check ended");
        journal.append(event)?;
        self.clear_child()
    }

    fn clear_child(&mut self) -> Result<()> {
        if !self.owner["child"].is_null() {
            self.owner["child"] = Value::Null;
            self.publish_owner()?;
        }
        Ok(())
    }

    fn publish_owner(&self) -> Result<()> {
        for files in self.files.iter().rev() {
            write_json_atomic(&files.receipt, &self.owner)?;
        }
        Ok(())
    }

    fn publish_acquired(&mut self, files: SlotFiles) -> Result<()> {
        // Drop only removes receipts this guard published.
        write_json_atomic(&files.receipt, &self.owner)?;
        self.files.push(files);
        Ok(())
    }
}

fn record_slot_wait(journal: &mut Journal, step: &str, attempt: u32, owner: Option<&Value>) -> Result<()> {
    // Status displays kind and step. Keep the actual step separately.
    let holder = owner.and_then(|owner| owner["runId"].as_str());
    let holder_home = owner.and_then(|owner| owner["home"].as_str());
    let display = holder.map_or_else(|| step.to_string(), |holder| format!("{step} (held by {holder})"));
    journal.append(json!({ "kind": "waiting for the check slot", "step": display,
        "checkStep": step, "attempt": attempt, "holder": holder, "holderHome": holder_home }))
}

fn is_current_holder(owner: &Value) -> bool {
    journal::live_pid(owner).is_some()
}

impl Drop for CheckSlot {
    fn drop(&mut self) {
        // Keep an unsettled child's identity for the next holder, even on a journal or process error.
        if self.owner["child"].is_null() {
            for files in &self.files {
                let _ = fs::remove_file(&files.receipt);
            }
        }
        // On macOS, a concurrent fork can keep the flock held through an inherited descriptor.
        #[cfg(unix)]
        let _ = self._lock.unlock();
    }
}

pub struct ProjectPaths {
    pub cache: PathBuf,
    parent: PathBuf,
}

pub(crate) const CHECKS_DIR: &str = "flow-checks";

fn repo_slug(top: &str) -> Result<String> {
    let top = claims::norm(top)?;
    let claims_dir = claims::claims_dir(&top);
    let name = claims_dir.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
    // The claims spelling is readable. A digest distinguishes paths whose punctuation folds to the same name.
    let digest = sha256_hex(claims::fold(&top, &top));
    Ok(format!("{}-{}", &name[name.len().saturating_sub(16)..], &digest[..12]))
}

impl ProjectPaths {
    pub fn new(home: &Path, git: &Git) -> Result<Self> {
        let top = git.run(&["rev-parse", "--show-toplevel"])?;
        let slug = repo_slug(top.trim_end_matches(['\r', '\n']))?;
        let home = std::path::absolute(home)?;
        Ok(Self { cache: home.join("flow-cache").join(&slug), parent: home.join(CHECKS_DIR).join(slug) })
    }

    pub fn private_places(&self) -> [(String, &'static str); 2] {
        [
            (self.parent.display().to_string(), "<check-workspace>"),
            (self.cache.display().to_string(), "<cache>"),
        ]
    }

    pub fn check_root(&self) -> &Path {
        self.parent.parent().expect("flow-checks folder")
    }

    fn resume_checkout(&self, workspace_id: &str, tree: &str) -> Result<bool> {
        let checkout = self.parent.join("checkout");
        let dot_git = checkout.join(".git");
        if !directory_path(self.check_root(), &dot_git, false)? {
            return Ok(false);
        }
        if read_stored(&checkout.join(CHECK_WORKSPACE)).as_ref() != Some(&json!({ "id": workspace_id, "tree": tree })) {
            return Ok(false);
        }
        Ok(Git::new(&checkout).rev("HEAD^{tree}").is_ok_and(|head| head == tree))
    }

    pub fn create_env_cache(&self, env: &BTreeMap<String, String>) -> Result<()> {
        if env.values().any(|value| value.contains(self.cache.to_string_lossy().as_ref())) {
            fs::create_dir_all(&self.cache)?;
        }
        Ok(())
    }

    /// Stage the exact tree first. Carry over only real directories that are still ignored by that tree and
    /// do not intersect its tracked paths. Discard the old checkout and any sibling fixtures before publishing.
    /// The slot must be held until the caller is finished with the published checkout.
    pub fn checkout(&self, cache: &[String], export: impl FnOnce(&Path) -> Result<()>) -> Result<PathBuf> {
        let root = self.check_root();
        fs::create_dir_all(root)?;
        if !directory_path(root, &self.parent, false)? {
            clear_export(&self.parent)?;
            fs::create_dir(&self.parent)?;
        }
        // Git writes into a unique stage. If the engine dies during the export, an old Git process cannot write
        // into the next holder's checkout. Keep the path short for Git object paths on Windows.
        let stage = StagedExport::new(&self.parent)?;
        let staging = stage.0.as_path();
        export(staging)?;
        crate::boundary::cut("check export staging");
        let checkout = self.parent.join("checkout");
        let cache_receipt = ".git/zodchi-check-cache.json";
        let has_previous = directory_path(root, &checkout.join(".git"), false)?;
        let previous = has_previous.then(|| read_stored(&checkout.join(cache_receipt))).flatten().unwrap_or(Value::Null);
        let snapshot = Git::new(staging);
        let mut eligible = Vec::new();
        for entry in cache {
            if directory_path(staging, &staging.join(entry), true)? && ignored_cache(&snapshot, entry)? {
                eligible.push(entry);
            }
        }
        eligible.sort();
        fs::write(staging.join(cache_receipt), json!(eligible).to_string())?;
        // Invalidate the old workspace before moving any of its generated files.
        if has_previous {
            match fs::remove_file(checkout.join(CHECK_WORKSPACE)) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Park caches at a fixed path until the new checkout is in place. If the engine is cut between these
        // moves, the next step can still restore them without involving the interrupted export.
        let parked = self.parent.with_extension("cache");
        for entry in &eligible {
            let from = checkout.join(entry);
            if previous.as_array().is_some_and(|paths| paths.iter().any(|path| path == entry.as_str()))
                && directory_path(&checkout, &from, false)?
            {
                let to = parked.join(entry);
                if directory_path(root, &to, true)? {
                    move_cache(&from, &to)?;
                }
            }
        }
        for entry in fs::read_dir(&self.parent)? {
            let path = entry?.path();
            if path != staging {
                clear_export(&path)?;
            }
        }
        fs::rename(staging, &checkout).map_err(|e| GatewayError(format!("Cannot publish the check checkout {}: {e}", checkout.display())))?;
        remove_stage_marker(staging)?;
        for entry in eligible {
            let from = parked.join(entry);
            if directory_path(root, &from, false)? {
                move_cache(&from, &checkout.join(entry))?;
            }
        }
        clear_export(&parked)?;
        Ok(checkout)
    }
}

const CHECK_WORKSPACE: &str = ".git/zodchi-check-workspace.json";

struct StagedExport(PathBuf);

pub(crate) fn is_check_stage(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix(".p-"))
        .is_some_and(|nonce| nonce.len() == 8 && nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn stage_marker(path: &Path) -> PathBuf {
    let repo = path.parent().expect("stage parent");
    let mut name = repo.file_name().expect("repository slug").to_os_string();
    name.push(".stage-");
    name.push(path.file_name().expect("stage name"));
    repo.with_file_name(name)
}

pub(crate) fn is_repo_check_stage(path: &Path) -> Result<bool> {
    if !is_check_stage(path) {
        return Ok(false);
    }
    match fs::symlink_metadata(stage_marker(path)) {
        Ok(meta) if meta.is_file() => return Ok(true),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // Old exports have no marker. A published checkout can have sibling fixtures with the same spelling.
    let repo = path.parent().expect("stage parent");
    Ok(!directory_path(repo, &repo.join("checkout/.git"), false)?)
}

fn remove_stage_marker(path: &Path) -> io::Result<()> {
    match fs::remove_file(stage_marker(path)) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(crate) fn clear_repo_check_stage(path: &Path) -> Result<()> {
    clear_export(path)?;
    Ok(remove_stage_marker(path)?)
}

impl StagedExport {
    fn new(root: &Path) -> Result<Self> {
        for entry in fs::read_dir(root)? {
            let path = entry?.path();
            if is_repo_check_stage(&path)? && directory_path(root, &path, false)? {
                clear_repo_check_stage(&path)?;
            }
        }
        loop {
            let path = root.join(format!(".p-{:08x}", rand::random::<u32>()));
            match fs::symlink_metadata(&path) {
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let marker = stage_marker(&path);
            match File::create_new(&marker) {
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
            if let Err(error) = fs::create_dir(&path) {
                let _ = fs::remove_file(&marker);
                return Err(error.into());
            }
            return Ok(Self(path));
        }
    }
}

impl Drop for StagedExport {
    fn drop(&mut self) { let _ = clear_repo_check_stage(&self.0); }
}

fn move_cache(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to.parent().expect("cache parent"))?;
    fs::rename(from, to).map_err(|e| GatewayError(format!("Cannot move the check cache {} to {}: {e}", from.display(), to.display())))
}

fn ignored_cache(snapshot: &Git, entry: &str) -> Result<bool> {
    let out = snapshot.output(&["-c", "core.excludesFile=", "check-ignore", "--no-index", "-q", "--", &format!("{entry}/")],
        &[("GIT_LITERAL_PATHSPECS", "0".into())], None)?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => fail(format!("Git could not check whether {entry:?} is ignored: {}", String::from_utf8_lossy(&out.stderr).trim())),
    }
}

fn ordinary_directory(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return false; } // Reparse point.
    }
    meta.is_dir()
}

/// An existing directory path, or a vacant path with ordinary directory ancestors.
fn directory_path(root: &Path, path: &Path, vacant: bool) -> Result<bool> {
    let mut current = root.to_path_buf();
    for part in path.strip_prefix(root).expect("path under root").components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if ordinary_directory(&meta) => {}
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vacant),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(!vacant)
}

pub(crate) fn clear_export(path: &Path) -> Result<()> {
    match remove_entry(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound
            && fs::symlink_metadata(path).is_err_and(|e| e.kind() == ErrorKind::NotFound) => Ok(()),
        Err(error) => fail(format!("Cannot clear the previous check export {}: {error}", path.display())),
    }
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if ordinary_directory(&meta) {
        let result = fs::remove_dir_all(path);
        #[cfg(windows)]
        if result.as_ref().is_err_and(|e| e.kind() == ErrorKind::PermissionDenied) {
            // Git's loose objects are read-only on Windows, as some generated files can be.
            remove_read_only_files(path)?;
            return fs::remove_dir_all(path);
        }
        return result;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x10 != 0 { // Directory link or junction.
            return fs::remove_dir(path);
        }
        if meta.file_attributes() & 0x400 == 0 && meta.permissions().readonly() {
            return remove_read_only_file(path);
        }
    }
    fs::remove_file(path)
}

#[cfg(windows)]
fn remove_read_only_files(path: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    let meta = fs::symlink_metadata(path)?;
    if ordinary_directory(&meta) {
        for entry in fs::read_dir(path)? {
            remove_read_only_files(&entry?.path())?;
        }
    } else if meta.file_attributes() & 0x400 == 0 && meta.permissions().readonly() {
        remove_read_only_file(path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn remove_read_only_file(path: &Path) -> std::io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(file: *mut c_void, class: i32, info: *mut u32, size: u32) -> i32;
    }
    const DELETE: u32 = 0x0001_0000;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_DISPOSITION_INFO_EX: i32 = 21;
    const FILE_DISPOSITION_DELETE: u32 = 0x01;
    const FILE_DISPOSITION_POSIX_SEMANTICS: u32 = 0x02;
    const FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE: u32 = 0x10;
    // Delete this directory entry without changing the attributes of any other hardlinks to the file.
    let file = OpenOptions::new().access_mode(DELETE | FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    let mut flags = FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS | FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE;
    if unsafe { SetFileInformationByHandle(file.as_raw_handle(), FILE_DISPOSITION_INFO_EX, &mut flags, std::mem::size_of::<u32>() as u32) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// What the journal is told about a check command: it started (its pid), or its process tree has ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Started,
    Ended,
}

pub fn record_process(journal: &mut crate::journal::Journal, step: &str, attempt: u32, phase: Phase, pid: u32) -> bool {
    let event = match phase {
        Phase::Started => json!({ "kind": "check started", "step": step, "attempt": attempt, "pid": pid, "start": process_start(pid) }),
        Phase::Ended => json!({ "kind": "check ended", "step": step, "attempt": attempt, "pid": pid }),
    };
    journal.append(event).is_ok()
}

/// The gate every check command passes: bash waits for the engine's word on stdin and only then runs the command
/// (`$1`) in its own place (the same pid). The engine gives the word after the pid and start time are in the journal;
/// when the engine is gone first, stdin closes and the gate exits 125 without running anything.
const GATE: &str = "IFS= read -r go || exit 125; [ \"$go\" = go ] || exit 125; set -- \"$BASH\" \"$@\"; for assignment in \"${@:3}\"; do export \"$assignment\" || exit 125; done; exec \"$1\" -c \"$2\" </dev/null";

/// Ends what a check command left in its process group (Unix: a check leads its own group). An error only when the
/// group could not be signalled at all; no group left is not one.
pub fn end_group(pid: u32) -> std::result::Result<(), String> {
    #[cfg(unix)]
    {
        // Exit 1 is "no such group" (or not ours): nothing of the check runs there.
        let status = command_without_window("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status();
        if let Err(e) = status {
            return Err(format!("kill could not start for the process group {pid}: {e}"));
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    Ok(())
}

/// Settle commands from earlier attempts before executing checks again.
pub fn reap_unended(journal: &mut crate::journal::Journal) -> Result<()> {
    let events = journal.events();
    let open: Vec<_> = events.iter().filter(|start| start["kind"] == "check started")
        .filter(|start| !events.iter().any(|end| {
            end["kind"] == "check ended" && end["step"] == start["step"]
                && end["attempt"] == start["attempt"] && end["pid"] == start["pid"]
                && end["seq"].as_u64().unwrap_or(0) > start["seq"].as_u64().unwrap_or(0)
        })).cloned().collect();
    for event in open {
        let state = settle_process(&event, event["step"].as_str().unwrap_or("?"))?;
        journal.append(json!({ "kind": "check ended", "step": event["step"], "attempt": event["attempt"], "pid": event["pid"], "reaped": state }))?;
    }
    Ok(())
}

fn settle_process(event: &Value, step: &str) -> Result<&'static str> {
    #[cfg(windows)]
    if let Some(name) = event["job"].as_str() {
        windows_job::settle_named(name)
            .map_err(|error| GatewayError(format!("Cannot settle the process job of {step} left by an earlier run: {error}.")))?;
        return Ok("stopped");
    }
    let pid = event["pid"].as_i64().unwrap_or(0);
    let state = stop_process(pid, event["start"].as_str());
    // On Unix a check owns its process group, which can outlive the group leader.
    let group = match state {
        "absent" | "stopped" => end_group(pid as u32),
        "other" => Ok(()),
        _ => Err(format!("it is still running and could not be stopped ({state})")),
    };
    group.map_err(|why| GatewayError(format!("a check command (pid {pid}) of {step} left by an earlier run: {why}. Stop it, then resume")))?;
    Ok(state)
}

#[derive(Default)]
pub struct CommandEnvironment<'a> {
    pub repo: Option<&'a Path>,
    pub extra: Option<&'a BTreeMap<String, String>>,
}

pub(crate) fn keep_environment(command: &mut Command) {
    command.env_clear();
    for key in KEEP {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

#[derive(Default)]
struct CommandExit {
    pid: Option<u32>,
    code: Option<i32>,
    ms: u64,
    note: String,
}

impl CommandExit {
    fn evidence(&self, cmd: &str, source: &str, log: &Path) -> Value {
        json!({ "command": cmd, "source": source, "exitCode": self.code, "log": log.display().to_string(),
            "ms": self.ms, "note": self.note })
    }
}

/// Open the gate only once the child is contained and the journal has its identity.
/// Return evidence only after the shell and anything it started have been stopped.
fn run_one(bash: &Path, cmd: &str, cwd: &Path, log: &Path, limit: Duration, environment: &CommandEnvironment<'_>, on_start: impl FnOnce(u32, Option<&str>) -> Result<()>) -> Result<CommandExit> {
    let started = Instant::now();
    let no_start = |note: String| Ok(CommandExit { note, ..CommandExit::default() });
    let Ok(file) = fs::File::create(log) else { return no_start("the log could not be created".into()) };
    let mut c = command_without_window(bash);
    c.arg("-c").arg(GATE).arg("zodchi-check").arg(cmd).current_dir(cwd);
    keep_environment(&mut c);
    if let Some(log_dir) = log.parent() { c.env("LOG_DIR", log_dir); }
    if let Some(repo) = environment.repo {
        c.env("ZODCHI_VERIFY_REPOSITORY", repo);
    }
    // The declared variables reach Bash only after the pid and start time have been recorded.
    for (key, value) in environment.extra.into_iter().flatten() {
        c.arg(format!("{key}={value}"));
    }
    #[cfg(windows)]
    let job = windows_job::Job::new().map_err(|error| GatewayError(format!("Cannot create the check process job: {error}.")))?;
    #[cfg(windows)]
    let spawned = job.spawn(&c, &file).map(|(child, stdin)| (child, Some(stdin)));
    #[cfg(not(windows))]
    let spawned = {
        let Ok(err) = file.try_clone() else { return no_start("the log could not be opened twice".into()) };
        c.stdin(Stdio::piped()).stdout(Stdio::from(file)).stderr(Stdio::from(err));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            c.process_group(0);
        }
        c.spawn().map(|mut child| {
            let stdin = child.stdin.take();
            (child, stdin)
        })
    };
    let (mut child, mut stdin) = match spawned {
        Ok(spawned) => spawned,
        Err(e) => return no_start(format!("bash could not start ({}): {e}", bash.display())),
    };
    let pid = child.id();
    #[cfg(windows)]
    let job_name = Some(job.name());
    #[cfg(not(windows))]
    let job_name = None;
    let go = on_start(pid, job_name).and_then(|_| {
        stdin.as_mut().ok_or_else(|| GatewayError("The check gate has no input pipe.".into()))?
            .write_all(b"go\n").map_err(|error| GatewayError(format!("Cannot open the check gate: {error}.")))
    });
    drop(stdin);
    let (code, note, shell_ended) = if go.is_ok() {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break (status.code(), String::new(), true),
                Ok(None) if started.elapsed() > limit => break (None, format!("stopped at its time limit of {} s", limit.as_secs()), false),
                Ok(None) => pause(100),
                Err(e) => break (None, format!("waiting for it failed: {e}"), false),
            }
        }
    } else {
        (None, String::new(), false)
    };
    #[cfg(windows)]
    {
        let _ = shell_ended;
        drop(child);
        job.settle().map_err(|error| GatewayError(format!("Cannot settle the check process job: {error}.")))?;
    }
    #[cfg(not(windows))]
    {
        end_group(pid).map_err(GatewayError)?;
        if !shell_ended {
            let _ = child.kill();
            child.wait()?;
        }
    }
    go?;
    Ok(CommandExit { pid: Some(pid), code, ms: started.elapsed().as_millis() as u64, note })
}

/// Runs a list of commands in order, each to its end. Every entry of the evidence holds the command, its source,
/// its real exit code (null when it did not end by itself) and its log. `on` records the start and the end of each
/// command; the second value is false when it could not, and then no further command starts.
pub fn run_list(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool) {
    run_legacy_commands(cmds, source, cwd, logs, limit, false, on)
}

pub fn run_setup(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool) {
    run_legacy_commands(cmds, source, cwd, logs, limit, true, on)
}

fn run_legacy_commands(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, stop_on_failure: bool, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool) {
    run_commands(cmds, source, cwd, logs, limit, &CommandEnvironment::default(), stop_on_failure, &mut |phase, pid, _| {
        if on(phase, pid) { Ok(()) } else { fail("Could not record the check process.") }
    })
}

#[allow(clippy::too_many_arguments)]
pub fn run_commands(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, environment: &CommandEnvironment<'_>, stop_on_failure: bool, on: &mut dyn FnMut(Phase, u32, Option<&str>) -> Result<()>) -> (Vec<Value>, bool) {
    let bash = find_bash();
    let _ = fs::create_dir_all(logs);
    let mut out = Vec::new();
    for (i, cmd) in cmds.iter().enumerate() {
        let log = command_log(logs, source, i + 1);
        let exit = run_one(&bash, cmd, cwd, &log, limit, environment, |pid, job| on(Phase::Started, pid, job));
        let exit = match exit {
            Ok(exit) => exit,
            Err(error) => {
                // A failed start record leaves the gate closed. Keep the attempted command and its log in the evidence.
                let failed = CommandExit { note: error.0, ..CommandExit::default() };
                out.push(failed.evidence(cmd, source, &log));
                return (out, false);
            }
        };
        out.push(exit.evidence(cmd, source, &log));
        if exit.pid.is_some_and(|pid| on(Phase::Ended, pid, None).is_err()) {
            return (out, false);
        }
        if stop_on_failure && exit.code != Some(0) {
            break;
        }
    }
    (out, true)
}

fn command_log(logs: &Path, source: &str, number: usize) -> PathBuf {
    logs.join(format!("{}-{number}.log", source.replace(['.', ' '], "-")))
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::{c_void, OsStr};
    use std::fs::File;
    use std::io::{self, PipeWriter};
    use std::mem::{size_of, size_of_val};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::process::{Command, ExitStatus};
    use std::ptr::{null, null_mut};

    use super::{pause, Duration, Instant};

    type Handle = *mut c_void;
    const EXTENDED_LIMITS: i32 = 9;
    const BASIC_ACCOUNTING: i32 = 1;
    const KILL_ON_CLOSE: u32 = 0x2000;
    const JOB_QUERY_AND_TERMINATE: u32 = 0x0004 | 0x0008;
    const JOB_LIST: usize = 0x0002_000d;
    const HANDLE_LIST: usize = 0x0002_0002;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const STARTF_USESTDHANDLES: u32 = 0x100;
    const DUPLICATE_SAME_ACCESS: u32 = 2;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        times: [i64; 4],
        page_faults: u32,
        total_processes: u32,
        active_processes: u32,
        terminated_processes: u32,
    }

    #[repr(C)]
    struct Startup {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        geometry: [u32; 7],
        flags: u32,
        show: u16,
        reserved2_size: u16,
        reserved2: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }

    #[repr(C)]
    struct StartupEx {
        startup: Startup,
        attributes: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInfo {
        process: Handle,
        thread: Handle,
        pid: u32,
        tid: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn OpenJobObjectW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
        fn QueryInformationJobObject(job: Handle, class: i32, info: *mut c_void, size: u32, returned: *mut u32) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn DuplicateHandle(source: Handle, handle: Handle, target: Handle, new: *mut Handle, access: u32, inherit: i32, options: u32) -> i32;
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(list: *mut c_void, flags: u32, attribute: usize, value: *mut c_void, size: usize, previous: *mut c_void, returned: *mut usize) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(app: *const u16, command: *mut u16, process_security: *const c_void, thread_security: *const c_void,
            inherit: i32, flags: u32, env: *const c_void, cwd: *const u16, startup: *mut Startup, info: *mut ProcessInfo) -> i32;
        fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
        fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
    }

    struct Attributes(*mut c_void);

    impl Drop for Attributes {
        fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.0) } }
    }

    pub(super) struct Child {
        id: u32,
        process: OwnedHandle,
    }

    impl Child {
        pub fn id(&self) -> u32 { self.id }

        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                258 => Ok(None), // WAIT_TIMEOUT
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    pub(super) struct Job {
        handle: OwnedHandle,
        name: String,
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            let name = format!("Global\\zodchi-check-{:032x}", rand::random::<u128>());
            let wide = wide(OsStr::new(&name))?;
            let handle = unsafe { CreateJobObjectW(null_mut(), wide.as_ptr()) };
            let error = io::Error::last_os_error();
            if handle.is_null() {
                return Err(error);
            }
            // Null security attributes make this handle non-inheritable.
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            if error.raw_os_error() == Some(183) { // ERROR_ALREADY_EXISTS
                return Err(error);
            }
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = KILL_ON_CLOSE;
            if unsafe { SetInformationJobObject(handle.as_raw_handle(), EXTENDED_LIMITS, (&limits as *const ExtendedLimits).cast(), size_of_val(&limits) as u32) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { handle, name })
        }

        pub fn name(&self) -> &str { &self.name }

        pub fn spawn(&self, command: &Command, log: &File) -> io::Result<(Child, PipeWriter)> {
            let (reader, writer) = io::pipe()?;
            let input = inheritable(&reader)?;
            let output = inheritable(log)?;
            let directory = command.get_current_dir().map(|path| wide(path.as_os_str())).transpose()?;
            let mut argv = Vec::new();
            for arg in std::iter::once(command.get_program()).chain(command.get_args()) {
                if !argv.is_empty() { argv.push(b' ' as u16); }
                quote_arg(arg, &mut argv)?;
            }
            argv.push(0);
            let env = environment(command)?;

            let mut size = 0;
            unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size); }
            let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            if size == 0 || unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut size) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut handles = [input.as_raw_handle(), output.as_raw_handle()];
            let mut jobs = [self.handle.as_raw_handle()];
            let _attributes = Attributes(list);
            for (attribute, values) in [(HANDLE_LIST, handles.as_mut_slice()), (JOB_LIST, jobs.as_mut_slice())] {
                if unsafe { UpdateProcThreadAttribute(list, 0, attribute, values.as_mut_ptr().cast(), size_of_val(values), null_mut(), null_mut()) } == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let mut startup: StartupEx = unsafe { std::mem::zeroed() };
            startup.startup.size = size_of::<StartupEx>() as u32;
            startup.startup.flags = STARTF_USESTDHANDLES;
            startup.startup.stdin = input.as_raw_handle();
            startup.startup.stdout = output.as_raw_handle();
            startup.startup.stderr = output.as_raw_handle();
            startup.attributes = list;
            let mut info: ProcessInfo = unsafe { std::mem::zeroed() };
            let flags = CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
            let cwd = directory.as_ref().map_or(null(), |wide| wide.as_ptr());
            // Bash may itself be a launcher. The OS assigns the job before any code in it can run.
            if unsafe { CreateProcessW(null(), argv.as_mut_ptr(), null(), null(), 1, flags, env.as_ptr().cast(), cwd, &mut startup.startup, &mut info) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let _thread = unsafe { OwnedHandle::from_raw_handle(info.thread) };
            let process = unsafe { OwnedHandle::from_raw_handle(info.process) };
            Ok((Child { id: info.pid, process }, writer))
        }

        pub fn settle(&self) -> io::Result<()> { settle(&self.handle) }
    }

    fn inheritable(handle: &impl AsRawHandle) -> io::Result<OwnedHandle> {
        let me = unsafe { GetCurrentProcess() };
        let mut copy = null_mut();
        if unsafe { DuplicateHandle(me, handle.as_raw_handle(), me, &mut copy, 0, 1, DUPLICATE_SAME_ACCESS) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(copy) })
    }

    fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
        let mut wide: Vec<_> = value.encode_wide().collect();
        if wide.contains(&0) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "an argument contains a NUL"));
        }
        wide.push(0);
        Ok(wide)
    }

    // Keep Rust's familiar Windows CRT quoting for a Bash program, one argument at a time.
    fn quote_arg(arg: &OsStr, argv: &mut Vec<u16>) -> io::Result<()> {
        const QUOTE: u16 = b'"' as u16;
        const BACKSLASH: u16 = b'\\' as u16;
        argv.push(QUOTE);
        let mut slashes = 0;
        for unit in arg.encode_wide() {
            match unit {
                0 => return Err(io::Error::new(io::ErrorKind::InvalidInput, "an argument contains a NUL")),
                BACKSLASH => { slashes += 1; continue; }
                QUOTE => slashes = slashes * 2 + 1,
                _ => {}
            }
            argv.extend(std::iter::repeat_n(BACKSLASH, slashes));
            argv.push(unit);
            slashes = 0;
        }
        argv.extend(std::iter::repeat_n(BACKSLASH, slashes * 2));
        argv.push(QUOTE);
        Ok(())
    }

    fn environment(command: &Command) -> io::Result<Vec<u16>> {
        let mut block = Vec::new();
        for (key, value) in command.get_envs().filter_map(|(key, value)| Some((key, value?))) {
            let mut pair = key.to_os_string();
            pair.push("=");
            pair.push(value);
            block.extend(wide(&pair)?);
        }
        if block.is_empty() { block.push(0); }
        block.push(0);
        Ok(block)
    }

    pub(super) fn settle_named(name: &str) -> io::Result<()> {
        let wide = wide(OsStr::new(name))?;
        let handle = unsafe { OpenJobObjectW(JOB_QUERY_AND_TERMINATE, 0, wide.as_ptr()) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            // Closing the last handle terminates the associated processes and destroys the job.
            return if error.kind() == io::ErrorKind::NotFound { Ok(()) } else { Err(error) };
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        settle(&handle)
    }

    fn active_processes(job: Handle) -> io::Result<u32> {
        let mut info = Accounting::default();
        if unsafe { QueryInformationJobObject(job, BASIC_ACCOUNTING, (&mut info as *mut Accounting).cast(), size_of::<Accounting>() as u32, null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info.active_processes)
    }

    fn settle(job: &OwnedHandle) -> io::Result<()> {
        let handle = job.as_raw_handle();
        if active_processes(handle)? == 0 {
            return Ok(());
        }
        if unsafe { TerminateJobObject(handle, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while active_processes(handle)? != 0 {
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the job still has active processes"));
            }
            pause(25);
        }
        Ok(())
    }
}

pub struct CheckBatch<'a> {
    pub step: &'a str,
    pub round: u32,
    pub attempt: u32,
    pub tree: &'a str,
    pub head: Option<&'a str>,
    pub logs: &'a Path,
    pub limit: Duration,
    pub environment: CommandEnvironment<'a>,
    pub checks: (&'a str, &'a [String]),
    pub verify: (&'a str, &'a [String]),
}

pub enum CheckOutcome {
    Finished { checkout: PathBuf, evidence: Vec<Value> },
    Unknown(String),
}

impl CheckBatch<'_> {
    pub fn run(&self, slot: &mut CheckSlot, journal: &mut Journal, paths: &ProjectPaths, cache: &[String], export: impl FnOnce(&Path) -> Result<()>) -> Result<CheckOutcome> {
        slot.set_repository(paths)?;
        let step = self.step;
        let attempt = self.attempt;
        let tree = self.tree;
        let intent = journal.last("intent", step, attempt);
        if intent.is_some_and(|event| event["tree"] != tree) {
            return Ok(CheckOutcome::Unknown("the candidate tree changed after this check attempt began".into()));
        }
        let mut evidence = match self.recover(journal) {
            Ok(evidence) => evidence,
            Err(why) => return Ok(CheckOutcome::Unknown(why)),
        };
        let mut checkout = paths.parent.join("checkout");
        if self.next(&evidence).is_some() {
            if evidence.is_empty() {
                let workspace = match intent.and_then(|event| event["workspaceId"].as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        let id = format!("{:032x}", rand::random::<u128>());
                        journal.append(json!({ "kind": "intent", "step": step, "round": self.round, "attempt": attempt,
                            "effect": "run checks", "digest": sha256_hex(tree), "tree": tree, "head": self.head, "workspaceId": id }))?;
                        id
                    }
                };
                checkout = paths.checkout(cache, |staging| {
                    export(staging)?;
                    if Git::new(staging).rev("HEAD^{tree}")? != tree {
                        return fail("The verification checkout does not match the pinned candidate tree.");
                    }
                    write_json_atomic(&staging.join(CHECK_WORKSPACE), &json!({ "id": workspace, "tree": tree }))
                })?;
            } else {
                let workspace = intent.and_then(|event| event["workspaceId"].as_str()).unwrap_or("");
                if !paths.resume_checkout(workspace, tree)? {
                    return Ok(CheckOutcome::Unknown("the checkout of the completed commands was replaced or no longer matches the candidate; pending commands may need its files".into()));
                }
            }
            if let Some(env) = self.environment.extra {
                paths.create_env_cache(env)?;
            }
            let bash = find_bash();
            let _ = fs::create_dir_all(self.logs);
            while let Some((source, cmd, number)) = self.next(&evidence) {
                let log = command_log(self.logs, source, number);
                let mut event = json!({ "step": step, "attempt": attempt, "tree": tree, "commandIndex": evidence.len() + 1 });
                let exit = run_one(&bash, cmd, &checkout, &log, self.limit, &self.environment, |pid, job| {
                    slot.record_start(journal, event.clone(), pid, job)
                })?;
                let result = exit.evidence(cmd, source, &log);
                event["pid"] = json!(exit.pid);
                event["result"] = result.clone();
                slot.record_end(journal, event)?;
                crate::boundary::cut(&format!("{step} {source} #{number}"));
                evidence.push(result);
            }
        }
        Ok(CheckOutcome::Finished { checkout, evidence })
    }

    fn next(&self, evidence: &[Value]) -> Option<(&str, &str, usize)> {
        let index = evidence.len();
        let (source, cmds) = self.checks;
        if let Some(cmd) = cmds.get(index) {
            return Some((source, cmd, index + 1));
        }
        if !passed(&evidence[..cmds.len()]) {
            return None;
        }
        let (source, verify) = self.verify;
        let verify_index = index - cmds.len();
        verify.get(verify_index).map(|cmd| (source, cmd.as_str(), verify_index + 1))
    }

    /// A start without a result is ambiguous even after reaping. Only replay a complete prefix of receipts.
    fn recover(&self, journal: &Journal) -> std::result::Result<Vec<Value>, String> {
        let mut evidence = Vec::new();
        let mut started = None;
        let unknown = |index| format!("check command {index} has no matching result for this candidate; inspect the logs before rerunning");
        for event in journal.events().iter().filter(|event| event["step"] == self.step && event["attempt"] == self.attempt
            && matches!(event["kind"].as_str(), Some("check started" | "check ended")))
        {
            let index = evidence.len() + 1;
            let Some((source, cmd, number)) = self.next(&evidence) else { return Err(unknown(index)) };
            if event["tree"] != self.tree || event["commandIndex"] != index {
                return Err(unknown(index));
            }
            let pid = event["pid"].as_u64();
            if event["kind"] == "check started" {
                if started.is_some() || pid.is_none() {
                    return Err(unknown(index));
                }
                started = pid;
            } else {
                let result = &event["result"];
                let log = command_log(self.logs, source, number);
                if pid != started || result["command"] != cmd || result["source"] != source
                    || result["log"] != log.display().to_string() || result.get("exitCode").is_none()
                {
                    return Err(unknown(index));
                }
                evidence.push(result.clone());
                started = None;
            }
        }
        if started.is_some() {
            return Err(unknown(evidence.len() + 1));
        }
        Ok(evidence)
    }
}

/// A stable label for a command in the evidence, such as "args.verify #1".
pub fn name(evidence: &[Value], i: usize) -> String {
    let source = evidence[i]["source"].as_str().unwrap_or("?");
    let n = evidence[..=i].iter().filter(|e| e["source"].as_str() == Some(source)).count();
    format!("{source} #{n}")
}

pub const WITHHELD_LINE: &str = "[source line withheld]";
pub const LEGACY_WITHHELD_LINE: &str = "[a line that may hold a credential is left out]";

/// Output of a check made fit for a model: the known private folders (`places`: a path and the word that stands for
/// it) replaced in any spelling of the path, and every line that may hold a credential (a password, token, key,
/// secret, cookie or a URL with a user) left out whole.
pub fn sanitize(text: &str, places: &[(String, &str)]) -> String {
    let lines = text.lines().map(|line| if credential_line(line) { WITHHELD_LINE } else { line });
    screen_paths(lines, places)
}

pub(crate) fn credential_url(line: &str) -> bool {
    line.match_indices("://").any(|(i, _)| line[i..].split_whitespace().next().is_some_and(|u| u.contains('@')))
}

pub fn credential_line(line: &str) -> bool {
    const MARKERS: [&str; 12] = ["password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "authorization", "bearer", "private key", "credential", "cookie"];
    let low = line.to_ascii_lowercase().replace(LEGACY_WITHHELD_LINE, WITHHELD_LINE);
    credential_url(&low) || MARKERS.iter().any(|m| low.contains(m))
}

pub fn screen_paths<'a>(text: impl Iterator<Item = &'a str>, places: &[(String, &str)]) -> String {
    let mut spellings: Vec<(String, &str)> = Vec::new();
    for (path, word) in places {
        let mut add = |fwd: &str| {
            if fwd.len() < 2 {
                return;
            }
            spellings.push((fwd.to_string(), *word));
            // Git for Windows may use the drive letter as the first folder.
            let bytes = fwd.as_bytes();
            if bytes.len() > 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                spellings.push((format!("/{}{}", (bytes[0] as char).to_ascii_lowercase(), &fwd[2..]), *word));
            }
        };
        for path in [Some(path.clone()), resolved_spelling(Path::new(path))].into_iter().flatten() {
            let forward = path.replace('\\', "/");
            let forward = forward.trim_end_matches('/');
            add(forward);
            if let Some(path) = forward.strip_prefix("//?/") {
                if let Some(unc) = path.strip_prefix("UNC/") {
                    add(&format!("//{unc}"));
                } else {
                    add(path);
                }
            }
        }
    }
    // The longest first: a folder inside another is named by its own word.
    spellings.sort_by_key(|(f, _)| std::cmp::Reverse(f.len()));
    let mut lines = Vec::new();
    for line in text {
        let mut out = line.to_string();
        for (form, word) in &spellings {
            out = replace_screened_path(&out, form, word);
        }
        lines.push(out);
    }
    lines.join("\n")
}

/// Checkouts may already be removed when their logs reach the reviewer. Their existing parent still resolves
/// aliases such as a Windows short directory name or the macOS system temporary directory.
fn resolved_spelling(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    path.ancestors().find_map(|ancestor| {
        let base = fs::canonicalize(ancestor).ok()?;
        let suffix = path.strip_prefix(ancestor).ok()?;
        Some(base.join(suffix).to_string_lossy().into_owned())
    })
}

/// Match paths ignoring ASCII case and mixed path separators. Each folded byte keeps its original offset.
fn replace_screened_path(text: &str, needle: &str, with: &str) -> String {
    let low = text.to_ascii_lowercase().replace('\\', "/");
    let n = needle.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = low[at..].find(&n) {
        out.push_str(&text[at..at + i]);
        out.push_str(with);
        at += i + n.len();
    }
    out.push_str(&text[at..]);
    out
}

pub fn passed(evidence: &[Value]) -> bool {
    evidence.iter().all(|e| e["exitCode"] == json!(0))
}

/// The end of a log, for the writer that fixes a failure.
pub fn tail(log: &str, max: usize) -> String {
    let text = fs::read(log).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    tail_text(&text, max)
}

fn tail_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("... ({} bytes before)\n{}", start, &text[start..])
}

/// Read from the beginning so the scrubber sees multiline credentials before anything is clipped for review.
pub fn review_output(log: &Path, budget: usize, clean: impl FnOnce(&str) -> String) -> String {
    const READ_LIMIT: u64 = 128 * 1024;
    let mut bytes = Vec::new();
    if fs::File::open(log).and_then(|file| file.take(READ_LIMIT + 1).read_to_end(&mut bytes)).is_err() {
        return "[log unavailable]".into();
    }
    let clipped = bytes.len() as u64 > READ_LIMIT;
    if clipped {
        // Keep complete lines from the bounded read. Do not expose an incomplete value at its boundary.
        bytes.truncate(bytes.iter().rposition(|byte| *byte == b'\n').unwrap_or(0));
    }
    let text = clean(&String::from_utf8_lossy(&bytes));
    let excerpt = tail_text(&text, budget);
    if clipped { format!("{excerpt}\n[remaining log omitted]") } else { excerpt }
}

pub fn temp_dir(run: &str, tag: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("zodchi-flow-{run}-{}-{:08x}", tag.replace([' ', '.'], "-"), rand::random::<u32>()));
    fs::create_dir(&dir)?;
    Ok(dir)
}

pub fn remove(dir: &Path) {
    for _ in 0..5 {
        if fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        pause(200);
    }
}

pub fn result(evidence: &[Value]) -> Result<Value> {
    Ok(json!({ "ok": passed(evidence), "evidence": evidence }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self { Self(temp_dir("test", "check-slot").unwrap()) }

        fn journal(&self, id: &str) -> Journal {
            Journal::create(&self.0, id, &json!({})).unwrap()
        }

        fn acquire(&self, journal: &mut Journal, step: &str) -> CheckSlot {
            let files = open_slot_in(&self.0.join("locks")).unwrap();
            CheckSlot::acquire_open(&self.0, journal, step, 1, vec![files]).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = clear_export(&self.0); }
    }

    #[test]
    fn slot_releases_after_success_failure_timeout_and_spawn_error() {
        let fixture = Fixture::new();
        let mut journal = fixture.journal("run");
        let missing = fixture.0.join("missing");
        let logs = fixture.0.join("logs");
        let cases = [
            ("success", "exit 0", &fixture.0, Duration::from_secs(15), Some(0), ""),
            ("failure", "exit 7", &fixture.0, Duration::from_secs(15), Some(7), ""),
            ("timeout", "sleep 15", &fixture.0, Duration::from_millis(300), None, "time limit"),
            ("error", "exit 0", &missing, Duration::from_secs(15), None, "bash could not start"),
        ];
        for (step, cmd, cwd, limit, exit, note) in cases {
            {
                let mut slot = fixture.acquire(&mut journal, step);
                let mut record = |phase, pid, job: Option<&str>| slot.record(&mut journal, step, 1, phase, pid, job);
                let (evidence, recorded) = run_commands(&[cmd.into()], step, cwd, &logs, limit, &CommandEnvironment::default(), false, &mut record);
                assert!(recorded);
                assert_eq!(evidence[0]["exitCode"], json!(exit), "{evidence:?}");
                assert!(evidence[0]["note"].as_str().unwrap().contains(note), "{evidence:?}");
            }
            let lock = OpenOptions::new().read(true).write(true).open(fixture.0.join("locks/check-slot.lock")).unwrap();
            assert!(lock.try_lock().is_ok(), "{step} did not release the slot");
        }
    }

    #[test]
    fn a_waiting_run_contends_with_the_legacy_home_slot() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        let legacy_dir = home.join("locks");
        let SlotFiles { lock: old_lock, receipt: old_receipt } = open_slot_in(&legacy_dir).unwrap();
        old_lock.try_lock().unwrap();
        let pid = std::process::id();
        write_json_atomic(&old_receipt, &json!({ "runId": "pinned-run", "pid": pid, "start": process_start(pid) })).unwrap();
        let mut next = Journal::create(&home, "next", &json!({})).unwrap();
        let (observer, _) = Journal::open(&home, "next").unwrap();
        let files = open_slot_in(&fixture.0.join("shared")).unwrap();
        let shared_receipt = files.receipt.clone();
        let waiter = std::thread::spawn({
            let home = home.clone();
            move || {
                let slot = CheckSlot::acquire_open(&home, &mut next, "verify", 1, vec![files]).unwrap();
                (slot, next)
            }
        });
        let until = Instant::now() + Duration::from_secs(10);
        let waiting = loop {
            if let Some(event) = observer.snapshot().unwrap().into_iter().next() { break Some(event); }
            if Instant::now() > until { break None; }
            pause(25);
        };
        let shared_holder = read_stored(&shared_receipt);
        drop(old_lock);
        let (slot, next) = waiter.join().unwrap();
        let waiting = waiting.unwrap();
        assert_eq!(waiting["kind"], "waiting for the check slot");
        assert_eq!(waiting["holder"], "pinned-run");
        assert_eq!(waiting["holderHome"], std::path::absolute(&home).unwrap().display().to_string());
        assert_eq!(shared_holder.unwrap()["runId"], "next");
        assert_eq!(next.events()[1]["kind"], "check slot acquired");
        assert_eq!(read_stored(&old_receipt).unwrap()["runId"], "next");
        let legacy = open_slot_in(&legacy_dir).unwrap().lock;
        assert!(matches!(legacy.try_lock(), Err(TryLockError::WouldBlock)));
        drop(slot);
        assert!(legacy.try_lock().is_ok());
        assert!(!old_receipt.exists());
    }

    #[test]
    fn an_unsettled_legacy_child_blocks_checks_until_it_is_safe_to_proceed() {
        let fixture = Fixture::new();
        let old_receipt = open_slot_in(&fixture.0.join("locks")).unwrap().receipt;
        // Recovery must never stop the calling process. Use it to model a child we cannot safely settle.
        let pid = std::process::id();
        let previous = json!({ "runId": "pinned-run",
            "child": { "step": "legacy verify", "pid": pid, "start": process_start(pid) } });
        write_json_atomic(&old_receipt, &previous).unwrap();
        let shared_dir = fixture.0.join("shared");
        let mut next = fixture.journal("next");
        let error = CheckSlot::acquire_open(&fixture.0, &mut next, "verify", 1, vec![open_slot_in(&shared_dir).unwrap()])
            .err().unwrap();
        assert!(error.0.contains("legacy verify"), "{error}");
        assert_eq!(read_stored(&old_receipt), Some(previous));
        assert!(!shared_dir.join("check-slot.json").exists());
        assert!(next.events().is_empty());
    }

    #[test]
    fn a_stale_owner_and_reused_pid_do_not_hold_the_slot() {
        let fixture = Fixture::new();
        let locks = fixture.0.join("locks");
        fs::create_dir(&locks).unwrap();
        File::create(locks.join("check-slot.lock")).unwrap();
        let owner = json!({ "runId": "stale", "pid": std::process::id(), "start": "previous process" });
        assert!(!is_current_holder(&owner));
        write_json_atomic(&locks.join("check-slot.json"), &owner).unwrap();
        let mut next = fixture.journal("next");
        let _slot = fixture.acquire(&mut next, "checks 1");
        assert_eq!(next.events()[0]["kind"], "check slot acquired");
        assert_eq!(read_stored(&locks.join("check-slot.json")).unwrap()["runId"], "next");
    }

    #[test]
    fn a_partial_check_attempt_stops_if_a_command_is_unconfirmed_or_its_checkout_is_gone() {
        let fixture = Fixture::new();
        let mut journal = fixture.journal("run");
        let paths = ProjectPaths { cache: fixture.0.join("flow-cache/repo"), parent: fixture.0.join("flow-checks/repo") };
        let logs = journal.file("logs");
        let cheap = ["check".into()];
        let verify = ["verify".into()];
        let step = "checks 1";
        let mut slot = fixture.acquire(&mut journal, step);
        let batch = CheckBatch {
            step, attempt: 1, round: 1, tree: "tree", head: None, logs: &logs, limit: Duration::from_secs(15),
            environment: CommandEnvironment::default(), checks: ("checks", &cheap), verify: ("args.verify", &verify),
        };
        journal.append(json!({ "kind": "intent", "step": step, "attempt": 1, "tree": "tree", "workspaceId": "old-checkout" })).unwrap();
        journal.append(json!({ "kind": "check started", "step": step, "attempt": 1, "tree": "tree", "commandIndex": 1, "pid": 42 })).unwrap();
        let recovered = batch.run(&mut slot, &mut journal, &paths, &[], |_| panic!("a check with unknown outcome cannot run again")).unwrap();
        assert!(matches!(recovered, CheckOutcome::Unknown(why) if why.contains("no matching result")));

        journal.append(json!({ "kind": "check ended", "step": step, "attempt": 1, "tree": "tree", "commandIndex": 1, "pid": 42,
            "result": { "command": cheap[0], "source": "checks", "exitCode": 0, "log": command_log(&logs, "checks", 1) } })).unwrap();
        let recovered = batch.run(&mut slot, &mut journal, &paths, &[], |_| panic!("pending commands need the original export")).unwrap();
        assert!(matches!(recovered, CheckOutcome::Unknown(why) if why.contains("checkout of the completed commands was replaced")));
    }

    #[test]
    fn completed_check_receipts_survive_replacement_of_the_checkout() {
        let fixture = Fixture::new();
        let mut journal = fixture.journal("run");
        let paths = ProjectPaths { cache: fixture.0.join("flow-cache/repo"), parent: fixture.0.join("flow-checks/repo") };
        let logs = journal.file("logs");
        let cheap = ["cheap".into()];
        let verify = ["verify".into()];
        let step = "checks 1";
        let mut slot = fixture.acquire(&mut journal, step);
        let batch = CheckBatch {
            step, attempt: 1, round: 1, tree: "tree", head: None, logs: &logs, limit: Duration::from_secs(15),
            environment: CommandEnvironment::default(), checks: ("checks", &cheap), verify: ("args.verify", &verify),
        };
        journal.append(json!({ "kind": "intent", "step": step, "attempt": 1, "tree": "tree", "workspaceId": "old-checkout" })).unwrap();
        let mut expected = Vec::new();
        for (index, (command, source, code)) in [(&cheap[0], "checks", 0), (&verify[0], "args.verify", 7)].into_iter().enumerate() {
            let result = CommandExit { code: Some(code), ..CommandExit::default() }.evidence(command, source, &command_log(&logs, source, 1));
            let mut event = json!({ "kind": "check started", "step": step, "attempt": 1,
                "tree": "tree", "commandIndex": index + 1, "pid": index + 42 });
            journal.append(event.clone()).unwrap();
            event["kind"] = json!("check ended");
            event["result"] = result.clone();
            journal.append(event).unwrap();
            expected.push(result);
        }
        let recovered = batch.run(&mut slot, &mut journal, &paths, &[], |_| panic!("all commands already have receipts")).unwrap();
        assert!(matches!(recovered, CheckOutcome::Finished { evidence, .. } if evidence == expected));
    }

    #[cfg(windows)]
    fn job_fixture(root: &Path, role: &str) -> Command {
        let mut command = command_without_window(std::env::current_exe().unwrap());
        keep_environment(&mut command);
        command.args(["--exact", "checks::tests::check_job_fixture"]).env("ZODCHI_TEST_CHECK_JOB", role)
            .env("ZODCHI_TEST_CHECK_JOB_ROOT", root).stdout(Stdio::null()).stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.is_file() {
            assert!(Instant::now() < deadline, "timed out waiting for {}", path.display());
            pause(25);
        }
    }

    #[cfg(windows)]
    #[test]
    fn check_job_fixture() {
        let Ok(role) = std::env::var("ZODCHI_TEST_CHECK_JOB") else { return };
        let root = PathBuf::from(std::env::var_os("ZODCHI_TEST_CHECK_JOB_ROOT").unwrap());
        let ready = root.join("ready");
        if role == "leader" {
            let mut input = [0];
            std::io::stdin().read_exact(&mut input).unwrap();
            assert_eq!(input, *b"g");
            let _worker = job_fixture(&root, "worker").stdin(Stdio::null()).spawn().unwrap();
            wait_for_file(&ready);
        } else {
            write_json_atomic(&ready, &json!(std::process::id())).unwrap();
            wait_for_file(&root.join("release"));
            fs::write(root.join("late-write"), "the check did not end").unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_settles_a_worker_that_outlives_the_leader() {
        let fixture = Fixture::new();
        let job = windows_job::Job::new().unwrap();
        let log = File::create(fixture.0.join("job.log")).unwrap();
        let (mut leader, mut gate) = job.spawn(&job_fixture(&fixture.0, "leader"), &log).unwrap();
        gate.write_all(b"g").unwrap();
        drop(gate);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = leader.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "the check leader did not exit");
            pause(25);
        }
        drop(leader);
        let worker = read_stored(&fixture.0.join("ready")).unwrap().as_u64().unwrap() as u32;
        assert!(zodchi_core::process::alive(worker));
        windows_job::settle_named(job.name()).unwrap();
        fs::write(fixture.0.join("release"), "").unwrap();
        assert!(!zodchi_core::process::alive(worker));
        assert!(!fixture.0.join("late-write").exists());
    }

    #[test]
    fn stable_checkout_replaces_the_old_tree_and_restores_only_ignored_cache_folders() {
        let fixture = Fixture::new();
        let repo = fixture.0.join("repo");
        fs::create_dir(&repo).unwrap();
        let git = Git::new(&repo);
        git.run(&["init", "--quiet", "--template="]).unwrap();
        let commit = || {
            git.run(&["add", "-A"]).unwrap();
            git.run(&["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost",
                "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]).unwrap();
            git.rev("HEAD^{tree}").unwrap()
        };
        fs::write(repo.join(".gitignore"), "rust/target/\ntracked-cache/\nformer-cache/\nignored-extra/\n").unwrap();
        fs::write(repo.join("tracked.txt"), "baseline").unwrap();
        fs::write(repo.join("removed.txt"), "old revision").unwrap();
        let first = commit();
        let paths = ProjectPaths::new(&fixture.0, &git).unwrap();
        let cache = ["rust/target", "tracked-cache", "former-cache", "unignored"].map(String::from);
        let old = paths.checkout(&cache, |staging| git.checkout_for_checks(&first, staging)).unwrap();
        for path in ["rust/target", "tracked-cache", "former-cache", "unignored", "ignored-extra"] {
            fs::create_dir_all(old.join(path)).unwrap();
            fs::write(old.join(path).join("leftover"), "previous check").unwrap();
        }
        fs::write(old.join("tracked.txt"), "dirty tracked file").unwrap();
        fs::write(old.join("untracked.txt"), "untracked file").unwrap();
        fs::write(old.with_file_name("sibling-fixture"), "left in the parent").unwrap();

        fs::remove_file(repo.join("removed.txt")).unwrap();
        fs::write(repo.join("tracked.txt"), "candidate").unwrap();
        fs::write(repo.join(".gitignore"), "rust/target/\ntracked-cache/\nignored-extra/\n").unwrap();
        fs::create_dir(repo.join("tracked-cache")).unwrap();
        fs::write(repo.join("tracked-cache/input"), "committed input").unwrap();
        git.run(&["add", "-f", "--", "tracked-cache/input"]).unwrap();
        let second = commit();
        let checkout = paths.checkout(&cache, |staging| git.checkout_for_checks(&second, staging)).unwrap();
        assert_eq!(checkout, old);
        assert_eq!(Git::new(&checkout).rev("HEAD^{tree}").unwrap(), second);
        assert_eq!(fs::read_to_string(checkout.join("tracked.txt")).unwrap(), "candidate");
        assert_eq!(fs::read_to_string(checkout.join("tracked-cache/input")).unwrap(), "committed input");
        assert_eq!(fs::read_to_string(checkout.join("rust/target/leftover")).unwrap(), "previous check");
        for path in ["removed.txt", "untracked.txt", "tracked-cache/leftover", "former-cache", "unignored", "ignored-extra"] {
            assert!(!checkout.join(path).exists(), "the new checkout still has {path}");
        }
        assert!(!checkout.with_file_name("sibling-fixture").exists());
        assert!(Git::new(&checkout).dirty().unwrap().is_empty());

        // Model a cut after the cache was parked but before the next export was published.
        let parked = paths.parent.with_extension("cache");
        move_cache(&checkout.join("rust/target"), &parked.join("rust/target")).unwrap();
        fs::remove_file(repo.join("tracked-cache/input")).unwrap();
        let third = commit();
        let checkout = paths.checkout(&cache, |staging| git.checkout_for_checks(&third, staging)).unwrap();
        assert!(!checkout.join("tracked-cache").exists(), "a previously tracked folder became a cache");
        assert!(checkout.join("rust/target/leftover").exists());
        assert!(!parked.exists());
    }

    #[test]
    fn staging_reclaims_abandoned_exports_for_its_repository_before_exporting() {
        let fixture = Fixture::new();
        let mut journal = fixture.journal("run");
        let _slot = fixture.acquire(&mut journal, "verify");
        let paths = ProjectPaths { cache: fixture.0.join("flow-cache/repo"), parent: fixture.0.join("flow-checks/repo") };
        let abandoned = paths.parent.join(".p-deadbeef");
        let another_repo = paths.check_root().join("another-repo/.p-deadbeef");
        for stage in [&abandoned, &another_repo] {
            fs::create_dir_all(stage).unwrap();
            fs::write(stage.join("partial-export"), "staged files").unwrap();
        }
        let mut fresh = None;
        let result = paths.checkout(&[], |staging| {
            assert_eq!(staging.parent(), Some(paths.parent.as_path()));
            assert!(staging.is_dir());
            assert!(!abandoned.exists());
            assert!(another_repo.exists());
            fresh = Some(staging.to_path_buf());
            fail("test export error")
        });
        assert_eq!(result.unwrap_err().0, "test export error");
        assert!(!fresh.unwrap().exists());
    }

    #[test]
    fn staging_distinguishes_a_registered_export_from_published_checkout_fixtures() {
        let fixture = Fixture::new();
        let repo = fixture.0.join("flow-checks/repo");
        fs::create_dir_all(repo.join("checkout/.git")).unwrap();
        let sibling = repo.join(".p-deadbeef");
        fs::create_dir(&sibling).unwrap();
        let interrupted = StagedExport::new(&repo).unwrap();
        let abandoned = interrupted.0.clone();
        std::mem::forget(interrupted);
        let fresh = StagedExport::new(&repo).unwrap();
        assert!(!abandoned.exists() && !stage_marker(&abandoned).exists());
        assert!(sibling.exists() && fresh.0.exists());
    }
}
