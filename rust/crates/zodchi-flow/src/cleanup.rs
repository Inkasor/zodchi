//! Reclaim run-owned scratch and retire records only after checking their on-disk references.

use crate::{
    candidate, checks,
    journal::{self, Journal},
    Exit,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata, OpenOptions, TryLockError},
    io::{self, ErrorKind, Read, Seek, Write},
    path::{Component, Path, PathBuf},
};
use zodchi_core::{
    config::{is_source_commit, user_home},
    util::{fail, iso, now_ms, parse_iso_ms, sha256_hex, GatewayError, Result},
};

const WRITERS: &str = "flow-writers";
const BUILDS: &str = "dev-builds";
const PACKAGES: &str = "packages";
const LARGE: u64 = 100_000_000;
const DAY_MS: i128 = 86_400_000;
const USAGE: &str =
    "Usage: zodchi flow cleanup [--apply] [--journals] [--retention-days <n>] [--claims]";

struct Options {
    apply: bool,
    journals: bool,
    claims: bool,
    retention_days: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            apply: false,
            journals: false,
            claims: false,
            retention_days: 14,
        }
    }
}

impl Options {
    fn parse(args: &[String]) -> Result<Self> {
        let mut options = Self::default();
        let mut days_set = false;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--apply" if !options.apply => options.apply = true,
                "--journals" if !options.journals => options.journals = true,
                "--claims" if !options.claims => options.claims = true,
                "--retention-days" if !days_set => {
                    options.retention_days = args
                        .next()
                        .and_then(|n| n.parse().ok())
                        .filter(|n| (1..=365).contains(n))
                        .ok_or_else(|| {
                            GatewayError("--retention-days needs an integer from 1 to 365.".into())
                        })?;
                    days_set = true;
                }
                _ => return fail(format!("Unexpected argument {arg:?}.\n{USAGE}")),
            }
        }
        Ok(options)
    }
}

