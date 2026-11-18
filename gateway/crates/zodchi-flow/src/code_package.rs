//! `code-package` v1 as a state machine. The engine alone decides every transition: gate, claim, write, apply,
//! cheap checks, verify, commit, review, close, and the stop rules. Models only propose a patch or judge a change.
//!
//! Every effect goes through the journal: a run that was cut is resumed by running the machine again from the start,
//! and each step either comes back from the journal (a recorded result or receipt), is reconciled (an interrupted
//! apply against its expected before/after blobs, an interrupted commit against the branch tip, a submitted model
//! call by polling its key), or runs. An outcome that none of them can settle stops the run with
//! `stoppedAt: "unknown outcome at <step>"` and keeps the claim.

use crate::args::{self, is_protected, Args};
use crate::checks;
use crate::claims;
use crate::executor;
use crate::gateway;
use crate::git::Git;
use crate::journal::Journal;
use crate::models::{self, Pick};
use crate::patch::{self, Patch, Refusal};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{self, compose_prompt, LIMIT_PROMPT};
use zodchi_core::role::load_role;
use zodchi_core::role::Overrides;
use zodchi_core::process::{process_start, stop_process};
use zodchi_core::util::{fail, iso, sha256_hex, GatewayError, Result};

pub const WORKFLOW: &str = "code-package";
pub const VERSION: &str = "1";

const RULES: &str = include_str!("../flows/code-package/v1/rules.md");
const WRITE: &str = include_str!("../flows/code-package/v1/write.md");
const FIX: &str = include_str!("../flows/code-package/v1/fix.md");
const CLOSE: &str = include_str!("../flows/code-package/v1/close.md");
const REVIEW: &str = include_str!("../flows/code-package/v1/review.md");
const PATCH_SCHEMA: &str = include_str!("../flows/code-package/v1/patch.schema.json");
const REVIEW_SCHEMA: &str = include_str!("../flows/code-package/v1/review.schema.json");

pub const WRITER_GATEWAY_ROLE: &str = "flow-patch";
pub const REVIEWER_GATEWAY_ROLE: &str = "code-review";

/// The process exit code of a cut made on purpose (`ZODCHI_FLOW_CUT`), as a crash would leave the run.
pub const CUT_EXIT: i32 = 75;

pub struct Exit {
    pub result: Value,
    pub code: u8,
}

