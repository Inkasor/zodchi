//! The writer's structured patch and its application. The writer has no shell: it answers with changes (create,
//! modify, delete, rename), each against the blob id the request gave it, and the engine alone writes the files.
//! A patch is checked whole before any file is touched: canonical paths inside the claim, no `..`, no absolute
//! path, nothing under `.git/` or `.agent-tmp/`, no link on the way, protected checks against the base, and every
//! blob id equal to the file as it is now.

use crate::args::{is_protected, Args};
use crate::git::Git;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use zodchi_core::util::{fail, Result};

#[derive(Clone, Debug)]
pub struct Change {
    pub op: String,
    pub path: String,
    pub from: Option<String>,
    pub base_blob: Option<String>,
    pub content: Option<Vec<u8>>,
    pub edits: Option<Vec<Edit>>,
}

#[derive(Clone, Debug)]
pub struct Edit {
    old: String,
    new: String,
}

#[derive(Clone, Debug)]
pub struct Patch {
    pub status: String,
    pub summary: String,
    pub changes: Vec<Change>,
    pub unverified: Vec<String>,
    pub questions: Vec<String>,
}

fn opt_str(v: &Value, k: &str) -> std::result::Result<Option<String>, String> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k} is a string or null")),
    }
}

fn str_list(v: &Value, k: &str) -> std::result::Result<Vec<String>, String> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or(format!("{k} is a list of strings"))).collect(),
        Some(_) => Err(format!("{k} is a list of strings")),
    }
}

fn edits(value: &Value) -> std::result::Result<Option<Vec<Edit>>, String> {
    match value.get("edits") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) if !items.is_empty() => {
            items.iter().map(|item| {
                let old = item["old"].as_str().filter(|text| !text.is_empty()).ok_or("edit old must be nonempty text")?;
                let new = item["new"].as_str().ok_or("edit new must be text")?;
                Ok(Edit { old: old.into(), new: new.into() })
            }).collect::<std::result::Result<_, _>>().map(Some)
        }
        _ => Err("edits is a nonempty array or null".into()),
    }
}

/// Reads a patch answer by the schema of this version; anything else is an invalid answer.
pub fn parse(v: &Value) -> std::result::Result<Patch, String> {
    let status = v.get("status").and_then(Value::as_str).unwrap_or("");
    if !["done", "blocked"].contains(&status) {
        return Err("status is \"done\" or \"blocked\"".into());
    }
    let Some(list) = v.get("changes").and_then(Value::as_array) else { return Err("changes is a list".into()) };
    let mut changes = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let op = c.get("op").and_then(Value::as_str).unwrap_or("");
        if !["create", "modify", "delete", "rename"].contains(&op) {
            return Err(format!("change {}: op is create, modify, delete or rename", i + 1));
        }
        let path = c.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let change = Change {
            op: op.to_string(),
            path,
            from: opt_str(c, "from").map_err(|e| format!("change {}: {e}", i + 1))?,
            base_blob: opt_str(c, "baseBlob").map_err(|e| format!("change {}: {e}", i + 1))?,
            content: opt_str(c, "content").map_err(|e| format!("change {}: {e}", i + 1))?.map(String::into_bytes),
            edits: edits(c).map_err(|e| format!("change {}: {e}", i + 1))?,
        };
        let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("change {} ({op} {}): {what}", i + 1, change.path)) };
        need(change.edits.is_none() || op == "modify", "only modify accepts edits")?;
        match op {
            "create" => need(change.content.is_some() && change.from.is_none(), "a create has content and no from")?,
            "modify" => need(change.content.is_some() != change.edits.is_some() && change.base_blob.is_some() && change.from.is_none(),
                "a modify has baseBlob and exactly one of content or edits")?,
            "delete" => need(change.content.is_none() && change.base_blob.is_some() && change.from.is_none(), "a delete has baseBlob and no content")?,
            _ => need(change.from.is_some() && change.base_blob.is_some(), "a rename has from and baseBlob")?,
        }
        changes.push(change);
    }
    Ok(Patch {
        status: status.to_string(),
        summary: v.get("summary").and_then(Value::as_str).unwrap_or("").to_string(),
        changes,
        unverified: str_list(v, "unverified")?,
        questions: str_list(v, "questions")?,
    })
}

