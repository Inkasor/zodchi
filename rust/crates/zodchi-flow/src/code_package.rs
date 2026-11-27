//! `code-package` v1 as a state machine. The engine alone decides every transition: gate, claim, write, apply,
//! cheap checks, verify, commit, review, close, and the stop rules. Models only propose a patch or judge a change.
//!
//! Every effect goes through the journal: a run that was cut is resumed by running the machine again from the start,
//! and each step either comes back from the journal (a recorded result or receipt), is reconciled (an interrupted
//! apply against its expected before/after blobs, an interrupted commit against the branch tip, a submitted model
//! call by polling its key), or runs. An outcome that none of them can settle stops the run with
//! `stoppedAt: "unknown outcome at <step>"` and keeps the claim.

use crate::agent;
use crate::args::{self, is_protected, Args};
use crate::boundary::Launch;
use crate::candidate;
use crate::catalog::ProjectGate;
use crate::checks;
use crate::claims;
use crate::executor;
use crate::gateway;
use crate::git::Git;
use crate::input::{GapDecision, GapOption, REVIEW_GAPS};
use crate::input_common::{args_digest, args_match, Scrubber, Withholding};
use crate::journal::{application_status, candidate_workspace, Journal};
use crate::models::{self, Pick};
use crate::patch::{self, Patch, Refusal};
use crate::review_contract::check_review;
use crate::review_source::{self, FileLine};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{compose_prompt, LIMIT_PROMPT};
use zodchi_core::role::load_role;
use zodchi_core::role::Overrides;
use zodchi_core::util::{fail, iso, now_ms, parse_iso_ms, sha256_hex, GatewayError, Result};

pub use crate::boundary::{Exit, CUT_EXIT, REVIEWER_GATEWAY_ROLE, WORKFLOW, WRITER_GATEWAY_ROLE};
#[allow(unused_imports)]
pub(crate) use crate::boundary::cut;
pub use crate::control::{start_package as start, start_package_detached as start_detached};

pub const VERSION: &str = "1";

const RULES: &str = include_str!("../flows/code-package/v1/rules.md");
const AGENT_RULES: &str = include_str!("../flows/code-package/v1/agent-rules.md");
const CHECK_RULES: &str = include_str!("../flows/code-package/v1/check-rules.md");
const WRITE: &str = include_str!("../flows/code-package/v1/write.md");
const FIX: &str = include_str!("../flows/code-package/v1/fix.md");
const CLOSE: &str = include_str!("../flows/code-package/v1/close.md");
const REVIEW: &str = include_str!("../flows/code-package/v1/review.md");
const PATCH_SCHEMA_V1: &str = include_str!("../flows/code-package/v1/patch.schema.json");
const PATCH_SCHEMA_V2: &str = include_str!("../flows/code-package/v2/patch.schema.json");
pub(crate) const REVIEW_SCHEMA: &str = include_str!("../flows/code-package/v1/review.schema.json");

fn exit_of(result: Value) -> Exit {
    let code = if result["approved"] == json!(true) { 0 } else { 2 };
    Exit { result, code }
}

/// A saved result provides the verdict after the claim can be closed. Keep it for a later resume if closure fails.
fn finish_result(journal: &mut Journal, args: &Args, id: &str, mut result: Value) -> Result<Exit> {
    let finished = journal.events().iter().any(|entry| entry["kind"] == json!("finished"));
    if finished && result.get("claimLeftOpen").is_none() {
        if let Some(application) = application_status(journal.events()) {
            result["application"] = application;
        }
        return Ok(exit_of(result));
    }
    if let Some(closing) = journal.events().iter().rev().find(|entry| entry["kind"] == json!("closing")) {
        if closing["close"] == json!(true) {
            let dir = claims::claims_dir(&args.repo_norm);
            let path = claims::file(&dir, &args.label);
            let status = closing["status"].as_str().unwrap_or("stopped");
            let failure = match claims::close(&dir, &args.label, id, status) {
                Ok(true) => None,
                Ok(false) => Some(format!("claim {} belongs to another run", path.display())),
                Err(error) => Some(error.0),
            };
            if let Some(why) = failure {
                result["approved"] = json!(false);
                result["verdict"] = json!("blocked");
                result["stoppedAt"] = json!("infrastructure at close claim");
                result["infra"] = json!(why);
                result["claimLeftOpen"] = json!(path.display().to_string());
                result["next"] = json!("Resolve the claim error, then resume this run to finish closing it.");
                return Ok(exit_of(result));
            }
        }
    }
    if result.as_object_mut().and_then(|out| out.remove("claimLeftOpen")).is_some() {
        journal.write_value("result.json", &result)?;
    }
    if !finished {
        journal.append(json!({ "kind": "finished", "verdict": result["verdict"], "stoppedAt": result["stoppedAt"] }))?;
    }
    Ok(exit_of(result))
}

fn refused(label: &str, why: String) -> Exit {
    exit_of(json!({ "label": label, "mode": "expert", "workflow": WORKFLOW, "version": VERSION, "rounds": [], "openFindings": [], "verifiedBy": "none", "refused": why }))
}

fn render(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

/// Severity of a finding: important blocks; nit and pre-existing do not. Older words are mapped; anything else is
/// read as important, so an unreadable finding never approves a change.
fn severity(word: &str) -> &'static str {
    match word.to_lowercase().as_str() {
        "important" | "blocking" => "important",
        "nit" | "should_fix" | "note" | "minor" => "nit",
        "pre-existing" => "pre-existing",
        _ => "important",
    }
}

fn schema(text: &str) -> Value {
    serde_json::from_str(text).expect("the schemas of this version are JSON")
}

/// Named text attachments of a request: (name, bytes).
type Attachments = Vec<(String, Vec<u8>)>;

/// Why the machine stopped early; the result already says it.
struct Halt;
type Step<T> = std::result::Result<T, Halt>;

struct GapEvidence {
    what: String,
    why: String,
    writer_closeable: bool,
}

fn review_gap_evidence(review: &Value) -> std::result::Result<Vec<GapEvidence>, String> {
    let Some(gaps) = review.get("gaps") else { return Ok(Vec::new()) };
    let gaps = gaps.as_array().ok_or("gaps is a list")?;
    gaps.iter().map(|gap| {
        let (Some(what), Some(why), Some(writer_closeable)) = (
            gap["what"].as_str(), gap["why"].as_str(), gap["writerCloseable"].as_bool(),
        ) else {
            return Err("a gap needs what and why text and a writerCloseable boolean".into());
        };
        if gap.as_object().is_none_or(|fields| fields.len() != 3) {
            return Err("a gap has unexpected fields".into());
        }
        Ok(GapEvidence { what: what.into(), why: why.into(), writer_closeable })
    }).collect()
}

fn check_package_review(review: &Value) -> std::result::Result<(), String> {
    check_review(review)?;
    review_gap_evidence(review).map(|_| ())
}

fn package_review_schema(reviewer: &Pick) -> Value {
    let mut schema = schema(REVIEW_SCHEMA);
    if reviewer.provider == "claude" {
        // The text executor validates locally before handing the answer to the package decoder.
        // Only the structured output request needs every property to be required.
        schema["required"].as_array_mut().expect("review schema required fields").retain(|field| field != "gaps");
    }
    schema
}

// Match an open gap across reviews by its "what", ignoring case and runs of whitespace.
fn gap_identity(what: &str) -> String {
    what.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GapState {
    Open,
    Finding,
    Accepted,
    ContextAttached,
    ReviewAgain,
    Superseded,
}

struct ReviewGap {
    id: String,
    evidence: GapEvidence,
    state: GapState,
}

impl ReviewGap {
    fn to_json(&self) -> Value {
        let state = match self.state {
            GapState::Open => "open",
            GapState::Finding => "finding",
            GapState::Accepted => "accepted",
            GapState::ContextAttached => "context attached",
            GapState::ReviewAgain => "review again",
            GapState::Superseded => "superseded",
        };
        json!({
            "id": self.id, "what": self.evidence.what, "why": self.evidence.why,
            "writerCloseable": self.evidence.writer_closeable, "state": state,
        })
    }
}

struct GapReply {
    seq: u64,
    decisions: Vec<GapDecision>,
}

struct ReviewRound<'a> {
    n: u32,
    candidate: &'a str,
    summary: &'a str,
    unverified: &'a [String],
    verification: &'a Value,
    checks: &'a Value,
    commit: &'a Value,
}

enum ScreenedPrompt {
    Prompt(String),
    Withheld(Vec<String>),
}

struct RoundVerdict {
    review: Value,
    findings: Vec<String>,
    important: Vec<String>,
    verdict: &'static str,
}

struct Run {
    id: String,
    args: Args,
    cfg: Config,
    git: Git,
    project: Option<Git>,
    journal: Journal,
    base: String,
    seed: String,
    history: Value,
    branch: String,
    brief: String,
    allowed_input_digests: HashSet<String>,
    review_md: Option<String>,
    patch_schema: &'static str,
    verify_plan: crate::verify::Plan,
    check_paths: checks::ProjectPaths,
    browser: Value,
    writer: Pick,
    reviewer: Pick,
    review_number: u32,
    gaps: Vec<ReviewGap>,
    claims_dir: PathBuf,
    claimed: Vec<String>,
    head: String,
    out: Map<String, Value>,
    keep_claim: bool,
    claim_status: &'static str,
    questions: Vec<String>,
    changed: Vec<String>,
    /// Written paths that are executable (from the applied plans): the candidate tree keeps their mode.
    exec: Vec<String>,
    step: String,
}

// ------------------------------------------------------------------------------------------------- start, resume

fn input_lines_with_bytes<'a>(
    scrubber: &'a Scrubber, text: &'a str, bytes: &'a [u8],
) -> impl Iterator<Item = (usize, &'a [u8], Withholding)> + 'a {
    // Screen decoded text, but hash the exact bytes of the line, excluding LF or CRLF.
    let mut lines = bytes.split_inclusive(|&b| b == b'\n').enumerate();
    scrubber.input_withholdings(text).map(move |(number, reason)| {
        let (_, original) = lines.find(|(index, _)| *index + 1 == number)
            .expect("decoded text preserves line boundaries");
        let content = original.strip_suffix(b"\r\n").or_else(|| original.strip_suffix(b"\n")).unwrap_or(original);
        (number, content, reason)
    })
}

fn withheld_input_lines(scrubber: &Scrubber, bytes: &[u8], allowed: &HashSet<String>) -> Vec<(usize, Withholding)> {
    input_lines_with_bytes(scrubber, &String::from_utf8_lossy(bytes), bytes).filter_map(|(line, content, reason)| {
        let exempt = reason.allows_input_exception() && !allowed.is_empty() && allowed.contains(&sha256_hex(content));
        (!exempt).then_some((line, reason))
    }).collect()
}

fn input_locations<'a>(
    name: &'a str, suffix: &'a str, lines: Vec<(usize, Withholding)>,
) -> impl Iterator<Item = String> + 'a {
    lines.into_iter().map(move |(line, reason)| format!("{name}:{line}{suffix} ({})", reason.reason()))
}

fn pin_input_allowances(git: &Git, base: &str, repo: &str, value: &Value, scrubber: &Scrubber) -> Result<Vec<Value>> {
    let entries = value.as_array()
        .ok_or_else(|| GatewayError("args.allowInputLines must be an array of path:line strings.".into()))?;
    let mut receipts = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let at = format!("args.allowInputLines entry {}", index + 1);
        let invalid = || GatewayError(format!("{at} must name a repository file and positive line number as path:line."));
        let (path, line) = entry.as_str().and_then(|s| s.rsplit_once(':')).ok_or_else(invalid)?;
        let path = args::rel(repo, path).map_err(|_| invalid())?;
        let line = line.parse::<usize>().ok().filter(|n| *n > 0).ok_or_else(invalid)?;
        if scrubber.input_withholdings(&path).next().is_some() {
            return fail(format!("{at} names a file whose path would be withheld."));
        }
        let bytes = git.show(base, &path)?
            .filter(|bytes| !bytes.contains(&0))
            .ok_or_else(|| GatewayError(format!("{at} does not name a regular text file in the base commit.")))?;
        let text = String::from_utf8_lossy(&bytes);
        if text.lines().nth(line - 1).is_none() {
            return fail(format!("{at} is outside the file in the base commit."));
        }
        let (_, content, reason) = input_lines_with_bytes(scrubber, &text, &bytes).find(|(number, _, _)| *number == line)
            .ok_or_else(|| GatewayError(format!("{at} names a line the input gate would pass.")))?;
        if !reason.allows_input_exception() {
            return fail(format!("{at} names a private word or private-key block. These lines cannot be allowed."));
        }
        receipts.push(json!({ "path": path, "line": line, "sha256": sha256_hex(content) }));
    }
    Ok(receipts)
}

fn input_allowance_digests(receipts: &[Value]) -> Result<HashSet<String>> {
    receipts.iter().map(|receipt| {
        receipt["sha256"].as_str().filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(String::from).ok_or_else(|| GatewayError("The journal has an invalid input line allowance digest.".into()))
    }).collect()
}

fn input_omissions(
    git: &Git, base: &str, files: &[String], brief: &str, scrubber: &Scrubber, allowed: &HashSet<String>,
) -> Result<Vec<String>> {
    let mut omissions: Vec<_> = input_locations("the brief", "", withheld_input_lines(scrubber, brief.as_bytes(), allowed)).collect();
    for (index, file) in files.iter().enumerate() {
        let private_name = scrubber.input_withholdings(file).next();
        let display = if let Some((_, reason)) = private_name {
            let entry = format!("args.files entry {}", index + 1);
            omissions.push(format!("{entry} (file name, {})", reason.reason()));
            entry
        } else {
            file.clone()
        };
        // NUL-containing blobs cannot be sent as text attachments.
        if let Some(bytes) = git.show(base, file)?.filter(|bytes| !bytes.contains(&0)) {
            omissions.extend(input_locations(&display, "", withheld_input_lines(scrubber, &bytes, allowed)));
        }
    }
    Ok(omissions)
}

/// Screen read-only material outside the package inputs with the outbound rules.
fn screen_attachment(scrubber: &Scrubber, bytes: Vec<u8>, places: &[(String, &str)]) -> Vec<u8> {
    // Keep the existing handling of binary files and preserve line endings in unchanged text.
    if bytes.contains(&0) {
        return bytes;
    }
    let text = String::from_utf8_lossy(&bytes);
    let screened = scrubber.text(&text, places);
    if text.lines().eq(screened.split('\n')) { bytes } else { screened.into_bytes() }
}

/// The gate has already checked this input. Keep the original text and line endings around path substitutions.
fn input_attachment(text: &str, places: &[(String, &str)]) -> Vec<u8> {
    checks::screen_paths(text.split('\n'), places).into_bytes()
}

/// The checks are named by source and number in the prompt, since a command may contain private material.
fn check_rules(args: &Args, plan: &crate::verify::Plan) -> String {
    let list = |v: &[String]| v.iter().map(|x| format!("{x:?}")).collect::<Vec<_>>().join(", ");
    let mut cmds: Vec<String> = (1..=plan.checks.len()).map(|i| format!("{} #{i}", plan.check_source)).collect();
    cmds.extend((1..=plan.verify.len()).map(|i| format!("{} #{i} (verify)", plan.verify_source)));
    render(CHECK_RULES, &[
        ("protect", if args.protect.is_empty() { String::new() } else { format!(", or under {}", list(&args.protect)) }),
        ("allowed", if args.allow_check_changes.is_empty() { String::new() } else { format!(", except {}, which the lead allowed", list(&args.allow_check_changes)) }),
        ("checks", if cmds.is_empty() { "none are given, so nothing is verified by running".into() } else { format!("{} (the brief may say what they are; the engine does not pass their command lines)", cmds.join(", ")) }),
    ])
}

fn expert_preamble(
    template: &str, step: &str, id: &str, files: String, checks: &str, vars: Vec<(&str, String)>,
) -> String {
    let rules = format!("{RULES}\n{checks}");
    let mut all = vec![("step", step.to_string()), ("run", id.to_string()), ("files", files), ("rules", rules)];
    all.extend(vars);
    render(template, &all)
}

fn agent_boundary(files: &[String]) -> String {
    files.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n")
}

fn agent_preamble(
    turn: &str, id: &str, boundary: &str, checks: &str, notes: &str, has_setup: bool, browser: &Value,
) -> String {
    let mut text = format!("Step: {turn} (code-package v1, run {id})\n\n{AGENT_RULES}\nAllowed files:\n{boundary}\n\n{checks}\n\n{notes}");
    if has_setup {
        text.push_str("\n\nThe engine completed the configured setup in this workspace. Use the prepared dependencies for your checks.");
    }
    if let Some(variable) = browser["variable"].as_str() {
        text.push_str(&format!("\n\nThe pinned browser executable is available in the shell variable {variable}. Project tests choose headless mode."));
    }
    text
}