fn zodchi_home() -> Result<PathBuf> {
    // Use Config's home convention without loading account configuration for disk maintenance.
    let home = std::env::var_os("ZODCHI_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".zodchi"));
    Ok(std::path::absolute(home)?)
}

fn profile_packages() -> Result<PathBuf> {
    Ok(std::path::absolute(
        user_home().join(".zodchi").join(PACKAGES),
    )?)
}

pub fn cli(args: &[String]) -> Result<Exit> {
    if matches!(args, [flag] if flag == "--help" || flag == "-h") {
        return Ok(Exit {
            code: 0,
            result: json!({ "usage": USAGE }),
        });
    }
    let options = Options::parse(args)?;
    let home = zodchi_home()?;
    let profile_packages = profile_packages()?;
    let report = collect(
        &home,
        &std::env::temp_dir(),
        Some(&profile_packages),
        &options,
        checks::live_slot_owners,
    );
    Ok(Exit {
        code: if report.errors.is_empty() { 0 } else { 2 },
        result: report.json(options.apply),
    })
}

fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

/// Check the ancestors before looking at the leaf. symlink_metadata alone only checks the leaf.
fn checked(path: &Path) -> Result<Option<Metadata>> {
    let mut current = PathBuf::new();
    let mut leaf = None;
    for part in path.components() {
        if part == Component::ParentDir {
            return fail(format!(
                "Cleanup path contains a parent component: {}",
                path.display()
            ));
        }
        current.push(part);
        if !matches!(part, Component::Normal(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if linked(&meta) => {
                return fail(format!(
                    "Cleanup path crosses a link or reparse point: {}",
                    current.display()
                ));
            }
            Ok(meta) => leaf = Some(meta),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return fail(format!("Cannot inspect {}: {error}", current.display())),
        }
    }
    Ok(leaf)
}

fn entries(path: &Path) -> Result<Vec<PathBuf>> {
    if checked(path)?.is_none() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<_> = fs::read_dir(path)?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<io::Result<_>>()?;
    paths.sort_unstable();
    Ok(paths)
}

fn read_json(path: &Path) -> Result<Option<Value>> {
    match checked(path)? {
        None => Ok(None),
        Some(meta) if meta.is_file() => {
            let text = fs::read_to_string(path)?;
            serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map(Some)
                .map_err(|e| GatewayError(format!("Cannot parse {}: {e}", path.display())))
        }
        Some(_) => fail(format!("Expected a regular file: {}", path.display())),
    }
}

fn size(path: &Path, meta: Metadata) -> io::Result<u64> {
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    let mut bytes = 0u64;
    let mut dirs = vec![path.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if linked(&meta) {
                continue;
            }
            if meta.is_dir() {
                dirs.push(entry.path());
            } else {
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    Ok(bytes)
}

fn open_lock(path: &Path) -> Result<File> {
    checked(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    if linked(&file.metadata()?) {
        return fail(format!("Cleanup lock crosses a link: {}", path.display()));
    }
    Ok(file)
}

pub(crate) fn lock_sources(home: &Path, shared: bool) -> Result<File> {
    let lock = open_lock(&journal::flows_dir(home).join(".sources.lock"))?;
    if shared {
        lock.lock_shared()?;
    } else {
        lock.lock()?;
    }
    Ok(lock)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Writer,
    Candidate,
    CheckTemp,
    CheckStage,
    JournalTemp,
    Journal,
    RetiredJournal,
    DevBuild,
    Claim,
    Pending,
}

impl Kind {
    fn is_external_scratch(self) -> bool {
        matches!(self, Self::Writer | Self::Candidate | Self::CheckTemp)
    }

    fn name(self) -> &'static str {
        match self {
            Self::Writer => "writer-workspace",
            Self::Candidate => "candidate-workspace",
            Self::CheckTemp => "check-temp",
            Self::CheckStage => "check-stage",
            Self::JournalTemp => "journal-temp",
            Self::Journal => "journal",
            Self::RetiredJournal => "retired-journal",
            Self::DevBuild => "dev-build",
            Self::Claim => "claim",
            Self::Pending => "pending-application",
        }
    }
}

struct Item {
    path: PathBuf,
    kind: Kind,
    run: Option<String>,
    bytes: u64,
    reason: &'static str,
    removed: bool,
    moved_to: Option<PathBuf>,
}

impl Item {
    fn measure(
        path: PathBuf,
        kind: Kind,
        run: Option<&str>,
        reason: &'static str,
    ) -> Result<Option<Self>> {
        let Some(meta) = checked(&path)? else {
            return Ok(None);
        };
        let expected = match kind {
            Kind::Claim | Kind::Pending if !meta.is_file() => Some("regular file"),
            Kind::Claim | Kind::Pending => None,
            _ if !meta.is_dir() => Some("directory"),
            _ => None,
        };
        if let Some(expected) = expected {
            return fail(format!("Expected a {expected}: {}", path.display()));
        }
        let bytes = size(&path, meta)
            .map_err(|e| GatewayError(format!("Cannot measure {}: {e}", path.display())))?;
        Ok(Some(Self {
            path,
            kind,
            run: run.map(String::from),
            bytes,
            reason,
            removed: false,
            moved_to: None,
        }))
    }

    fn json(&self) -> Value {
        let mut value = json!({
            "path": self.path.display().to_string(), "kind": self.kind.name(),
            "sizeBytes": self.bytes, "reason": self.reason, "removed": self.removed,
        });
        if let Some(destination) = &self.moved_to {
            value["movedTo"] = json!(destination.display().to_string());
        }
        value
    }
}

#[derive(Default)]
struct Report {
    items: Vec<Item>,
    kept: Vec<Item>,
    errors: Vec<String>,
    freed: u64,
    incomplete_scratch: BTreeSet<String>,
    external_scan_failed: bool,
}

impl Report {
    fn scanned<T: Default>(&mut self, result: Result<T>) -> T {
        result.unwrap_or_else(|error| {
            self.errors.push(error.0);
            T::default()
        })
    }

    fn scanned_external<T: Default>(&mut self, result: Result<T>) -> T {
        // A failed directory listing can hide scratch for any run.
        self.external_scan_failed |= result.is_err();
        self.scanned(result)
    }

    fn record(&mut self, path: PathBuf, kind: Kind, run: Option<&str>, decision: Decision) {
        let (reason, remove) = match decision {
            Decision::Remove(reason) => (reason, true),
            Decision::Keep(reason) => (reason, false),
        };
        let item = match Item::measure(path, kind, run, reason) {
            Ok(Some(item)) => item,
            Ok(None) => return,
            Err(error) => {
                if remove && kind.is_external_scratch() {
                    self.incomplete_scratch
                        .insert(id_key(run.expect("run-owned scratch")));
                }
                self.errors.push(error.0);
                return;
            }
        };
        if remove {
            self.items.push(item);
        } else if kind == Kind::RetiredJournal
            || item.bytes > LARGE
            || matches!(reason, LIVE | SCRATCH_INCOMPLETE | AMBIGUOUS_HOME)
        {
            self.kept.push(item);
        }
    }

    fn json(&self, apply: bool) -> Value {
        json!({
            "apply": apply,
            "items": self.items.iter().map(Item::json).collect::<Vec<_>>(),
            "kept": self.kept.iter().map(Item::json).collect::<Vec<_>>(),
            "totalBytes": self.items.iter().map(|item| item.bytes).fold(0u64, u64::saturating_add),
            "bytesFreed": self.freed,
            "errors": self.errors,
        })
    }
}

#[derive(Clone, Copy)]
enum Decision {
    Keep(&'static str),
    Remove(&'static str),
}

const LIVE: &str = "run has a live worker or lock owner";
const SCRATCH_INCOMPLETE: &str = "some external run scratch could not be checked or removed";
const AMBIGUOUS_HOME: &str = "owning journal home is unconfirmed for this package record";

#[derive(Default)]
struct Workers {
    active: bool,
    builds: BTreeSet<String>,
    unknown_build: bool,
}

fn build_on_path(path: &Path) -> Option<String> {
    let root = path.parent()?.parent()?;
    let commit = root.file_name()?.to_str()?;
    (is_source_commit(commit) && root.parent()?.file_name()? == BUILDS).then(|| commit.to_owned())
}

#[cfg(target_os = "linux")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    fs::read_link(Path::new("/proc").join(pid.to_string()).join("exe")).ok()
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn process_executable(pid: u32) -> Option<PathBuf> {
    let output = std::process::Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

#[cfg(windows)]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::{
        ffi::{c_void, OsString},
        os::windows::ffi::OsStringExt,
    };
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn QueryFullProcessImageNameW(
            handle: Handle,
            flags: u32,
            path: *mut u16,
            len: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    let handle = unsafe { OpenProcess(0x1000, 0, pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
    if handle.is_null() {
        return None;
    }
    let mut path = vec![0u16; 32768];
    let mut len = path.len() as u32;
    let success =
        unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut len) } != 0;
    unsafe { CloseHandle(handle) };
    success.then(|| PathBuf::from(OsString::from_wide(&path[..len as usize])))
}

fn workers(dir: &Path, ignore_pid: Option<u32>, inspect_build: bool) -> Result<Workers> {
    let mut workers = Workers::default();
    let lock = checked(&dir.join("lock"))?;
    let mut pids = BTreeSet::new();
    for name in ["lock/owner.json", "worker.json"] {
        if let Some(owner) = read_json(&dir.join(name))? {
            if journal::owner_pid(&owner).is_none() {
                // An unrecognizable receipt cannot establish that its worker is gone.
                workers.active = true;
                workers.unknown_build = true;
            }
            let Some(pid) = journal::live_pid(&owner) else {
                continue;
            };
            if ignore_pid == Some(pid) {
                continue;
            }
            workers.active = true;
            if inspect_build && pids.insert(pid) {
                let executable = owner["executable"]
                    .as_str()
                    .or_else(|| owner["exe"].as_str())
                    .map(PathBuf::from)
                    .or_else(|| process_executable(pid));
                match executable.filter(|path| path.is_absolute()) {
                    Some(path) => workers.builds.extend(build_on_path(&path)),
                    None => workers.unknown_build = true,
                }
            }
        } else if name == "lock/owner.json"
            && lock.as_ref().is_some_and(|m| {
                m.modified()
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_none_or(|age| age.as_secs() < 60)
            })
        {
            workers.active = true;
            workers.unknown_build = true;
        }
    }
    Ok(workers)
}

struct Run {
    finished: bool,
    finished_at: Option<i128>,
    approved: Option<bool>,
    applied: bool,
    awaiting_application: bool,
    workers: Workers,
    pin: Option<String>,
    sources: BTreeSet<String>,
    dependencies: BTreeSet<String>,
}

fn run_state(
    journal: &Journal,
    run: &Value,
    ignore_pid: Option<u32>,
    inspect_build: bool,
) -> Result<Run> {
    let event_path = journal.file("events.jsonl");
    require_file(&event_path)?;
    let events = journal.snapshot()?;
    let result = read_json(&journal.file("result.json"))?;
    let end = journal::finished_event(&events, result.as_ref());
    let result = result.as_ref().unwrap_or(&Value::Null);
    let verdict = end.and_then(|event| event["verdict"].as_str());
    let approved = if result["approved"] == true
        || result["verdict"] == "approved"
        || verdict == Some("approved")
    {
        Some(true)
    } else {
        result["approved"]
            .as_bool()
            .or_else(|| verdict.map(|_| false))
    };
    let applied = candidate::applied(&events).is_some_and(|r| r["status"] == "applied");
    let awaiting_application = !applied
        && (result["application"]["status"] == "pending"
            || (approved == Some(true)
                && (run["isolated"] == true || run["inputs"]["args"]["isolated"] == true)));
    let mut dependencies = BTreeSet::new();
    for key in ["previousReview", "verificationRun"] {
        dependencies.extend(
            run[key]
                .as_str()
                .filter(|id| journal::is_run_id(id))
                .map(id_key),
        );
    }
    for event in &events {
        let dependency = match event["kind"].as_str() {
            Some("child intent") => event["runId"].as_str(),
            Some("ops-repair") => event["child"].as_str(),
            _ => None,
        };
        dependencies.extend(dependency.filter(|id| journal::is_run_id(id)).map(id_key));
    }
    Ok(Run {
        finished: end.is_some(),
        finished_at: end.and_then(|event| parse_iso_ms(event["at"].as_str()?)),
        approved,
        applied,
        awaiting_application,
        workers: workers(&journal.dir, ignore_pid, inspect_build)?,
        pin: run["buildCommit"].as_str().map(String::from),
        sources: journal::source_ids(run).map(id_key).collect(),
        dependencies,
    })
}

fn require_file(path: &Path) -> Result<()> {
    if checked(path)?.is_some_and(|meta| meta.is_file()) {
        Ok(())
    } else {
        fail(format!("Expected a regular file: {}", path.display()))
    }
}

fn open_run(home: &Path, id: &str) -> Result<(Journal, Value)> {
    require_file(&journal::flows_dir(home).join(id).join("run.json"))?;
    Journal::open(home, id)
}

fn id_key(id: &str) -> String {
    if cfg!(windows) {
        id.trim_end_matches('.').to_ascii_lowercase()
    } else {
        id.to_owned()
    }
}

#[derive(Default)]
struct Runs {
    by_id: BTreeMap<String, (String, Option<Run>)>,
    retired: Vec<PathBuf>,
    sources: BTreeSet<String>,
    dependencies: BTreeSet<String>,
    errors: Vec<String>,
}

impl Runs {
    fn load(home: &Path, inspect_build: bool) -> Result<Self> {
        let mut runs = Self::default();
        for entry in entries(&journal::flows_dir(home))? {
            if is_retired_journal(&entry) {
                match ordinary_dir(&entry) {
                    Ok(true) => runs.retired.push(entry),
                    Ok(false) => {}
                    Err(error) => runs
                        .errors
                        .push(format!("Cannot inspect {}: {error}", entry.display())),
                }
                continue;
            }
            let Some(id) = name(&entry).filter(|id| journal::is_run_id(id)) else {
                continue;
            };
            if fs::symlink_metadata(&entry).is_ok_and(|m| !linked(&m) && !m.is_dir()) {
                continue;
            }
            let run = match open_run(home, id)
                .and_then(|(journal, run)| run_state(&journal, &run, None, inspect_build))
            {
                Ok(run) => {
                    if !run.finished || run.workers.active {
                        runs.sources.extend(run.sources.iter().cloned());
                        runs.dependencies.extend(run.dependencies.iter().cloned());
                    }
                    Some(run)
                }
                Err(e) => {
                    runs.errors.push(e.0);
                    None
                }
            };
            runs.by_id.insert(id_key(id), (id.to_owned(), run));
        }
        Ok(runs)
    }

    fn get(&self, id: &str) -> Option<&Run> {
        self.by_id.get(&id_key(id))?.1.as_ref()
    }
}

fn name(path: &Path) -> Option<&str> {
    path.file_name()?.to_str()
}

fn run_decision(
    kind: Kind,
    id: &str,
    run: Option<&Run>,
    runs: &Runs,
    packages: &Packages,
    cutoff: i128,
    journals: bool,
) -> Decision {
    use Decision::{Keep, Remove};
    let Some(run) = run else {
        return Keep("run journal unavailable");
    };
    if run.workers.active {
        return Keep(LIVE);
    }
    if !run.finished {
        return Keep("run has not finished");
    }
    if matches!(kind, Kind::Writer | Kind::JournalTemp | Kind::CheckTemp) {
        return Remove("run finished");
    }
    if kind == Kind::Journal && !journals {
        return Keep("journal removal requires --journals");
    }
    let id = id_key(id);
    if runs.sources.contains(&id) {
        return Keep("sourceRun of an unfinished run");
    }
    if !runs.errors.is_empty() {
        return Keep("some run references could not be checked");
    }
    let expired = run.finished_at.is_some_and(|at| at < cutoff);
    if kind == Kind::Candidate {
        return if run.applied {
            Remove("candidate applied")
        } else if run.approved != Some(false) {
            Keep("candidate approval is pending application or could not be checked")
        } else if expired {
            Remove("unapproved candidate past retention")
        } else {
            Keep("unapproved candidate within retention")
        };
    }
    if packages.references.contains(&id) {
        Keep("referenced by a file under packages")
    } else if !packages.errors.is_empty() {
        Keep("some package references could not be checked")
    } else if runs.dependencies.contains(&id) {
        Keep("journal is needed by an unfinished workflow")
    } else if run.awaiting_application {
        Keep("approved candidate is awaiting application")
    } else if expired {
        Remove("unreferenced finished journal past retention")
    } else {
        Keep("journal within retention or finish time unavailable")
    }
}

fn check_temps(temp: &Path, owns_run: impl Fn(&str) -> bool) -> Result<Vec<(String, PathBuf)>> {
    let temp = std::path::absolute(temp)?;
    // macOS exposes its system temp directory through the system alias /var.
    // Translate just that alias so entries() still checks each component of the temp root.
    #[cfg(target_os = "macos")]
    let temp = match temp.strip_prefix("/var") {
        Ok(suffix)
            if fs::read_link("/var").is_ok_and(|target| {
                target == Path::new("private/var") || target == Path::new("/private/var")
            }) =>
        {
            Path::new("/private/var").join(suffix)
        }
        _ => temp,
    };
    Ok(entries(&temp)?
        .into_iter()
        .filter_map(|path| {
            let (head, nonce) = name(&path)?
                .strip_prefix("zodchi-flow-")?
                .rsplit_once('-')?;
            if nonce.len() != 8 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            // The tag can have hyphens, as can the id. Prefer the longest known run prefix.
            let id = head
                .rmatch_indices('-')
                .filter(|(i, _)| i + 1 < head.len())
                .map(|(i, _)| &head[..i])
                .find(|id| owns_run(id))?
                .to_owned();
            Some((id, path))
        })
        .collect())
}

fn check_stages(root: &Path) -> Result<Vec<PathBuf>> {
    let mut stages = Vec::new();
    for repo in entries(root)? {
        // Parked cache directories can survive a cut too, and may be needed by the next export.
        if name(&repo).is_none_or(|name| name.ends_with(".cache")) || !ordinary_dir(&repo)? {
            continue;
        }
        if checks::is_check_stage(&repo) {
            // Older versions staged directly under flow-checks without a repository slug.
            stages.push(repo);
            continue;
        }
        for path in entries(&repo)? {
            if checks::is_repo_check_stage(&path)? && ordinary_dir(&path)? {
                stages.push(path);
            }
        }
    }
    Ok(stages)
}

fn ordinary_dir(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.is_dir() && !linked(&meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn check_stage_busy(root: &Path, stage: &Path, owners: &[Value]) -> Result<bool> {
    let repo = stage.parent().expect("stage parent");
    let matches_repo = |owner: &Value| {
        repo == root
            || owner["repoSlug"]
                .as_str()
                .is_none_or(|slug| name(repo) == Some(slug))
    };
    if owners.iter().any(matches_repo) {
        return Ok(true);
    }
    let locks = root
        .parent()
        .expect("check root within its home")
        .join("locks");
    let Some(legacy_owner) = read_json(&locks.join("check-slot.json"))?
        .filter(|owner| journal::live_pid(owner).is_some())
    else {
        return Ok(false);
    };
    if repo == root || legacy_owner["repoSlug"].is_string() {
        return Ok(matches_repo(&legacy_owner));
    }
    // Older receipts may only identify the process. Confirm it still holds the home-local lock.
    let lock_path = locks.join("check-slot.lock");
    if checked(&lock_path)?.is_none() {
        return Ok(false);
    }
    let lock = open_lock(&lock_path)?;
    match lock.try_lock() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

fn collect_check_stages(
    home: &Path,
    report: &mut Report,
    slot_owners: &impl Fn() -> Result<Vec<Value>>,
) {
    let root = home.join(checks::CHECKS_DIR);
    let stages = report.scanned(check_stages(&root));
    if stages.is_empty() {
        return;
    }
    // A writer records its repository before creating a fresh stage. Inspect the holder after listing paths.
    let Some(owners) = report.scanned(slot_owners().map(Some)) else {
        return;
    };
    for stage in stages {
        if let Some(false) =
            report.scanned(check_stage_busy(&root, &stage, &owners).map(Some))
        {
            report.record(
                stage,
                Kind::CheckStage,
                None,
                Decision::Remove("unpublished check export"),
            );
        }
    }
}

#[derive(Default)]
struct Packages {
    references: BTreeSet<String>,
    claim_items: Vec<(PathBuf, Kind, Decision)>,
    errors: Vec<String>,
}

enum ArchiveScope {
    Local,
    Shared { allow_legacy: bool },
}

struct PackageRoot {
    path: PathBuf,
    scope: ArchiveScope,
}

impl PackageRoot {
    fn for_home(home: &Path, profile_packages: Option<&Path>) -> Result<Vec<Self>> {
        let local = home.join(PACKAGES);
        // Windows paths can also name the same directory with a different case or a short name.
        let local_is_profile = if let Some(profile) = profile_packages {
            local == profile
                || (checked(&local)?.is_some()
                    && checked(profile)?.is_some()
                    && fs::canonicalize(&local)? == fs::canonicalize(profile)?)
        } else {
            false
        };
        let mut roots = vec![Self {
            path: local,
            scope: if local_is_profile {
                ArchiveScope::Shared { allow_legacy: true }
            } else {
                ArchiveScope::Local
            },
        }];
        // The claim writer uses the default profile even when ZODCHI_HOME overrides the journals.
        if let Some(profile) = profile_packages.filter(|_| !local_is_profile) {
            roots.push(Self {
                path: profile.to_owned(),
                scope: ArchiveScope::Shared {
                    allow_legacy: false,
                },
            });
        }
        Ok(roots)
    }
}

fn home_key(home: &Path) -> Result<String> {
    let home = std::path::absolute(home)?;
    checked(&home)?;
    Ok(sha256_hex(
        fs::canonicalize(home)?.as_os_str().as_encoded_bytes(),
    ))
}

fn package_home_markers(packages: &Path, id: &str) -> PathBuf {
    packages
        .with_file_name("package-journal-homes")
        .join(id_key(id))
}

fn record_package_home(home: &Path, packages: &Path, id: &str) -> Result<()> {
    if !journal::is_run_id(id) {
        return fail(format!("Not a run id: {id}"));
    }
    let marker = package_home_markers(packages, id).join(home_key(home)?);
    checked(&marker)?;
    fs::create_dir_all(marker)?;
    Ok(())
}

/// Keep ownership evidence in the profile even if a journal disappears. Legacy claim writers can
/// keep reading and writing their original JSON format. Missing evidence leaves the claim in place.
pub(crate) fn note_package_home(home: &Path, id: &str) {
    if let Err(error) = profile_packages().and_then(|root| record_package_home(home, &root, id)) {
        eprintln!("Could not record the package journal home for {id}: {error}");
    }
}

fn package_ids(value: &Value) -> impl Iterator<Item = &str> {
    [&value["run"], &value["runId"]]
        .into_iter()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn package_decision(
    home: &Path,
    root: &PackageRoot,
    value: &Value,
    kind: Kind,
) -> Result<Option<Decision>> {
    let mut has_id = false;
    for id in package_ids(value) {
        has_id = true;
        if !journal::is_run_id(id)
            || checked(&journal::flows_dir(home).join(id))?.is_some()
            || retired_journal_exists(home, id)?
        {
            return Ok(None);
        }
    }
    Ok(if has_id {
        if let ArchiveScope::Shared { .. } = root.scope {
            let owner = home_key(home)?;
            for id in package_ids(value) {
                let markers = entries(&package_home_markers(&root.path, id))?;
                let [marker] = markers.as_slice() else {
                    return Ok(Some(Decision::Keep(AMBIGUOUS_HOME)));
                };
                if name(marker) != Some(owner.as_str())
                    || !checked(marker)?.is_some_and(|m| m.is_dir())
                {
                    return Ok(Some(Decision::Keep(AMBIGUOUS_HOME)));
                }
            }
        }
        Some(Decision::Remove("run journal is missing"))
    } else if kind == Kind::Claim
        && !matches!(
            root.scope,
            ArchiveScope::Shared {
                allow_legacy: false
            }
        )
        && value["status"].is_string()
        && (value["label"].is_string() || value["files"].is_array())
    {
        Some(Decision::Remove("legacy claim has no run id"))
    } else {
        None
    })
}

impl Packages {
    fn scan(home: &Path, profile_packages: Option<&Path>, journals: bool, claims: bool) -> Self {
        let mut packages = Self::default();
        if journals || claims {
            match PackageRoot::for_home(home, profile_packages) {
                Ok(roots) => {
                    for root in roots {
                        packages.read(home, &root, journals, claims);
                    }
                }
                Err(error) => packages.errors.push(error.0),
            }
        }
        packages
    }

    fn read(&mut self, home: &Path, root: &PackageRoot, references: bool, claims: bool) {
        let mut dirs = vec![root.path.clone()];
        while let Some(dir) = dirs.pop() {
            let files = match entries(&dir) {
                Ok(entries) => entries,
                Err(error) => {
                    self.errors.push(error.0);
                    continue;
                }
            };
            for path in files {
                let Some(file) = name(&path) else { continue };
                if matches!(file, ".lock" | "lock") || (file == ".removed" && !references) {
                    continue;
                }
                match fs::symlink_metadata(&path) {
                    Ok(meta) if linked(&meta) => {
                        self.errors.push(format!(
                            "Package reference crosses a link: {}",
                            path.display()
                        ));
                        continue;
                    }
                    Ok(meta) if meta.is_dir() => {
                        dirs.push(path);
                        continue;
                    }
                    Ok(meta) if meta.is_file() => {}
                    Ok(_) => continue,
                    Err(e) if e.kind() == ErrorKind::NotFound => continue,
                    Err(e) => {
                        self.errors
                            .push(format!("Cannot inspect {}: {e}", path.display()));
                        continue;
                    }
                }
                let Ok(relative) = path.strip_prefix(&root.path) else {
                    continue;
                };
                let parts: Vec<_> = relative.iter().collect();
                let kind = match parts.as_slice() {
                    [repo, _] if *repo != ".removed" && file.ends_with(".json") => {
                        Some(Kind::Claim)
                    }
                    [_, applications, _]
                        if *applications == "applications" && file == "pending.json" =>
                    {
                        Some(Kind::Pending)
                    }
                    _ => None,
                };
                let json_record = file.ends_with(".json") || file.contains(".bak-");
                if !(references && json_record || claims && kind.is_some()) {
                    continue;
                }
                match read_json(&path) {
                    Ok(Some(value)) => {
                        self.references.extend(package_ids(&value).map(id_key));
                        if let Some(kind) = kind.filter(|_| claims) {
                            match package_decision(home, root, &value, kind) {
                                Ok(Some(decision)) => self.claim_items.push((path, kind, decision)),
                                Ok(None) => {}
                                Err(e) => self.errors.push(e.0),
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => self.errors.push(e.0),
                }
            }
        }
    }
}

struct Builds {
    paths: Vec<PathBuf>,
    current: Option<String>,
    previous: Option<String>,
    live: BTreeSet<String>,
    pinned: BTreeSet<String>,
    unknown_worker: bool,
    selection_error: Option<String>,
}

impl Builds {
    fn load(home: &Path, runs: &Runs) -> Result<Self> {
        let mut paths: Vec<_> = entries(&home.join(BUILDS))?
            .into_iter()
            .filter(|path| name(path).is_some_and(is_source_commit))
            .collect();
        paths.sort();
        let selection = read_json(&home.join("dev-current.json")).and_then(|value| {
            value
                .map(|value| {
                    value["sourceCommit"]
                        .as_str()
                        .filter(|id| is_source_commit(id))
                        .map(String::from)
                        .ok_or_else(|| {
                            GatewayError("dev-current.json has no valid sourceCommit.".into())
                        })
                })
                .transpose()
        });
        let (current, selection_error) = match selection {
            Ok(current) => (current, None),
            Err(e) => (None, Some(e.0)),
        };
        let mut previous = None;
        let mut newest = None;
        for path in &paths {
            if name(path) == current.as_deref() {
                continue;
            }
            if let Some(modified) = checked(path)
                .ok()
                .flatten()
                .filter(Metadata::is_dir)
                .and_then(|meta| meta.modified().ok())
            {
                if newest.is_none_or(|time| time <= modified) {
                    newest = Some(modified);
                    previous = name(path).map(String::from);
                }
            }
        }
        let mut live = BTreeSet::new();
        live.extend(
            std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(build_on_path),
        );
        let mut pinned = BTreeSet::new();
        let mut unknown_worker = !runs.errors.is_empty();
        for run in runs.by_id.values().filter_map(|(_, run)| run.as_ref()) {
            pinned.extend(run.pin.iter().cloned());
            live.extend(run.workers.builds.iter().cloned());
            unknown_worker |= run.workers.unknown_build;
        }
        Ok(Self {
            paths,
            current,
            previous,
            live,
            pinned,
            unknown_worker,
            selection_error,
        })
    }

    fn decision(&self, commit: &str) -> Decision {
        use Decision::{Keep, Remove};
        if self.current.as_deref() == Some(commit) {
            Keep("selected DEV build")
        } else if self.previous.as_deref() == Some(commit) {
            Keep("newest previous DEV build")
        } else if self.live.contains(commit) {
            Keep("DEV build is in use")
        } else if self.pinned.contains(commit) {
            // Installed launchers route resume, status and apply to the exact journaled build.
            Keep("DEV build is pinned by a retained run journal")
        } else if self.unknown_worker || self.selection_error.is_some() {
            Keep("could not verify DEV selection or worker executables")
        } else {
            Remove("unused older DEV build")
        }
    }
}

fn is_retired_journal(path: &Path) -> bool {
    name(path).is_some_and(|name| name.starts_with(".cleanup-"))
}

enum RetiredJournal {
    Identified(String),
    Unidentified,
    Empty,
}

fn retired_journal(path: &Path) -> Result<RetiredJournal> {
    // New retirement directories retain the original journal ID even after partial deletion.
    if let Some((_, id)) = name(path).and_then(|name| name.split_once("--")) {
        if journal::is_run_id(id) {
            return Ok(RetiredJournal::Identified(id_key(id)));
        }
    }
    for file in ["journal/run.json", "journal/result.json"] {
        let Some(record) = read_json(&path.join(file))? else {
            continue;
        };
        if let Some(id) = record["runId"].as_str().filter(|id| journal::is_run_id(id)) {
            return Ok(RetiredJournal::Identified(id_key(id)));
        }
    }
    // An interrupted legacy retirement can lose its identity before the rest of its files are deleted.
    Ok(if entries(path)?.is_empty() {
        RetiredJournal::Empty
    } else {
        RetiredJournal::Unidentified
    })
}

fn retired_journal_exists(home: &Path, id: &str) -> Result<bool> {
    let id = id_key(id);
    for path in entries(&journal::flows_dir(home))? {
        if is_retired_journal(&path) && ordinary_dir(&path)? {
            match retired_journal(&path)? {
                RetiredJournal::Identified(retired_id) if retired_id == id => return Ok(true),
                RetiredJournal::Unidentified => return Ok(true),
                _ => {}
            }
        }
    }
    Ok(false)
}

fn retired_decision(path: &Path, packages: &Packages) -> Result<Decision> {
    match retired_journal(path)? {
        RetiredJournal::Identified(id) if packages.references.contains(&id) => {
            return Ok(Decision::Keep(
                "retired journal is referenced by a package record",
            ));
        }
        RetiredJournal::Unidentified => {
            let flows = path.parent().expect("retirement within flows");
            for id in packages.references.iter().filter(|id| journal::is_run_id(id)) {
                if !checked(&flows.join(id).join("run.json"))?.is_some_and(|meta| meta.is_file()) {
                    return Ok(Decision::Keep(
                        "retired journal may belong to an unresolved package record",
                    ));
                }
            }
        }
        _ => {}
    }
    if !packages.errors.is_empty() {
        return Ok(Decision::Keep(
            "some package references could not be checked",
        ));
    }
    Ok(Decision::Remove("journal already retired by cleanup"))
}

fn collect(
    home: &Path,
    temp: &Path,
    profile_packages: Option<&Path>,
    options: &Options,
    slot_owners: impl Fn() -> Result<Vec<Value>>,
) -> Report {
    let runs = Runs::load(home, true).unwrap_or_else(|error| Runs {
        errors: vec![error.0],
        ..Runs::default()
    });
    let packages = Packages::scan(
        home,
        profile_packages,
        options.journals || !runs.retired.is_empty(),
        options.claims,
    );
    let cutoff = now_ms() - i128::from(options.retention_days) * DAY_MS;
    let mut report = Report::default();
    let decide = |kind, id: &str| {
        run_decision(
            kind,
            id,
            runs.get(id),
            &runs,
            &packages,
            cutoff,
            options.journals,
        )
    };
    for (root, kind) in [
        (WRITERS, Kind::Writer),
        (candidate::WORKSPACES_DIR, Kind::Candidate),
    ] {
        for path in report.scanned_external(entries(&home.join(root))) {
            if let Some(id) = name(&path)
                .filter(|id| journal::is_run_id(id))
                .map(String::from)
            {
                report.record(path, kind, Some(&id), decide(kind, &id));
            }
        }
    }
    for (id, path) in
        report.scanned_external(check_temps(temp, |id| runs.by_id.contains_key(&id_key(id))))
    {
        report.record(
            path,
            Kind::CheckTemp,
            Some(&id),
            decide(Kind::CheckTemp, &id),
        );
    }
    collect_check_stages(home, &mut report, &slot_owners);
    for path in &runs.retired {
        if let Some(decision) = report.scanned(retired_decision(path, &packages).map(Some)) {
            report.record(path.clone(), Kind::RetiredJournal, None, decision);
        }
    }
    for (id, _) in runs.by_id.values() {
        let path = journal::flows_dir(home).join(id);
        let mut decision = decide(Kind::Journal, id);
        if matches!(decision, Decision::Remove(_))
            && (report.external_scan_failed || report.incomplete_scratch.contains(&id_key(id)))
        {
            decision = Decision::Keep(SCRATCH_INCOMPLETE);
        }
        // The journal size already includes tmp when the whole journal is removable.
        if matches!(decision, Decision::Keep(_)) {
            report.record(
                path.join("tmp"),
                Kind::JournalTemp,
                Some(id),
                decide(Kind::JournalTemp, id),
            );
        }
        report.record(path, Kind::Journal, Some(id), decision);
    }
    if let Some(builds) = report.scanned(Builds::load(home, &runs).map(Some)) {
        for path in &builds.paths {
            report.record(
                path.clone(),
                Kind::DevBuild,
                None,
                builds.decision(name(path).expect("commit")),
            );
        }
        report.errors.extend(builds.selection_error);
    }
    for (path, kind, decision) in &packages.claim_items {
        report.record(path.clone(), *kind, None, *decision);
    }
    report.errors.extend(runs.errors);
    report.errors.extend(packages.errors);
    if options.apply {
        apply(
            home,
            profile_packages,
            options,
            cutoff,
            &mut report,
            &slot_owners,
        );
    }
    report
}

fn remove_tree(path: &Path) -> Result<()> {
    match checked(path)? {
        Some(meta) if meta.is_dir() => Ok(fs::remove_dir_all(path)?), // std unlinks nested symlinks and junctions.
        Some(_) => fail(format!("Expected a cleanup directory: {}", path.display())),
        None => fail(format!(
            "Cleanup directory no longer exists: {}",
            path.display()
        )),
    }
}

fn apply(
    home: &Path,
    profile_packages: Option<&Path>,
    options: &Options,
    cutoff: i128,
    report: &mut Report,
    slot_owners: &impl Fn() -> Result<Vec<Value>>,
) {
    // The plan lists external workspaces and check temps before their journals.
    for item in &mut report.items {
        let result = match item.kind {
            Kind::DevBuild => remove_build(home, &item.path),
            Kind::CheckStage => remove_check_stage(home, &item.path, slot_owners),
            Kind::RetiredJournal => remove_retired_journal(home, profile_packages, &item.path),
            Kind::Claim | Kind::Pending => {
                archive_package(home, profile_packages, &item.path, item.kind)
                    .map(|path| item.moved_to = Some(path))
            }
            Kind::Journal
                if report
                    .incomplete_scratch
                    .contains(&id_key(item.run.as_deref().expect("journal run"))) =>
            {
                fail(SCRATCH_INCOMPLETE)
            }
            _ => remove_run_item(home, profile_packages, item, cutoff, options.journals),
        };
        match result {
            Ok(()) => {
                item.removed = true;
                if item.moved_to.is_none() {
                    report.freed = report.freed.saturating_add(item.bytes);
                }
            }
            Err(e) => {
                if item.kind.is_external_scratch() {
                    report
                        .incomplete_scratch
                        .insert(id_key(item.run.as_deref().expect("run-owned scratch")));
                }
                report
                    .errors
                    .push(format!("{}: {}", item.path.display(), e.0));
            }
        }
    }
}

fn remove_check_stage(
    home: &Path,
    path: &Path,
    slot_owners: &impl Fn() -> Result<Vec<Value>>,
) -> Result<()> {
    // The next export uses a fresh name, even if it starts while cleanup is deleting the abandoned one.
    let root = home.join(checks::CHECKS_DIR);
    if check_stage_busy(&root, path, &slot_owners()?)? {
        return fail("the repository holds the check slot");
    }
    if !checked(path)?.is_some_and(|meta| meta.is_dir()) {
        return fail("the check stage is no longer a directory");
    }
    if path.parent() == Some(root.as_path()) {
        return checks::clear_export(path);
    }
    if !checks::is_repo_check_stage(path)? {
        return fail("the directory may be a fixture of the published check checkout");
    }
    checks::clear_repo_check_stage(path)
}

fn remove_retired_journal(home: &Path, profile_packages: Option<&Path>, path: &Path) -> Result<()> {
    let _sources_lock = lock_sources(home, false)?;
    let packages = Packages::scan(home, profile_packages, true, false);
    match retired_decision(path, &packages)? {
        Decision::Keep(reason) => fail(reason),
        Decision::Remove(_) => remove_tree(path),
    }
}

fn remove_run_item(
    home: &Path,
    profile_packages: Option<&Path>,
    item: &Item,
    cutoff: i128,
    journals: bool,
) -> Result<()> {
    let id = item.run.as_deref().expect("run-owned item");
    let (journal, record) = open_run(home, id)?;
    if workers(&journal.dir, None, false)?.active {
        return fail(LIVE);
    }
    let sources_lock = if matches!(item.kind, Kind::Candidate | Kind::Journal) {
        Some(lock_sources(home, false)?)
    } else {
        None
    };
    let mut lock = journal.lock()?;
    let run = run_state(&journal, &record, Some(std::process::id()), false)?;
    let runs = if sources_lock.is_some() {
        Runs::load(home, false)?
    } else {
        Runs::default()
    };
    let packages = if item.kind == Kind::Journal {
        Packages::scan(home, profile_packages, true, false)
    } else {
        Packages::default()
    };
    if let Decision::Keep(reason) = run_decision(
        item.kind,
        id,
        Some(&run),
        &runs,
        &packages,
        cutoff,
        journals,
    ) {
        return fail(reason);
    }
    if item.kind != Kind::Journal {
        return remove_tree(&item.path);
    }
    let retired = retire_journal(home, id, &mut lock)?;
    crate::code_package::cut("journal retired");
    drop(lock);
    remove_tree(&retired)
        .map_err(|e| GatewayError(format!("Retired journal at {}: {}", retired.display(), e.0)))
}

fn retire_journal(home: &Path, id: &str, lock: &mut journal::RunLock) -> Result<PathBuf> {
    let retired =
        journal::flows_dir(home).join(format!(".cleanup-{}--{id}", journal::new_run_id()));
    fs::create_dir(&retired)?;
    let destination = retired.join("journal");
    if let Err(error) = lock.move_journal(&destination) {
        let _ = fs::remove_dir(&retired);
        return Err(error);
    }
    Ok(retired)
}

fn remove_build(home: &Path, path: &Path) -> Result<()> {
    let lock = open_lock(&home.join("release-install.lock"))?;
    lock.lock()?;
    let runs = Runs::load(home, true)?;
    let builds = Builds::load(home, &runs)?;
    if let Decision::Keep(reason) = builds.decision(name(path).expect("commit")) {
        return fail(reason);
    }
    remove_tree(path)
}

struct ClaimLock {
    dir: PathBuf,
    directory_id: String,
    owner: File,
}

impl ClaimLock {
    fn acquire(repo: &Path) -> Result<Self> {
        // Keep .lock empty so ordinary claim writers can still reclaim it after their ten-minute lease.
        // The adjacent receipt serializes archival and ties the recorded pid to this instance of .lock.
        let mut owner = open_lock(&repo.join(".cleanup-claim-owner"))?;
        match owner.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return fail("the claim lock is busy"),
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
        let dir = repo.join(".lock");
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let Some(meta) = checked(&dir)?.filter(|meta| meta.is_dir()) else {
                    return fail("the claim lock changed during recovery");
                };
                let identity = claim_lock_identity(&meta);
                let mut receipt = Vec::new();
                owner.read_to_end(&mut receipt)?;
                let receipt = serde_json::from_slice::<Value>(&receipt).unwrap_or(Value::Null);
                if receipt["directory"] == identity && journal::owner_pid(&receipt).is_some() {
                    if let Some(pid) = journal::live_pid(&receipt) {
                        return fail(format!("the claim lock is held by pid {pid}"));
                    }
                } else if !meta
                    .modified()?
                    .elapsed()
                    .is_ok_and(|age| age.as_secs() > 600)
                {
                    return fail("the claim lock is busy");
                }
                if !checked(&dir)?
                    .is_some_and(|meta| meta.is_dir() && claim_lock_identity(&meta) == identity)
                {
                    return fail("the claim lock changed during recovery");
                }
                fs::remove_dir(&dir)?;
                fs::create_dir(&dir)?;
            }
            Err(error) => return Err(error.into()),
        }
        let directory_id = claim_lock_identity(&fs::symlink_metadata(&dir)?);
        let mut lock = Self {
            dir,
            directory_id,
            owner,
        };
        let pid = std::process::id();
        let receipt = json!({ "pid": pid, "start": zodchi_core::process::process_start(pid),
            "directory": lock.directory_id });
        lock.owner.set_len(0)?;
        lock.owner.rewind()?;
        lock.owner.write_all(receipt.to_string().as_bytes())?;
        lock.owner.sync_all()?;
        Ok(lock)
    }
}

fn claim_lock_identity(meta: &Metadata) -> String {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        format!("{}:{}", meta.creation_time(), meta.last_write_time())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.ctime(),
            meta.ctime_nsec()
        )
    }
}

impl Drop for ClaimLock {
    fn drop(&mut self) {
        // A legacy writer may have replaced the directory after the lease elapsed.
        if fs::symlink_metadata(&self.dir)
            .is_ok_and(|meta| claim_lock_identity(&meta) == self.directory_id)
            && fs::remove_dir(&self.dir).is_ok()
        {
            let _ = self.owner.set_len(0);
        }
    }
}

fn archive_package(
    home: &Path,
    profile_packages: Option<&Path>,
    path: &Path,
    kind: Kind,
) -> Result<PathBuf> {
    let dir = path.parent().expect("package file in its repository");
    let repo = if kind == Kind::Pending {
        dir.parent().expect("applications in its repository")
    } else {
        dir
    };
    let packages = repo.parent().expect("repository under packages");
    let root = PackageRoot::for_home(home, profile_packages)?
        .into_iter()
        .find(|root| root.path == packages)
        .ok_or_else(|| GatewayError("Package record is outside the cleanup roots.".into()))?;
    require_file(path)?;
    let (_claim, _pending) = if kind == Kind::Pending {
        let lock = dir.join("lock");
        checked(&lock.join("owner.json"))?;
        (None, Some(Journal::lock_directory(lock)?))
    } else {
        (Some(ClaimLock::acquire(dir)?), None)
    };
    let value =
        read_json(path)?.ok_or_else(|| GatewayError("Package record no longer exists.".into()))?;
    if !matches!(
        package_decision(home, &root, &value, kind)?,
        Some(Decision::Remove(_))
    ) {
        return fail("Package record is no longer stale for this Zodchi home.");
    }
    let date = iso();
    let archive = packages.join(".removed").join(&date[..10]);
    checked(&archive)?;
    fs::create_dir_all(&archive)?;
    let batch = archive.join(journal::new_run_id());
    fs::create_dir(&batch)?;
    let destination = batch.join(
        path.strip_prefix(packages)
            .expect("archive within packages"),
    );
    fs::create_dir_all(destination.parent().expect("archive parent"))?;
    fs::rename(path, &destination)?;
    Ok(destination)
}

/// This is best effort and must never replace the workflow's result or exit code.
pub(crate) fn after_run(id: &str) {
    let result = zodchi_home().and_then(|home| clean_finished(&home, &std::env::temp_dir(), id));
    if let Err(error) = result {
        eprintln!("Flow cleanup for {id}: {error}");
    }
}

fn clean_finished(home: &Path, temp: &Path, id: &str) -> Result<()> {
    // Some workflows refuse before creating a journal.
    if !journal::is_run_id(id)
        || checked(&journal::flows_dir(home).join(id).join("run.json"))?.is_none()
    {
        return Ok(());
    }
    let (mut journal, record) = open_run(home, id)?;
    require_file(&journal.file("events.jsonl"))?;
    if !journal
        .snapshot()?
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        return Ok(());
    }
    if read_json(&journal.file("lock/owner.json"))?
        .is_some_and(|owner| journal::owner_pid(&owner).is_none())
    {
        return fail("The run lock has an unreadable owner.");
    }
    let _lock = journal.lock()?;
    journal.load()?;
    let mut report = Report::default();
    // A detached worker owns its worker receipt until it exits. Its workflow has already returned.
    let me = Some(std::process::id());
    if let Some(run) = report.scanned(run_state(&journal, &record, me, false).map(Some)) {
        if !run.finished || run.workers.active {
            return Ok(());
        }
        clean_scratch(home, temp, id, &journal, &mut report);
    }
    if !report.items.is_empty() || !report.errors.is_empty() {
        let mut event = report.json(true);
        event["kind"] = json!("cleanup");
        journal.append(event)?;
    }
    Ok(())
}

fn clean_scratch(home: &Path, temp: &Path, id: &str, journal: &Journal, report: &mut Report) {
    let decision = Decision::Remove("run finished");
    report.record(
        home.join(WRITERS).join(id),
        Kind::Writer,
        Some(id),
        decision,
    );
    report.record(journal.file("tmp"), Kind::JournalTemp, Some(id), decision);
    match entries(&journal::flows_dir(home)).and_then(|dirs| {
        let ids: BTreeSet<_> = dirs
            .iter()
            .filter_map(|path| name(path))
            .map(id_key)
            .collect();
        check_temps(temp, |id| ids.contains(&id_key(id)))
    }) {
        Ok(temps) => {
            for (owner, path) in temps {
                if id_key(&owner) == id_key(id) {
                    report.record(path, Kind::CheckTemp, Some(id), decision);
                }
            }
        }
        Err(e) => report.errors.push(e.0),
    }
    for item in &mut report.items {
        match remove_tree(&item.path) {
            Ok(()) => {
                item.removed = true;
                report.freed = report.freed.saturating_add(item.bytes);
            }
            Err(e) => report
                .errors
                .push(format!("{}: {}", item.path.display(), e.0)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "2000-01-01T00:00:00.000Z";

    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        temp: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../.agent-tmp")
                .join(format!("cleanup-{}", journal::new_run_id()));
            let home = root.join("home");
            let temp = root.join("temp");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir(&temp).unwrap();
            Self {
                root: root.canonicalize().unwrap(),
                home: home.canonicalize().unwrap(),
                temp: temp.canonicalize().unwrap(),
            }
        }

        fn file(&self, path: &str, bytes: &[u8]) -> PathBuf {
            let path = self.home.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn json(&self, path: &str, value: Value) -> PathBuf {
            self.file(path, value.to_string().as_bytes())
        }

        fn run(&self, id: &str, record: Value, event: Value) {
            self.json(&format!("flows/{id}/run.json"), record);
            self.file(
                &format!("flows/{id}/events.jsonl"),
                format!("{event}\n").as_bytes(),
            );
        }

        fn expired(&self, id: &str) {
            self.run(
                id,
                json!({}),
                json!({"kind":"finished", "verdict":"changes_requested", "at":OLD}),
            );
            self.json(
                &format!("flows/{id}/result.json"),
                json!({"approved":false, "verdict":"changes_requested"}),
            );
        }

        fn report(&self, options: Options) -> Report {
            self.report_with_slot(options, || Ok(Vec::new()))
        }

        fn report_with_slot(
            &self,
            options: Options,
            slot_owners: impl Fn() -> Result<Vec<Value>>,
        ) -> Report {
            collect(&self.home, &self.temp, None, &options, slot_owners)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn planned(report: &Report, path: &Path) -> bool {
        report.items.iter().any(|item| item.path == path)
    }

    #[cfg(windows)]
    fn create_junction(path: &Path, target: &Path) -> io::Result<()> {
        use std::{
            ffi::c_void,
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };

        #[link(name = "kernel32")]
        extern "system" {
            fn DeviceIoControl(
                handle: *mut c_void,
                code: u32,
                input: *const c_void,
                input_size: u32,
                output: *mut c_void,
                output_size: u32,
                bytes_returned: *mut u32,
                overlapped: *mut c_void,
            ) -> i32;
        }

        // Use a real junction without a child process that could inherit concurrent tests' pipes.
        // The fixture supplies a canonical path on a local drive. Junctions store its NT name and
        // a display name in the same UTF-16 buffer, with byte offsets and lengths.
        let target = target.to_str().expect("Unicode fixture path");
        let display = target
            .strip_prefix(r"\\?\")
            .expect("canonical fixture path");
        let substitute: Vec<_> = format!(r"\??\{display}").encode_utf16().collect();
        let display: Vec<_> = display.encode_utf16().collect();
        let substitute_bytes = u16::try_from(substitute.len() * 2).expect("short fixture path");
        let display_bytes = u16::try_from(display.len() * 2).expect("short fixture path");
        let display_offset = substitute_bytes + 2;
        let data_bytes = 8 + display_offset + display_bytes + 2;
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&0xA000_0003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
        for field in [
            data_bytes,
            0,
            0,
            substitute_bytes,
            display_offset,
            display_bytes,
        ] {
            buffer.extend_from_slice(&field.to_le_bytes());
        }
        for unit in substitute.into_iter().chain([0]).chain(display).chain([0]) {
            buffer.extend_from_slice(&unit.to_le_bytes());
        }

        fs::create_dir(path)?;
        let dir = OpenOptions::new()
            .write(true)
            .custom_flags(0x0220_0000) // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
            .open(path)?;
        let mut bytes_returned = 0;
        let ok = unsafe {
            DeviceIoControl(
                dir.as_raw_handle(),
                0x0009_00A4, // FSCTL_SET_REPARSE_POINT
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[test]
    fn only_finished_runs_lose_writer_and_check_scratch() {
        let f = Fixture::new();
        f.expired("finished");
        f.run(
            "waiting",
            json!({}),
            json!({"kind":"waiting", "reason":"outside claim"}),
        );
        f.expired("open-claim");
        f.json(
            "flows/open-claim/result.json",
            json!({"claimLeftOpen":"claim.json"}),
        );
        for id in ["finished", "waiting", "open-claim"] {
            f.file(
                &format!("flow-writers/{id}/writer/dependency"),
                b"dependency",
            );
            f.file(&format!("flows/{id}/tmp/scratch"), b"scratch");
            let temp = f.temp.join(format!("zodchi-flow-{id}-verify-0123abcd"));
            fs::create_dir(&temp).unwrap();
            fs::write(temp.join("output"), b"temporary").unwrap();
        }
        let report = f.report(Options {
            apply: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.freed, 26);
        assert_eq!(report.items.len(), 3);
        assert!(report
            .items
            .iter()
            .all(|item| item.removed && item.run.as_deref() == Some("finished")));
        assert!(f.home.join("flow-writers/waiting").is_dir());
        assert!(f.home.join("flow-writers/open-claim").is_dir());
        assert!(f.home.join("flows/waiting/tmp").is_dir());
        assert!(f.temp.join("zodchi-flow-waiting-verify-0123abcd").is_dir());
        assert!(f.home.join("flows/finished/events.jsonl").is_file());
    }

    #[test]
    fn a_finished_event_without_a_result_keeps_scratch_and_journal() {
        let f = Fixture::new();
        let id = "unfinished-result";
        f.run(
            id,
            json!({}),
            json!({"kind":"finished", "verdict":"blocked", "at":OLD}),
        );
        let writer = f.file("flow-writers/unfinished-result/writer/payload", b"writer");
        let candidate = f.file("flow-candidates/unfinished-result/payload", b"candidate");
        let scratch = f.file("flows/unfinished-result/tmp/payload", b"scratch");

        clean_finished(&f.home, &f.temp, id).unwrap();
        let options = Options {
            journals: true,
            apply: true,
            ..Options::default()
        };
        let report = f.report(options);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.items.is_empty());
        for path in [
            writer,
            candidate,
            scratch,
            f.home.join("flows/unfinished-result/run.json"),
        ] {
            assert!(path.is_file(), "{}", path.display());
        }
    }

    #[test]
    fn automatic_cleanup_records_failures_and_preserves_the_finished_state() {
        let f = Fixture::new();
        f.expired("finished");
        f.json(
            "flows/finished/worker.json",
            json!({"pid":std::process::id()}),
        );
        let writer = f.file("flow-writers/finished", b"not a workspace directory");
        f.file("flows/finished/tmp/scratch", b"scratch");
        clean_finished(&f.home, &f.temp, "finished").unwrap();
        assert!(writer.is_file());
        assert!(!f.home.join("flows/finished/tmp").exists());
        let (journal, _) = Journal::open(&f.home, "finished").unwrap();
        let events = journal.snapshot().unwrap();
        assert_eq!(
            journal::last_state_event(&events).unwrap()["kind"],
            "finished"
        );
        let cleanup = events.last().unwrap();
        assert_eq!(cleanup["kind"], "cleanup");
        assert_eq!(cleanup["bytesFreed"], 7);
        assert_eq!(cleanup["errors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn automatic_cleanup_records_an_unreadable_worker_receipt_and_keeps_scratch() {
        let f = Fixture::new();
        f.expired("finished");
        let marker = f.file("flow-writers/finished/writer/payload", b"payload");
        f.file("flows/finished/worker.json", b"broken receipt");
        clean_finished(&f.home, &f.temp, "finished").unwrap();
        assert!(marker.is_file());
        let (journal, _) = Journal::open(&f.home, "finished").unwrap();
        let events = journal.snapshot().unwrap();
        let cleanup = events.last().unwrap();
        assert_eq!(cleanup["kind"], "cleanup");
        assert_eq!(cleanup["bytesFreed"], 0);
        assert!(cleanup["errors"][0]
            .as_str()
            .unwrap()
            .contains("worker.json"));
    }

    #[test]
    fn candidates_require_application_or_expiry_and_no_unfinished_successor() {
        let f = Fixture::new();
        for id in ["applied", "expired", "source", "approved", "recent"] {
            f.expired(id);
            f.file(&format!("flow-candidates/{id}/candidate"), b"checkout");
        }
        f.json("flows/approved/result.json", json!({"approved":true}));
        f.run(
            "recent",
            json!({}),
            json!({"kind":"finished", "verdict":"changes_requested", "at":iso()}),
        );
        f.run(
            "successor",
            json!({"inputs":{"args":{"sourceRun":"source"}}}),
            json!({"kind":"waiting"}),
        );
        let (mut journal, _) = Journal::open(&f.home, "applied").unwrap();
        journal.load().unwrap();
        journal
            .append(json!({"kind":"application finished", "result":{"status":"applied"}}))
            .unwrap();
        let report = f.report(Options::default());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        for (id, remove) in [
            ("applied", true),
            ("expired", true),
            ("source", false),
            ("approved", false),
            ("recent", false),
        ] {
            assert_eq!(
                planned(&report, &candidate::workspace(&f.home, id)),
                remove,
                "{id}"
            );
        }
    }

    #[test]
    fn journals_need_explicit_retention_and_are_protected_by_each_reference() {
        let f = Fixture::new();
        for id in ["claimed", "pending", "source", "child", "unreferenced"] {
            f.expired(id);
        }
        f.run(
            "successor",
            json!({"sourceRun":"source"}),
            json!({"kind":"child intent", "runId":"child"}),
        );
        f.json(
            "packages/checkout/done.json",
            json!({"run":"claimed", "status":"done"}),
        );
        f.json(
            "packages/checkout/applications/pending.json",
            json!({"runId":"pending"}),
        );
        f.run(
            "approved",
            json!({"isolated":true}),
            json!({"kind":"finished", "verdict":"approved", "at":OLD}),
        );
        f.json("flows/approved/result.json", json!({"approved":true}));
        assert!(f.report(Options::default()).items.is_empty());
        let report = f.report(Options {
            journals: true,
            apply: true,
            retention_days: 1,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].path, f.home.join("flows/unreferenced"));
        assert!(report.items[0].removed);
        for id in ["claimed", "pending", "source", "child", "approved"] {
            assert!(f.home.join("flows").join(id).is_dir(), "{id}");
        }
    }

    #[test]
    fn cleanup_finishes_journal_retirement_after_the_rename() {
        let f = Fixture::new();
        f.expired("expired");
        let (journal, _) = Journal::open(&f.home, "expired").unwrap();
        let mut lock = journal.lock().unwrap();
        let retired = retire_journal(&f.home, "expired", &mut lock).unwrap();
        drop(lock);
        assert!(!journal.dir.exists());
        assert!(retired.join("journal/run.json").exists());

        let options = || Options {
            apply: true,
            ..Options::default()
        };
        for (path, value) in [
            ("packages/repo/claim.json", json!({"run":"expired"})),
            (
                "packages/repo/applications/pending.json",
                json!({"runId":"expired"}),
            ),
        ] {
            let reference = f.json(path, value);
            let report = f.report(Options {
                claims: true,
                ..options()
            });
            assert!(report.errors.is_empty(), "{:?}", report.errors);
            assert!(report.items.is_empty());
            assert_eq!(report.kept.len(), 1);
            assert_eq!(report.kept[0].path, retired);
            assert!(retired.is_dir() && reference.is_file());
            fs::remove_file(reference).unwrap();
        }

        let preview = f.report(Options::default());
        assert!(preview.errors.is_empty(), "{:?}", preview.errors);
        assert_eq!(preview.items.len(), 1);
        assert_eq!(preview.items[0].kind.name(), "retired-journal");
        let bytes = preview.items[0].bytes;
        assert!(bytes > 0);
        assert!(retired.is_dir());
        let applied = f.report(options());
        assert!(applied.errors.is_empty(), "{:?}", applied.errors);
        assert_eq!(applied.freed, bytes);
        assert!(applied.items[0].removed);
        assert!(!retired.exists());
    }

    #[test]
    fn cleanup_preserves_legacy_retirement_with_a_shared_pending_receipt() {
        let custom = Fixture::new();
        let profile = Fixture::new();
        let packages = profile.home.join("packages");
        let record = custom.json(
            "flows/.cleanup-legacy/journal/run.json",
            json!({"runId":"old"}),
        );
        let pending = profile.json(
            "packages/repo/applications/pending.json",
            json!({"runId":"old"}),
        );
        let options = Options {
            apply: true,
            claims: true,
            ..Options::default()
        };
        let collect = || {
            super::collect(
                &custom.home,
                &custom.temp,
                Some(&packages),
                &options,
                || Ok(Vec::new()),
            )
        };
        let protected = collect();
        assert!(protected.errors.is_empty(), "{:?}", protected.errors);
        assert!(protected.items.is_empty() && record.is_file() && pending.is_file());
        assert_eq!(protected.kept[0].kind.name(), "retired-journal");

        fs::remove_file(pending).unwrap();
        let reclaimed = collect();
        assert!(reclaimed.errors.is_empty(), "{:?}", reclaimed.errors);
        assert!(reclaimed.items[0].removed && !record.exists());
    }

    #[test]
    fn cleanup_preserves_an_unidentified_legacy_retirement_and_its_possible_reference() {
        let custom = Fixture::new();
        let profile = Fixture::new();
        let packages = profile.home.join("packages");
        let remaining = custom.file(
            "flows/.cleanup-partial/journal/events.jsonl",
            b"remaining journal evidence\n",
        );
        let interrupted_before_move = custom.home.join("flows/.cleanup-empty");
        fs::create_dir(&interrupted_before_move).unwrap();
        let pending = profile.json(
            "packages/repo/applications/pending.json",
            json!({"runId":"old"}),
        );
        record_package_home(&custom.home, &packages, "old").unwrap();
        let options = Options {
            apply: true,
            claims: true,
            ..Options::default()
        };
        let collect = || {
            super::collect(
                &custom.home,
                &custom.temp,
                Some(&packages),
                &options,
                || Ok(Vec::new()),
            )
        };
        let protected = collect();
        assert!(protected.errors.is_empty(), "{:?}", protected.errors);
        assert!(remaining.is_file() && pending.is_file());
        assert!(protected
            .kept
            .iter()
            .any(|item| item.kind == Kind::RetiredJournal));
        assert_eq!(protected.items.len(), 1);
        assert_eq!(protected.items[0].path, interrupted_before_move);
        assert!(protected.items[0].removed);

        fs::remove_file(pending).unwrap();
        let reclaimed = collect();
        assert!(reclaimed.errors.is_empty(), "{:?}", reclaimed.errors);
        assert_eq!(reclaimed.items.len(), 1);
        assert_eq!(reclaimed.freed, b"remaining journal evidence\n".len() as u64);
        assert!(reclaimed.items[0].removed && !remaining.exists());
    }

    #[test]
    fn cleanup_removes_abandoned_check_stages_while_preserving_a_live_repository() {
        let f = Fixture::new();
        let live = f.file("flow-checks/live/.p-0123abcd/input", b"live stage");
        let abandoned = f.file("flow-checks/other/.p-deadbeef/input", b"old stage");
        let legacy = f.file("flow-checks/.p-0123abcd/input", b"old layout");
        let checkout = f.file("flow-checks/other/checkout/record", b"published checkout");
        let parked = f.file("flow-checks/other.cache/.p-0123abcd/input", b"parked cache");
        let options = || Options {
            apply: true,
            ..Options::default()
        };
        let report = f.report_with_slot(options(), || {
            Ok(vec![json!({"repoSlug":"unrelated"}), json!({"repoSlug":"live"})])
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.items.len(), 1);
        assert_eq!(report.items[0].kind.name(), "check-stage");
        assert_eq!(report.freed, 9);
        assert!(!abandoned.exists());
        assert!(live.exists() && legacy.exists());

        let pid = std::process::id();
        let start = zodchi_core::process::process_start(pid);
        let old_receipt = f.json("locks/check-slot.json", json!({"pid":pid, "start":start}));
        let report = f.report(options());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.freed, 10);
        assert!(!live.exists() && legacy.exists());

        fs::remove_file(old_receipt).unwrap();
        let report = f.report(options());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.freed, 10);
        assert!(!legacy.exists());
        assert!(checkout.exists() && parked.exists());
    }

    #[test]
    fn cleanup_preserves_stage_like_siblings_of_a_published_checkout() {
        let f = Fixture::new();
        let checkout = f.file("flow-checks/repo/checkout/.git/HEAD", b"published");
        let fixture = f.file("flow-checks/repo/.p-fixture/input", b"verify input");
        let numbered_fixture = f.file("flow-checks/repo/.p-deadbeef/input", b"more verify input");
        let abandoned = f.file("flow-checks/repo/.p-0123abcd/input", b"old stage");
        let marker = f.file("flow-checks/repo.stage-.p-0123abcd", b"");
        let report = f.report(Options {
            apply: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.items.len(), 1);
        assert!(report.items[0].removed && !abandoned.exists() && !marker.exists());
        assert_eq!(report.freed, b"old stage".len() as u64);
        assert!(checkout.is_file() && fixture.is_file() && numbered_fixture.is_file());
    }

    #[test]
    fn cleanup_rechecks_the_check_slot_before_removing_a_stage() {
        let f = Fixture::new();
        let stage = f.file("flow-checks/repo/.p-deadbeef/input", b"candidate tree");
        let scanned = std::cell::Cell::new(false);
        let options = Options {
            apply: true,
            ..Options::default()
        };
        let report = f.report_with_slot(options, || {
            Ok(if scanned.replace(true) {
                vec![json!({"repoSlug":"repo"})]
            } else {
                Vec::new()
            })
        });
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("the repository holds the check slot")));
        assert!(!report.items[0].removed && stage.exists());
        assert_eq!(report.freed, 0);
    }

    #[test]
    fn claim_archival_takes_over_a_dead_owner_and_keeps_a_live_one() {
        let f = Fixture::new();
        let claim = f.json(
            "packages/repo/claim.json",
            json!({"run":"missing","status":"open"}),
        );
        let repo = claim.parent().unwrap();
        let pid = std::process::id();
        let start = zodchi_core::process::process_start(pid).unwrap();
        let mut guard = ClaimLock::acquire(repo).unwrap();
        guard.owner.rewind().unwrap();
        let written: Value = serde_json::from_reader(&guard.owner).unwrap();
        assert_eq!(written["pid"], pid);
        assert_eq!(written["start"], start);
        drop(guard);

        let lock = repo.join(".lock");
        fs::create_dir(&lock).unwrap();
        let identity = claim_lock_identity(&fs::symlink_metadata(&lock).unwrap());
        let receipt = |start: &str| json!({"pid":pid, "start":start, "directory":identity});
        f.json("packages/repo/.cleanup-claim-owner", receipt(&start));
        let options = || Options {
            claims: true,
            apply: true,
            ..Options::default()
        };
        let report = f.report(options());
        assert!(report
            .errors
            .iter()
            .any(|e| e.contains(&format!("held by pid {pid}"))));
        assert!(claim.is_file() && lock.is_dir());

        // The old process is gone even though its pid now identifies this test.
        f.json(
            "packages/repo/.cleanup-claim-owner",
            receipt("previous start"),
        );
        let report = f.report(options());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        let moved = report.items[0].moved_to.as_ref().unwrap();
        assert!(moved.is_file());
        assert!(!claim.exists() && !lock.exists());
    }

    #[test]
    fn a_scratch_scan_failure_only_defers_the_affected_journal() {
        let f = Fixture::new();
        f.expired("blocked-scratch");
        f.expired("unaffected");
        let broken = f.file("flow-candidates/blocked-scratch", b"expected a directory");
        let journal = f.home.join("flows/blocked-scratch");
        let options = Options {
            journals: true,
            apply: true,
            ..Options::default()
        };
        let report = f.report(options);
        assert!(report.errors.iter().any(|e| e.contains("blocked-scratch")));
        assert!(report
            .kept
            .iter()
            .any(|item| item.path == journal && item.reason == SCRATCH_INCOMPLETE));
        assert!(journal.is_dir());
        assert!(!f.home.join("flows/unaffected").exists());

        fs::remove_file(broken).unwrap();
        let checkout = f.file("flow-candidates/blocked-scratch/payload", b"checkout");
        let retry = f.report(Options {
            journals: true,
            apply: true,
            ..Options::default()
        });
        assert!(retry.errors.is_empty(), "{:?}", retry.errors);
        assert!(!checkout.exists() && !journal.exists());
    }

    #[test]
    fn a_failed_scratch_removal_keeps_its_journal_until_cleanup_can_retry() {
        let f = Fixture::new();
        f.expired("blocked-scratch");
        f.expired("unaffected");
        let payload = f.file("flow-writers/blocked-scratch/payload", b"writer");
        let writer = payload.parent().unwrap();
        let journal = f.home.join("flows/blocked-scratch");
        let options = Options {
            journals: true,
            ..Options::default()
        };
        let mut report = f.report(options);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(planned(&report, writer) && planned(&report, &journal));

        #[cfg(windows)]
        let busy = {
            use std::os::windows::fs::OpenOptionsExt;
            // Allow metadata reads, but prevent deletion while this handle is open.
            OpenOptions::new()
                .read(true)
                .share_mode(0x3)
                .open(&payload)
                .unwrap()
        };
        #[cfg(not(windows))]
        let saved = {
            // Make the removal fail after the scan, independent of permissions or test user.
            let saved = f.root.join("saved-writer");
            fs::rename(writer, &saved).unwrap();
            fs::write(writer, b"expected a directory").unwrap();
            saved
        };

        let options = Options {
            journals: true,
            apply: true,
            ..Options::default()
        };
        apply(
            &f.home,
            None,
            &options,
            now_ms() - 14 * DAY_MS,
            &mut report,
            &|| Ok(Vec::new()),
        );
        assert_eq!(report.errors.len(), 2, "{:?}", report.errors);
        assert!(report.errors.iter().any(|e| e.contains(SCRATCH_INCOMPLETE)));
        assert!(writer.exists() && journal.is_dir());
        assert!(!f.home.join("flows/unaffected").exists());

        #[cfg(windows)]
        drop(busy);
        #[cfg(not(windows))]
        {
            fs::remove_file(writer).unwrap();
            fs::rename(saved, writer).unwrap();
        }
        let retry = f.report(options);
        assert!(retry.errors.is_empty(), "{:?}", retry.errors);
        assert!(retry
            .items
            .iter()
            .any(|item| item.path == writer && item.removed));
        assert!(!writer.exists() && !journal.exists());
    }

    #[test]
    fn worker_receipt_and_run_lock_prevent_apply_even_after_finished() {
        let f = Fixture::new();
        let pid = std::process::id();
        for (id, receipt) in [("worker", "worker.json"), ("lock-owner", "lock/owner.json")] {
            f.expired(id);
            f.json(&format!("flows/{id}/{receipt}"), json!({"pid":pid}));
            f.file(
                &format!("flow-writers/{id}/writer/dependency"),
                b"dependency",
            );
            f.file(&format!("flow-candidates/{id}/candidate"), b"checkout");
        }
        let report = f.report(Options {
            journals: true,
            apply: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.items.is_empty());
        assert_eq!(
            report
                .kept
                .iter()
                .filter(|item| item.reason == LIVE)
                .count(),
            6
        );
    }

    #[test]
    fn old_dev_builds_are_pruned_around_the_selection_and_live_executable() {
        let f = Fixture::new();
        let commits: Vec<_> = ["a", "b", "c", "d", "e"].map(|c| c.repeat(40)).into();
        let paths: Vec<_> = commits
            .iter()
            .map(|commit| f.file(&format!("dev-builds/{commit}/bin/zodchi"), b"build"))
            .collect();
        f.json("dev-current.json", json!({"sourceCommit":commits[3]}));
        f.run(
            "pinned",
            json!({"buildCommit":commits[1]}),
            json!({"kind":"finished"}),
        );
        f.json("flows/pinned/result.json", json!({"approved":false}));
        f.run("running", json!({}), json!({"kind":"submitted"}));
        f.json(
            "flows/running/worker.json",
            json!({"pid":std::process::id(), "executable":paths[2].display().to_string()}),
        );
        let report = f.report(Options {
            apply: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(!paths[0].exists());
        assert!(paths[1..].iter().all(|path| path.is_file()));
    }

    #[test]
    fn stale_claims_and_pending_are_archived_without_changing_live_claims() {
        let f = Fixture::new();
        f.run("waiting", json!({}), json!({"kind":"waiting"}));
        let live = f.json(
            "packages/repo/live.json",
            json!({"run":"waiting", "status":"open"}),
        );
        let missing = f.json(
            "packages/repo/stale.json",
            json!({"run":"gone", "status":"open"}),
        );
        let legacy = f.json(
            "packages/repo/legacy.json",
            json!({"label":"legacy", "files":[], "status":"open"}),
        );
        let backup = f.file("packages/repo/legacy.json.bak-old", b"original");
        let pending = f.json(
            "packages/repo/applications/pending.json",
            json!({"runId":"gone"}),
        );
        let report = f.report(Options {
            apply: true,
            claims: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.items.len(), 3);
        assert_eq!(report.freed, 0);
        for path in [missing, legacy, pending] {
            assert!(!path.exists());
            let item = report.items.iter().find(|item| item.path == path).unwrap();
            let archive = item.moved_to.as_ref().unwrap();
            assert!(
                item.removed
                    && archive.starts_with(f.home.join("packages/.removed"))
                    && archive.is_file()
            );
        }
        assert!(live.is_file() && backup.is_file());
    }

    #[test]
    fn shared_package_records_require_evidence_of_their_journal_home() {
        let f = Fixture::new();
        let packages = f.home.join(PACKAGES);
        let other_home = f.root.join("custom-home");
        fs::create_dir(&other_home).unwrap();
        record_package_home(&f.home, &packages, "known-missing").unwrap();
        record_package_home(&other_home, &packages, "other-home").unwrap();
        record_package_home(&f.home, &packages, "conflicting").unwrap();
        record_package_home(&other_home, &packages, "conflicting").unwrap();

        let owned_claim = f.json("packages/owned/claim.json", json!({"run":"known-missing"}));
        let owned_pending = f.json(
            "packages/owned/applications/pending.json",
            json!({"runId":"known-missing"}),
        );
        let ambiguous_claim = f.json("packages/older/claim.json", json!({"run":"older-id"}));
        let ambiguous_pending = f.json(
            "packages/older/applications/pending.json",
            json!({"runId":"older-id"}),
        );
        let foreign = f.json("packages/other/claim.json", json!({"run":"other-home"}));
        let conflicting = f.json(
            "packages/conflicting/claim.json",
            json!({"run":"conflicting"}),
        );
        let legacy = f.json(
            "packages/older/no-id.json",
            json!({"status":"open", "label":"legacy"}),
        );
        let report = collect(
            &f.home,
            &f.temp,
            Some(&packages),
            &Options {
                apply: true,
                claims: true,
                ..Options::default()
            },
            || Ok(Vec::new()),
        );
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        for removed in [owned_claim, owned_pending, legacy] {
            assert!(!removed.exists());
            let moved = report
                .items
                .iter()
                .find(|item| item.path == removed)
                .unwrap();
            assert!(moved.removed && moved.moved_to.as_ref().unwrap().is_file());
        }
        for kept in [ambiguous_claim, ambiguous_pending, foreign, conflicting] {
            assert!(kept.is_file());
            assert!(report
                .kept
                .iter()
                .any(|item| item.path == kept && item.reason == AMBIGUOUS_HOME));
        }
    }

    #[test]
    fn custom_home_archives_only_its_confirmed_shared_records() {
        let profile = Fixture::new();
        let custom = Fixture::new();
        let packages = profile.home.join(PACKAGES);
        custom.expired("custom-run");
        record_package_home(&custom.home, &packages, "custom-run").unwrap();
        record_package_home(&profile.home, &packages, "foreign-run").unwrap();
        record_package_home(&profile.home, &packages, "conflicting-run").unwrap();
        record_package_home(&custom.home, &packages, "conflicting-run").unwrap();

        let claim = profile.json("packages/owned/claim.json", json!({"run":"custom-run"}));
        let pending = profile.json(
            "packages/owned/applications/pending.json",
            json!({"runId":"custom-run"}),
        );
        let foreign = profile.json(
            "packages/foreign/applications/pending.json",
            json!({"runId":"foreign-run"}),
        );
        let unconfirmed = profile.json(
            "packages/older/applications/pending.json",
            json!({"runId":"older-run"}),
        );
        let conflicting = profile.json(
            "packages/conflicting/claim.json",
            json!({"run":"conflicting-run"}),
        );
        let legacy = profile.json(
            "packages/older/claim.json",
            json!({"status":"open", "label":"legacy"}),
        );
        let options = Options {
            apply: true,
            claims: true,
            ..Options::default()
        };
        let collect_shared = || {
            collect(
                &custom.home,
                &custom.temp,
                Some(&packages),
                &options,
                || Ok(Vec::new()),
            )
        };

        let report = collect_shared();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.items.is_empty());
        assert!(claim.is_file() && pending.is_file());

        let journal = custom.home.join("flows/custom-run");
        fs::rename(&journal, custom.root.join("retired-journal")).unwrap();

        let contents = [&claim, &pending].map(|path| fs::read(path).unwrap());
        let report = collect_shared();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.freed, 0);
        assert_eq!(report.items.len(), 2);
        for (path, contents) in [claim, pending].into_iter().zip(contents) {
            assert!(!path.exists());
            let item = report.items.iter().find(|item| item.path == path).unwrap();
            let archive = item.moved_to.as_ref().unwrap();
            assert!(item.removed && archive.starts_with(packages.join(".removed")));
            assert_eq!(fs::read(archive).unwrap(), contents);
        }
        for kept in [foreign, unconfirmed, conflicting] {
            assert!(kept.is_file());
            assert!(report
                .kept
                .iter()
                .any(|item| item.path == kept && item.reason == AMBIGUOUS_HOME));
        }
        assert!(legacy.is_file());
    }

    #[test]
    fn an_external_directory_link_is_not_followed_for_size_or_removal() {
        let f = Fixture::new();
        f.expired("finished");
        let marker = f.file("flow-writers/finished/writer/payload", b"payload");
        let dir = marker.parent().unwrap();
        let outside = f.temp.join("external");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), b"outside the Zodchi home").unwrap();
        let link = dir.join("junction");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        create_junction(&link, &outside).expect("junction fixture unavailable");
        assert_eq!(
            fs::read(link.join("keep")).unwrap(),
            b"outside the Zodchi home"
        );
        let report = f.report(Options {
            apply: true,
            ..Options::default()
        });
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.freed, 7);
        assert!(!dir.exists());
        assert_eq!(
            fs::read(outside.join("keep")).unwrap(),
            b"outside the Zodchi home"
        );
    }
}