/// Why a patch is not applied.
#[derive(Debug)]
pub enum Refusal {
    /// Paths outside the claim, in the case the patch gave.
    Outside(Vec<String>),
    /// Existing protected files the patch changes or deletes.
    Protected(Vec<String>),
    /// A path that is not a plain relative path of the repository, or a link on its way.
    BadPath(String),
    /// The patch was written against another version of a file, or creates one that exists.
    Stale(String),
    /// The requested replacements do not describe disjoint, uniquely matched parts of the base.
    EditConflict(String),
}

/// What applying a patch does: for each path its blob before and after (None: no file), the written paths that
/// are executable for Git (a modified script keeps its mode, a renamed one takes its source's), and on Unix the exact
/// permission bits each written file gets (a modified file keeps its own, a renamed one its source's; a created one
/// is not listed and gets what the umask gives).
#[derive(Clone, Debug)]
pub struct Plan {
    pub writes: BTreeMap<String, Option<Vec<u8>>>,
    pub before: BTreeMap<String, Option<String>>,
    pub after: BTreeMap<String, Option<String>>,
    pub exec: Vec<String>,
    pub modes: BTreeMap<String, u32>,
}

impl Plan {
    pub fn to_json(&self) -> Value {
        let writes: BTreeMap<_, _> = self.writes.iter().map(|(path, bytes)| {
            let value = match bytes.as_deref() {
                None => Value::Null,
                Some(bytes) => match std::str::from_utf8(bytes) {
                    Ok(text) => json!(text),
                    Err(_) => json!({ "base64": STANDARD.encode(bytes) }),
                },
            };
            (path, value)
        }).collect();
        json!({ "writes": writes, "before": self.before, "after": self.after, "exec": self.exec, "modes": self.modes })
    }
    /// A saved plan, or None when it is not one whole (a lost or damaged plan is never read as an empty one).
    pub fn from_json(v: &Value) -> Option<Plan> {
        let map = |k: &str| -> Option<BTreeMap<String, Option<String>>> {
            v.get(k)?.as_object()?.iter().map(|(p, x)| match x {
                Value::Null => Some((p.clone(), None)),
                Value::String(s) => Some((p.clone(), Some(s.clone()))),
                _ => None,
            }).collect()
        };
        let exec = v.get("exec")?.as_array()?.iter().map(|x| x.as_str().map(String::from)).collect::<Option<Vec<_>>>()?;
        // A plan without modes (none was saved: not Unix, or nothing to keep) has none; a damaged list is no plan.
        let modes = match v.get("modes") {
            None => BTreeMap::new(),
            Some(m) => m.as_object()?.iter()
                .map(|(p, m)| m.as_u64().filter(|m| *m <= 0o7777).map(|m| (p.clone(), m as u32)))
                .collect::<Option<BTreeMap<_, _>>>()?,
        };
        let writes = v.get("writes")?.as_object()?.iter().map(|(p, x)| match x {
            Value::Null => Some((p.clone(), None)),
            Value::String(s) => Some((p.clone(), Some(s.as_bytes().to_vec()))),
            _ => Some((p.clone(), Some(STANDARD.decode(x.get("base64")?.as_str()?).ok()?))),
        }).collect::<Option<_>>()?;
        Some(Plan { writes, before: map("before")?, after: map("after")?, exec, modes })
    }
}

/// Whether a file of the work tree is executable: its mode bits on Unix; elsewhere the mode Git keeps in the index.
fn executable(git: &Git, path: &str) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(fs::metadata(git.root.join(path)).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false))
    }
    #[cfg(not(unix))]
    {
        Ok(git.index_mode(path)?.as_deref() == Some("100755"))
    }
}

/// The permission bits of a file of the work tree (Unix); None elsewhere, where Git keeps the mode.
fn file_mode(root: &Path, path: &str) -> Result<Option<u32>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(Some(fs::metadata(root.join(path))?.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path);
        Ok(None)
    }
}