fn writer_file_line(path: &str, blob: Option<&str>, note: &str) -> String {
    match blob {
        Some(blob) => format!("- {path}  blob {blob}{note}"),
        None => format!("- {path}  none (it does not exist)"),
    }
}

fn writer_worktree_path(git: &Git, head: &str, path: &str) -> Result<PathBuf> {
    // On a checkout with core.symlinks=false, the file can look regular but actually hold a link's target.
    if !patch::no_links(&git.root, path) {
        return fail(format!("{path}: a link or reparse point lies on its way, so it is not read"));
    }
    if git.tracked_link(head, path)? {
        return fail(format!("{path}: Git keeps it as a link, so it is not read"));
    }
    Ok(git.root.join(path))
}

fn expert_file_sizes(git: &Git, seed: &str, args: &Args, attachments: &mut Vec<Value>) -> Result<String> {
    let mut lines = Vec::new();
    for path in &args.files {
        let file = if args.isolated {
            // The future private checkout does not exist during preview. Read source sizes from its pinned tree.
            let entry = git.entry_at(seed, path)?.filter(|(mode, kind, _)| mode.starts_with("100") && kind == "blob");
            if let Some((_, _, blob)) = entry {
                let size = git.run(&["cat-file", "-s", &blob])?.trim().parse::<u64>()
                    .map_err(|_| GatewayError(format!("Git could not report the size of {path}.")))?;
                Some(size)
            } else {
                None
            }
        } else {
            // A file the writer cannot read has no attachment to size.
            writer_worktree_path(git, seed, path).ok()
                .and_then(|path| path.metadata().ok())
                .filter(std::fs::Metadata::is_file)
                .map(|file| file.len())
        };
        if let Some(bytes) = file {
            // Each blob ID in the manifest has the same byte length as the seed commit ID.
            lines.push(writer_file_line(path, Some(seed), ""));
            attachments.push(json!({ "path": path, "bytes": bytes }));
        } else {
            lines.push(writer_file_line(path, None, ""));
        }
    }
    Ok(lines.join("\n"))
}

#[allow(clippy::too_many_arguments)]
fn preview_writer_prompt(
    args: &Args, plan: &crate::verify::Plan, id: &str, browser: &Value, git: &Git, seed: &str,
    brief: &str, history: &Value, places: &[(String, &str)],
) -> Result<Value> {
    let mut attachments = vec![json!({ "path": "brief", "bytes": input_attachment(brief, places).len() })];
    if history.is_object() {
        attachments.push(json!({ "path": "previous-package.json", "bytes": history.to_string().len() }));
    }
    let checks = check_rules(args, plan);
    let (preamble, files, rules) = if args.agent {
        let files = agent_boundary(&args.files);
        let text = agent_preamble("write", id, &files, &checks, "", !plan.setup.is_empty(), browser);
        (text, files.len(), AGENT_RULES.len())
    } else {
        let files = expert_file_sizes(git, seed, args, &mut attachments)?;
        let size = files.len();
        (expert_preamble(WRITE, "write", id, files, &checks, vec![]), size, RULES.len())
    };
    let instructions = preamble.len().saturating_sub(files + rules + checks.len());
    Ok(json!({
        "sections": [
            { "name": "instructions", "bytes": instructions },
            { "name": "files", "bytes": files },
            { "name": "rules", "bytes": rules },
            { "name": "checkRules", "bytes": checks.len() },
        ],
        "attachments": attachments,
    }))
}

fn preview_pick(pick: &Pick, server: Option<&str>) -> Value {
    let route = match (pick.provider.as_str(), server) {
        ("claude", _) => "claude cli".into(),
        (_, Some(url)) => {
            let (scheme, address) = url.split_once("://").expect("preflight validated the server URL");
            let host = address.split('/').next().expect("server authority");
            format!("company server {scheme}://{host}")
        }
        _ => "local codex gateway".into(),
    };
    json!({ "provider": pick.provider, "model": pick.model, "effort": pick.effort, "route": route })
}

fn private_places(
    cfg: &Config, args: &Args, journal: &Path, check_paths: &checks::ProjectPaths, browser: &Value,
) -> Vec<(String, &'static str)> {
    let mut v = vec![
        (std::env::temp_dir().display().to_string(), "<tmp>"),
        (journal.display().to_string(), "<journal>"),
        (cfg.home.display().to_string(), "<zodchi-home>"),
        (args.repo_norm.clone(), "<repo>"),
    ];
    v.extend(check_paths.private_places());
    for key in ["configuredPath", "path"] {
        if let Some(path) = browser[key].as_str().filter(|s| !s.is_empty()) {
            v.push((path.to_string(), "<browser>"));
        }
    }
    for k in ["HOME", "USERPROFILE"] {
        if let Some(h) = std::env::var_os(k).filter(|h| !h.is_empty()) {
            v.push((h.to_string_lossy().into_owned(), "~"));
        }
    }
    v
}

fn review_context(git: &Git, commit: &str, files: &[String]) -> Result<Vec<(String, String)>> {
    let mut context = Vec::with_capacity(files.len());
    let mut size = 0;
    let limit = LIMIT_PROMPT / 2;
    for file in files {
        let (_, _, blob) = git.entry_at(commit, file)?
            .filter(|(mode, kind, _)| mode.starts_with("100") && kind == "blob")
            .ok_or_else(|| GatewayError(format!("The review context file {file} is not a regular file in {commit}.")))?;
        let length = git.run(&["cat-file", "-s", &blob])?.trim().parse::<usize>()
            .map_err(|_| GatewayError(format!("Git could not report the size of {file}.")))?;
        if length > limit - size {
            return fail(format!("The review context exceeds {limit} bytes at {file}. Supply smaller regular text sources."));
        }
        size += length;
        let bytes = git.show(commit, file)?
            .ok_or_else(|| GatewayError(format!("The review context file {file} is no longer readable in {commit}.")))?;
        let text = String::from_utf8(bytes).ok().filter(|text| !text.contains('\0'))
            .ok_or_else(|| GatewayError(format!("The review context file {file} is not UTF-8 text.")))?;
        context.push((file.clone(), text));
    }
    Ok(context)
}

pub(crate) fn start_child(raw: &Value, id: &str, require_workflow: ProjectGate) -> Result<Exit> {
    start_run(raw, StartMode::Child(id), require_workflow)
}

#[derive(Clone, Copy)]
pub(crate) enum StartMode<'a> {
    Foreground,
    Detached(Launch),
    Child(&'a str),
    DryRun,
}