fn exit_of(result: Value) -> Exit {
    let code = if result["approved"] == json!(true) { 0 } else { 2 };
    Exit { result, code }
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

/// A cut on purpose, for recovery tests: `ZODCHI_FLOW_CUT=<point>` ends the process right after that effect and
/// before its receipt is journaled, as a crash would.
fn cut(point: &str) {
    if std::env::var("ZODCHI_FLOW_CUT").ok().as_deref() == Some(point) {
        eprintln!("zodchi flow: cut after {point} (ZODCHI_FLOW_CUT)");
        std::process::exit(CUT_EXIT);
    }
}

/// Named text attachments of a request: (name, bytes).
type Attachments = Vec<(String, Vec<u8>)>;

/// Why the machine stopped early; the result already says it.
struct Halt;
type Step<T> = std::result::Result<T, Halt>;

struct Run {
    id: String,
    args: Args,
    cfg: Config,
    git: Git,
    journal: Journal,
    base: String,
    branch: String,
    brief: String,
    review_md: Option<String>,
    writer: Pick,
    reviewer: Pick,
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

/// Starts a new run from its arguments: the gate (no effect), then the journal, the claim and the machine.
pub fn start(raw: &Value) -> Result<Exit> {
    let label = raw["label"].as_str().unwrap_or("").to_string();
    let args = match args::parse(raw) {
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
    let Some(branch) = git.branch()? else {
        return Ok(refused(&label, "HEAD is detached: check out the branch the package commits on.".into()));
    };
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
    if args.verify.is_empty() && git.exists_at(&base, ".claude/skills/verify/SKILL.md")? {
        return Ok(refused(&label, "The repository has a verify skill (.claude/skills/verify/SKILL.md), and the engine runs commands only: pass the skill's commands as args.verify.".into()));
    }
    let review_md = git.show(&base, "REVIEW.md")?.map(|b| String::from_utf8_lossy(&b).into_owned());
    let cfg = Config::new(Some(&repo))?;
    // With a flow server the Codex steps run there: the local Codex sign-in and roles are not needed for them, and
    // the server's roles and sign-in are asked below, before the claim.
    let server = executor::flow_server(&cfg);
    let table = match models::table(&cfg, &repo, &args.models) {
        Ok(t) => t,
        Err(why) => return Ok(refused(&label, why)),
    };
    let codex = match &server {
        None => models::codex_usable(&job::account(&cfg)),
        Some(_) => Ok(()),
    };
    let (writer, reviewer, skipped) = match models::resolve(&table, &codex) {
        Ok(p) => p,
        Err(why) => return Ok(refused(&label, why)),
    };
    let on_server = |p: &Pick| server.is_some() && p.provider == "codex";
    if !(on_server(&writer) && on_server(&reviewer)) {
        for role in [WRITER_GATEWAY_ROLE, REVIEWER_GATEWAY_ROLE] {
            if let Err(e) = load_role(&cfg, role, &Overrides::default()) {
                return Ok(refused(&label, format!("The gateway role {role} does not load: {e}. Install the roles of this zodchi version.")));
            }
        }
    }
    if let Some(url) = server.as_ref().filter(|_| on_server(&writer) || on_server(&reviewer)) {
        if let Err(e) = executor::server::Server::new(cfg.clone(), url.clone()).preflight(&[WRITER_GATEWAY_ROLE, REVIEWER_GATEWAY_ROLE]) {
            return Ok(refused(&label, e.0));
        }
    }
    let executors = if server.is_some() { "codex via server" } else { "codex only" };
    let now = time_id();
    let id = format!("{now}-{:06x}", rand::random::<u32>() & 0xff_ffff);
    let run = json!({
        "runId": id, "workflow": WORKFLOW, "version": VERSION, "createdAt": iso(),
        "repo": args.repo, "base": base, "branch": branch,
        "inputs": { "args": raw, "brief": args.brief, "briefSha256": sha256_hex(&brief), "reviewMd": review_md.is_some() },
        "pair": { "expertWriter": writer.to_json(), "reviewer": reviewer.to_json(), "skipped": skipped },
        "policy": { "rounds": args.rounds, "fixes": args.fixes, "protected": ["test/", "tests/", "e2e/", ".claude/skills/verify/", "REVIEW.md"],
            "protect": args.protect, "allowCheckChanges": args.allow_check_changes, "extendClaim": args.extend_claim, "checkTimeoutMin": args.check_timeout_min,
            "executors": executors, "checksEnvironment": "exported candidate tree, reduced environment" },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    journal.write_text("brief.md", &brief)?;
    if let Some(text) = &review_md {
        journal.write_text("REVIEW.base.md", text)?;
    }
    let lock = journal.lock()?;
    let run = Run::new(id, args, cfg, git, journal, &run, brief, review_md);
    let exit = run.machine();
    drop(lock);
    exit
}

/// The time part of a run id, from the UTC time stamp: "20261118-120000".
fn time_id() -> String {
    let digits: String = iso().chars().filter(|c| c.is_ascii_digit()).collect();
    format!("{}-{}", &digits[..8], &digits[8..14])
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
        if g != &raw {
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
        // A cut between the saved result and the closing of the claim: the claim of this run is closed as the result
        // says (a claim of another run is left alone).
        if let Some(closing) = journal.events().iter().rev().find(|e| e["kind"] == json!("closing")).cloned() {
            if closing["close"] == json!(true) {
                let _ = claims::close(&claims::claims_dir(&args.repo_norm), &args.label, id, closing["status"].as_str().unwrap_or("stopped"));
            }
        }
        drop(lock);
        return Ok(exit_of(done));
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
    let brief = std::fs::read_to_string(journal.file("brief.md")).map_err(|e| GatewayError(format!("The brief of run {id} ({}) cannot be read: {e}", journal.file("brief.md").display())))?;
    let review_md = if run["inputs"]["reviewMd"] == json!(true) {
        let file = journal.file("REVIEW.base.md");
        Some(std::fs::read_to_string(&file).map_err(|e| GatewayError(format!("The base REVIEW.md of run {id} ({}) cannot be read: {e}; the review would lose the owner's criteria.", file.display())))?)
    } else {
        None
    };
    let git = Git::new(&repo);
    let r = Run::new(id.to_string(), args, cfg, git, journal, &run, brief, review_md);
    let exit = r.machine();
    drop(lock);
    exit
}

// ------------------------------------------------------------------------------------------------- the machine

impl Run {
    #[allow(clippy::too_many_arguments)]
    fn new(id: String, args: Args, cfg: Config, git: Git, journal: Journal, run: &Value, brief: String, review_md: Option<String>) -> Run {
        let base = run["base"].as_str().unwrap_or("").to_string();
        let writer = Pick::from_json(&run["pair"]["expertWriter"]);
        let reviewer = Pick::from_json(&run["pair"]["reviewer"]);
        let mut out = Map::new();
        out.insert("label".into(), json!(args.label));
        out.insert("mode".into(), json!("expert"));
        out.insert("workflow".into(), json!(WORKFLOW));
        out.insert("version".into(), json!(VERSION));
        out.insert("runId".into(), json!(id));
        out.insert("journal".into(), json!(journal.dir.display().to_string()));
        out.insert("base".into(), json!(base));
        out.insert("models".into(), json!({ models::WRITER_ROLE: writer.to_json(), models::REVIEWER_ROLE: reviewer.to_json() }));
        out.insert("skipped".into(), run["pair"]["skipped"].clone());
        out.insert("rounds".into(), json!([]));
        out.insert("openFindings".into(), json!([]));
        out.insert("verifiedBy".into(), json!("none"));
        Run {
            claims_dir: claims::claims_dir(&args.repo_norm),
            claimed: args.files.clone(),
            head: base.clone(),
            branch: run["branch"].as_str().unwrap_or("").to_string(),
            id, args, cfg, git, journal, base, brief, review_md, writer, reviewer, out,
            keep_claim: false,
            claim_status: "stopped",
            questions: vec![],
            changed: vec![],
            exec: vec![],
            step: "gate".into(),
        }
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
        // A halt has written its reason into the result already.
        let _ = self.body();
        let keep = self.keep_claim;
        self.finish(!keep)
    }

    /// Writes the result and then closes the claim (unless the run stops to be resumed). The result and the intent to
    /// close are in the journal before the claim changes, so a resume after a cut there returns the result and closes
    /// the claim, instead of reading its own closed claim as a conflict.
    fn finish(mut self, close: bool) -> Result<Exit> {
        let open = self.out["openFindings"].as_array().map(|a| a.len()).unwrap_or(0);
        if open > 0 && !self.out.contains_key("next") {
            self.out.insert("next".into(), json!(format!("The last review left {open} finding(s) open (openFindings): close them with the writer, or decide on them.")));
        }
        if self.keep_claim {
            return Ok(exit_of(Value::Object(self.out)));
        }
        // The intent first: a cut before the saved result runs the machine again from the journal with the claim
        // still open; a cut after it finds both.
        let mut result = Value::Object(self.out);
        self.journal.append(json!({ "kind": "closing", "close": close, "status": self.claim_status }))?;
        self.journal.write_value("result.json", &result)?;
        cut("result");
        if close {
            let ok = claims::close(&self.claims_dir, &self.args.label, &self.id, self.claim_status).unwrap_or(false);
            if !ok {
                result["claimLeftOpen"] = json!(format!("{}: set \"status\" to \"closed\" by hand", claims::file(&self.claims_dir, &self.args.label).display()));
                self.journal.write_value("result.json", &result)?;
            }
        }
        self.journal.append(json!({ "kind": "finished", "verdict": result["verdict"], "stoppedAt": result["stoppedAt"] }))?;
        Ok(exit_of(result))
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
        let patch = self.writer_turn("write", 0, &write, vec![], vec![])?;
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
                let first = evidence.iter().find(|e| e["exitCode"] != json!(0)).cloned().unwrap_or(Value::Null);
                let verification = json!({ "verifiedBy": "none", "evidence": evidence, "note": format!("not verified by running: the checks of round {n} failed"), "stamp": "Verified: none" });
                self.push_round(json!({ "n": n, "checks": checks }));
                self.out.insert("verifiedBy".into(), json!("none"));
                self.out.insert("verification".into(), verification);
                let failed = format!("{} exit {}", first["source"].as_str().unwrap_or("?"), if first["exitCode"].is_null() { "none".to_string() } else { first["exitCode"].to_string() });
                self.out.insert("stoppedAt".into(), json!(format!("checks ({failed})")));
                self.out.insert("next".into(), json!(format!("The checks failed after the change and the writer's fixes ({}): see the logs in verification.evidence. Nothing of round {n} was committed; the work stays in the work tree. Fix it, or decide that the check is flaky (args.allowCheckChanges).", failed)));
                return Err(Halt);
            }
            let verification = verification(&evidence, !self.args.verify.is_empty(), !self.args.checks.is_empty());
            self.out.insert("verifiedBy".into(), verification["verifiedBy"].clone());
            self.out.insert("verification".into(), verification.clone());
            let receipt = self.commit(n, &checks, verification["stamp"].as_str().unwrap_or("Verified: none"))?;
            let review = self.review(n, &summary, &unverified, &verification)?;
            let findings = strings(&review["findings"]);
            let important = strings(&review["important"]);
            let word = review["verdict"].as_str().unwrap_or("");
            let verdict = if word == "blocked" || (word == "changes_requested" && findings.is_empty()) { "blocked" } else if !important.is_empty() { "changes_requested" } else { "approved" };
            self.out.insert("openFindings".into(), json!(findings));
            self.out.insert("verdict".into(), json!(verdict));
            self.push_round(json!({ "n": n, "checks": checks, "commit": receipt, "review": review, "verification": verification, "verdict": verdict }));
            if verdict == "approved" {
                self.out.insert("approved".into(), json!(true));
                self.claim_status = "done";
                if !findings.is_empty() {
                    self.out.insert("next".into(), json!(format!("Approved with {} open finding(s) in openFindings (none is important): read them and decide, or close them in a new package.", findings.len())));
                }
                return Ok(());
            }
            if verdict == "blocked" {
                self.out.insert("stoppedAt".into(), json!(format!("review verdict {word}{}", if findings.is_empty() { " without findings" } else { "" })));
                self.out.insert("question".into(), json!(format!("The reviewer could not approve or name what to change ({word}): {} See {}.", review["summary"].as_str().unwrap_or(""), review["reviewFile"].as_str().unwrap_or(""))));
                return Err(Halt);
            }
            if n == self.args.rounds {
                self.out.insert("stoppedAt".into(), json!(format!("stop rule: {} review rounds without approval", self.args.rounds)));
                self.out.insert("question".into(), json!(format!("The package has important findings after {} rounds: {}. Decide: accept as is, change the brief, or start again with another writer.", self.args.rounds, important.join(" | "))));
                return Err(Halt);
            }
            let step = format!("close {n}");
            let vars = vec![("round", n.to_string()), ("findings", important.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n"))];
            let review_file = std::fs::read(review["reviewFile"].as_str().unwrap_or("")).unwrap_or_default();
            let fix = self.writer_turn(&step, n, CLOSE, vars, vec![(format!("review-{n}.json"), review_file)])?;
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

    fn stop_blocked(&mut self, step: &str, patch: &Patch) -> Step<()> {
        self.out.insert("stoppedAt".into(), json!(if step == "write" { "write".to_string() } else { step.split(' ').next().unwrap_or(step).to_string() }));
        let q = if patch.questions.is_empty() { patch.summary.clone() } else { patch.questions.join(" | ") };
        self.out.insert("question".into(), json!(q));
        Err(Halt)
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
        let abs: Vec<String> = self.changed.iter().map(|p| format!("{}/{p}", self.args.repo_norm)).collect();
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

    // --------------------------------------------------------------------------------------------- model calls

    /// The claimed files with the blob id of their current content, and the existing ones as attachments.
    fn files_view(&self) -> Result<(String, Attachments)> {
        let mut lines = Vec::new();
        let mut attached = Vec::new();
        for p in &self.claimed {
            // A link would show the writer a file from outside the repository, or its target (a tracked link that
            // the work tree holds as a text file when core.symlinks is false).
            if !patch::no_links(&self.git.root, p) {
                return fail(format!("{p}: a link or reparse point lies on its way, so it is not read"));
            }
            if self.git.tracked_link(&self.head, p)? {
                return fail(format!("{p}: Git keeps it as a link, so it is not read"));
            }
            match std::fs::read(self.git.root.join(p)) {
                Ok(bytes) => {
                    lines.push(format!("- {p}  blob {}", self.git.blob_of(&bytes)?));
                    attached.push((p.clone(), bytes));
                }
                Err(_) => lines.push(format!("- {p}  none (it does not exist)")),
            }
        }
        Ok((lines.join("\n"), attached))
    }

    /// The rules of a writer turn. The checks are named by source and number: their command lines stay with the engine,
    /// since one may hold a private path or a credential.
    fn rules(&self) -> String {
        let list = |v: &[String]| v.iter().map(|x| format!("{x:?}")).collect::<Vec<_>>().join(", ");
        let mut cmds: Vec<String> = (1..=self.args.checks.len()).map(|i| format!("checks #{i}")).collect();
        cmds.extend((1..=self.args.verify.len()).map(|i| format!("args.verify #{i} (verify)")));
        render(RULES, &[
            ("protect", if self.args.protect.is_empty() { String::new() } else { format!(", or under {}", list(&self.args.protect)) }),
            ("allowed", if self.args.allow_check_changes.is_empty() { String::new() } else { format!(", except {}, which the lead allowed", list(&self.args.allow_check_changes)) }),
            ("checks", if cmds.is_empty() { "none are given, so nothing is verified by running".into() } else { format!("{} (the brief may say what they are; the engine does not pass their command lines)", cmds.join(", ")) }),
        ])
    }

    /// The private folders a check's output may name, each with the word a model sees instead.
    fn private_places(&self) -> Vec<(String, &'static str)> {
        let mut v = vec![
            (std::env::temp_dir().display().to_string(), "<tmp>"),
            (self.journal.dir.display().to_string(), "<journal>"),
            (self.cfg.home.display().to_string(), "<zodchi-home>"),
            (self.args.repo_norm.clone(), "<repo>"),
        ];
        for k in ["HOME", "USERPROFILE"] {
            if let Some(h) = std::env::var_os(k).filter(|h| !h.is_empty()) {
                v.push((h.to_string_lossy().into_owned(), "~"));
            }
        }
        v
    }

    /// One writer turn: the prompt from its template, the brief, the claimed files and `extra` attachments; the
    /// answer is a patch by this version's schema.
    fn writer_turn(&mut self, step: &str, round: u32, template: &str, vars: Vec<(&str, String)>, extra: Vec<(String, Vec<u8>)>) -> Step<Patch> {
        self.step = step.to_string();
        // A recorded answer or request is replayed or polled before anything is read from the live work tree.
        let attempt = self.attempt(step);
        let recorded = self.done(step).is_some() || !self.journal.all("intent", step, attempt).is_empty();
        let built = if recorded {
            Ok(String::new())
        } else {
            (|| -> Result<String> {
                let (files, attached) = self.files_view()?;
                let mut all = vec![("step", step.to_string()), ("run", self.id.clone()), ("files", files), ("rules", self.rules())];
                all.extend(vars);
                let text = render(template, &all);
                let mut attachments = vec![("brief".to_string(), self.brief.clone().into_bytes())];
                attachments.extend(extra);
                attachments.extend(attached);
                compose_prompt(&text, &attachments)
            })()
        };
        let prompt = match built {
            Ok(p) => p,
            Err(e) => {
                // A binary claimed file cannot be shown to the expert.
                self.out.insert("stoppedAt".into(), json!(format!("context at {step}: {e}")));
                return Err(Halt);
            }
        };
        let writer = self.writer.clone();
        let data = self.ask(step, round, WRITER_GATEWAY_ROLE, &writer, &schema(PATCH_SCHEMA), prompt, |v| patch::parse(v).map(|_| ()))?;
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

    /// A gateway call under the journal. Before the submission: the intent with the step, round, attempt, input
    /// digest and key, and the exact request in the journal. Only an intent this process recorded is submitted; a
    /// resumed run only looks up and waits for the job of a recorded key, and a key without its job is an unknown
    /// outcome. A job that died before its model turn is asked again under the next key (at most two times).
    #[allow(clippy::too_many_arguments)]
    fn ask(&mut self, step: &str, round: u32, role_name: &str, pick: &Pick, schema: &Value, prompt: String, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> Step<Value> {
        self.step = step.to_string();
        let attempt = self.attempt(step);
        if let Some(d) = self.done(step) {
            return Ok(d);
        }
        let exec = match executor::for_pick(&self.cfg, pick) {
            Ok(e) => e,
            Err(why) => {
                self.halt_infra(step, format!("infrastructure at {step}"), why);
                return Err(Halt);
            }
        };
        let base = gateway::base_key(&self.id, step, attempt);
        let intents: Vec<Value> = self.journal.all("intent", step, attempt).into_iter().cloned().collect();
        // `fresh`: the intent of `key` was recorded by this process, so its job cannot have been submitted before.
        let (mut key, stored, mut fresh) = match intents.last() {
            Some(last) => {
                let file = last["request"].as_str().unwrap_or("").to_string();
                let stored = self.journal.read_value(&file);
                let Some(stored) = stored else {
                    self.halt_infra(step, format!("unknown outcome at {step}"), format!("the stored request {file} of key {} is missing", last["key"]));
                    return Err(Halt);
                };
                (last["key"].as_str().unwrap_or("").to_string(), stored, false)
            }
            None => {
                if prompt.len() > LIMIT_PROMPT {
                    self.out.insert("stoppedAt".into(), json!(format!("context too large at {step}")));
                    self.out.insert("next".into(), json!(format!("The request of {step} is {} KB with its required attachments, over the gateway's {} KB: split the package or claim fewer files. Nothing was submitted.", prompt.len() / 1024, LIMIT_PROMPT / 1024)));
                    return Err(Halt);
                }
                let role = exec.role(role_name, pick, schema);
                let role = self.infra(step, role)?;
                let stored = json!({ "role": role, "prompt": prompt });
                let file = format!("requests/{}.json", gateway::slug(&base));
                let w = self.journal.write_value(&file, &stored);
                self.infra(step, w)?;
                let digest = sha256_hex(stored.to_string());
                let r = self.record_intent(step, round, "gateway job", &digest, json!({ "key": base, "request": file, "role": role_name, "model": pick.model, "effort": pick.effort, "executor": exec.name() }));
                self.infra(step, r)?;
                (base.clone(), stored, true)
            }
        };
        let mut retries = intents.len().saturating_sub(1) as u32;
        loop {
            if fresh {
                let sub = exec.submit(&key, &stored);
                let created = self.infra(step, sub)?;
                cut(&format!("submit {step}"));
                let r = self.journal.append(json!({ "kind": "submitted", "step": step, "attempt": attempt, "key": key, "created": created }));
                self.infra(step, r)?;
            } else if !exec.exists(&key) {
                // A key of an earlier process is never submitted again (a submission can create a job): its job is
                // looked up and waited for. Without its folder nothing proves that the job never ran (a cleaned or
                // swept folder looks the same), so it is not asked again by itself.
                let submitted = self.journal.events().iter().any(|e| e["kind"] == json!("submitted") && e["key"] == json!(key));
                let what = if submitted { format!("the job {key} was submitted and its folder is gone") } else { format!("the job {key} has an intent but neither a \"submitted\" record nor a job folder: it may have run and been cleaned up") };
                self.halt_infra(step, format!("unknown outcome at {step}"), what);
                return Err(Halt);
            }
            // Waiting only reads the job: a folder removed meanwhile is an error here and an unknown outcome on resume.
            let waited = exec.wait_final(&key);
            let fin = self.infra(step, waited)?;
            let status = fin["status"].as_str().unwrap_or("").to_string();
            if status == "succeeded" {
                let data = fin["result"]["data"].clone();
                if let Err(why) = validate(&data) {
                    self.halt_infra(step, format!("invalid answer at {step}"), format!("the answer of job {key} does not hold: {why}"));
                    return Err(Halt);
                }
                let r = self.record_done(step, round, data.clone());
                self.infra(step, r)?;
                return Ok(data);
            }
            if status == "unknown" {
                self.halt_infra(step, format!("unknown outcome at {step}"), format!("job {key}: {}", fin["error"].as_str().unwrap_or("unknown")));
                return Err(Halt);
            }
            if exec.died_before_turn(&fin) && retries < 2 {
                retries += 1;
                key = format!("{base}-r{}", retries + 1);
                let file = format!("requests/{}.json", gateway::slug(&base));
                let digest = sha256_hex(stored.to_string());
                let r = self.record_intent(step, round, "gateway job", &digest, json!({ "key": key, "request": file, "after": gateway::summary(&fin), "executor": exec.name() }));
                self.infra(step, r)?;
                fresh = true;
                continue;
            }
            self.halt_infra(step, format!("gateway {status} at {step}"), format!("job {key}: {}", fin["error"].as_str().unwrap_or(&status)));
            return Err(Halt);
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
            if !self.args.extend_claim {
                let r = self.record_done(step, round, json!({ "refused": "outside", "paths": outside }));
                self.infra(step, r)?;
                return self.replay_apply(step, &self.done(step).unwrap());
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
        let planned = patch::plan(&self.git, &self.args, &self.base, p, &self.claimed);
        let planned = self.infra(step, planned)?;
        let plan = match planned {
            Ok(plan) => plan,
            Err(refusal) => {
                let result = match refusal {
                    Refusal::Outside(paths) => json!({ "refused": "outside", "paths": paths }),
                    Refusal::Protected(paths) => json!({ "refused": "protected", "paths": paths }),
                    Refusal::BadPath(why) => json!({ "refused": "path", "why": why }),
                    Refusal::Stale(why) => json!({ "refused": "stale", "why": why }),
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
        cut(step);
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
        let mut res = self.run_checks(&format!("checks {n}"), n)?;
        for f in 1..=self.args.fixes {
            if res["ok"] == json!(true) {
                break;
            }
            // The writer sees each failed command by its source and number, and the end of its log without the
            // private folders and without lines that may hold a credential; the raw logs stay in the journal.
            let evidence = res["evidence"].as_array().cloned().unwrap_or_default();
            let places = self.private_places();
            let failures: Vec<String> = evidence.iter().enumerate().filter(|(_, e)| e["exitCode"] != json!(0)).map(|(i, e)| {
                format!("{} exit {}{}\n```\n{}\n```", checks::name(&evidence, i),
                    if e["exitCode"].is_null() { "none".into() } else { e["exitCode"].to_string() },
                    e["note"].as_str().filter(|s| !s.is_empty()).map(|s| format!(" ({})", checks::sanitize(s, &places))).unwrap_or_default(),
                    checks::sanitize(&checks::tail(e["log"].as_str().unwrap_or(""), 8 * 1024), &places))
            }).collect();
            let step = format!("fix {n}.{f}");
            let fix = self.writer_turn(&step, n, FIX, vec![("failures", failures.join("\n\n"))], vec![])?;
            if fix.status != "done" {
                break;
            }
            self.apply_step(&format!("apply {step}"), n, &fix)?;
            self.set_changed();
            res = self.run_checks(&format!("checks {n}.{f}"), n)?;
        }
        Ok(res)
    }

    /// One run of the checks on the candidate tree: the parent commit with the claimed paths from the work tree,
    /// exported to a temporary folder. The cheap checks first; the verify commands only when they all pass.
    ///
    /// The candidate tree, whatever brought it into the work tree, must leave the protected checks of the base as they
    /// were (content, mode, existence), except those args.allowCheckChanges names; else the package stops before
    /// review. Each command runs only after its pid and start time are in the journal, and its end is journaled too,
    /// so a resumed run (or a rerun) stops what any earlier attempt left running before it starts the checks again.
    /// A start or an end the journal cannot record stops the run.
    fn run_checks(&mut self, step: &str, round: u32) -> Step<Value> {
        self.step = step.to_string();
        if let Some(d) = self.done(step) {
            return self.checks_result(step, d);
        }
        let attempt = self.attempt(step);
        self.reap_checks(step)?;
        let scratch = self.journal.file("tmp");
        let tree = self.git.candidate_tree(&self.head, &self.claimed, &self.exec, &scratch);
        let tree = self.infra(step, tree)?;
        let changed = self.git.changes(&self.base, &tree);
        let changed = self.infra(step, changed)?;
        let protected: Vec<String> = changed.into_iter()
            .filter(|(status, p)| status != "A" && is_protected(&self.args, p) && !self.args.allow_check_changes.contains(&p.to_lowercase()))
            .map(|(_, p)| p).collect();
        if !protected.is_empty() {
            let result = json!({ "ok": false, "tree": tree, "evidence": [], "refused": "protected", "paths": protected });
            let r = self.record_done(step, round, result.clone());
            self.infra(step, r)?;
            return self.checks_result(step, result);
        }
        let r = self.record_intent(step, round, "run checks", &sha256_hex(&tree), json!({ "tree": tree }));
        self.infra(step, r)?;
        let export = checks::temp_dir(&self.id, step);
        let exported = self.git.export(&tree, &export, &scratch);
        if let Err(e) = exported {
            checks::remove(&export);
            return self.infra(step, Err(e));
        }
        let logs = self.journal.file(&format!("logs/{}", gateway::slug(step)));
        let limit = Duration::from_secs_f64(self.args.check_timeout_min * 60.0);
        let journal = &mut self.journal;
        let mut on = |phase: checks::Phase, pid: u32| -> bool {
            let e = match phase {
                checks::Phase::Started => json!({ "kind": "check started", "step": step, "attempt": attempt, "pid": pid, "start": process_start(pid) }),
                checks::Phase::Ended => json!({ "kind": "check ended", "step": step, "attempt": attempt, "pid": pid }),
            };
            journal.append(e).is_ok()
        };
        let (mut evidence, mut recorded) = checks::run_list(&self.args.checks, "checks", &export, &logs, limit, &mut on);
        if recorded && checks::passed(&evidence) && !self.args.verify.is_empty() {
            let (more, ok) = checks::run_list(&self.args.verify, "args.verify", &export, &logs, limit, &mut on);
            evidence.extend(more);
            recorded = ok;
        }
        checks::remove(&export);
        if !recorded {
            self.halt_infra(step, format!("infrastructure at {step}"), "the journal could not record the start or the end of a check command, so no further command ran: fix the journal folder, then resume".into());
            return Err(Halt);
        }
        let result = json!({ "ok": checks::passed(&evidence), "tree": tree, "evidence": evidence });
        let r = self.record_done(step, round, result.clone());
        self.infra(step, r)?;
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
        let events = self.journal.events();
        let open: Vec<Value> = events.iter()
            .filter(|s| s["kind"] == json!("check started"))
            .filter(|s| !events.iter().any(|x| x["kind"] == json!("check ended") && x["step"] == s["step"] && x["attempt"] == s["attempt"] && x["pid"] == s["pid"]
                && x["seq"].as_u64().unwrap_or(0) > s["seq"].as_u64().unwrap_or(0)))
            .cloned().collect();
        for e in open {
            let pid = e["pid"].as_i64().unwrap_or(0);
            let answer = stop_process(pid, e["start"].as_str());
            // On Unix a check is the leader of its own process group: what it started may outlive it, and the group's
            // id is not given to anybody else while one of them still runs.
            let group = match answer {
                "absent" | "stopped" => checks::end_group(pid as u32),
                "other" => Ok(()),
                _ => Err(format!("it is still running and could not be stopped ({answer})")),
            };
            if let Err(why) = group {
                self.halt_infra(step, format!("infrastructure at {step}"), format!("a check command (pid {pid}) of {} left by an earlier run: {why}. Stop it, then resume", e["step"].as_str().unwrap_or("?")));
                return Err(Halt);
            }
            let r = self.journal.append(json!({ "kind": "check ended", "step": e["step"], "attempt": e["attempt"], "pid": pid, "reaped": answer }));
            self.infra(step, r)?;
        }
        Ok(())
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
        if let Some(intent) = self.journal.last("intent", &step, attempt).cloned() {
            let parent = intent["parent"].as_str().unwrap_or("").to_string();
            let tip = self.git.rev(&self.branch);
            let tip = self.infra(&step, tip)?;
            if tip != parent {
                // Only the exact commit the engine made and journaled before moving the branch is its receipt; another
                // commit of the same tree (made by hand, without the stamp) is not.
                let made = self.journal.last("made", &step, attempt).and_then(|e| e["commit"].as_str()).map(String::from);
                if made.as_deref() == Some(tip.as_str()) {
                    return self.commit_receipt(&step, n, &parent, &tip, &tree);
                }
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
        let r = self.record_intent(&step, n, "commit", &sha256_hex(format!("{parent}{tree}{message}")), json!({ "parent": parent, "tree": tree, "ref": self.branch, "message": message }));
        self.infra(&step, r)?;
        let made = self.git.run_env(&["commit-tree", &tree, "-p", &parent, "-F", "-"], &[], Some(message.as_bytes()));
        let commit = self.infra(&step, made)?.trim().to_string();
        let r = self.journal.append(json!({ "kind": "made", "step": step, "round": n, "attempt": self.attempt(&step), "commit": commit }));
        self.infra(&step, r)?;
        // The index entries of the claimed paths follow the commit before the branch does, so that after the branch
        // moved the engine never has to touch the index again: an entry that differs from the commit then is
        // somebody's staging. Staged entries that are neither the parent's nor the commit's are somebody's work
        // already: nothing is published.
        let reset = self.index_paths(&parent, &commit);
        let reset = self.infra(&step, reset)?;
        if !reset.is_empty() {
            let staged = |rev: &str| -> Result<Vec<String>> {
                let mut a = vec!["diff", "--cached", "--name-only", "-z", "--no-renames", rev, "--"];
                a.extend(reset.iter().map(String::as_str));
                Ok(self.git.run(&a)?.split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
            };
            let both = staged(&parent).and_then(|a| staged(&commit).map(|b| a.into_iter().filter(|p| b.contains(p)).collect::<Vec<_>>()));
            let both = self.infra(&step, both)?;
            if !both.is_empty() {
                let what = format!("staged changes in {} are neither the parent's nor the round's commit: unstage or keep them elsewhere; nothing was committed", both.join(", "));
                self.halt_infra(&step, format!("{step} (staged work in claimed files)"), what);
                return Err(Halt);
            }
            let mut a = vec!["reset", "-q", commit.as_str(), "--"];
            a.extend(reset.iter().map(String::as_str));
            let r = self.git.run(&a);
            self.infra(&step, r)?;
        }
        let moved = self.git.run(&["update-ref", "-m", &format!("zodchi flow {}: round {n}", self.args.label), &self.branch, &commit, &parent]);
        if moved.is_err() && !reset.is_empty() {
            // The branch did not move: its index entries go back to the parent's.
            let mut a = vec!["reset", "-q", parent.as_str(), "--"];
            a.extend(reset.iter().map(String::as_str));
            let _ = self.git.run(&a);
        }
        self.infra(&step, moved)?;
        cut(&step);
        self.commit_receipt(&step, n, &parent, &commit, &tree)
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
            if !paths.is_empty() {
                let mut a = vec!["diff", "--cached", "--name-only", "-z", "--no-renames", commit, "--"];
                a.extend(paths.iter().map(String::as_str));
                let staged = self.git.run(&a);
                left = self.infra(step, staged)?.split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
            }
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

    fn review(&mut self, n: u32, summary: &str, unverified: &[String], verification: &Value) -> Step<Value> {
        let step = format!("review {n}");
        self.step = step.clone();
        let reviews = format!("reviews/review-{n}.json");
        let review_file = self.journal.file(&reviews).display().to_string();
        let attempt = self.attempt(&step);
        let prompt = if self.done(&step).is_some() || !self.journal.all("intent", &step, attempt).is_empty() {
            String::new()
        } else {
            let built = self.review_prompt(n, &step, summary, unverified, verification);
            self.infra(&step, built)?
        };
        let reviewer = self.reviewer.clone();
        let data = self.ask(&step, n, REVIEWER_GATEWAY_ROLE, &reviewer, &schema(REVIEW_SCHEMA), prompt, check_review)?;
        let w = self.journal.write_value(&reviews, &data);
        self.infra(&step, w)?;
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
        Ok(json!({ "verdict": data["verdict"], "summary": data["summary"], "findings": findings, "important": important, "blocking": important.len(), "reviewFile": review_file }))
    }

    fn review_prompt(&self, n: u32, step: &str, summary: &str, unverified: &[String], verification: &Value) -> Result<String> {
        let mut paths = vec!["diff", "--no-renames", &self.base, &self.head, "--"];
        paths.extend(self.claimed.iter().map(String::as_str));
        let diff = self.git.run(&paths)?;
        // Commands by source and number: their command lines stay with the engine.
        let all = verification["evidence"].as_array().cloned().unwrap_or_default();
        let evidence: Vec<String> = all.iter().enumerate().map(|(i, e)| format!("{} exit {}", checks::name(&all, i), e["exitCode"])).collect();
        let how = format!("{}{}{}", verification["stamp"].as_str().unwrap_or(""),
            verification["note"].as_str().filter(|s| !s.is_empty()).map(|s| format!(": {s}")).unwrap_or_default(),
            if evidence.is_empty() { String::new() } else { format!("; commands: {}", evidence.join(", ")) });
        let history = if n > 1 {
            format!("This is review round {n}. The previous review is attached as review-{}.json; the writer closed its important findings (its words are in the summary above), and the package's commits sit on top of the base.", n - 1)
        } else {
            "This is the first review of the change; its commit sits on top of the base.".into()
        };
        let focus = if self.review_md.is_some() {
            "REVIEW.md as of the base commit is attached as REVIEW.base.md: apply it; it says what the owner wants flagged and what not."
        } else {
            "The base commit has no REVIEW.md: judge by the brief."
        };
        let text = render(REVIEW, &[
            ("step", step.to_string()), ("run", self.id.clone()), ("base", self.base.clone()), ("summary", summary.to_string()),
            ("unverified", if unverified.is_empty() { "nothing named".into() } else { unverified.join("; ") }),
            ("verification", how), ("history", history), ("focus", focus.to_string()),
        ]);
        let mut required = vec![("change.diff".to_string(), diff.into_bytes()), ("brief".to_string(), self.brief.clone().into_bytes())];
        if let Some(r) = &self.review_md {
            required.push(("REVIEW.base.md".into(), r.clone().into_bytes()));
        }
        if n > 1 {
            let prev = std::fs::read(self.journal.file(&format!("reviews/review-{}.json", n - 1))).unwrap_or_default();
            required.push((format!("review-{}.json", n - 1), prev));
        }
        // The full copies of the claimed files are optional: the largest go first when the request is too large.
        let mut optional: Vec<(String, Vec<u8>)> = Vec::new();
        // Copies of the reviewed commit's blobs, never the live work tree.
        for p in &self.claimed {
            if let Some(bytes) = self.git.show(&self.head, p)? {
                if !bytes.contains(&0) {
                    optional.push((p.clone(), bytes));
                }
            }
        }
        let mut dropped: Vec<String> = Vec::new();
        loop {
            let note = if dropped.is_empty() { String::new() } else { format!("\n\nNot attached for size: {}", dropped.join(", ")) };
            let mut all = required.clone();
            all.extend(optional.iter().cloned());
            let prompt = compose_prompt(&format!("{text}{note}"), &all)?;
            if prompt.len() <= LIMIT_PROMPT || optional.is_empty() {
                return Ok(prompt);
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

/// A review answer by the schema: a verdict and findings with their fields.
fn check_review(v: &Value) -> std::result::Result<(), String> {
    if !["approved", "changes_requested", "blocked"].contains(&v["verdict"].as_str().unwrap_or("")) {
        return Err("verdict is approved, changes_requested or blocked".into());
    }
    let Some(list) = v["findings"].as_array() else { return Err("findings is a list".into()) };
    for f in list {
        for k in ["id", "severity", "location", "problem"] {
            if !f[k].is_string() {
                return Err(format!("a finding has no {k}"));
            }
        }
    }
    Ok(())
}

/// What verified a round: the slowest source that ran and passed, from the real exit codes. The stamp names the
/// sources and exit codes only, never a command.
fn verification(evidence: &[Value], has_verify: bool, has_checks: bool) -> Value {
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
    let by = if !receipts { "none" } else if sources.iter().any(|(s, _)| s == "args.verify") { "args.verify" } else { "checks" };
    let stamp = if by == "none" {
        "Verified: none".to_string()
    } else {
        format!("Verified: {}", sources.iter().map(|(s, c)| format!("{s} exit {}", c.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("/"))).collect::<Vec<_>>().join("; "))
    };
    let note = if by != "none" { String::new() } else if !has_verify && !has_checks { "not verified by running: no args.verify and no checks".into() } else { "not verified by running: a command has no exit code".into() };
    json!({ "verifiedBy": by, "evidence": evidence, "note": note, "stamp": stamp })
}