/// Whether the file's permission bits are exactly those the plan saved for it (Unix only; elsewhere Git keeps the
/// mode). A path the plan saved no mode for passes.
fn mode_ok(root: &Path, path: &str, mode: Option<u32>) -> bool {
    match mode {
        None => true,
        Some(want) => file_mode(root, path).ok().flatten().is_none_or(|now| now == want),
    }
}

/// A plain relative path: forward slashes, no empty, "." or ".." segment, no drive, nothing under .git/ or
/// .agent-tmp/, no characters Windows or Git cannot hold.
pub fn plain(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.bytes().any(|b| b < 0x20)
        && path.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && !s.eq_ignore_ascii_case(".git"))
        && !path.to_lowercase().starts_with(".agent-tmp/")
}

/// No link and no reparse point on the way: every folder above the path inside the repository, and the path itself.
pub fn no_links(root: &Path, path: &str) -> bool {
    let mut at = root.to_path_buf();
    for seg in path.split('/') {
        at.push(seg);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    true
}

/// The claimed spelling of a path, when it is claimed.
pub fn claimed_as(claimed: &[String], path: &str) -> Option<String> {
    claimed.iter().find(|c| c.to_lowercase() == path.to_lowercase()).cloned()
}

/// The paths of a patch that are outside the claim (both ends of a rename).
pub fn outside(patch: &Patch, claimed: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for c in &patch.changes {
        for p in std::iter::once(&c.path).chain(c.from.iter()) {
            if claimed_as(claimed, p).is_none() && !out.contains(p) {
                out.push(p.clone());
            }
        }
    }
    out
}

/// Every replacement is located in the original text. Keep the file's line endings when it uses a uniform style.
fn replace_fragments(text: &str, edits: &[Edit]) -> std::result::Result<String, String> {
    let mut endings = text.match_indices('\n').map(|(at, _)| at > 0 && text.as_bytes()[at - 1] == b'\r');
    let uniform = endings.next().filter(|first| endings.all(|e| e == *first));
    let fragment = |value: &str| match uniform {
        Some(false) => value.replace("\r\n", "\n"),
        Some(true) => value.replace("\r\n", "\n").replace('\n', "\r\n"),
        None => value.to_string(),
    };
    let mut spans = Vec::with_capacity(edits.len());
    let splits_crlf = |at: usize| at > 0 && text.as_bytes().get(at - 1..at + 1) == Some(b"\r\n");
    for (index, edit) in edits.iter().enumerate() {
        let old = fragment(&edit.old);
        let Some(start) = text.find(&old) else {
            return Err(format!("edit {} has no exact match", index + 1));
        };
        if text.rfind(&old) != Some(start) {
            return Err(format!("edit {} matches more than once", index + 1));
        }
        let end = start + old.len();
        if splits_crlf(start) || splits_crlf(end) {
            return Err(format!("edit {} ends or begins inside a CRLF pair", index + 1));
        }
        spans.push((start, end, fragment(&edit.new)));
    }
    spans.sort_unstable_by_key(|(start, _, _)| *start);
    let mut result = String::with_capacity(text.len());
    let mut offset = 0;
    for (start, end, replacement) in spans {
        if start < offset {
            return Err("edits overlap on the original file".into());
        }
        result.push_str(&text[offset..start]);
        result.push_str(&replacement);
        offset = end;
    }
    result.push_str(&text[offset..]);
    Ok(result)
}

/// Checks a patch whole against the claim, the base and the work tree, and returns what applying it does.
pub fn plan(git: &Git, args: &Args, base: &str, patch: &Patch, claimed: &[String]) -> Result<std::result::Result<Plan, Refusal>> {
    for c in &patch.changes {
        for p in std::iter::once(&c.path).chain(c.from.iter()) {
            if !plain(p) {
                return Ok(Err(Refusal::BadPath(format!("{p:?} is not a plain path relative to the repository"))));
            }
        }
    }
    let out = outside(patch, claimed);
    if !out.is_empty() {
        return Ok(Err(Refusal::Outside(out)));
    }
    // Every change in the claimed spelling, each path once.
    let mut seen: Vec<String> = Vec::new();
    let mut changes = Vec::new();
    for c in &patch.changes {
        let path = claimed_as(claimed, &c.path).unwrap();
        let from = c.from.as_ref().map(|f| claimed_as(claimed, f).unwrap());
        for p in std::iter::once(&path).chain(from.iter()) {
            let key = p.to_lowercase();
            if seen.contains(&key) {
                return Ok(Err(Refusal::BadPath(format!("{p} appears in more than one change"))));
            }
            if seen.iter().any(|other| key.strip_prefix(other.as_str()).is_some_and(|rest| rest.starts_with('/')) ||
                other.strip_prefix(key.as_str()).is_some_and(|rest| rest.starts_with('/'))) {
                return Ok(Err(Refusal::BadPath(format!("{p} overlaps another file path in the patch"))));
            }
            if !no_links(&git.root, p) {
                return Ok(Err(Refusal::BadPath(format!("{p}: a link or reparse point lies on its way"))));
            }
            if git.tracked_link("HEAD", p)? {
                return Ok(Err(Refusal::BadPath(format!("{p}: Git keeps it as a link"))));
            }
            seen.push(key);
        }
        changes.push((c, path, from));
    }
    // Protected checks: changing, deleting or renaming away an existing one stops the package.
    let mut protected = Vec::new();
    for (c, path, from) in &changes {
        let touched: Vec<&String> = match c.op.as_str() {
            "modify" | "delete" => vec![path],
            "rename" => vec![from.as_ref().unwrap(), path],
            _ => vec![path],
        };
        for p in touched {
            if is_protected(args, p) && !args.allow_check_changes.contains(&p.to_lowercase())
                && (crate::args::is_project_configuration(p) || git.exists_at(base, p)?)
            {
                let unchanged = c.op == "modify" && git.show(base, p)?.as_deref() == c.content.as_deref();
                if !unchanged && !protected.contains(p) {
                    protected.push(p.clone());
                }
            }
        }
    }
    if !protected.is_empty() {
        return Ok(Err(Refusal::Protected(protected)));
    }
    let mut plan = Plan { writes: BTreeMap::new(), before: BTreeMap::new(), after: BTreeMap::new(), exec: Vec::new(), modes: BTreeMap::new() };
    for (c, path, from) in &changes {
        let current_text = if c.edits.is_some() {
            match fs::read_to_string(git.root.join(path)) {
                Ok(text) => Some(text),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData) => {
                    return Ok(Err(Refusal::EditConflict(format!("{path}: edits need an existing UTF-8 file"))));
                }
                Err(e) => return Err(e.into()),
            }
        } else {
            None
        };
        let now = match &current_text {
            Some(text) => Some(git.blob_of(text.as_bytes())?),
            None => git.blob_of_file(path)?,
        };
        match c.op.as_str() {
            "create" => {
                if now.is_some() {
                    return Ok(Err(Refusal::Stale(format!("create {path}: the file exists"))));
                }
            }
            "rename" => {
                let old = from.as_ref().unwrap();
                let was = git.blob_of_file(old)?;
                if was.is_none() || was != c.base_blob {
                    return Ok(Err(Refusal::Stale(format!("rename {old}: written against blob {}, the file is {}", c.base_blob.as_deref().unwrap_or("none"), was.as_deref().unwrap_or("missing")))));
                }
                if now.is_some() {
                    return Ok(Err(Refusal::Stale(format!("rename to {path}: the file exists"))));
                }
            }
            _ => {
                if now.is_none() || now != c.base_blob {
                    return Ok(Err(Refusal::Stale(format!("{} {path}: written against blob {}, the file is {}", c.op, c.base_blob.as_deref().unwrap_or("none"), now.as_deref().unwrap_or("missing")))));
                }
            }
        }
        match c.op.as_str() {
            "delete" => {
                plan.writes.insert(path.clone(), None);
                plan.before.insert(path.clone(), now);
                plan.after.insert(path.clone(), None);
            }
            "rename" => {
                let old = from.clone().unwrap();
                let content = match &c.content {
                    Some(bytes) => bytes.clone(),
                    None => fs::read(git.root.join(&old))?,
                };
                if executable(git, &old)? {
                    plan.exec.push(path.clone());
                }
                if let Some(m) = file_mode(&git.root, &old)? {
                    plan.modes.insert(path.clone(), m);
                }
                plan.writes.insert(old.clone(), None);
                plan.before.insert(old.clone(), c.base_blob.clone());
                plan.after.insert(old, None);
                plan.after.insert(path.clone(), Some(git.blob_of(&content)?));
                plan.writes.insert(path.clone(), Some(content));
                plan.before.insert(path.clone(), None);
            }
            _ => {
                let bytes = match &c.edits {
                    Some(edits) => match replace_fragments(current_text.as_deref().expect("read for edits"), edits) {
                        Ok(text) => text.into_bytes(),
                        Err(why) => return Ok(Err(Refusal::EditConflict(format!("{path}: {why}")))),
                    },
                    None => c.content.clone().expect("content or edits"),
                };
                if c.op == "modify" {
                    if executable(git, path)? {
                        plan.exec.push(path.clone());
                    }
                    if let Some(m) = file_mode(&git.root, path)? {
                        plan.modes.insert(path.clone(), m);
                    }
                }
                plan.after.insert(path.clone(), Some(git.blob_of(&bytes)?));
                plan.writes.insert(path.clone(), Some(bytes));
                plan.before.insert(path.clone(), now);
            }
        }
    }
    Ok(Ok(plan))
}