pub(crate) fn start_run(
    raw: &Value,
    mode: StartMode<'_>,
    require_workflow: ProjectGate,
) -> Result<Exit> {
    let dry_run = matches!(mode, StartMode::DryRun);
    let label = raw["label"].as_str().unwrap_or("").to_string();
    // Resolve this gate-specific field against Git before journaling the normal execution args.
    let mut package_args = raw.clone();
    let allowances = package_args.as_object_mut().and_then(|args| args.remove("allowInputLines"));
    let args = match args::parse(&package_args) {
        Ok(a) => a,
        Err(why) => return Ok(refused(&label, why)),
    };
    let repo = PathBuf::from(&args.repo);
    let git = Git::new(&repo);
    let Ok(brief) = std::fs::read_to_string(&args.brief) else {
        return Ok(refused(&label, format!("Cannot read the brief {}", args.brief)));
    };
    let top_raw = git.run(&["rev-parse", "--show-toplevel"]).ok();
    let top = top_raw.as_deref().and_then(|t| claims::norm(t.trim()).ok());
    // The same folder can have two spellings: a short 8.3 name on Windows (RUNNER~1), a linked /var on macOS
    // (/private/var). Compare the canonical paths when the spelled ones differ.
    let same_canonical = top_raw.as_deref().is_some_and(|t| {
        match (std::fs::canonicalize(t.trim()), std::fs::canonicalize(&repo)) { (Ok(a), Ok(b)) => a == b, _ => false }
    });
    if !same_canonical && top.as_deref().map(|t| claims::fold(&args.repo_norm, t)) != Some(claims::fold(&args.repo_norm, &args.repo_norm)) {
        return Ok(refused(&label, format!("{} is not the top folder of a Git work tree: code-package reads the protected checks and REVIEW.md from the base commit.", args.repo)));
    }
    let Ok(base) = git.rev("HEAD^{commit}") else {
        return Ok(refused(&label, format!("{} has no commit yet: commit the current state first.", args.repo)));
    };
    if let Err(error) = require_workflow(&git, &base, WORKFLOW) {
        return Ok(refused(&label, error.0));
    }
    let Some(branch) = git.branch()? else {
        return Ok(refused(&label, "HEAD is detached: check out the branch the package commits on.".into()));
    };
    let cfg = Config::new(Some(&repo))?;
    let scrubber = match Scrubber::new(&cfg) {
        Ok(scrubber) => scrubber,
        Err(error) => return Ok(refused(&label, error.0)),
    };
    let allowances = allowances.as_ref()
        .map(|value| pin_input_allowances(&git, &base, &args.repo_norm, value, &scrubber)).transpose()?;
    let allowed_input_digests = input_allowance_digests(allowances.as_deref().unwrap_or_default())?;
    let omissions = match input_omissions(&git, &base, &args.files, &brief, &scrubber, &allowed_input_digests) {
        Ok(omissions) => omissions,
        Err(error) => return Ok(refused(&label, error.0)),
    };
    if !omissions.is_empty() {
        return Ok(refused(&label, format!(
            "Package inputs contain lines that would be withheld: {}. Rewrite the brief, remove the marked files from the claim, or list the lines in allowInputLines after checking they are not secrets.",
            omissions.join(", "),
        )));
    }
    let (seed, history, prior_writers) = match args.source_run.as_deref() {
        Some(source_id) => {
            let load = || -> Result<_> {
                let source = crate::package_source::Source::load(&cfg.home, &repo, source_id)?;
                let seed = source.seed(&git, &base, &branch, &args.files)?;
                let mut context = source.review_context();
                context["originalBrief"] = json!(String::from_utf8_lossy(source.initial_brief()));
                scrubber.value(&mut context, &[(args.repo_norm.clone(), "<repo>"), (cfg.home.display().to_string(), "<zodchi-home>")]);
                Ok((seed, context, source.writers()?))
            };
            match load() {
                Ok(source) => source,
                Err(error) => return Ok(refused(&label, error.0)),
            }
        }
        None => (base.clone(), Value::Null, vec![]),
    };
    if let Err(error) = review_context(&git, &seed, &args.review_context) {
        return Ok(refused(&label, error.0));
    }
    // check-ignore takes path names, and refuses the literal pathspec mode the engine's other calls run in.
    match git.output(&["check-ignore", "-q", "--", ".agent-tmp/gateway/"], &[("GIT_LITERAL_PATHSPECS", "0".into())], None)?.status.code() {
        Some(0) => {}
        Some(1) => return Ok(refused(&label, format!("{} does not ignore .agent-tmp/, so the gateway would refuse this package's calls. Add \".agent-tmp/\" to its .gitignore and commit it first.", args.repo))),
        _ => return Ok(refused(&label, "Git could not check the ignore rules of the repository.".into())),
    }
    let dirty = git.dirty()?;
    let overlap: Vec<String> = dirty.iter().filter(|d| args.files.iter().any(|f| f.to_lowercase() == d.to_lowercase())).cloned().collect();
    if !overlap.is_empty() {
        return Ok(refused(&label, format!("Uncommitted changes in package files: {}. Commit or stash them first.", overlap.join(", "))));
    }
    // A claim names files, each by itself: a folder would take in whatever lies under it.
    for f in &args.files {
        let folder = std::fs::symlink_metadata(repo.join(f)).is_ok_and(|m| m.is_dir()) || git.entry_at(&base, f)?.is_some_and(|(_, kind, _)| kind == "tree");
        if folder {
            return Ok(refused(&label, format!("args.files names files only; {f} is a folder. List the files of the package one by one.")));
        }
    }
    let check_paths = checks::ProjectPaths::new(&cfg.home, &git)?;
    let verify_plan = match crate::verify::Plan::load(&git, &seed, &args, &check_paths) {
        Ok(plan) => plan,
        Err(error) => return Ok(refused(&label, error.0)),
    };
    if !verify_plan.setup.is_empty() || !verify_plan.checks.is_empty() || !verify_plan.verify.is_empty() || !verify_plan.full_local.is_empty() {
        if let Err(error) = checks::preflight() {
            return Ok(refused(&label, error.0));
        }
    }
    if let Err(error) = checks::preflight_tools(&verify_plan.project.tools) {
        return Ok(refused(&label, error.0));
    }
    let review_md = git.show(&base, "REVIEW.md")?.map(|b| String::from_utf8_lossy(&b).into_owned());
    // With a flow server the Codex steps run there: the local Codex sign-in and roles are not needed for them, and
    // the server's roles and sign-in are asked below, before the claim.
    let server = executor::flow_server(&cfg);
    if args.agent && server.is_some() {
        return Ok(refused(&label, "Agent mode needs the local Codex gateway for its writable workspace. This installation has a Flow server configured.".into()));
    }
    let table = match models::table(&cfg, &repo, &args.models) {
        Ok(t) => t,
        Err(why) => return Ok(refused(&label, why)),
    };
    let codex = match &server {
        None => models::local_codex_usable(&cfg),
        Some(_) => Ok(()),
    };
    let (writer, reviewer, skipped) = match models::resolve_pair(&table, &codex, args.writer_role(), args.agent, &prior_writers, dry_run) {
        Ok(p) => p,
        Err(models::ResolveError::Unavailable(why)) => return Ok(refused(&label, why)),
        Err(models::ResolveError::PreflightRequired(why)) => return Ok(Exit { code: 1, ..refused(&label, why) }),
    };
    let writer_gateway_role = if args.agent { agent::ROLE } else { WRITER_GATEWAY_ROLE };
    let on_server = |p: &Pick| server.is_some() && p.provider == "codex";
    if !(on_server(&writer) && on_server(&reviewer)) {
        for name in [writer_gateway_role, REVIEWER_GATEWAY_ROLE] {
            let role = load_role(&cfg, name, &Overrides::default()).and_then(|role| {
                if name == agent::ROLE { agent::check_writer_role(&role) } else { Ok(()) }
            });
            if let Err(e) = role {
                return Ok(refused(&label, format!("The gateway role {name} is unavailable for this package: {e}")));
            }
        }
    }
    if let Some(url) = server.as_ref().filter(|_| on_server(&writer) || on_server(&reviewer)) {
        if let Err(e) = executor::server::Server::new(cfg.clone(), url.clone()).preflight(&[WRITER_GATEWAY_ROLE, REVIEWER_GATEWAY_ROLE]) {
            return Ok(refused(&label, e.0));
        }
    }
    let executors = if server.is_some() { "codex via server" } else { "codex only" };
    let id = match mode {
        StartMode::Child(id) => id.to_string(),
        _ => crate::journal::new_run_id(),
    };
    let browser = match &args.browser {
        Some((variable, path)) => match gateway::pin_browser(variable, Path::new(path)) {
            Ok(pin) => pin,
            Err(why) => return Ok(refused(&label, why)),
        },
        None => Value::Null,
    };
    let screening = json!({ "brief": "screened", "files": "screened", "agentWorkspace": args.agent.then_some("not screened") });
    // A preview leaves the shared gate before creating the journal, launching a worker, or claiming the files.
    if dry_run {
        let places = private_places(&cfg, &args, &crate::journal::flows_dir(&cfg.home).join(&id), &check_paths, &browser);
        let prompt = preview_writer_prompt(&args, &verify_plan, &id, &browser, &git, &seed, &brief, &history, &places)?;
        return Ok(Exit { code: 0, result: json!({
            "dryRun": true, "label": args.label, "repo": args.repo, "branch": branch, "base": base,
            "files": args.files, "protected": args.protected_paths(), "allowCheckChanges": args.allow_check_changes,
            "models": {
                (args.writer_role()): preview_pick(&writer, server.as_deref()),
                "reviewer": preview_pick(&reviewer, server.as_deref()),
            },
            "prompt": prompt, "screening": screening, "checks": verify_plan.checks, "verify": verify_plan.verify,
            "budget": { "rounds": args.rounds, "fixes": args.fixes, "continuations": args.continuations },
        }) });
    }
    let is_child = matches!(mode, StartMode::Child(_));
    let mut inputs = json!({ "args": package_args, "brief": args.brief, "briefSha256": sha256_hex(&brief), "reviewMd": review_md.is_some() });
    if let Some(receipts) = allowances {
        inputs["allowInputLines"] = json!(receipts);
        inputs["argsSha256"] = json!(args_digest(raw));
    }
    let run = json!({
        "runId": id, "workflow": WORKFLOW, "version": VERSION, "mode": args.mode(), "patchSchema": 2,
        "release": env!("CARGO_PKG_VERSION"), "createdAt": iso(),
        "repo": args.repo, "base": base, "branch": branch, "isolated": args.isolated,
        "seed": seed, "history": history, "priorWriters": prior_writers,
        "screening": screening,
        "inputs": inputs,
        "pair": { (args.writer_role()): writer.to_json(), "reviewer": reviewer.to_json(), "skipped": skipped },
        "verificationPlan": verify_plan.to_json(), "reviewContext": args.review_context, "browser": browser,
        "policy": { "rounds": args.rounds, "fixes": args.fixes, "protected": args::BUILTIN_PROTECTED,
            "protect": args.protect, "allowCheckChanges": args.allow_check_changes, "extendClaim": args.extend_claim,
            "checkTimeoutMin": args.check_timeout_min, "continuations": args.continuations,
            "executors": executors, "checksEnvironment": "exported candidate tree, reduced environment" },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    if is_child { crate::boundary::cut("code-package context"); }
    journal.write_text("brief.md", &brief)?;
    if let Some(text) = &review_md {
        journal.write_text("REVIEW.base.md", text)?;
    }
    if is_child { journal.write_text("initialized", "1\n")?; }
    if let StartMode::Detached(launch) = mode {
        return launch(&journal, &id);
    }
    let lock = journal.lock()?;
    let run = Run::new(id, args, cfg, git, journal, &run, brief, review_md)?;
    let exit = run.machine();
    drop(lock);
    exit
}

fn restore_child_context(journal: &Journal, run: &Value, git: &Git, id: &str) -> Result<()> {
    let inputs = &run["inputs"];
    let brief_path = inputs["brief"].as_str()
        .ok_or_else(|| GatewayError(format!("Run {id} has no brief path in its run.json.")))?;
    let brief_problem = || format!("The brief of run {id} ({brief_path}) has changed or gone missing since the run started");
    let brief = std::fs::read_to_string(brief_path)
        .map_err(|error| GatewayError(format!("{} ({error}).", brief_problem())))?;
    if inputs["briefSha256"] != sha256_hex(&brief) {
        return fail(format!("{}.", brief_problem()));
    }
    let review_md = if inputs["reviewMd"] == json!(true) {
        let base = run["base"].as_str().filter(|base| !base.is_empty())
            .ok_or_else(|| GatewayError(format!("Run {id} has no base commit for REVIEW.md in its run.json.")))?;
        let cannot_read = |reason: &str| GatewayError(format!(
            "The base REVIEW.md of run {id} in commit {base} ({}) cannot be read ({reason}).",
            git.root.display(),
        ));
        let bytes = git.show(base, "REVIEW.md")
            .map_err(|error| cannot_read(&error.0))?
            .ok_or_else(|| cannot_read("no regular REVIEW.md in the commit"))?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        None
    };

    journal.write_text("brief.md", &brief)?;
    if let Some(text) = &review_md {
        journal.write_text("REVIEW.base.md", text)?;
    }
    journal.write_text("initialized", "1\n")?;
    Ok(())
}

/// Resumes a run from its journal. `args`, when given, must be the arguments the run started with; `rerun` names the
/// step the run stopped at, to run it again under a new key.
pub fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    let home = Config::new(None).map(|c| c.home)?;
    let (mut journal, run) = Journal::open(&home, id)?;
    if run["workflow"] != json!(WORKFLOW) || run["version"] != json!(VERSION) {
        return Err(GatewayError(format!("Run {id} is {} v{}; this engine runs {WORKFLOW} v{VERSION}.", run["workflow"], run["version"])));
    }
    let raw = run["inputs"]["args"].clone();
    if let Some(g) = given {
        if !args_match(&run["inputs"], g) {
            return Err(GatewayError(format!("The args differ from those run {id} started with; resume without --args, or start a new run.")));
        }
    }
    let lock = journal.lock()?;
    journal.load()?;
    // The repository is the one the run pinned (an absolute path), whatever folder the resume is started from.
    let mut pinned = raw.clone();
    let Some(repo) = run["repo"].as_str().filter(|r| std::path::Path::new(r).is_absolute()) else {
        return Err(GatewayError(format!("Run {id} has no absolute repository in its run.json.")));
    };
    pinned["repo"] = json!(repo);
    let args = args::parse(&pinned).map_err(GatewayError)?;
    if let Some(done) = journal.read_value("result.json") {
        if rerun.is_some() {
            return Err(GatewayError(format!("Run {id} has finished; there is nothing to run again.")));
        }
        let exit = finish_result(&mut journal, &args, id, done);
        drop(lock);
        return exit;
    }
    if let Some(step) = rerun {
        let last = journal.last_event().cloned().unwrap_or(Value::Null);
        if last["kind"] != json!("stop") || last["step"] != json!(step) {
            return Err(GatewayError(format!("--rerun names the step the run stopped at ({}); {step:?} is not it.", last["step"].as_str().unwrap_or("none: the run did not stop at a step"))));
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }
    let repo = PathBuf::from(&args.repo);
    let cfg = Config::new(Some(&repo))?;
    let git = Git::new(&repo);
    let brief_file = journal.file("brief.md");
    let missing = |path: &Path| {
        std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    };
    // A child can be cut after the journal was created, before it wrote its context.
    if journal.events().is_empty() && missing(&brief_file) && missing(&journal.file("initialized")) {
        restore_child_context(&journal, &run, &git, id)?;
    }
    let brief = std::fs::read_to_string(&brief_file).map_err(|e| GatewayError(format!("The brief of run {id} ({}) cannot be read: {e}", brief_file.display())))?;
    let review_md = if run["inputs"]["reviewMd"] == json!(true) {
        let file = journal.file("REVIEW.base.md");
        Some(std::fs::read_to_string(&file).map_err(|e| GatewayError(format!("The base REVIEW.md of run {id} ({}) cannot be read: {e}; the review would lose the owner's criteria.", file.display())))?)
    } else {
        None
    };
    let r = Run::new(id.to_string(), args, cfg, git, journal, &run, brief, review_md)?;
    let exit = r.machine();
    drop(lock);
    exit
}

// ------------------------------------------------------------------------------------------------- the machine

impl Run {
    #[allow(clippy::too_many_arguments)]
    fn new(id: String, args: Args, cfg: Config, git: Git, journal: Journal, run: &Value, brief: String, review_md: Option<String>) -> Result<Run> {
        let base = run["base"].as_str().unwrap_or("").to_string();
        let seed = run["seed"].as_str().unwrap_or(&base).to_string();
        let history = run["history"].clone();
        let writer = Pick::from_json(&run["pair"][args.writer_role()]);
        let reviewer = Pick::from_json(&run["pair"]["reviewer"]);
        let mut out = Map::new();
        out.insert("label".into(), json!(args.label));
        out.insert("mode".into(), json!(args.mode()));
        out.insert("workflow".into(), json!(WORKFLOW));
        out.insert("version".into(), json!(VERSION));
        out.insert("runId".into(), json!(id));
        out.insert("journal".into(), json!(journal.dir.display().to_string()));
        out.insert("base".into(), json!(base));
        if let Some(screening) = run.get("screening") {
            out.insert("screening".into(), screening.clone());
        }
        if let Some(source) = &args.source_run {
            out.insert("sourceRun".into(), json!(source));
            out.insert("seed".into(), json!(seed));
        }
        out.insert("models".into(), json!({ (args.writer_role()): writer.to_json(), models::REVIEWER_ROLE: reviewer.to_json() }));
        out.insert("skipped".into(), run["pair"]["skipped"].clone());
        out.insert("rounds".into(), json!([]));
        out.insert("openFindings".into(), json!([]));
        out.insert("verifiedBy".into(), json!("none"));
        let check_paths = checks::ProjectPaths::new(&cfg.home, &git)?;
        let (git, project, branch) = if args.isolated {
            let stage = candidate_workspace(&cfg.home, &id);
            out.insert("workspace".into(), json!(stage));
            out.insert("targetBranch".into(), run["branch"].clone());
            (Git::new(&stage), Some(git), candidate::BRANCH.to_string())
        } else {
            (git, None, run["branch"].as_str().unwrap_or("").to_string())
        };
        let verify_plan = crate::verify::Plan::from_run(run, &args)?;
        let allowed_input_digests = match run["inputs"].get("allowInputLines") {
            Some(value) => input_allowance_digests(value.as_array()
                .ok_or_else(|| GatewayError("The journal has invalid input line allowances.".into()))?)?,
            None => HashSet::new(),
        };
        Ok(Run {
            claims_dir: claims::claims_dir(&args.repo_norm),
            claimed: args.files.clone(),
            head: seed.clone(),
            branch,
            patch_schema: if run["patchSchema"] == json!(2) { PATCH_SCHEMA_V2 } else { PATCH_SCHEMA_V1 },
            verify_plan, check_paths, allowed_input_digests,
            browser: run["browser"].clone(),
            id, args, cfg, git, project, journal, base, seed, history, brief, review_md, writer, reviewer, out,
            review_number: 0,
            gaps: vec![],
            keep_claim: false,
            claim_status: "stopped",
            questions: vec![],
            changed: vec![],
            exec: vec![],
            step: "gate".into(),
        })
    }

    fn machine(mut self) -> Result<Exit> {
        self.step = "claim".into();
        let conflicts = match self.claim() {
            Ok(c) => c,
            Err(e) => {
                self.halt_infra("claim", "infrastructure at claim".to_string(), e.0);
                return Ok(exit_of(Value::Object(self.out)));
            }
        };
        if !conflicts.is_empty() {
            self.out.insert("conflicts".into(), json!(conflicts));
            self.out.insert("refused".into(), json!(format!("Open packages claim the same files: {}. Finish them, or close a stale one (status \"closed\" in {}).", conflicts.join("; "), self.claims_dir.display())));
            return self.finish(false);
        }
        if let Some(project) = &self.project {
            let prepared = if !self.git.root.exists() && self.journal.events().iter().any(|e| e["effect"] == "apply patch") {
                fail("The private checkout is missing. Recover it before continuing this run.")
            } else {
                candidate::prepare(project, &self.git, &self.seed)
            };
            if self.infra("private checkout", prepared).is_err() {
                return self.finish(false);
            }
        }
        // A halt has written its reason into the result already.
        let _ = self.body();
        let keep = self.keep_claim;
        self.finish(!keep)
    }

    /// Writes the result and then closes the claim (unless the run stops to be resumed). The result and the intent to
    /// close are in the journal before the claim changes, so a resume after a cut there returns the result and closes
    /// the claim, instead of reading its own closed claim as a conflict.
    fn finish(mut self, close: bool) -> Result<Exit> {
        if let Some(budget) = self.args.budget {
            self.out.insert("budget".into(), budget.report(self.journal.events()));
        }
        let open = self.out["openFindings"].as_array().map(|a| a.len()).unwrap_or(0);
        if open > 0 && !self.out.contains_key("next") {
            self.out.insert("next".into(), json!(format!("The last review left {open} finding(s) open (openFindings): close them with the writer, or decide on them.")));
        }
        if self.keep_claim {
            return Ok(exit_of(Value::Object(self.out)));
        }
        // The intent first: a cut before the saved result runs the machine again from the journal with the claim
        // still open; a cut after it finds both.
        let result = Value::Object(self.out);
        self.journal.append(json!({ "kind": "closing", "close": close, "status": self.claim_status }))?;
        self.journal.write_value("result.json", &result)?;
        crate::boundary::cut("result");
        finish_result(&mut self.journal, &self.args, &self.id, result)
    }

    fn claim(&mut self) -> Result<Vec<String>> {
        if let Some(done) = self.done("claim") {
            let conflicts = strings(&done["conflicts"]);
            let keys: Vec<String> = self.claimed.iter().map(|f| f.to_lowercase()).collect();
            if conflicts.is_empty() && !claims::holds(&self.claims_dir, &self.args.label, &self.id, &keys) {
                return Ok(vec![format!("{}: the claim is no longer the open claim of run {} (it was closed or taken over meanwhile)", self.args.label, self.id)]);
            }
            return Ok(conflicts);
        }
        let keys: Vec<String> = self.claimed.iter().map(|f| f.to_lowercase()).collect();
        let conflicts = claims::open(&self.claims_dir, &self.args.label, &self.id, &keys, &self.args.brief, &self.base)?;
        self.record_done("claim", 0, json!({ "conflicts": conflicts, "file": claims::file(&self.claims_dir, &self.args.label).display().to_string() }))?;
        Ok(conflicts)
    }

    fn body(&mut self) -> Step<()> {
        let write = WRITE.to_string();
        let patch = self.writer_turn("write", 0, &write, vec![], vec![], None)?;
        self.out.insert("write".into(), json!({
            "done": patch.status == "done", "summary": patch.summary, "changed": [], "unverified": patch.unverified, "questions": patch.questions,
        }));
        if patch.status != "done" {
            return self.stop_blocked("write", &patch);
        }
        self.apply_step("apply write", 0, &patch)?;
        self.set_changed();
        let mut summary = patch.summary.clone();
        let mut unverified = patch.unverified.clone();
        for n in 1..=self.args.rounds {
            let checks = self.checked(n)?;
            let evidence: Vec<Value> = checks["evidence"].as_array().cloned().unwrap_or_default();
            if checks["ok"] != json!(true) {
                if let (Some(project), Some(tree)) = (&self.project, checks["tree"].as_str()) {
                    let pin = candidate::pin(project, &self.git, &self.id, n, &self.base, tree, &self.args.label);
                    let retained = self.infra("pin candidate", pin)?;
                    self.out.insert("candidate".into(), retained);
                }
                let first = evidence.iter().find(|e| e["exitCode"] != json!(0)).cloned().unwrap_or(Value::Null);
                let verification = json!({ "verifiedBy": "none", "evidence": evidence, "note": format!("not verified by running: the checks of round {n} failed"), "stamp": "Verified: none" });
                self.push_round(json!({ "n": n, "checks": checks }));
                self.out.insert("verifiedBy".into(), json!("none"));
                self.out.insert("verification".into(), verification);
                let failed = format!("{} exit {}", first["source"].as_str().unwrap_or("?"), if first["exitCode"].is_null() { "none".to_string() } else { first["exitCode"].to_string() });
                self.out.insert("stoppedAt".into(), json!(if checks["noProgress"] == true { format!("checks (same failure on unchanged candidate: {failed})") } else { format!("checks ({failed})") }));
                self.out.insert("next".into(), json!(format!("The checks failed after the change and the writer's fixes ({}): see the logs in verification.evidence. Nothing of round {n} was committed; the work stays in the work tree. Fix it, or decide that the check is flaky (args.allowCheckChanges).", failed)));
                return Err(Halt);
            }
            let verification = verification(&checks, !self.verify_plan.verify.is_empty(), !self.verify_plan.checks.is_empty());
            self.out.insert("verifiedBy".into(), verification["verifiedBy"].clone());
            self.out.insert("verification".into(), verification.clone());
            let mut receipt = self.commit(n, &checks, verification["stamp"].as_str().unwrap_or("Verified: none"))?;
            let reviewed = if let Some(project) = &self.project {
                let tree = checks["tree"].as_str().expect("checked tree");
                let pin = candidate::pin(project, &self.git, &self.id, n, &self.base, tree, &self.args.label);
                let pinned = self.infra("pin candidate", pin)?;
                let commit = pinned["commit"].as_str().expect("pinned commit").to_string();
                receipt = json!({ "commit": commit, "tree": tree, "parent": self.base, "staging": receipt });
                self.out.insert("candidate".into(), pinned);
                commit
            } else {
                self.head.clone()
            };
            let RoundVerdict { review, findings, important, verdict } = self.review_round(&ReviewRound {
                n, candidate: &reviewed, summary: &summary, unverified: &unverified,
                verification: &verification, checks: &checks, commit: &receipt,
            })?;
            let word = review["verdict"].as_str().unwrap_or("");
            if verdict == "approved" {
                if self.verify_plan.full_in_ci {
                    self.out.insert("fullVerification".into(), json!({ "status": "pending_ci" }));
                }
                if !self.verify_plan.full_local.is_empty() {
                    let tree = checks["tree"].as_str().expect("checked tree");
                    let full = self.run_checks("verify full", n, Some(tree))?;
                    let passed = full["ok"] == json!(true);
                    self.out.insert("fullVerification".into(), json!({ "status": if passed { "passed" } else { "failed" }, "evidence": full["evidence"], "tree": tree }));
                    if !passed {
                        self.out.insert("verdict".into(), json!("blocked"));
                        self.out.insert("stoppedAt".into(), json!("verify full"));
                        self.out.insert("next".into(), json!("Review the full verification evidence. The checked commit remains local."));
                        return Err(Halt);
                    }
                }
                self.out.insert("approved".into(), json!(true));
                self.claim_status = "done";
                if !findings.is_empty() {
                    self.out.insert("next".into(), json!(format!("Approved with {} open finding(s) in openFindings (none is important): read them and decide, or close them in a new package.", findings.len())));
                }
                if self.args.isolated {
                    self.out.insert("application".into(), json!({ "status": "pending", "command": format!("zodchi flow apply {}", self.id) }));
                }
                return Ok(());
            }
            if verdict == "blocked" {
                let stopped_at = if word == "blocked" { "review verdict blocked" } else { "review verdict changes_requested without findings" };
                self.out.insert("stoppedAt".into(), json!(stopped_at));
                self.out.insert("question".into(), json!(format!("The reviewer could not approve or name what to change ({word}): {} See {}.", review["summary"].as_str().unwrap_or(""), review["reviewFile"].as_str().unwrap_or(""))));
                return Err(Halt);
            }
            if n == self.args.rounds {
                self.out.insert("stoppedAt".into(), json!(format!("stop rule: {} review rounds without approval", self.args.rounds)));
                self.out.insert("question".into(), json!(format!("The package has important findings after {} rounds: {}. Decide: accept as is, change the brief, or start again with another writer.", self.args.rounds, important.join(" | "))));
                return Err(Halt);
            }
            let step = format!("close {n}");
            let review_number = self.review_number;
            let vars = vec![("round", review_number.to_string()), ("findings", important.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n"))];
            let review_file = std::fs::read(review["reviewFile"].as_str().unwrap_or("")).unwrap_or_default();
            let fix = self.writer_turn(&step, n, CLOSE, vars, vec![(format!("review-{review_number}.json"), review_file)], None)?;
            if fix.status != "done" {
                return self.stop_blocked(&step, &fix);
            }
            self.apply_step(&format!("apply {step}"), n, &fix)?;
            self.set_changed();
            summary = format!("{summary} | round {n} fixes: {}", fix.summary);
            if !fix.unverified.is_empty() {
                unverified = fix.unverified.clone();
            }
            if let Some(w) = self.out.get_mut("write") {
                w["summary"] = json!(summary);
                w["unverified"] = json!(unverified);
            }
        }
        Ok(())
    }

    fn stop_blocked<T>(&mut self, step: &str, patch: &Patch) -> Step<T> {
        self.out.insert("stoppedAt".into(), json!(if step == "write" { "write".to_string() } else { step.split(' ').next().unwrap_or(step).to_string() }));
        let q = if patch.questions.is_empty() { patch.summary.clone() } else { patch.questions.join(" | ") };
        self.out.insert("question".into(), json!(q));
        if self.args.agent {
            let checks = self.journal.events().iter().filter(|event| event["kind"] == "done" && event["step"] == self.step
                && event["attempt"].as_u64() == Some(u64::from(self.attempt(&self.step))))
                .flat_map(|event| event["result"]["checks"].as_array().into_iter().flatten())
                .filter(|check| check["exitCode"].as_i64().is_some_and(|code| code != 0));
            for check in checks {
                let result = check["result"].as_str().unwrap_or("");
                let hint = if result.contains("ERR_MODULE_NOT_FOUND") {
                    Some("A recorded writer check reported ERR_MODULE_NOT_FOUND. Install the project's Node dependencies using its configured setup, then reply to the blocked writer before resuming, or use the candidate acceptance runner.")
                } else if result.lines().any(|line| line.split_once("browserType.launch:")
                    .is_some_and(|(_, diagnostic)| diagnostic.trim_start().starts_with("Executable doesn't exist at "))) {
                    Some("A recorded writer check reports a missing browser executable. Restore the configured executable, then reply to the blocked writer before resuming, or use the candidate acceptance runner.")
                } else { None };
                if let Some(hint) = hint {
                    self.out.insert("prerequisiteHint".into(), json!(hint));
                    break;
                }
            }
        }
        self.out.insert("status".into(), json!("waiting"));
        self.keep_claim = true;
        let waiting_step = if self.args.agent { self.step.clone() } else { step.to_string() };
        let step = waiting_step.as_str();
        let attempt = self.attempt(step);
        if self.journal.last("waiting", step, attempt).is_none() {
            let event = self.journal.append(json!({ "kind": "waiting", "step": step, "attempt": attempt, "question": q }));
            self.infra(step, event)?;
        }
        Err(Halt)
    }

    fn scope_decision<T>(&mut self, step: &str, writer_step: &str, paths: &[String]) -> Step<T> {
        let question = format!("Allow the writer to also change {}?", paths.join(", "));
        self.out.insert("outsideClaim".into(), json!(paths));
        self.out.insert("stoppedAt".into(), json!(format!("patch outside the claim at {step}")));
        self.out.insert("status".into(), json!("waiting"));
        self.out.insert("question".into(), json!(question));
        self.keep_claim = true;
        let attempt = self.attempt(step);
        let already_waiting = self.journal.last_event().is_some_and(|event|
            event["kind"] == "waiting" && event["step"] == step && event["scope"] == json!(paths));
        if !already_waiting {
            let event = self.journal.append(json!({
                "kind": "waiting", "step": step, "writerStep": writer_step, "attempt": attempt,
                "question": question, "scope": paths,
            }));
            self.infra(step, event)?;
        }
        Err(Halt)
    }

    fn approved_paths(&self, step: &str) -> Vec<String> {
        self.journal.all("scope allowed", step, self.attempt(step)).into_iter()
            .flat_map(|approval| strings(&approval["files"])).collect()
    }

    fn push_round(&mut self, round: Value) {
        if let Some(Value::Array(list)) = self.out.get_mut("rounds") {
            if let Some(last) = list.last_mut() {
                if last["n"] == round["n"] {
                    *last = round;
                    return;
                }
            }
            list.push(round);
        }
    }

    fn set_changed(&mut self) {
        let root = if self.args.isolated { self.git.root.to_string_lossy() } else { self.args.repo_norm.as_str().into() };
        let abs: Vec<String> = self.changed.iter().map(|p| format!("{root}/{p}")).collect();
        if let Some(w) = self.out.get_mut("write") {
            w["changed"] = json!(abs);
        }
        if !self.questions.is_empty() {
            self.out.insert("questions".into(), json!(self.questions));
        }
    }

    // --------------------------------------------------------------------------------------------- journal helpers

    fn attempt(&self, step: &str) -> u32 {
        self.journal.attempt(step)
    }

    fn done(&self, step: &str) -> Option<Value> {
        self.journal.last("done", step, self.attempt(step)).map(|e| e["result"].clone())
    }

    fn record_done(&mut self, step: &str, round: u32, result: Value) -> Result<()> {
        let attempt = self.attempt(step);
        self.journal.append(json!({ "kind": "done", "step": step, "round": round, "attempt": attempt, "result": result }))
    }

    fn record_intent(&mut self, step: &str, round: u32, effect: &str, digest: &str, extra: Value) -> Result<()> {
        let attempt = self.attempt(step);
        let mut e = json!({ "kind": "intent", "step": step, "round": round, "attempt": attempt, "effect": effect, "digest": digest });
        if let (Some(m), Some(x)) = (e.as_object_mut(), extra.as_object()) {
            for (k, v) in x {
                m.insert(k.clone(), v.clone());
            }
        }
        self.journal.append(e)
    }

    /// A stop the run can be resumed from: the claim stays open; `next` says how to go on.
    fn halt_infra(&mut self, step: &str, stopped_at: String, what: String) {
        self.keep_claim = true;
        let attempt = self.attempt(step);
        let _ = self.journal.append(json!({ "kind": "stop", "step": step, "attempt": attempt, "stoppedAt": stopped_at, "what": what }));
        let claim = claims::file(&self.claims_dir, &self.args.label);
        let next = if stopped_at.starts_with("unknown outcome") {
            format!("Neither the journal, Git nor the gateway can settle whether {step} took effect ({what}). Look at it; when you are sure, run it again under a new key: zodchi flow code-package --resume {} --rerun \"{step}\". The claim {} stays open meanwhile.", self.id, claim.display())
        } else {
            format!("Fix the cause, then resume: zodchi flow code-package --resume {} (it polls what was submitted), or with --rerun \"{step}\" to run that step again under a new key. The claim {} stays open meanwhile.", self.id, claim.display())
        };
        self.out.insert("stoppedAt".into(), json!(stopped_at));
        self.out.insert("infra".into(), json!(what));
        self.out.insert("next".into(), json!(next));
    }

    /// Turns an error of a step into a resumable stop.
    fn infra<T>(&mut self, step: &str, r: Result<T>) -> Step<T> {
        r.map_err(|e| {
            self.halt_infra(step, format!("infrastructure at {step}"), e.0);
            Halt
        })
    }

    fn stop_screening<T>(&mut self, step: &str, description: &str, locations: &[String]) -> Step<T> {
        self.out.insert("verdict".into(), json!("blocked"));
        self.out.insert("stoppedAt".into(), json!(format!("privacy screening at {step}")));
        self.out.insert("question".into(), json!(format!(
            "{description}: {}. Can you remove the marked material and start a new package?",
            locations.join(", "),
        )));
        Err(Halt)
    }

    // --------------------------------------------------------------------------------------------- model calls

    fn withheld_brief(&self, scrubber: &Scrubber) -> Vec<String> {
        let withheld = withheld_input_lines(scrubber, self.brief.as_bytes(), &self.allowed_input_digests);
        input_locations("the brief", "", withheld).collect()
    }

    /// The claimed paths and current blob IDs, editable attachments, and any omissions that block sending them.
    fn files_view(&self, scrubber: &Scrubber, failed_tree: Option<&str>) -> Result<(String, Attachments, Vec<String>)> {
        let mut lines = Vec::new();
        let mut attached = Vec::new();
        let mut omissions = Vec::new();
        for (index, p) in self.claimed.iter().enumerate() {
            if let Some((_, reason)) = scrubber.input_withholdings(p).next() {
                omissions.push(format!("claimed file #{} (file name, {})", index + 1, reason.reason()));
                continue;
            }
            match std::fs::read(writer_worktree_path(&self.git, &self.head, p)?) {
                Ok(bytes) => {
                    let withheld = if bytes.contains(&0) {
                        Vec::new()
                    } else {
                        withheld_input_lines(scrubber, &bytes, &self.allowed_input_digests)
                    };
                    let blob = self.git.blob_of(&bytes)?;
                    let (bytes, note) = if withheld.is_empty() {
                        (bytes, "")
                    } else {
                        // A fix can use a screened preview of the exact file whose check failed.
                        let matches_failed_tree = match failed_tree {
                            Some(tree) => self.git.entry_at(tree, p)?.is_some_and(|(mode, kind, id)| {
                                mode.starts_with("100") && kind == "blob" && id == blob
                            }),
                            None => false,
                        };
                        if !matches_failed_tree {
                            omissions.extend(input_locations(p, "", withheld));
                            continue;
                        }
                        let preview = Scrubber::redact_lines(&String::from_utf8_lossy(&bytes), &withheld);
                        (preview.into_bytes(), " (screened preview. Use only visible text in exact old fragments. \
                            Give complete replacement content to remove or replace withheld lines.)")
                    };
                    lines.push(writer_file_line(p, Some(&blob), note));
                    attached.push((p.clone(), bytes));
                }
                Err(_) => lines.push(writer_file_line(p, None, "")),
            }
        }
        Ok((lines.join("\n"), attached, omissions))
    }

    /// The private folders a check's output may name, each with the word a model sees instead.
    fn private_places(&self) -> Vec<(String, &'static str)> {
        private_places(&self.cfg, &self.args, &self.journal.dir, &self.check_paths, &self.browser)
    }

    /// One writer turn: the prompt from its template, the brief, the claimed files and `extra` attachments; the
    /// answer is a patch by this version's schema.
    fn writer_turn(&mut self, step: &str, round: u32, template: &str, vars: Vec<(&str, String)>, mut extra: Vec<(String, Vec<u8>)>, failed_tree: Option<&str>) -> Step<Patch> {
        self.step = step.to_string();
        if step == "write" && self.history.is_object() {
            extra.push(("previous-package.json".into(), self.history.to_string().into_bytes()));
        }
        if self.args.agent {
            return self.agent_turn(step, round, vars, extra);
        }
        // A recorded answer or request is replayed or polled before anything is read from the live work tree.
        let attempt = self.attempt(step);
        let recorded = self.done(step).is_some() || !self.journal.all("intent", step, attempt).is_empty();
        let built = if recorded {
            Ok(ScreenedPrompt::Prompt(String::new()))
        } else {
            (|| -> Result<ScreenedPrompt> {
                let scrubber = Scrubber::new(&self.cfg)?;
                let places = self.private_places();
                let (files, attached, mut omissions) = self.files_view(&scrubber, failed_tree)?;
                omissions.extend(self.withheld_brief(&scrubber));
                if !omissions.is_empty() {
                    return Ok(ScreenedPrompt::Withheld(omissions));
                }
                let text = expert_preamble(template, step, &self.id, files, &check_rules(&self.args, &self.verify_plan), vars);
                let brief = input_attachment(&self.brief, &places);
                let mut attachments = vec![("brief".to_string(), brief)];
                attachments.extend(extra);
                attachments.extend(attached);
                compose_prompt(&text, &attachments).map(ScreenedPrompt::Prompt)
            })()
        };
        let prompt = match built {
            Ok(ScreenedPrompt::Prompt(prompt)) => prompt,
            Ok(ScreenedPrompt::Withheld(locations)) => {
                return self.stop_screening(step, "The brief or claimed working files contain material that would be withheld", &locations);
            }
            Err(e) => {
                // A binary claimed file cannot be shown to the expert.
                self.out.insert("stoppedAt".into(), json!(format!("context at {step}: {e}")));
                return Err(Halt);
            }
        };
        let writer = self.writer.clone();
        let data = self.ask(step, round, WRITER_GATEWAY_ROLE, &writer, &schema(self.patch_schema), prompt, None, |v| patch::parse(v).map(|_| ()))?;
        let p = patch::parse(&data).expect("validated");
        for q in &p.questions {
            if !self.questions.contains(q) {
                self.questions.push(q.clone());
            }
        }
        if !self.questions.is_empty() {
            self.out.insert("questions".into(), json!(self.questions));
        }
        Ok(p)
    }

    fn writer_snapshot(&mut self, step: &str, round: u32) -> Step<Value> {
        if let Some(saved) = self.journal.last("writer prepared", step, 1) {
            return Ok(saved["snapshot"].clone());
        }
        self.owns(step)?;
        let setup_step = format!("setup {step}");
        let has_setup = !self.verify_plan.setup.is_empty();
        if has_setup {
            if let Some(failure) = self.done(&setup_step) {
                return self.stop_writer_setup(&setup_step, failure);
            }
        }
        let id = format!("{}-{:08x}", gateway::slug(step), rand::random::<u32>());
        let workspace = self.cfg.home.join("flow-writers").join(&self.id).join(id);
        let scratch = self.journal.file("tmp");
        let prepared = agent::prepare(&self.git, &workspace, &self.head, &self.claimed, &self.exec, &scratch);
        let prepared = self.infra(step, prepared)?;
        let mut event = json!({ "kind": "writer prepared", "step": step, "round": round, "attempt": 1, "snapshot": prepared });
        if has_setup {
            // One receipt admits both the snapshot and the setup. A continuation only reuses a prepared workspace.
            event["setup"] = self.run_writer_setup(&setup_step, round, &workspace, &prepared["tree"])?;
        }
        let recorded = self.journal.append(event);
        self.infra(step, recorded)?;
        Ok(prepared)
    }

    fn run_writer_setup(&mut self, step: &str, round: u32, workspace: &Path, tree: &Value) -> Step<Value> {
        let git = Git::new(workspace);
        let baseline = self.infra(step, git.rev("HEAD"))?;
        let attempt = self.attempt(step);
        let slot = checks::CheckSlot::acquire(&self.cfg.home, &mut self.journal, step, attempt);
        let mut slot = self.infra(step, slot)?;
        self.reap_checks(step)?;
        let env_cache = self.check_paths.create_env_cache(&self.verify_plan.project.env);
        self.infra(step, env_cache)?;
        let writer_cache = agent::create_writer_cache(&self.verify_plan.writer);
        self.infra(step, writer_cache)?;
        let start = self.journal.events().iter().filter(|e| e["kind"] == "intent" && e["step"] == step).count() + 1;
        let logs = self.journal.file(&format!("logs/{}-{start}", gateway::slug(step)));
        let intended = self.record_intent(step, round, "run writer setup", &sha256_hex(tree.to_string()),
            json!({ "tree": tree, "workspace": workspace, "logs": logs }));
        self.infra(step, intended)?;
        let limit = Duration::from_secs_f64(self.args.check_timeout_min * 60.0);
        let journal = &mut self.journal;
        let mut on = |phase, pid, job: Option<&str>| slot.record(journal, step, attempt, phase, pid, job);
        let setup_env = self.verify_plan.setup_environment();
        let environment = checks::CommandEnvironment { repo: None, extra: Some(&setup_env) };
        let (evidence, recorded) = checks::run_commands(
            &self.verify_plan.setup, self.verify_plan.setup_source, workspace, &logs, limit, &environment, true, &mut on);
        if !recorded {
            return self.infra(step, fail("The journal could not record the start or the end of a writer setup command."));
        }
        let workspace_clean = || -> Result<()> {
            if git.rev("HEAD")? != baseline {
                return fail("Writer setup moved the workspace HEAD.");
            }
            let paths = git.dirty()?;
            if !paths.is_empty() {
                return fail(format!("Writer setup must leave tracked files unchanged and write generated files to ignored paths. Git reports {} changed or unignored path(s), including {}.",
                    paths.len(), paths.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
            }
            Ok(())
        };
        let why = if let Some((i, failed)) = evidence.iter().enumerate().find(|(_, e)| e["exitCode"] != 0) {
            let exit = failed["exitCode"].as_i64().map(|code| format!("exit {code}")).unwrap_or_else(|| {
                failed["note"].as_str().filter(|s| !s.is_empty()).unwrap_or("no exit status").to_string()
            });
            Some(format!("{} failed ({exit}). See {}.", checks::name(&evidence, i), failed["log"].as_str().unwrap_or("the setup log")))
        } else {
            workspace_clean().err().map(|error| error.0)
        };
        let result = json!({ "ok": why.is_none(), "step": step, "attempt": attempt, "evidence": evidence, "why": why });
        if why.is_some() {
            let saved = self.record_done(step, round, result.clone());
            self.infra(step, saved)?;
            return self.stop_writer_setup(step, result);
        }
        Ok(result)
    }

    fn stop_writer_setup(&mut self, step: &str, failure: Value) -> Step<Value> {
        let why = failure["why"].as_str().unwrap_or("See the writer setup evidence.").to_string();
        self.halt_infra(step, format!("writer setup failed ({step})"), why);
        self.out.insert("setupFailure".into(), failure);
        self.out.insert("next".into(), json!(format!("Fix the environment, then run zodchi flow code-package --resume {} --rerun \"{step}\". Start a new run to change its pinned commands.", self.id)));
        Err(Halt)
    }

    fn agent_turn(&mut self, step: &str, round: u32, vars: Vec<(&str, String)>, extra: Vec<(String, Vec<u8>)>) -> Step<Patch> {
        let apply_step = format!("apply {step}");
        let applied = self.done(&apply_step).is_some();
        let snapshot = self.writer_snapshot(step, round)?;
        let root = if applied {
            PathBuf::new()
        } else {
            let root = agent::workspace(&snapshot);
            self.infra(step, root)?
        };
        let writer = self.writer.clone();
        let output_schema = schema(agent::SCHEMA);
        let mut allowed = self.claimed.clone();
        allowed.extend(self.approved_paths(&apply_step));
        let boundary = agent_boundary(&allowed);
        let notes = vars.into_iter().map(|(_, note)| note).collect::<Vec<_>>().join("\n\n");
        let mut previous_summary: Option<String> = None;
        let continuations = if self.args.budget.is_some() { u32::MAX } else { self.args.continuations };
        for n in 0..=continuations {
            let turn = if n == 0 { step.to_string() } else { format!("{step} continue {n}") };
            let attempt = self.attempt(&turn);
            let prompt = if self.done(&turn).is_some() || !self.journal.all("intent", &turn, attempt).is_empty() {
                String::new()
            } else {
                if attempt > 1 {
                    if let Some(summary) = self.journal.last("done", &turn, attempt - 1)
                        .and_then(|done| done["result"]["summary"].as_str())
                    {
                        previous_summary = Some(summary.to_string());
                    }
                }
                let mut preamble = agent_preamble(
                    &turn, &self.id, &boundary, &check_rules(&self.args, &self.verify_plan), &notes,
                    !self.verify_plan.setup.is_empty(), &self.browser,
                );
                if n > 0 || attempt > 1 {
                    preamble.push_str("\n\nContinue the writer's work in this same private workspace. Inspect its current files and preserve edits that are already complete.");
                }
                let scrubber = Scrubber::new(&self.cfg);
                let scrubber = self.infra(&turn, scrubber)?;
                let places = self.private_places();
                if let Some(summary) = &previous_summary {
                    preamble.push_str("\n\nPrevious writer summary (work status):\n");
                    preamble.push_str(&scrubber.text(summary, &places));
                }
                let omissions = self.withheld_brief(&scrubber);
                if !omissions.is_empty() {
                    return self.stop_screening(&turn, "The brief contains material that would be withheld", &omissions);
                }
                let brief = input_attachment(&self.brief, &places);
                let mut attachments = vec![("brief".into(), brief)];
                attachments.extend(extra.iter().cloned());
                let prompt = compose_prompt(&preamble, &attachments);
                self.infra(&turn, prompt)?
            };
            let data = self.ask(&turn, round, agent::ROLE, &writer, &output_schema, prompt,
                Some(&root), agent::validate)?;
            let mut questions: Vec<String> = data["questions"].as_array().into_iter().flatten().filter_map(|q| {
                let text = q["text"].as_str()?;
                let options = strings(&q["options"]);
                Some(if options.is_empty() { text.to_string() } else { format!("{text}\n{}", options.join("\n")) })
            }).collect();
            let summary = data["summary"].as_str().unwrap_or("").to_string();
            let status = data["status"].as_str().unwrap_or("");
            if status == "more" && questions.is_empty() && n < continuations {
                previous_summary = Some(summary);
                continue;
            }
            let mut changes = Vec::new();
            if status == "done" && questions.is_empty() && !applied {
                let observed = agent::changes(&root, &self.git, &snapshot, &allowed);
                match self.infra(&turn, observed)? {
                    agent::Changes::Scoped(scoped) => changes = scoped,
                    agent::Changes::Outside(paths) => return self.scope_decision(&apply_step, &turn, &paths),
                }
            }
            if status == "more" && questions.is_empty() {
                questions.push("The writer reached its continuation limit. Decide whether to give it another turn.".into());
            }
            for question in &questions {
                if !self.questions.contains(question) {
                    self.questions.push(question.clone());
                }
            }
            if !self.questions.is_empty() {
                self.out.insert("questions".into(), json!(self.questions));
            }
            let done = status == "done" && questions.is_empty();
            return Ok(Patch { status: if done { "done" } else { "blocked" }.into(), summary, changes, unverified: vec![], questions });
        }
        unreachable!("the last writer turn always returns")
    }

    #[allow(clippy::too_many_arguments)]
    fn ask(&mut self, step: &str, round: u32, role: &str, pick: &Pick, schema: &Value, prompt: String, writer_workspace: Option<&Path>, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> Step<Value> {
        self.step = step.to_string();
        let call = gateway::Call { id: &self.id, step, round, role, pick, schema, prompt, writer_workspace };
        let browser = if writer_workspace.is_some() { Some(&self.browser) } else { None };
        let owner_private_places: Vec<_> = ["configuredPath", "path"].into_iter()
            .filter_map(|key| self.browser[key].as_str().filter(|path| !path.is_empty()))
            .map(|path| (path.to_string(), "<browser>"))
            .collect();
        let result = gateway::ask_budgeted(&mut self.journal, &self.cfg, call, self.args.budget, browser, &owner_private_places, validate);
        self.call_result(step, result)
    }

    fn call_result(&mut self, step: &str, result: std::result::Result<Value, gateway::CallError>) -> Step<Value> {
        match result {
            Ok(data) => Ok(data),
            Err(gateway::CallError::Stop { at, reason }) if at == format!("budget at {step}") => {
                self.keep_claim = true;
                self.out.insert("stoppedAt".into(), json!(at));
                self.out.insert("status".into(), json!("waiting"));
                self.out.insert("question".into(), json!(reason));
                self.out.insert("next".into(), json!(format!("Extend the budget with zodchi flow budget {} --add-calls <n> or --add-minutes <n>, then resume.", self.id)));
                if !self.journal.last_event().is_some_and(|e| e["kind"] == "waiting" && e["reason"] == "budget" && e["step"] == step) {
                    let record = self.journal.append(json!({ "kind": "waiting", "step": step, "reason": "budget", "question": reason }));
                    self.infra(step, record)?;
                }
                Err(Halt)
            }
            Err(gateway::CallError::Stop { at, reason }) if at == format!("provider safety at {step}") => {
                self.out.insert("verdict".into(), json!("blocked"));
                self.out.insert("stoppedAt".into(), json!(at));
                self.out.insert("reason".into(), json!(reason));
                Err(Halt)
            }
            Err(gateway::CallError::Stop { at, reason }) => {
                self.halt_infra(step, at, reason);
                Err(Halt)
            }
            Err(gateway::CallError::Context { bytes }) => {
                self.out.insert("stoppedAt".into(), json!(format!("context too large at {step}")));
                self.out.insert("next".into(), json!(format!("The request of {step} is {} KB with its required attachments, over the gateway's {} KB: split the package or claim fewer files. Nothing was submitted.", bytes / 1024, LIMIT_PROMPT / 1024)));
                Err(Halt)
            }
        }
    }

    // --------------------------------------------------------------------------------------------- apply

    fn apply_step(&mut self, step: &str, round: u32, p: &Patch) -> Step<()> {
        self.step = step.to_string();
        if let Some(done) = self.done(step) {
            return self.replay_apply(step, &done);
        }
        let attempt = self.attempt(step);
        if let Some(intent) = self.journal.last("intent", step, attempt).cloned() {
            // The saved plan must be the one the intent names, whole: a lost plan is never read as an empty patch.
            let file = intent["plan"].as_str().unwrap_or("").to_string();
            let plan = self.journal.read_value(&file).and_then(|v| patch::Plan::from_json(&v))
                .filter(|p| sha256_hex(p.to_json().to_string()) == intent["digest"].as_str().unwrap_or(""));
            let Some(plan) = plan else {
                self.halt_infra(step, format!("unknown outcome at {step}"), format!("the saved plan {file} of the interrupted apply is missing or does not match the digest of its intent"));
                return Err(Halt);
            };
            for k in strings(&intent["claimAdded"]) {
                if patch::claimed_as(&self.claimed, &k).is_none() {
                    self.claimed.push(k);
                }
            }
            self.owns(step)?;
            let state = patch::reconcile(&self.git, &plan);
            match self.infra(step, state)? {
                "applied" => {}
                "partial" => {
                    let r = patch::apply(&self.git.root, &plan);
                    self.infra(step, r)?;
                }
                _ => {
                    self.halt_infra(step, format!("unknown outcome at {step}"), "a file of the patch is neither as before nor as after it; somebody else changed it".into());
                    return Err(Halt);
                }
            }
            let result = json!({ "paths": plan.after.keys().collect::<Vec<_>>(), "claimAdded": intent["claimAdded"], "exec": plan.exec });
            let r = self.record_done(step, round, result.clone());
            self.infra(step, r)?;
            return self.replay_apply(step, &result);
        }
        self.owns(step)?;
        // Outside the claim: refused, or the claim is extended under its lock before anything is written.
        let outside = patch::outside(p, &self.claimed);
        let mut added = Vec::new();
        if let Some(folder) = outside.iter().find(|o| plain_ok(o) && self.git.root.join(o.as_str()).is_dir()) {
            let r = self.record_done(step, round, json!({ "refused": "path", "why": format!("{folder} is a folder; a patch names files") }));
            self.infra(step, r)?;
            return self.replay_apply(step, &self.done(step).unwrap());
        }
        if !outside.is_empty() && p.changes.iter().all(|c| plain_ok(&c.path) && c.from.as_deref().is_none_or(plain_ok)) {
            let approval = self.approved_paths(step);
            if !self.args.extend_claim && !outside.iter().all(|path| patch::claimed_as(&approval, path).is_some()) {
                let requested: Vec<_> = outside.iter().filter(|path| patch::claimed_as(&approval, path).is_none()).cloned().collect();
                return self.scope_decision(step, step.strip_prefix("apply ").unwrap_or(step), &requested);
            }
            let keys: Vec<String> = outside.iter().map(|o| o.to_lowercase()).collect();
            let ext = claims::extend(&self.claims_dir, &self.args.label, &self.id, &keys);
            let conflicts = self.infra(step, ext)?;
            if !conflicts.is_empty() {
                let r = self.record_done(step, round, json!({ "refused": "conflict", "conflicts": conflicts }));
                self.infra(step, r)?;
                return self.replay_apply(step, &self.done(step).unwrap());
            }
            self.claimed.extend(outside.iter().cloned());
            added = outside;
        }
        let planned = patch::plan(&self.git, &self.args, &self.seed, p, &self.claimed);
        let planned = self.infra(step, planned)?;
        let plan = match planned {
            Ok(plan) => plan,
            Err(refusal) => {
                let result = match refusal {
                    Refusal::Outside(paths) => json!({ "refused": "outside", "paths": paths }),
                    Refusal::Protected(paths) => json!({ "refused": "protected", "paths": paths }),
                    Refusal::BadPath(why) => json!({ "refused": "path", "why": why }),
                    Refusal::Stale(why) => json!({ "refused": "stale", "why": why }),
                    Refusal::EditConflict(why) => json!({ "refused": "edit", "why": why }),
                };
                let r = self.record_done(step, round, merge(&result, &json!({ "claimAdded": added })));
                self.infra(step, r)?;
                return self.replay_apply(step, &self.done(step).unwrap());
            }
        };
        let file = format!("plans/{}.json", gateway::slug(step));
        let w = self.journal.write_value(&file, &plan.to_json());
        self.infra(step, w)?;
        let digest = sha256_hex(plan.to_json().to_string());
        let r = self.record_intent(step, round, "apply patch", &digest, json!({ "plan": file, "claimAdded": added }));
        self.infra(step, r)?;
        let a = patch::apply(&self.git.root, &plan);
        self.infra(step, a)?;
        crate::boundary::cut(step);
        let result = json!({ "paths": plan.after.keys().collect::<Vec<_>>(), "claimAdded": added, "exec": plan.exec });
        let r = self.record_done(step, round, result.clone());
        self.infra(step, r)?;
        self.replay_apply(step, &result)
    }

    /// Before a write into the work tree: the pinned branch is checked out, and the claim is still this run's open
    /// claim with every claimed file. A claim closed or taken over meanwhile stops the run; nothing is written.
    fn owns(&mut self, step: &str) -> Step<()> {
        let on = self.git.branch();
        let on = self.infra(step, on)?;
        if on.as_deref() != Some(self.branch.as_str()) {
            let what = format!("the run writes on {}, but {} is checked out: check it out again", self.branch, on.unwrap_or_else(|| "a detached HEAD".into()));
            self.halt_infra(step, format!("{step} (the branch of the run is not checked out)"), what);
            return Err(Halt);
        }
        let keys: Vec<String> = self.claimed.iter().map(|c| c.to_lowercase()).collect();
        if !claims::holds(&self.claims_dir, &self.args.label, &self.id, &keys) {
            self.out.insert("stoppedAt".into(), json!(format!("{step} (the claim is not open)")));
            self.out.insert("next".into(), json!(format!("The claim {} is no longer the open claim of this run with all its files (closed or taken over meanwhile). Nothing of {step} was written.", claims::file(&self.claims_dir, &self.args.label).display())));
            return Err(Halt);
        }
        Ok(())
    }

    /// The effect of a recorded apply on the run: its paths and claim extension, or its refusal.
    fn replay_apply(&mut self, step: &str, done: &Value) -> Step<()> {
        for k in strings(&done["claimAdded"]) {
            if patch::claimed_as(&self.claimed, &k).is_none() {
                self.claimed.push(k.clone());
            }
            let mut list: Vec<String> = self.out.get("claimAdded").map(strings).unwrap_or_default();
            if !list.contains(&k) {
                list.push(k);
                self.out.insert("claimAdded".into(), json!(list));
            }
        }
        for p in strings(&done["exec"]) {
            if !self.exec.contains(&p) {
                self.exec.push(p);
            }
        }
        let kind = done["refused"].as_str().unwrap_or("");
        if kind.is_empty() {
            for p in strings(&done["paths"]) {
                if !self.changed.contains(&p) {
                    self.changed.push(p);
                }
            }
            return Ok(());
        }
        let nothing = "Nothing of this patch was applied";
        let patch_note = format!("the patch is in the journal {}", self.journal.dir.display());
        match kind {
            "outside" => {
                let paths = strings(&done["paths"]);
                self.out.insert("outsideClaim".into(), json!(paths));
                self.out.insert("stoppedAt".into(), json!(format!("patch outside the claim at {step}")));
                self.out.insert("next".into(), json!(format!("The writer's patch names files outside the claim: {}. {nothing}; {patch_note}. Add them to args.files (or run with args.extendClaim true) and start a new run.", paths.join(", "))));
            }
            "conflict" => {
                let c = strings(&done["conflicts"]);
                self.out.insert("conflicts".into(), json!(c));
                self.out.insert("stoppedAt".into(), json!("claim conflict"));
                self.out.insert("next".into(), json!(format!("The patch needs files that another open package claims: {}. {nothing}; settle it with that package.", c.join("; "))));
            }
            "protected" => {
                let paths = strings(&done["paths"]);
                self.out.insert("protectedChanged".into(), json!(paths));
                self.out.insert("stoppedAt".into(), json!(format!("protected checks changed at {step}")));
                self.out.insert("next".into(), json!(format!("The patch changes or deletes existing checks: {}. A change must not edit the checks that judge it, so the package stopped before review. {nothing}; {patch_note}. If the change is right, start again with args.allowCheckChanges listing those paths.", paths.join(", "))));
            }
            _ => {
                let why = done["why"].as_str().unwrap_or("");
                self.out.insert("stoppedAt".into(), json!(format!("{} at {step}: {why}", if kind == "stale" { "stale patch" } else { "patch refused" })));
                self.out.insert("next".into(), json!(format!("{nothing}; {patch_note}.")));
            }
        }
        Err(Halt)
    }

    // --------------------------------------------------------------------------------------------- checks

    /// The checks of round n, and up to args.fixes fixes by the writer when they fail.
    fn checked(&mut self, n: u32) -> Step<Value> {
        let mut res = self.run_checks(&format!("checks {n}"), n, None)?;
        for f in 1..=self.args.fixes {
            if res["ok"] == json!(true) {
                break;
            }
            // The writer sees each failed command by its source and number, and the end of its log without the
            // private folders and without lines that may hold a credential; the raw logs stay in the journal.
            let evidence = res["evidence"].as_array().cloned().unwrap_or_default();
            let mut places = self.private_places();
            if let Some(export) = res["checkout"].as_str() {
                places.push((export.to_string(), "<tmp>"));
            }
            let failures: Vec<String> = evidence.iter().enumerate().filter(|(_, e)| e["exitCode"] != json!(0)).map(|(i, e)| {
                format!("{} exit {}{}\n```\n{}\n```", checks::name(&evidence, i),
                    if e["exitCode"].is_null() { "none".into() } else { e["exitCode"].to_string() },
                    e["note"].as_str().filter(|s| !s.is_empty()).map(|s| format!(" ({})", checks::sanitize(s, &places))).unwrap_or_default(),
                    checks::sanitize(&checks::tail(e["log"].as_str().unwrap_or(""), 8 * 1024), &places))
            }).collect();
            let step = format!("fix {n}.{f}");
            let fix = self.writer_turn(&step, n, FIX, vec![("failures", failures.join("\n\n"))], vec![], res["tree"].as_str())?;
            if fix.status != "done" {
                return self.stop_blocked(&step, &fix);
            }
            self.apply_step(&format!("apply {step}"), n, &fix)?;
            self.set_changed();
            let next = self.run_checks(&format!("checks {n}.{f}"), n, None)?;
            let failure_shape = |result: &Value| -> Vec<_> {
                let mut places = places.clone();
                if let Some(export) = result["checkout"].as_str() {
                    places.push((export.to_string(), "<tmp>"));
                }
                result["evidence"].as_array().into_iter().flatten().filter(|e| e["exitCode"] != 0)
                    .map(|e| (e["command"].clone(), e["exitCode"].clone(), checks::sanitize(&checks::tail(e["log"].as_str().unwrap_or(""), 8192), &places))).collect()
            };
            if self.args.budget.is_some() && next["ok"] == false && next["tree"].is_string()
                && next["tree"] == res["tree"] && failure_shape(&next) == failure_shape(&res)
            {
                res = next;
                res["noProgress"] = json!(true);
                break;
            }
            res = next;
        }
        Ok(res)
    }

    /// One run of the checks on the candidate tree: the parent commit with the claimed paths from the work tree,
    /// exported to the repository's shared check checkout. The cheap checks first, then verify once they pass.
    ///
    /// The candidate tree, whatever brought it into the work tree, must leave the protected checks of the base as they
    /// were (content, mode, existence), except those args.allowCheckChanges names; else the package stops before
    /// review. An interrupted attempt reuses its saved command results and continues in the same checkout when
    /// available. An uncertain result or a replaced checkout that pending commands need requires a new attempt.
    fn run_checks(&mut self, step: &str, round: u32, full_tree: Option<&str>) -> Step<Value> {
        self.step = step.to_string();
        if let Some(d) = self.done(step) {
            return self.checks_result(step, d);
        }
        let scratch = self.journal.file("tmp");
        let tree = match full_tree {
            Some(tree) => tree.to_string(),
            None => {
                let tree = self.git.candidate_tree(&self.head, &self.claimed, &self.exec, &scratch);
                self.infra(step, tree)?
            }
        };
        let changed = self.git.changes(&self.seed, &tree);
        let changed = self.infra(step, changed)?;
        let protected: Vec<String> = changed.into_iter()
            .filter(|(status, p)| (status != "A" || args::is_project_configuration(p))
                && is_protected(&self.args, p) && !self.args.allow_check_changes.contains(&p.to_lowercase()))
            .map(|(_, p)| p).collect();
        if !protected.is_empty() {
            let result = json!({ "ok": false, "tree": tree, "evidence": [], "refused": "protected", "paths": protected });
            let r = self.record_done(step, round, result.clone());
            self.infra(step, r)?;
            return self.checks_result(step, result);
        }
        let full = full_tree.is_some();
        let has_commands = if full { !self.verify_plan.full_local.is_empty() }
            else { !self.verify_plan.checks.is_empty() || !self.verify_plan.verify.is_empty() };
        if !has_commands {
            let result = json!({ "ok": true, "tree": tree, "evidence": [] });
            let r = self.record_done(step, round, result.clone());
            self.infra(step, r)?;
            return Ok(result);
        }
        let attempt = self.attempt(step);
        let slot = checks::CheckSlot::acquire(&self.cfg.home, &mut self.journal, step, attempt);
        let mut slot = self.infra(step, slot)?;
        self.reap_checks(step)?;
        let prior_runs = self.journal.events().iter().filter(|e| e["kind"] == "intent" && e["step"] == step
            && e["effect"] == "run checks" && e["attempt"] != attempt).count();
        let name = gateway::slug(step);
        let name = if prior_runs == 0 { name } else { format!("{name}-retry-{}", prior_runs + 1) };
        let logs = self.journal.file(&format!("logs/{name}"));
        let batch = checks::CheckBatch {
            step, round, attempt, tree: &tree, head: None, logs: &logs,
            limit: Duration::from_secs_f64(self.args.check_timeout_min * 60.0),
            environment: checks::CommandEnvironment {
                repo: Some(Path::new(&self.args.repo)),
                extra: Some(&self.verify_plan.project.env),
            },
            checks: if full { ("project.full", &self.verify_plan.full_local) } else {
                (self.verify_plan.check_source, &self.verify_plan.checks)
            },
            verify: (self.verify_plan.verify_source, if full { &[] } else { &self.verify_plan.verify }),
        };
        let run = batch.run(&mut slot, &mut self.journal, &self.check_paths, &self.verify_plan.project.cache,
            |staging| self.git.checkout_for_checks(&tree, staging));
        let (checkout, evidence) = match self.infra(step, run)? {
            checks::CheckOutcome::Finished { checkout, evidence } => (checkout, evidence),
            checks::CheckOutcome::Unknown(why) => {
                self.halt_infra(step, format!("unknown outcome at {step}"), why);
                return Err(Halt);
            }
        };
        let result = json!({ "ok": checks::passed(&evidence), "tree": tree, "checkout": checkout, "evidence": evidence });
        let r = self.record_done(step, round, result.clone());
        self.infra(step, r)?;
        crate::boundary::cut(step);
        Ok(result)
    }

    /// A recorded run of the checks; one that found changed protected checks stops the package before review.
    fn checks_result(&mut self, step: &str, d: Value) -> Step<Value> {
        if d["refused"] != json!("protected") {
            return Ok(d);
        }
        let paths = strings(&d["paths"]);
        self.out.insert("protectedChanged".into(), json!(paths));
        self.out.insert("stoppedAt".into(), json!(format!("protected checks changed at {step}")));
        self.out.insert("next".into(), json!(format!("The candidate tree changes or deletes existing checks: {}. A change must not edit the checks that judge it, so the package stopped before the checks ran and before review; nothing was committed. Restore them in the work tree, or, if the change is right, start again with args.allowCheckChanges listing those paths.", paths.join(", "))));
        Err(Halt)
    }

    /// Stops every check command of this run that started and has no recorded end, whatever step or attempt started
    /// it (by pid and start time), before checks start again; each one settled gets its end recorded. One that cannot
    /// be stopped, or an end the journal cannot record, stops the run.
    fn reap_checks(&mut self, step: &str) -> Step<()> {
        let result = checks::reap_unended(&mut self.journal);
        self.infra(step, result)
    }

    // --------------------------------------------------------------------------------------------- commit

    /// Commits the checked tree on the branch, path-limited by construction (the parent's tree with the claimed
    /// paths only), after rechecking the branch, the claim and the work tree. Never pushes.
    fn commit(&mut self, n: u32, checks: &Value, stamp: &str) -> Step<Value> {
        let step = format!("commit {n}");
        self.step = step.clone();
        if let Some(done) = self.done(&step) {
            if let Some(c) = done["commit"].as_str() {
                self.head = c.to_string();
            }
            return Ok(done);
        }
        let attempt = self.attempt(&step);
        let tree = checks["tree"].as_str().unwrap_or("").to_string();
        let events = self.journal.events();
        let intent = events.iter().rev().find(|e| e["kind"] == "intent" && e["step"] == step).cloned();
        let made = events.iter().rev().find(|e| e["kind"] == "made" && e["step"] == step)
            .and_then(|e| e["commit"].as_str()).map(String::from);
        let pending_index = events.iter().rev().find(|e| e["step"] == step && (e["kind"] == "index planned" || e["kind"] == "index restored"))
            .filter(|e| e["kind"] == "index planned").map(|e| strings(&e["paths"]));
        if let Some(intent) = &intent {
            let parent = intent["parent"].as_str().unwrap_or("");
            let tip = self.git.rev(&self.branch);
            let tip = self.infra(&step, tip)?;
            if made.as_deref() == Some(tip.as_str()) {
                return self.commit_receipt(&step, n, parent, &tip, &tree);
            }
            if let (Some(paths), Some(commit)) = (pending_index, &made) {
                let restored = self.restore_index(&step, n, parent, commit, &tip, &paths);
                self.infra(&step, restored)?;
            }
            if tip != parent {
                self.halt_infra(&step, format!("unknown outcome at {step}"), format!("the branch {} moved to {tip}, which is not the commit this run made for round {n} on {parent} ({})", self.branch, made.as_deref().unwrap_or("none was recorded")));
                return Err(Halt);
            }
        }
        // Recheck the base, the claim and the tree that was checked.
        let tip = self.git.rev(&self.branch);
        let tip = self.infra(&step, tip)?;
        let on = self.git.branch();
        let on = self.infra(&step, on)?;
        if tip != self.head || on.as_deref() != Some(self.branch.as_str()) {
            self.out.insert("stoppedAt".into(), json!("commit (the branch moved)"));
            self.out.insert("next".into(), json!(format!("{} is at {tip} (checked out: {}), not at {}: somebody else committed or switched branches during the run. Nothing of round {n} was committed; the work stays in the work tree.", self.branch, on.unwrap_or_else(|| "detached".into()), self.head)));
            return Err(Halt);
        }
        let keys: Vec<String> = self.claimed.iter().map(|c| c.to_lowercase()).collect();
        if !claims::holds(&self.claims_dir, &self.args.label, &self.id, &keys) {
            self.out.insert("stoppedAt".into(), json!("commit (the claim is not open)"));
            self.out.insert("next".into(), json!(format!("The claim {} is no longer the open claim of this run with all its files. Nothing of round {n} was committed.", claims::file(&self.claims_dir, &self.args.label).display())));
            return Err(Halt);
        }
        let scratch = self.journal.file("tmp");
        let now = self.git.candidate_tree(&self.head, &self.claimed, &self.exec, &scratch);
        let now = self.infra(&step, now)?;
        if now != tree {
            self.out.insert("stoppedAt".into(), json!("commit (the work tree changed after the checks)"));
            self.out.insert("next".into(), json!(format!("A claimed file changed in the work tree after the checks of round {n} ran: the checked tree {tree} is not the tree now ({now}). Nothing was committed.")));
            return Err(Halt);
        }
        let parent_tree = self.git.rev(&format!("{}^{{tree}}", self.head));
        let parent_tree = self.infra(&step, parent_tree)?;
        if parent_tree == tree {
            let receipt = json!({ "commit": null, "parent": self.head, "tree": tree, "note": "nothing to commit" });
            let r = self.record_done(&step, n, receipt.clone());
            self.infra(&step, r)?;
            return Ok(receipt);
        }
        let parent = self.head.clone();
        let message = format!("{}: round {n}\n\n{stamp}\n", self.args.label);
        if intent.is_none() {
            let r = self.record_intent(&step, n, "commit", &sha256_hex(format!("{parent}{tree}{message}")), json!({ "parent": parent, "tree": tree, "ref": self.branch, "message": message }));
            self.infra(&step, r)?;
        }
        let commit = match made {
            Some(commit) => commit,
            None => {
                let made = self.git.run_env(&["commit-tree", &tree, "-p", &parent, "-F", "-"], &[], Some(message.as_bytes()));
                let commit = self.infra(&step, made)?.trim().to_string();
                let r = self.journal.append(json!({ "kind": "made", "step": step, "round": n, "attempt": attempt, "commit": commit }));
                self.infra(&step, r)?;
                commit
            }
        };
        // The index entries of the claimed paths follow the commit before the branch does, so that after the branch
        // moved the engine never has to touch the index again: an entry that differs from the commit then is
        // somebody's staging. Staged entries that are neither the parent's nor the commit's are somebody's work
        // already: nothing is published.
        let paths = self.index_paths(&parent, &commit);
        let paths = self.infra(&step, paths)?;
        let from_parent = self.git.staged_paths(&parent, &paths);
        let from_parent = self.infra(&step, from_parent)?;
        let from_commit = self.git.staged_paths(&commit, &paths);
        let from_commit = self.infra(&step, from_commit)?;
        let conflicts: Vec<_> = from_commit.iter().filter(|p| from_parent.contains(p)).cloned().collect();
        if !conflicts.is_empty() {
            let why = format!("staged changes in {} are neither the parent's nor the round's commit", conflicts.join(", "));
            self.halt_infra(&step, format!("{step} (staged work in claimed files)"), why);
            return Err(Halt);
        }
        // Only paths that differed from the candidate initially belong to our index transition. Remember them
        // before reset so an interrupted publication can still undo them without touching already-staged work.
        let r = self.journal.append(json!({ "kind": "index planned", "step": step, "round": n, "attempt": attempt, "paths": from_commit }));
        self.infra(&step, r)?;
        let changed = self.git.reset_index_paths(&commit, &from_commit);
        self.infra(&step, changed)?;
        crate::boundary::cut(&format!("index {n}"));
        let moved = self.git.run(&["update-ref", "-m", &format!("zodchi flow {}: round {n}", self.args.label), &self.branch, &commit, &parent]);
        if let Err(error) = moved {
            let tip = match self.git.rev(&self.branch) {
                Ok(tip) => tip,
                Err(read_error) => {
                    self.halt_infra(&step, format!("unknown outcome at {step}"), format!("{}; could not verify the branch tip: {}", error.0, read_error.0));
                    return Err(Halt);
                }
            };
            if tip == commit {
                return self.commit_receipt(&step, n, &parent, &commit, &tree);
            }
            let restored = self.restore_index(&step, n, &parent, &commit, &tip, &from_commit);
            let why = match restored {
                Ok(()) => error.0,
                Err(rollback) => format!("{}; restoring the run's index entries failed: {}", error.0, rollback.0),
            };
            let stop = if tip == parent { "infrastructure" } else { "unknown outcome" };
            self.halt_infra(&step, format!("{stop} at {step}"), why);
            return Err(Halt);
        }
        crate::boundary::cut(&step);
        self.commit_receipt(&step, n, &parent, &commit, &tree)
    }

    /// Restore the run's index entries while keeping any staging and branch changes made by someone else.
    fn restore_index(&mut self, step: &str, round: u32, parent: &str, candidate: &str, tip: &str, paths: &[String]) -> Result<()> {
        if !paths.is_empty() {
            if self.git.branch()?.as_deref() != Some(self.branch.as_str()) {
                return fail("the checked-out branch changed; its index was left in place");
            }
            let externally_staged = self.git.staged_paths(candidate, paths)?;
            let published_changes: Vec<_> = self.git.changes(parent, tip)?.into_iter().map(|(_, path)| path).collect();
            let ours: Vec<_> = paths.iter().filter(|p| !externally_staged.contains(p) && !published_changes.contains(p)).cloned().collect();
            self.git.reset_index_paths(parent, &ours)?;
        }
        self.journal.append(json!({ "kind": "index restored", "step": step, "round": round, "attempt": self.attempt(step) }))?;
        Ok(())
    }

    /// The claimed paths the parent or the commit holds: those whose index entries follow the round's commit.
    fn index_paths(&self, parent: &str, commit: &str) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for p in &self.claimed {
            if self.git.exists_at(commit, p)? || self.git.exists_at(parent, p)? {
                out.push(p.clone());
            }
        }
        Ok(out)
    }

    /// After the branch moved to the round's commit: the receipt goes into the journal. The index is never touched
    /// here (its entries followed the commit before the branch moved); claimed entries that differ from the commit
    /// now are somebody's staging since, left as they are and named in the receipt. The claim, with every path it was
    /// extended by, must still be this run's.
    fn commit_receipt(&mut self, step: &str, n: u32, parent: &str, commit: &str, tree: &str) -> Step<Value> {
        let keys: Vec<String> = self.claimed.iter().map(|c| c.to_lowercase()).collect();
        if !claims::holds(&self.claims_dir, &self.args.label, &self.id, &keys) {
            self.out.insert("stoppedAt".into(), json!(format!("{step} (the claim is not open)")));
            self.out.insert("next".into(), json!(format!("The round's commit {commit} is on {}, but the claim {} is no longer the open claim of this run with all its files (closed, narrowed or taken over meanwhile). The index was left as it is; nothing was reviewed.", self.branch, claims::file(&self.claims_dir, &self.args.label).display())));
            return Err(Halt);
        }
        let on = self.git.branch();
        let on = self.infra(step, on)?;
        let mut left = Vec::new();
        if on.as_deref() == Some(self.branch.as_str()) {
            let paths = self.index_paths(parent, commit);
            let paths = self.infra(step, paths)?;
            let staged = self.git.staged_paths(commit, &paths);
            left = self.infra(step, staged)?;
        }
        let files = self.git.run(&["diff", "--name-only", "--no-renames", parent, commit]);
        let files: Vec<String> = self.infra(step, files)?.lines().map(String::from).collect();
        let mut receipt = json!({ "commit": commit, "parent": parent, "tree": tree, "files": files });
        if !left.is_empty() {
            receipt["indexLeft"] = json!(left);
            self.out.insert("indexLeft".into(), json!(format!("Staged entries of {} differ from the round's commit {commit} and were left as they are: they are somebody's staging (git diff --cached shows them).", left.join(", "))));
        }
        let r = self.record_done(step, n, receipt.clone());
        self.infra(step, r)?;
        self.head = commit.to_string();
        Ok(receipt)
    }

    // --------------------------------------------------------------------------------------------- review

    fn review_round(&mut self, round: &ReviewRound<'_>) -> Step<RoundVerdict> {
        let previous_writer_review = self.review_number;
        let mut reply = None;
        loop {
            self.review_number += 1;
            let step = format!("review {}", self.review_number);
            let (review, reported) = self.review(round, &step, previous_writer_review, reply.as_ref())?;
            let findings = strings(&review["findings"]);
            let important = strings(&review["important"]);
            let word = review["verdict"].as_str().unwrap_or("");
            let blocked_on_gaps = word == "blocked" && findings.is_empty();
            let verdict = if word == "blocked" || (word == "changes_requested" && findings.is_empty()) {
                "blocked"
            } else if !important.is_empty() {
                "changes_requested"
            } else {
                "approved"
            };
            let mut outcome = RoundVerdict { review, findings, important, verdict };
            let reported = blocked_on_gaps.then_some(reported);
            let writer_findings = self.track_gaps(round.n, &step, &outcome.review, reported)?;
            let mut waiting = false;
            if blocked_on_gaps {
                if !writer_findings.is_empty() {
                    outcome.findings = writer_findings.clone();
                    outcome.important = writer_findings;
                    outcome.verdict = "changes_requested";
                } else if self.gaps.iter().any(|gap| gap.state == GapState::Open) {
                    waiting = true;
                } else {
                    outcome.verdict = "approved";
                }
            }
            self.show_review_round(round, &outcome);
            if waiting {
                let answer = self.review_gap_reply(round.n, &step)?;
                if answer.decisions.iter().any(|decision| decision.option != GapOption::Accept) {
                    reply = Some(answer);
                    continue;
                }
                outcome.verdict = "approved";
                self.show_review_round(round, &outcome);
            }
            return Ok(outcome);
        }
    }

    fn show_review_round(&mut self, round: &ReviewRound<'_>, outcome: &RoundVerdict) {
        self.out.insert("openFindings".into(), json!(outcome.findings));
        self.out.insert("verdict".into(), json!(outcome.verdict));
        self.push_round(json!({
            "n": round.n, "checks": round.checks, "commit": round.commit, "review": outcome.review,
            "verification": round.verification, "verdict": outcome.verdict,
        }));
    }

    fn record_gaps(&mut self, step: &str, round: u32, attempt: u32, gaps: Vec<Value>) -> Step<()> {
        if !gaps.is_empty() && self.journal.last("gaps", step, attempt).is_none() {
            let record = self.journal.append(json!({
                "kind": "gaps", "step": step, "round": round, "attempt": attempt, "gaps": gaps,
            }));
            self.infra(step, record)?;
        }
        Ok(())
    }

    fn track_gaps(&mut self, round: u32, step: &str, review: &Value, reported: Option<Vec<GapEvidence>>) -> Step<Vec<String>> {
        let (mut accepted, mut previous): (Vec<_>, Vec<_>) = std::mem::take(&mut self.gaps)
            .into_iter().partition(|gap| gap.state == GapState::Accepted);
        let mut current = Vec::new();
        if let Some(reported) = reported {
            if reported.is_empty() {
                current.push(ReviewGap {
                    id: format!("g{}-0", self.review_number),
                    evidence: GapEvidence {
                        what: review["summary"].as_str().unwrap_or("The reviewer could not establish enough evidence.").to_string(),
                        why: "The reviewer did not name a specific evidence gap.".into(),
                        writer_closeable: false,
                    },
                    state: GapState::Open,
                });
            }
            // An accepted gap stays waived. Match each remaining report to at most one unresolved gap,
            // including one sent to a writer or re-review that has yet to settle it.
            for (index, evidence) in reported.into_iter().enumerate() {
                let identity = gap_identity(&evidence.what);
                let id = match previous.iter().position(|gap| gap_identity(&gap.evidence.what) == identity) {
                    Some(index) => previous.remove(index).id,
                    None if accepted.iter().any(|gap| gap_identity(&gap.evidence.what) == identity) => continue,
                    None => format!("g{}-{}", self.review_number, index + 1),
                };
                let state = if evidence.writer_closeable && round < self.args.rounds {
                    GapState::Finding
                } else {
                    GapState::Open
                };
                current.push(ReviewGap { id, evidence, state });
            }
        }
        for gap in &mut previous {
            gap.state = GapState::Superseded;
        }
        let writer_findings = current.iter().filter(|gap| gap.state == GapState::Finding).map(|gap| {
            format!("{} important evidence gap: {}\n  {}", gap.id, gap.evidence.what, gap.evidence.why)
        }).collect();
        if !current.is_empty() || !previous.is_empty() {
            let snapshot = current.iter().chain(&previous).chain(&accepted).map(ReviewGap::to_json).collect();
            self.record_gaps(step, round, self.attempt(step), snapshot)?;
        }
        accepted.extend(current);
        self.gaps = accepted;
        Ok(writer_findings)
    }

    fn review_gap_reply(&mut self, round: u32, review_step: &str) -> Step<GapReply> {
        let step = format!("{REVIEW_GAPS} {}", self.review_number);
        let attempt = self.attempt(review_step);
        if let Some(event) = self.journal.last("rerun", &step, attempt) {
            let seq = event["seq"].as_u64().expect("journal sequence");
            let decisions = event["ownerAnswer"].as_array()
                .and_then(|answers| answers.iter().map(GapDecision::from_json).collect::<Option<Vec<_>>>())
                .ok_or_else(|| GatewayError("The saved review gap reply is unreadable.".into()));
            let decisions = self.infra(&step, decisions)?;
            let mut changed = Vec::with_capacity(decisions.len());
            for decision in &decisions {
                let gap = self.gaps.iter_mut().find(|gap| gap.id == decision.id).expect("validated gap id");
                gap.state = match decision.option {
                    GapOption::Accept => GapState::Accepted,
                    GapOption::Attach => GapState::ContextAttached,
                    GapOption::ReviewAgain => GapState::ReviewAgain,
                };
                changed.push(gap.to_json());
            }
            self.record_gaps(&step, round, attempt, changed)?;
            return Ok(GapReply { seq, decisions });
        }
        let gaps: Vec<_> = self.gaps.iter().filter(|gap| gap.state == GapState::Open).collect();
        let items = gaps.iter().map(|gap| format!("- {}  {}\n  {}", gap.id, gap.evidence.what, gap.evidence.why)).collect::<Vec<_>>();
        let question = format!(
            "The reviewer needs a decision on each of these evidence gaps.\n{}\n\n\
             For each gap, use `<gap id>: accept`, `<gap id>: attach context or verification`, or `<gap id>: review again`. \
             Put any supporting material under that gap's line.", items.join("\n"),
        );
        let gaps: Vec<_> = gaps.into_iter().map(ReviewGap::to_json).collect();
        if !self.journal.last_event().is_some_and(|event| {
            event["kind"] == "waiting" && event["step"] == step && event["attempt"] == attempt && event["reason"] == REVIEW_GAPS
        }) {
            let record = self.journal.append(json!({
                "kind": "waiting", "step": step, "round": round, "attempt": attempt, "reason": REVIEW_GAPS,
                "question": question, "gaps": gaps, "options": GapOption::ALL.map(GapOption::label),
            }));
            self.infra(&step, record)?;
        }
        self.out.insert("status".into(), json!("waiting"));
        self.out.insert("stoppedAt".into(), json!(REVIEW_GAPS));
        self.out.insert("question".into(), json!(question));
        self.out.insert("openGaps".into(), json!(gaps));
        self.out.insert("next".into(), json!(format!("Use zodchi flow reply {} --file <text>, then resume.", self.id)));
        self.keep_claim = true;
        Err(Halt)
    }

    /// The owner requested one new review of the same candidate. Save the reply's sequence on the
    /// gateway intent, reserve its budget once per attempt, and keep the same key across dispatch and recovery.
    /// An explicit rerun after a stop starts a new attempt with the same reply.
    fn call_gap_review(&mut self, step: &str, round: u32, pick: &Pick, mut prompt: String, reply_seq: u64) -> std::result::Result<Value, gateway::CallError> {
        let attempt = self.attempt(step);
        let schema = package_review_schema(pick);
        let stop = |at, reason| gateway::CallError::Stop { at: format!("{at} at {step}"), reason };
        let infra = |error: GatewayError| stop("infrastructure", error.0);
        if self.done(step).is_none() && self.journal.last("safety blocked", step, attempt).is_none() {
            let intent = self.journal.last("intent", step, attempt);
            if intent.is_none() && self.args.budget.is_some_and(|budget| budget.exhausted(&self.journal)) {
                return Err(stop("budget", "The package budget for new model calls is exhausted.".into()));
            }
            let key = gateway::base_key(&self.id, step, attempt);
            let exec = executor::for_pick(&self.cfg, pick).map_err(|reason| stop("infrastructure", reason))?;
            let dispatch = if let Some(intent) = intent {
                if intent["gapReplySeq"] != reply_seq || intent["key"] != key {
                    return Err(stop("unknown outcome", format!("The saved review intent does not match gap reply {reply_seq}.")));
                }
                // The server executor has its own account-bound recovery for an intent with a missing key.
                // For a local executor, recover an absent key only inside the gateway's retention window
                // and before a submission receipt. A known job is always reattached below.
                const RECOVERY_WINDOW_MS: i128 = 6 * 86_400_000;
                let recent = intent["at"].as_str().and_then(parse_iso_ms).is_some_and(|at| now_ms() - at < RECOVERY_WINDOW_MS);
                let submitted = self.journal.last("submitted", step, attempt).is_some();
                if matches!(exec.name(), "local-gateway" | "claude") && intent["executor"] == exec.name()
                    && recent && !submitted && !exec.exists(&key)
                {
                    let stored = intent["request"].as_str().and_then(|file| self.journal.read_value(file))
                        .filter(|stored| intent["digest"] == sha256_hex(stored.to_string()))
                        .ok_or_else(|| stop("unknown outcome", format!("The saved request for {key} is missing or changed.")))?;
                    Some(stored)
                } else {
                    None
                }
            } else {
                prompt.push_str(&gateway::owner_suffix(&self.journal, &self.cfg, &self.private_places()).map_err(infra)?);
                if prompt.len() > LIMIT_PROMPT {
                    return Err(gateway::CallError::Context { bytes: prompt.len() });
                }
                let role = exec.role(REVIEWER_GATEWAY_ROLE, pick, &schema).map_err(infra)?;
                let mut stored = json!({ "role": role, "prompt": prompt });
                if stored["role"]["mode"] == "work" {
                    stored["keepThread"] = json!(false);
                }
                let file = format!("requests/{key}.json");
                self.journal.write_value(&file, &stored).map_err(infra)?;
                self.record_intent(step, round, "gateway job", &sha256_hex(stored.to_string()), json!({
                    "key": key, "request": file, "role": REVIEWER_GATEWAY_ROLE, "model": pick.model,
                    "effort": pick.effort, "executor": exec.name(), "gapReplySeq": reply_seq,
                })).map_err(infra)?;
                Some(stored)
            };
            if let Some(stored) = dispatch {
                crate::boundary::cut(&format!("intent {step}"));
                eprintln!("{}: {step} · {}/{} {} · {key}", self.id, pick.provider, pick.model, pick.effort);
                let created = exec.submit(&key, &stored).map_err(infra)?;
                crate::boundary::cut(&format!("submit {step}"));
                self.journal.append(json!({
                    "kind": "submitted", "step": step, "attempt": attempt, "key": key, "created": created,
                })).map_err(infra)?;
            }
        }
        let call = gateway::Call {
            id: &self.id, step, round, role: REVIEWER_GATEWAY_ROLE, pick, schema: &schema,
            prompt: String::new(), writer_workspace: None,
        };
        gateway::ask_without_resubmission(&mut self.journal, &self.cfg, call, check_package_review)
    }

    fn review(&mut self, round: &ReviewRound<'_>, step: &str, previous_writer_review: u32, reply: Option<&GapReply>) -> Step<(Value, Vec<GapEvidence>)> {
        let n = self.review_number;
        self.step = step.to_string();
        let reviews = format!("reviews/review-{n}.json");
        let review_file = self.journal.file(&reviews).display().to_string();
        let attempt = self.attempt(step);
        let prompt = if self.done(step).is_some() || self.journal.last("intent", step, attempt).is_some() {
            String::new()
        } else {
            let built = self.review_prompt(round, step, previous_writer_review, reply);
            match self.infra(step, built)? {
                ScreenedPrompt::Prompt(prompt) => prompt,
                ScreenedPrompt::Withheld(locations) => {
                    self.push_round(json!({
                        "n": round.n, "checks": round.checks, "commit": round.commit,
                        "verification": round.verification, "verdict": "blocked",
                    }));
                    let commit = round.candidate;
                    let n = round.n;
                    let location = if self.args.isolated {
                        format!("is retained at {}", self.out["candidate"]["ref"].as_str().expect("pinned candidate ref"))
                    } else {
                        format!("is on {}", self.branch)
                    };
                    self.out.insert("next".into(), json!(format!(
                        "Commit {commit} for round {n} {location}. Inspect it locally and remove the marked material before starting a new package."
                    )));
                    let description = format!("The review material for round {n} at commit {commit} contains lines that would be withheld");
                    return self.stop_screening(step, &description, &locations);
                }
            }
        };
        let reviewer = self.reviewer.clone();
        let data = if let Some(reply) = reply {
            let call = self.call_gap_review(step, round.n, &reviewer, prompt, reply.seq);
            self.call_result(step, call)?
        } else {
            self.ask(step, round.n, REVIEWER_GATEWAY_ROLE, &reviewer, &package_review_schema(&reviewer), prompt, None, check_package_review)?
        };
        let w = self.journal.write_value(&reviews, &data);
        self.infra(step, w)?;
        let gaps = self.infra(step, review_gap_evidence(&data).map_err(GatewayError))?;
        // The severity comes from the structured field; the strings are only how the result and the prompts show them.
        let mut findings = Vec::new();
        let mut important = Vec::new();
        for f in data["findings"].as_array().cloned().unwrap_or_default() {
            let sev = severity(f["severity"].as_str().unwrap_or(""));
            let line = format!("{} {sev} {}: {}", f["id"].as_str().unwrap_or("F?"), f["location"].as_str().unwrap_or(""), f["problem"].as_str().unwrap_or(""));
            if sev == "important" {
                important.push(line.clone());
            }
            findings.push(line);
        }
        Ok((json!({ "verdict": data["verdict"], "summary": data["summary"], "findings": findings, "important": important, "blocking": important.len(), "reviewFile": review_file }), gaps))
    }

    fn review_verification(&self, candidate: &str, verification: &Value, evidence: &[Value]) -> Result<Vec<u8>> {
        let tree = self.git.rev(&format!("{candidate}^{{tree}}"))?;
        if verification["tree"].as_str() != Some(tree.as_str()) {
            return fail("The reviewed commit does not have the tree recorded by checks.");
        }
        let mut places = self.private_places();
        if let Some(checkout) = verification["checkout"].as_str() {
            places.push((checkout.to_string(), "<candidate>"));
        }
        let scrubber = Scrubber::new(&self.cfg)?;
        let logs = self.journal.file("logs");
        let output_budget = (24 * 1024 / evidence.len().max(1)).min(4096);
        let commands: Vec<Value> = evidence.iter().enumerate().map(|(i, entry)| {
            let command = scrubber.text(entry["command"].as_str().unwrap_or(""), &places);
            let mut chars = command.chars();
            let mut description: String = chars.by_ref().take(512).collect();
            if chars.next().is_some() {
                description.push_str("...");
            }
            let output = entry["log"].as_str().map(Path::new).filter(|log| log.starts_with(&logs))
                .map(|log| checks::review_output(log, output_budget, |raw| scrubber.text(raw, &places)));
            json!({
                "check": checks::name(evidence, i), "command": description,
                "exitCode": entry["exitCode"], "ms": entry["ms"], "output": output,
            })
        }).collect();
        serde_json::to_vec_pretty(&json!({
            "commit": candidate, "tree": tree, "verifiedBy": verification["verifiedBy"], "commands": commands,
        })).map_err(|error| GatewayError(format!("Cannot encode the verification attachment: {error}")))
    }

    fn review_writer_checks(&self, previous_writer_review: u32) -> Result<Option<Vec<u8>>> {
        if !self.args.agent {
            return Ok(None);
        }
        let previous_review = format!("review {previous_writer_review}");
        let mut reported: Vec<_> = self.journal.events().iter().rev()
            .filter(|event| event["kind"] == "done")
            .take_while(|event| event["step"] != previous_review)
            .filter_map(|event| {
                let step = event["step"].as_str()?;
                let checks = event["result"]["checks"].as_array()?;
                (event["attempt"].as_u64() == Some(u64::from(self.attempt(step)))).then_some((step, checks))
            })
            .flat_map(|(step, checks)| checks.iter().rev().map(move |check| (step, check)))
            .filter_map(|(step, check)| Some((step, check["command"].as_str()?, check["exitCode"].as_i64(), check["result"].as_str()?)))
            .take(12).collect();
        if reported.is_empty() {
            return Ok(None);
        }
        let scrubber = Scrubber::new(&self.cfg)?;
        let places = self.private_places();
        reported.reverse();
        let checks: Vec<_> = reported.into_iter().map(|(step, command, exit, result)| {
            let command: String = scrubber.text(command, &places).chars().take(400).collect();
            let result: String = scrubber.text(result, &places).chars().take(400).collect();
            json!({ "step": step, "command": command, "exitCode": exit, "result": result })
        }).collect();
        serde_json::to_vec_pretty(&json!({ "source": "writer report from the private workspace", "checks": checks }))
            .map(Some).map_err(|error| GatewayError(format!("Cannot encode the writer checks attachment: {error}")))
    }

    fn review_files(
        &self,
        candidate: &str,
        changed: &[review_source::File<'_>],
        scrubber: &Scrubber,
        places: &[(String, &str)],
    ) -> Result<(Attachments, Vec<&str>, Vec<String>)> {
        let mut attachments = Vec::new();
        let mut binary = Vec::new();
        let mut omissions = Vec::new();
        for (index, file) in self.claimed.iter().enumerate() {
            if let Some((_, reason)) = scrubber.input_withholdings(file).next() {
                omissions.push(format!("claimed file #{} (file name, {})", index + 1, reason.reason()));
                continue;
            }
            // The diff can include both deleted lines and unchanged context. Screen the whole blobs so
            // a hunk boundary cannot hide part of a credential and full candidate attachments are safe.
            if changed.iter().any(|entry| entry.path == file.as_str()) {
                if let Some(bytes) = self.git.show(&self.base, file)? {
                    if bytes.contains(&0) {
                        binary.push(file.as_str());
                    } else {
                        let withheld = withheld_input_lines(scrubber, &bytes, &self.allowed_input_digests);
                        omissions.extend(input_locations(file, " in the base", withheld));
                    }
                }
            }
            if let Some(bytes) = self.git.show(candidate, file)? {
                if bytes.contains(&0) {
                    binary.push(file.as_str());
                } else {
                    let withheld = withheld_input_lines(scrubber, &bytes, &self.allowed_input_digests);
                    omissions.extend(input_locations(file, "", withheld));
                    if patch::claimed_as(&self.args.review_context, file).is_none() {
                        attachments.push((file.clone(), input_attachment(&String::from_utf8_lossy(&bytes), places)));
                    }
                }
            }
        }
        Ok((attachments, binary, omissions))
    }

    fn review_material(
        &self,
        candidate: &str,
        scrubber: &Scrubber,
        places: &[(String, &str)],
    ) -> Result<(String, Attachments, Vec<String>)> {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", &self.base, candidate, "--"];
        args.extend(self.claimed.iter().map(String::as_str));
        let diff = self.git.run(&args)?;
        args.splice(1..1, ["--raw", "-z"]);
        let raw = self.git.run(&args)?;
        // --no-renames gives one path per raw record, in the same order as the patch.
        let mut fields = raw.split_terminator('\0');
        let files: Vec<_> = std::iter::from_fn(|| {
            let mut header = fields.next()?.split_ascii_whitespace();
            let path = fields.next()?;
            let regular = matches!(header.next(), Some(":000000" | ":100644" | ":100755"))
                && matches!(header.next(), Some("000000" | "100644" | "100755"));
            Some(review_source::File { path, regular })
        }).collect();
        let (attachments, binary, mut locations) = self.review_files(candidate, &files, scrubber, places)?;
        if !locations.is_empty() {
            return Ok((String::new(), attachments, locations));
        }
        // Keep the outbound rule for any diff payload that did not come from a screened text blob.
        let needs_screening = |path| binary.contains(&path)
            || !self.claimed.iter().any(|claimed| claimed.as_str() == path)
            || !files.iter().any(|file| file.path == path && file.regular);
        if files.iter().any(|file| needs_screening(file.path)) {
            let (_, omissions) = review_source::screen_with_locations(&diff, &files, scrubber, places);
            let lines: Vec<_> = diff.lines().collect();
            locations.extend(omissions.into_iter()
                .filter(|omission| {
                    let Some(file) = omission.file else { return true };
                    if !needs_screening(file) {
                        return false;
                    }
                    // These headers contain only paths, which have already passed the input gate.
                    omission.file_line.is_some() || !self.claimed.iter().any(|p| p.as_str() == file)
                        || !["diff --git ", "--- ", "+++ ", "Binary files "].iter()
                            .any(|prefix| lines[omission.diff_line - 1].starts_with(prefix))
                })
                .map(|omission| {
                    let file = match omission.file {
                        Some(file) if scrubber.input_withholdings(file).next().is_none() => file,
                        Some(_) => "claimed file",
                        None => "candidate diff",
                    };
                    let location = match omission.file_line {
                        Some(FileLine::Base(line)) => format!("{file}:{line} in the base"),
                        Some(FileLine::Candidate(line)) => format!("{file}:{line}"),
                        None => format!("{file} at diff line {}", omission.diff_line),
                    };
                    format!("{location} ({})", omission.reason)
                }));
        }
        let diff = checks::screen_paths(diff.split('\n'), places);
        Ok((diff, attachments, locations))
    }

    fn review_prompt(&self, round: &ReviewRound<'_>, step: &str, previous_writer_review: u32, reply: Option<&GapReply>) -> Result<ScreenedPrompt> {
        let n = self.review_number;
        let ReviewRound { candidate, summary, unverified, verification, .. } = *round;
        let scrubber = Scrubber::new(&self.cfg)?;
        let places = self.private_places();
        let omissions = self.withheld_brief(&scrubber);
        if !omissions.is_empty() {
            return Ok(ScreenedPrompt::Withheld(omissions));
        }
        let (diff, files, omissions) = self.review_material(candidate, &scrubber, &places)?;
        if !omissions.is_empty() {
            return Ok(ScreenedPrompt::Withheld(omissions));
        }
        let evidence = verification["evidence"].as_array().map(Vec::as_slice).unwrap_or_default();
        let how = format!("{}{}{}{}", verification["stamp"].as_str().unwrap_or(""),
            verification["note"].as_str().filter(|s| !s.is_empty()).map(|s| format!(": {s}")).unwrap_or_default(),
            if evidence.is_empty() { "" } else { ". Per-command results are attached as verification.json" },
            if self.verify_plan.full_local.is_empty() { "" } else {
                ". The configured Full verification will run on this candidate tree after an approving review"
            });
        let history = if reply.is_some() {
            format!("This is review {n} of the same candidate. Read the previous review (review-{}.json) and the owner's gap decisions (owner-gap-reply.json). Reassess the open gaps using the evidence provided.", n - 1)
        } else if n > 1 {
            format!("This is review round {n}. The previous review is attached as review-{}.json; the writer closed its important findings (its words are in the summary above), and the package's commits sit on top of the base.", n - 1)
        } else {
            "This is the first review of the change; its commit sits on top of the base.".into()
        };
        let focus = if self.review_md.is_some() {
            "REVIEW.md as of the base commit is attached as REVIEW.base.md: apply it; it says what the owner wants flagged and what not."
        } else {
            "The base commit has no REVIEW.md: judge by the brief."
        };
        let summary = scrubber.text(summary, &places);
        let text = render(REVIEW, &[
            ("step", step.to_string()), ("run", self.id.clone()), ("base", self.base.clone()), ("summary", summary),
            ("unverified", if unverified.is_empty() { "nothing named".into() } else { unverified.join("; ") }),
            ("verification", how), ("history", history), ("focus", focus.to_string()),
        ]);
        let brief = input_attachment(&self.brief, &places);
        let mut required = vec![("change.diff".to_string(), diff.into_bytes()), ("brief".to_string(), brief)];
        if self.history.is_object() {
            required.push(("previous-package.json".into(), self.history.to_string().into_bytes()));
            let changes = self.git.changes(&self.seed, candidate)?;
            let unchanged: Vec<_> = self.git.changes(&self.base, &self.seed)?.into_iter()
                .map(|(_, path)| path)
                .filter(|path| !changes.iter().any(|(_, changed)| changed == path)).collect();
            let delta = json!({ "seed": self.seed, "candidate": candidate,
                "changedSinceSeed": changes.iter().map(|(status, path)| json!({ "status": status, "path": path })).collect::<Vec<_>>(),
                "inheritedUnchanged": unchanged });
            required.push(("source-delta.json".into(), delta.to_string().into_bytes()));
        }
        if !evidence.is_empty() {
            required.push(("verification.json".into(), self.review_verification(candidate, verification, evidence)?));
        }
        if let Some(r) = &self.review_md {
            required.push(("REVIEW.base.md".into(), screen_attachment(&scrubber, r.as_bytes().to_vec(), &places)));
        }
        if n > 1 {
            let prev = std::fs::read(self.journal.file(&format!("reviews/review-{}.json", n - 1))).unwrap_or_default();
            required.push((format!("review-{}.json", n - 1), prev));
        }
        if let Some(reply) = reply {
            let decisions: Vec<_> = reply.decisions.iter().map(|decision| {
                let gap = self.gaps.iter().find(|gap| gap.id == decision.id).expect("validated gap id");
                let mut detail = json!({
                    "id": gap.id,
                    "what": gap.evidence.what,
                    "why": gap.evidence.why,
                    "option": decision.option.label(),
                });
                if decision.option == GapOption::Attach {
                    detail["material"] = json!(scrubber.text(&decision.material, &places));
                }
                detail
            }).collect();
            required.push(("owner-gap-reply.json".into(), json!({ "decisions": decisions }).to_string().into_bytes()));
        }
        if !self.args.review_context.is_empty() {
            for (number, (file, text)) in review_context(&self.git, candidate, &self.args.review_context)?.into_iter().enumerate() {
                if self.claimed.contains(&file) {
                    required.push((file, input_attachment(&text, &places)));
                    continue;
                }
                let label = if scrubber.text(&file, &places) == file {
                    file
                } else {
                    format!("context-{}.txt", number + 1)
                };
                required.push((label, scrubber.text(&text, &places).into_bytes()));
            }
        }
        // Drop the largest optional attachments first when the request is too large.
        let mut optional: Vec<(String, Vec<u8>)> = Vec::new();
        if let Some(checks) = self.review_writer_checks(previous_writer_review)? {
            optional.push(("writer-checks.json".into(), checks));
        }
        optional.extend(files);
        let mut dropped: Vec<String> = Vec::new();
        loop {
            let note = if dropped.is_empty() { String::new() } else { format!("\n\nNot attached for size: {}", dropped.join(", ")) };
            let mut all = required.clone();
            all.extend(optional.iter().cloned());
            let prompt = compose_prompt(&format!("{text}{note}"), &all)?;
            if prompt.len() <= LIMIT_PROMPT || optional.is_empty() {
                return Ok(ScreenedPrompt::Prompt(prompt));
            }
            let largest = optional.iter().enumerate().max_by_key(|(_, (_, b))| b.len()).map(|(i, _)| i).unwrap();
            dropped.push(optional.remove(largest).0);
        }
    }
}

fn plain_ok(p: &str) -> bool {
    !p.is_empty() && !p.contains("..") && !p.starts_with('/') && !p.contains('\\') && !p.contains(':')
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn merge(a: &Value, b: &Value) -> Value {
    zodchi_core::util::merge(a, b)
}

/// What verified a round: the slowest source that ran and passed, from the real exit codes. The stamp names the
/// sources and exit codes only, never a command.
fn verification(checks: &Value, has_verify: bool, has_checks: bool) -> Value {
    let evidence = checks["evidence"].as_array().map(Vec::as_slice).unwrap_or_default();
    let receipts = !evidence.is_empty() && evidence.iter().all(|e| e["exitCode"].is_i64());
    let mut sources: Vec<(String, Vec<i64>)> = Vec::new();
    if receipts {
        for e in evidence {
            let s = e["source"].as_str().unwrap_or("").to_string();
            let code = e["exitCode"].as_i64().unwrap_or(-1);
            match sources.iter_mut().find(|(x, _)| *x == s) {
                Some((_, codes)) => {
                    if !codes.contains(&code) {
                        codes.push(code);
                    }
                }
                None => sources.push((s, vec![code])),
            }
        }
    }
    let by = if !receipts { "none" } else {
        sources.iter().rev().find(|(s, _)| s.ends_with(".verify")).or_else(|| sources.first())
            .map(|(s, _)| s.as_str()).unwrap_or("none")
    };
    let stamp = if by == "none" {
        "Verified: none".to_string()
    } else {
        format!("Verified: {}", sources.iter().map(|(s, c)| format!("{s} exit {}", c.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("/"))).collect::<Vec<_>>().join("; "))
    };
    let note = if by != "none" { String::new() } else if !has_verify && !has_checks { "not verified by running: no args.verify and no checks".into() } else { "not verified by running: a command has no exit code".into() };
    json!({ "verifiedBy": by, "evidence": evidence, "note": note, "stamp": stamp, "tree": checks["tree"], "checkout": checks["checkout"] })
}