/// Writes a file through a temporary one that gets `mode` (Unix) before it takes the file's place; without a mode it
/// keeps what the umask gave it.
fn write_file(root: &Path, path: &str, content: &[u8], mode: Option<u32>) -> Result<()> {
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = target.with_file_name(format!(".{}.zodchi-flow.{}.tmp", target.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
    fs::write(&temp, content)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&temp, fs::Permissions::from_mode(mode & 0o7777)) {
            let _ = fs::remove_file(&temp);
            return Err(e.into());
        }
    }
    #[cfg(not(unix))]
    let _ = mode;
    if let Err(e) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(e.into());
    }
    Ok(())
}

/// Writes the plan into the work tree. Applying it again is harmless: every write puts the same bytes in place.
pub fn apply(root: &Path, plan: &Plan) -> Result<()> {
    for (path, content) in &plan.writes {
        match content {
            Some(text) => write_file(root, path, text, plan.modes.get(path).copied())?,
            None => match fs::remove_file(root.join(path)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
        }
    }
    Ok(())
}

/// Repeat only writes still at their expected starting state. Leave any intervening edit in place.
pub fn apply_recoverable(git: &Git, plan: &Plan) -> Result<()> {
    for (path, content) in &plan.writes {
        if !no_links(&git.root, path) {
            return fail(format!("A link lies on the way to {path}."));
        }
        let now = git.blob_of_file(path)?;
        let mode = plan.modes.get(path).copied();
        let is_after = plan.after.get(path) == Some(&now);
        if is_after && (now.is_none() || mode_ok(&git.root, path, mode)) { continue; }
        if !is_after && plan.before.get(path) != Some(&now) {
            return fail(format!("Application would overwrite an intervening edit at {path}."));
        }
        match content {
            Some(bytes) => write_file(&git.root, path, bytes, mode)?,
            None => fs::remove_file(git.root.join(path))?,
        }
    }
    Ok(())
}

/// Where an interrupted apply stands: "applied" (every path as after), "partial" (every path as before or as after:
/// applying again finishes it) or "unknown" (some path is neither: somebody else changed it, or a link now lies on
/// its way). A file with the after content but not yet the exact mode the plan saved for it is "partial".
pub fn reconcile(git: &Git, plan: &Plan) -> Result<&'static str> {
    let mut all_after = true;
    for (path, after) in &plan.after {
        if !no_links(&git.root, path) {
            return Ok("unknown");
        }
        let now = git.blob_of_file(path)?;
        if &now == after {
            if after.is_some() && !mode_ok(&git.root, path, plan.modes.get(path).copied()) {
                all_after = false;
            }
            continue;
        }
        all_after = false;
        if plan.before.get(path) != Some(&now) {
            return Ok("unknown");
        }
    }
    Ok(if all_after { "applied" } else { "partial" })
}
