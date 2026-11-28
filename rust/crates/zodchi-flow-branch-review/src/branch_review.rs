//! Branch review pins the committed trees and authors, then runs independent reviews through the shared journal.

use serde_json::{json, Map, Value};
use std::{fs, io::Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zodchi_core::{
    config::Config,
    job::{self, compose_prompt, LIMIT_PROMPT},
    role::{load_role, Overrides},
    util::{fail, iso, sha256_hex, GatewayError, Result},
};
use zodchi_flow_engine::{
    args,
    boundary::Launch,
    catalog::ProjectGate,
    checks, executor, gateway,
    git::Git,
    input_common,
    journal::{self, Journal},
    models::{self, Pick},
    package_source::Source,
    patch, review_contract, review_source,
    verify::{self, ProjectSettings},
    Exit,
};

pub const NAME: &str = "branch-review";
const VERSION: &str = "2";
const VERSION_ONE_DIGEST: &str = "637c33df2680a4cc321421dd523d45430dc8a5a01246ee25fea9451553f395a1";
const DIFF_ARGS: &[&str] = &["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
const VERIFY_STEP: &str = "verify";
const MAX_ROUNDS: u64 = 3;
struct ReviewStep {
    name: &'static str,
    model_role: &'static str,
    gateway_role: &'static str,
    instruction: &'static str,
}

const REVIEWS: [ReviewStep; 2] = [
    ReviewStep {
        name: "review",
        model_role: "reviewer",
        gateway_role: "code-review",
        instruction: "Review the exact committed change. Check behavior and whether the change meets the brief and the repository's review criteria.",
    },
    ReviewStep {
        name: "architecture",
        model_role: "architect",
        gateway_role: "architecture-review",
        instruction: "Review changes to contracts, storage, dependencies and authority. Limit the review to the committed change and its consequences.",
    },
];

fn review_steps(architecture: bool) -> &'static [ReviewStep] {
    &REVIEWS[..if architecture { 2 } else { 1 }]
}

fn review_models(
    table: &Map<String, Value>,
    claude: &mut models::ClaudeGate,
    authors: &[String],
    architecture: bool,
    mut check: impl FnMut(&ReviewStep, &Pick) -> std::result::Result<(), String>,
) -> Result<Map<String, Value>> {
    let mut pair = Map::new();
    let mut used = authors.to_vec();
    let mut skipped = Vec::new();
    for review in review_steps(architecture) {
        let pick = claude.one_shot(table, review.model_role, None, &mut skipped, |pick| {
            if used.contains(&pick.name()) {
                return Err("requires a model distinct from the authors and earlier reviewers".into());
            }
            check(review, pick)
        }).map_err(GatewayError)?;
        used.push(pick.name());
        pair.insert(review.model_role.into(), pick.to_json());
    }
    pair.insert("skipped".into(), json!(skipped));
    Ok(pair)
}

fn refused(why: String) -> Exit {
    Exit {
        code: 2,
        result: json!({ "workflow": NAME, "approved": false, "refused": why }),
    }
}

fn text_list(value: &Value, name: &str) -> Result<Vec<String>> {
    let values = match value {
        Value::String(text) => return Ok(vec![text.to_string()]),
        Value::Array(items) => items,
        _ => return fail(format!("args.{name} is a string or an array of strings.")),
    };
    values
        .iter()
        .map(|value| {
            value.as_str().map(String::from).ok_or_else(|| {
                GatewayError(format!("args.{name} contains an entry that is not text."))
            })
        })
        .collect()
}

fn review_diff(git: &Git, base: &str, head: &str, excluded: &[String], raw: bool) -> Result<String> {
    let mut args = DIFF_ARGS.to_vec();
    if raw {
        args.extend(["--raw", "-z"]);
    }
    if excluded.is_empty() {
        args.extend([base, head, "--"]);
        return git.run(&args);
    }
    let pathspecs: Vec<_> = excluded.iter().map(|path| format!(":(exclude,literal){path}")).collect();
    args.extend(["--no-renames", base, head, "--"]);
    args.extend(pathspecs.iter().map(String::as_str));
    git.run_env(&args, &[("GIT_LITERAL_PATHSPECS", "0".into())], None)
}

fn diff_files(raw: &str) -> Vec<review_source::File<'_>> {
    let mut fields = raw.split_terminator('\0');
    let mut files = Vec::new();
    while let (Some(header), Some(path)) = (fields.next(), fields.next()) {
        let header: Vec<_> = header.split_ascii_whitespace().collect();
        let [before, after, _, _, status] = header.as_slice() else { return Vec::new() };
        let paired = status.starts_with(['R', 'C']);
        let path = if paired {
            let Some(destination) = fields.next() else { return Vec::new() };
            destination
        } else {
            path
        };
        let regular = !paired && matches!(*before, ":000000" | ":100644" | ":100755")
            && matches!(*after, "000000" | "100644" | "100755");
        files.push(review_source::File { path, regular });
    }
    files
}

fn blob_receipt(git: &Git, commit: &str, file: &str) -> Result<Value> {
    let Some((mode, kind, blob)) = git.entry_at(commit, file)? else { return Ok(Value::Null) };
    if kind != "blob" || !mode.starts_with("100") {
        return fail(format!("args.exclude can only summarize regular files. {file} has mode {mode}."));
    }
    let bytes = git.run(&["cat-file", "-s", &blob])?.trim().parse::<u64>()
        .map_err(|_| GatewayError(format!("Git did not report the size of {file}.")))?;
    Ok(json!({ "blob": blob, "bytes": bytes, "mode": mode }))
}

fn fork_words(git: &Git, base: &str, public: bool) -> Result<Vec<String>> {
    if public || !git.is_fork()? {
        return Ok(Vec::new());
    }
    const PATH: &str = ".zodchi/allowed-words.txt";
    let Some((mode, _, _)) = git.entry_at(base, PATH)? else {
        return Ok(Vec::new());
    };
    if !mode.starts_with("100") {
        return fail("The fork allow-list in the review base must be a regular file.");
    }
    let bytes = git.show(base, PATH)?.unwrap_or_default();
    let text = std::str::from_utf8(&bytes).map_err(|_| GatewayError("The fork allow-list must be UTF-8.".into()))?;
    Ok(input_common::private_words(text.trim_start_matches('\u{feff}')))
}

fn coordinator_receipt(path: &str, head: &str, tree: &str) -> Result<Value> {
    let file = Path::new(path);
    if !file.is_absolute() || !fs::symlink_metadata(file)?.file_type().is_file() {
        return fail("args.verificationFile needs an absolute path to a regular JSON receipt.");
    }
    let mut bytes = Vec::new();
    let limit = LIMIT_PROMPT / 3;
    fs::File::open(file)?.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return fail(format!("The coordinator's verification receipt exceeds {limit} bytes."));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| GatewayError("The verification receipt must be UTF-8 JSON.".into()))?;
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| GatewayError(format!("Invalid verification receipt JSON: {error}")))?;
    if data["tree"] != tree || data.get("head").is_some_and(|value| value != head) {
        return fail("The coordinator's verification receipt must match the exact candidate tree and any supplied head.");
    }
    let rows = data["commands"].as_array().filter(|rows| !rows.is_empty())
        .ok_or_else(|| GatewayError("The verification receipt needs a nonempty commands array.".into()))?;
    let mut commands = Vec::with_capacity(rows.len());
    for row in rows {
        let command = row["command"].as_str().filter(|name| !name.trim().is_empty())
            .ok_or_else(|| GatewayError("A verification receipt command needs nonempty command text.".into()))?;
        if row["exitCode"].as_i64() != Some(0) || row.get("output").is_some_and(|value| !value.is_string()) {
            return fail("The coordinator's receipt needs exitCode 0 for every command and optional text output.");
        }
        commands.push(json!({ "command": command, "exitCode": 0, "output": row["output"] }));
    }
    Ok(json!({ "provenance": "coordinator", "head": head, "tree": tree,
        "receiptSha256": sha256_hex(bytes), "commands": commands }))
}

struct ReviewHistory {
    previous: Option<String>,
    round: u64,
    limit: u64,
    reviews: Vec<Value>,
}

fn review_history(raw: &Value, cfg: &Config, repo: &Path, base: &str) -> Result<ReviewHistory> {
    let declared = raw.get("rounds").map(|value| {
        value.as_u64().filter(|count| (1..=MAX_ROUNDS).contains(count))
            .ok_or_else(|| GatewayError(format!("args.rounds must be a whole number from 1 to {MAX_ROUNDS}.")))
    }).transpose()?;
    let Some(previous) = raw.get("previousReview") else {
        return Ok(ReviewHistory { previous: None, round: 1, limit: declared.unwrap_or(MAX_ROUNDS), reviews: Vec::new() });
    };
    let id = previous.as_str().filter(|id| journal::is_run_id(id))
        .ok_or_else(|| GatewayError("args.previousReview needs a branch-review run ID.".into()))?;
    let (journal, run) = Journal::open(&cfg.home, id)?;
    let prior_repo = run["repo"].as_str().and_then(|path| fs::canonicalize(path).ok());
    if run["workflow"] != NAME || run["base"] != base || prior_repo.as_deref() != Some(fs::canonicalize(repo)?.as_path())
        || run["sourceRun"].as_str() != raw["sourceRun"].as_str()
    {
        return fail("args.previousReview needs a branch-review of the same repository, base and source package.");
    }
    let result = journal.read_value("result.json").filter(|_| {
        journal.snapshot().is_ok_and(|events| events.iter().any(|event| event["kind"] == "finished"))
    }).ok_or_else(|| GatewayError("args.previousReview must name a finished review.".into()))?;
    let limit = run["reviewLimit"].as_u64().unwrap_or(MAX_ROUNDS);
    let round = run["reviewRound"].as_u64().unwrap_or(1) + 1;
    if declared.is_some_and(|count| count != limit) {
        return fail("The review chain keeps the rounds limit of its first run.");
    }
    if round > limit {
        return fail(format!("The review chain reached its limit of {limit} round(s)."));
    }
    let mut reviews = run["reviewHistory"].as_array().cloned().unwrap_or_default();
    reviews.push(json!({ "runId": id, "head": result["head"], "verdict": result["verdict"],
        "review": result["review"], "architecture": result["architecture"] }));
    Ok(ReviewHistory { previous: Some(id.to_string()), round, limit, reviews })
}

fn verify_candidate(journal: &mut Journal, run: &Value, cfg: &Config, available: usize) -> Result<Value> {
    let step = VERIFY_STEP;
    let attempt = journal.attempt(step);
    if let Some(done) = journal.last("done", step, attempt) {
        return Ok(done["result"].clone());
    }
    let head = run["head"].as_str().ok_or_else(|| GatewayError("The review has no pinned head.".into()))?;
    let tree = run["tree"].as_str().ok_or_else(|| GatewayError("The review has no pinned tree.".into()))?;
    let git = Git::new(cfg.root.as_deref().ok_or_else(|| GatewayError("The review has no repository.".into()))?);
    let plan = &run["localVerification"];
    let fast = args::commands(plan.get("checks"), "checks").map_err(GatewayError)?;
    let verify = args::commands(plan.get("verify"), "verify").map_err(GatewayError)?;
    let project = ProjectSettings::from_json(plan)?;
    let paths = checks::ProjectPaths::new(&cfg.home, &git)?;
    let mut slot = checks::CheckSlot::acquire(&cfg.home, journal, step, attempt)?;
    checks::reap_unended(journal)?;
    let logs = journal.file(&format!("logs/verify-{attempt}"));
    let batch = checks::CheckBatch {
        step, round: 1, attempt, tree, head: Some(head), logs: &logs, limit: Duration::from_secs(3600),
        environment: checks::CommandEnvironment { repo: Some(&git.root), extra: Some(&project.env) },
        checks: ("args.checks", &fast),
        verify: ("args.verify", &verify),
    };
    let outcome = batch.run(&mut slot, journal, &paths, &project.cache, |staging| {
        let snapshot = git.init_snapshot(staging)?;
        snapshot.run(&["reset", "--hard", "--quiet", "--no-recurse-submodules", head])?;
        Ok(())
    })?;
    let (checkout, evidence) = match outcome {
        checks::CheckOutcome::Finished { checkout, evidence } => (checkout, evidence),
        checks::CheckOutcome::Unknown(why) => return fail(format!("{why}. Inspect the attempt before explicitly rerunning verify.")),
    };
    let mut places = vec![
        (checkout.to_string_lossy().into_owned(), "<verification-checkout>"),
        (git.root.to_string_lossy().into_owned(), "<repo>"),
        (cfg.home.to_string_lossy().into_owned(), "<zodchi-home>"),
    ];
    places.extend(paths.private_places());
    let allowed: Vec<_> = run["reviewPolicy"]["forkWords"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(String::from).collect();
    let scrubber = input_common::Scrubber::new(cfg)?.allow_words(&allowed);
    let budget = available.min(32 * 1024) / 6 / evidence.len().max(1);
    let commands: Vec<_> = evidence.iter().map(|item| {
        let log = Path::new(item["log"].as_str().unwrap_or(""));
        let output = checks::review_output(log, budget, |raw| scrubber.text(raw, &places));
        let mut command = json!({
            "command": item["command"], "source": item["source"], "exitCode": item["exitCode"],
            "note": item["note"], "output": output,
        });
        scrubber.value(&mut command, &places);
        command
    }).collect();
    let result = json!({ "ok": checks::passed(&evidence), "head": head, "tree": tree, "evidence": evidence, "commands": commands });
    journal.append(json!({ "kind": "done", "step": step, "attempt": attempt, "result": result }))?;
    Ok(result)
}

pub fn project_handoff(run: &Value, result: &Value, handoff: &mut Value) {
    handoff["head"] = run["head"].clone();
    handoff["screening"] = run["screening"].clone();
    for key in ["previousReview", "reviewRound", "reviewLimit", "verificationReceipt"] {
        if let Some(value) = run.get(key).filter(|value| !value.is_null()) {
            handoff[key] = value.clone();
        }
    }
    handoff["review"] = json!({ "verdict": result["review"]["verdict"],
        "openFindings": result["blocking"].as_array().map(Vec::len) });
}

pub fn start(raw: &Value, launch: Option<Launch>, require_workflow: ProjectGate) -> Result<Exit> {
    match prepare(raw, require_workflow) {
        Ok((id, journal)) => {
            if let Some(launch) = launch {
                launch(&journal, &id)
            } else {
                resume(&id, None, None)
            }
        }
        Err(error) => Ok(refused(error.0)),
    }
}

fn prepare(raw: &Value, require_workflow: ProjectGate) -> Result<(String, Journal)> {
    let Some(fields) = raw.as_object() else {
        return fail("branch-review needs a JSON object for its arguments.");
    };
    if let Some(key) = fields.keys().find(|key| {
        ![
            "repo",
            "base",
            "head",
            "author",
            "sourceRun",
            "verificationRun",
            "verificationFile",
            "previousReview",
            "rounds",
            "checks",
            "verify",
            "label",
            "tmp",
            "brief",
            "context",
            "exclude",
            "publicRepo",
            "architecture",
            "models",
        ]
        .contains(&key.as_str())
    }) {
        return fail(format!("Unknown branch-review argument: {key}"));
    }
    let label = raw["label"]
        .as_str()
        .filter(|text| zodchi_core::util::is_key(text) && text.len() <= 40)
        .ok_or_else(|| GatewayError("branch-review needs a short args.label.".into()))?;
    let repo = raw["repo"]
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            GatewayError(
                "branch-review needs the absolute path to the Git checkout in args.repo.".into(),
            )
        })?;
    let architecture = match raw.get("architecture") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return fail("args.architecture is true or false."),
    };
    let public = match raw.get("publicRepo") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return fail("args.publicRepo is true or false."),
    };
    let overrides = match raw.get("models") {
        None => serde_json::Map::new(),
        Some(Value::Object(roles)) => roles.clone(),
        Some(_) => return fail("args.models is an object of role settings."),
    };
    let git = Git::new(&repo);
    let top = git.run(&["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top.trim())? != fs::canonicalize(&repo)? {
        return fail("args.repo must be the top directory of the Git checkout.");
    }
    let cfg = Config::new(Some(&repo))?;
    let server = executor::flow_server(&cfg);
    let read_text = |key: &str| -> Result<Option<&str>> {
        raw.get(key)
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| GatewayError(format!("args.{key} must be nonempty text.")))
            })
            .transpose()
    };
    let source = read_text("sourceRun")?
        .map(|id| Source::load(&cfg.home, &repo, id))
        .transpose()?;
    if source.is_some() && (raw.get("base").is_some() || raw.get("head").is_none()) {
        return fail(
            "Use args.head with args.sourceRun. The source package supplies the comparison base.",
        );
    }
    let base_ref = match &source {
        Some(source) => source.base()?,
        None => read_text("base")?.ok_or_else(|| {
            GatewayError("branch-review needs args.base or args.sourceRun.".into())
        })?,
    };
    let resolve = |name: &str| {
        git.rev(&format!("{name}^{{commit}}"))
            .map_err(|_| GatewayError(format!("Cannot resolve {name} to a commit.")))
    };
    let base = resolve(base_ref)?;
    let head = resolve(read_text("head")?.unwrap_or("HEAD"))?;
    let mut history = review_history(raw, &cfg, &repo, &base)?;
    if source.is_some() && !git.test(&["merge-base", "--is-ancestor", &base, &head])? {
        return fail("The candidate does not descend from the source package base.");
    }
    let tree = git.rev(&format!("{head}^{{tree}}"))?;
    require_workflow(&git, &head, NAME)?;
    if server.is_none() {
        job::ensure_ignored(&cfg)?;
    }
    let changed = git.changes(&base, &head)?;
    let files: Vec<String> = changed.iter().map(|(_, file)| file.clone()).collect();
    if files.is_empty() {
        return fail("There are no committed file changes to review in that range.");
    }
    let mut authors = raw
        .get("author")
        .map(|v| text_list(v, "author"))
        .transpose()?
        .unwrap_or_default();
    if let Some(source) = &source {
        source.check_range(&git, &head, &files)?;
        for writer in source.writers()? {
            if !authors.contains(&writer) {
                authors.push(writer);
            }
        }
    }
    if authors.is_empty()
        || authors.iter().any(|author| {
            author
                .split_once('/')
                .is_none_or(|(provider, model)| provider.is_empty() || model.trim().is_empty())
        })
    {
        return fail("args.author names each author as provider/model.");
    }
    let checks = args::commands(raw.get("checks"), "checks").map_err(GatewayError)?;
    let verify = args::commands(raw.get("verify"), "verify").map_err(GatewayError)?;
    let local_verification = if !checks.is_empty() || !verify.is_empty() {
        let paths = checks::ProjectPaths::new(&cfg.home, &git)?;
        let project = ProjectSettings::load(&git, &base, &head, &paths, checks.iter().chain(&verify))?;
        checks::preflight()?;
        checks::preflight_tools(&project.tools)?;
        let mut plan = project.to_json();
        plan["checks"] = json!(checks);
        plan["verify"] = json!(verify);
        Some(plan)
    } else { None };
    let verification_run = read_text("verificationRun")?;
    let verification_file = read_text("verificationFile")?;
    if [local_verification.is_some(), verification_run.is_some(), verification_file.is_some()]
        .into_iter().filter(|chosen| *chosen).count() > 1
    {
        return fail("Choose args.verificationRun, args.verificationFile or local verification commands for this review.");
    }
    let verification = if let Some(file) = verification_file {
        Some(coordinator_receipt(file, &head, &tree)?)
    } else { match verification_run {
        Some(id) => {
            let (journal, run) = Journal::open(&cfg.home, id)?;
            let evidence = if run["workflow"] == verify::NAME {
                verify::run_evidence(&journal, &run, id, &repo, &tree)?
            } else {
                Source::load(&cfg.home, &repo, id)?.evidence(&tree)
            };
            Some(evidence.ok_or_else(|| GatewayError(format!("Run {id} has no passing checks for tree {tree}.")))?)
        }
        None if local_verification.is_none() => source.as_ref().and_then(|s| s.evidence(&tree)),
        None => None,
    } };
    let mut excluded = raw.get("exclude").map(|value| text_list(value, "exclude"))
        .transpose()?.unwrap_or_default();
    excluded.sort();
    excluded.dedup();
    let mut excluded_diff = Vec::new();
    for file in &excluded {
        let Some((change, _)) = changed.iter().find(|(_, path)| path == file).filter(|_| patch::plain(file)) else {
            return fail(format!("args.exclude must name a changed Git path. {file} is outside that list."));
        };
        excluded_diff.push(json!({
            "path": file, "change": change,
            "before": blob_receipt(&git, &base, file)?,
            "after": blob_receipt(&git, &head, file)?,
        }));
    }
    let diff = review_diff(&git, &base, &head, &excluded, false)?;
    let paths = review_diff(&git, &base, &head, &excluded, true)?;
    let places = [
        (repo.to_string_lossy().into_owned(), "<repo>"),
        (cfg.home.to_string_lossy().into_owned(), "<zodchi-home>"),
    ];
    let allowed = fork_words(&git, &base, public)?;
    let scrubber = input_common::Scrubber::new(&cfg)?.allow_words(&allowed);
    let clean = |bytes: &[u8]| {
        scrubber
            .text(&String::from_utf8_lossy(bytes), &places)
            .into_bytes()
    };
    let (screened, omissions) = review_source::screen(&diff, &diff_files(&paths), &scrubber, &places);
    let withheld = omissions.len();
    let screening = json!({ "diffLines": diff.lines().count(), "diffLinesWithheld": withheld,
        "withheld": omissions, "forkAllowlistApplied": !allowed.is_empty() });
    let mut attachments = vec![("candidate.diff".to_string(), screened.into_bytes())];
    if !excluded_diff.is_empty() {
        let mut visible = json!(excluded_diff);
        scrubber.value(&mut visible, &places);
        attachments.push(("excluded-diff.json".into(), visible.to_string().into_bytes()));
    }
    if let Some(source) = &source {
        attachments.push(("package-brief.md".into(), clean(source.initial_brief())));
        let mut context = source.review_context();
        scrubber.value(&mut context, &places);
        attachments.push((
            "previous-review.json".into(),
            context.to_string().into_bytes(),
        ));
    }
    if let Some(evidence) = &verification {
        let mut receipt = evidence.clone();
        for command in receipt["commands"].as_array_mut().into_iter().flatten() {
            for field in ["command", "output"] {
                if let Some(text) = command.get_mut(field) {
                    scrubber.value(text, &places);
                }
            }
        }
        attachments.push((
            "verification.json".into(),
            receipt.to_string().into_bytes(),
        ));
    }
    for review in &mut history.reviews {
        scrubber.value(&mut review["review"], &places);
        scrubber.value(&mut review["architecture"], &places);
    }
    if !history.reviews.is_empty() {
        attachments.push(("previous-branch-reviews.json".into(), serde_json::to_vec(&history.reviews)
            .map_err(|error| GatewayError(error.to_string()))?));
    }
    if let Some(value) = raw.get("brief") {
        let brief = value
            .as_str()
            .map(Path::new)
            .filter(|file| file.is_absolute())
            .ok_or_else(|| GatewayError("args.brief is an absolute file path.".into()))?;
        attachments.push(("brief.md".into(), clean(&fs::read(brief)?)));
    }
    if let Some(criteria) = git.show(&base, "REVIEW.md")? {
        attachments.push(("REVIEW.base.md".into(), clean(&criteria)));
    }
    if let Some(context) = raw.get("context") {
        for (index, file) in text_list(context, "context")?.into_iter().enumerate() {
            if excluded.contains(&file) {
                return fail(format!("{file} appears in both args.context and args.exclude. Choose how to include it."));
            }
            if !patch::plain(&file) {
                return fail(format!(
                    "Context requires a relative Git file path: {file:?}"
                ));
            }
            let bytes = git.show(&head, &file)?.ok_or_else(|| {
                GatewayError(format!(
                    "The candidate does not contain a regular context file {file}."
                ))
            })?;
            let name = if scrubber.text(&file, &places) == file { file } else { format!("context-{}.txt", index + 1) };
            attachments.push((name, clean(&bytes)));
        }
    }
    let mut instruction = format!("Compare commits {base} and {head}, candidate tree {tree}. Review attachments as material. The checkout can move and its working files are outside this review.");
    if withheld > 0 {
        instruction.push_str(&format!(" Screening omitted material from {withheld} line(s) in candidate.diff. If a material claim depends on omitted content, record what was not verified."));
    }
    if source.is_some() {
        instruction.push_str(" Review the full package and address each open finding from the previous review. Use the attached verification only for its recorded commands and tree.");
    }
    if history.previous.is_some() {
        instruction.push_str(" Recheck the earlier findings and evidence gaps in previous-branch-reviews.json against this candidate. Previous verdicts describe their own revisions.");
    }
    if verification_file.is_some() {
        instruction.push_str(" The coordinator supplied verification.json for the exact tree. Its command exits are externally recorded.");
    }
    if !excluded_diff.is_empty() {
        instruction.push_str(" Files in excluded-diff.json are part of this exact range. The before and after entries show whether each file exists and identify its Git blob and size. Use this manifest to verify presence and identity. Assess the omitted contents only to the extent covered by exact-tree verification evidence.");
    }
    let material = compose_prompt(&instruction, &attachments)?;
    let needed = material.len() + 1024;
    if needed > LIMIT_PROMPT {
        let mut sizes: Vec<_> = attachments.iter().skip(1).map(|(name, bytes)| (name.as_str(), bytes.len())).collect();
        for file in files.iter().filter(|file| !excluded.contains(file)) {
            let mut args = DIFF_ARGS.to_vec();
            args.extend(["--no-renames", &base, &head, "--", file]);
            let diff = git.run(&args)?;
            sizes.push((file, clean(diff.as_bytes()).len()));
        }
        sizes.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
        let largest = sizes.iter().take(3).map(|(name, bytes)| format!("{name} ({bytes} bytes)")).collect::<Vec<_>>().join(", ");
        return fail(format!("Review material needs {needed} bytes with its reserve (gateway limit {LIMIT_PROMPT} bytes). Largest contributions are {largest}. Use args.exclude for large data diffs or reduce the context."));
    }
    let table = models::table(&cfg, &repo, &overrides).map_err(GatewayError)?;
    let mut claude = models::ClaudeGate::of(&table);
    let local_codex = models::local_codex(&cfg, "The local Codex gateway is not configured.");
    let server = server.map(|url| executor::server::Server::new(cfg.clone(), url));
    let pair = review_models(&table, &mut claude, &authors, architecture, |review, pick| {
        if pick.provider == "codex" {
            if let Some(server) = &server {
                return server.preflight(&[review.gateway_role]).map_err(|error| error.0);
            }
            local_codex()?;
        }
        load_role(&cfg, review.gateway_role, &Overrides::default()).map_err(|error| error.0)?;
        Ok(())
    })?;
    let id = journal::new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"), "createdAt": iso(),
        "label": label, "repo": repo, "base": base, "head": head, "files": files, "architecture": architecture,
        "pair": pair, "authors": authors, "tree": tree, "sourceRun": source.as_ref().map(|s| &s.id),
        "verificationRun": verification.as_ref().and_then(|v| v["runId"].as_str()), "excludedDiff": excluded_diff,
        "localVerification": local_verification,
        "verificationReceipt": verification.as_ref().filter(|v| v["provenance"] == "coordinator").map(|v| json!({
            "provenance": "coordinator", "tree": v["tree"], "sha256": v["receiptSha256"],
        })),
        "previousReview": history.previous, "reviewRound": history.round, "reviewLimit": history.limit,
        "reviewHistory": history.reviews,
        "reviewPolicy": { "forkWords": allowed }, "screening": screening,
        "inputs": { "args": raw, "materialSha256": sha256_hex(&material) },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    journal.write_text("material.md", &material)?;
    Ok((id, journal))
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    let version = run["version"].as_str().unwrap_or("");
    if run["workflow"] != NAME
        || !matches!(version, "1" | VERSION)
        || given.is_some_and(|value| value != &run["inputs"]["args"])
    {
        return fail(format!(
            "Run {id} does not match this branch-review command."
        ));
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        if retry.is_some() {
            return fail("This review has finished.");
        }
        if !journal
            .events()
            .iter()
            .any(|event| event["kind"] == "finished")
        {
            journal.append(json!({ "kind": "finished", "step": "result" }))?;
        }
        return Ok(exit(result));
    }
    if let Some(step) = retry {
        if !journal
            .last_event()
            .is_some_and(|event| event["kind"] == "stop" && event["step"] == step)
        {
            return fail("Retry must name the stopped step.");
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }
    if version == "1" {
        journal.verify_legacy_workflow(&run, VERSION_ONE_DIGEST)?;
    }
    let mut material = journal.read_verified("material.md", &run["inputs"]["materialSha256"])?;
    let cfg = Config::new(run["repo"].as_str().map(Path::new))?;
    let schema: Value = serde_json::from_str(review_contract::REVIEW_SCHEMA).expect("review schema");
    let mut result = json!({
        "runId": id, "workflow": NAME, "version": version, "label": run["label"], "base": run["base"],
        "head": run["head"], "files": run["files"], "models": run["pair"], "journal": journal.dir,
    });
    for name in ["sourceRun", "verificationRun", "verificationReceipt", "tree", "excludedDiff", "screening",
        "previousReview", "reviewRound", "reviewLimit"] {
        if let Some(value) = run.get(name).filter(|v| !v.is_null()) {
            result[name] = value.clone();
        }
    }
    if run["localVerification"].is_object() {
        let available = LIMIT_PROMPT.saturating_sub(material.len() + 1024);
        let verification = match verify_candidate(&mut journal, &run, &cfg, available) {
            Ok(verification) => verification,
            Err(error) => return stopped(&mut journal, result, VERIFY_STEP, "infrastructure at verify", &error.0),
        };
        result["verification"] = verification.clone();
        if verification["ok"] != true {
            return stopped(&mut journal, result, VERIFY_STEP, "checks failed at verify", "Verification commands did not pass on the pinned candidate tree.");
        }
        let receipt = json!({
            "head": verification["head"], "tree": verification["tree"], "ok": true,
            "commands": verification["commands"],
        });
        material = compose_prompt(&material, &[("verification.json".into(), receipt.to_string().into_bytes())])?;
    }
    let mut reviews = serde_json::Map::new();
    for review in review_steps(run["architecture"] == true) {
        let ReviewStep {
            name: step,
            model_role,
            gateway_role,
            instruction,
        } = *review;
        if run["pair"][model_role].is_null() {
            return fail(format!("The journal has no model for {model_role}."));
        }
        let pick = Pick::from_json(&run["pair"][model_role]);
        let call = gateway::Call {
            id,
            step,
            round: 1,
            role: gateway_role,
            pick: &pick,
            schema: &schema,
            writer_workspace: None,
            prompt: format!(
                "Step: {step} ({NAME} v{version}, run {id})\n\n{instruction}\n\n{material}"
            ),
        };
        match gateway::ask(&mut journal, &cfg, call, review_contract::check_review) {
            Ok(data) => {
                reviews.insert(step.into(), data);
            }
            Err(error) => {
                let (at, reason) = match error {
                    gateway::CallError::Stop { at, reason } => (at, reason),
                    gateway::CallError::Context { .. } => (
                        format!("context too large at {step}"),
                        "The review material and owner remarks exceed the gateway limit.".into(),
                    ),
                };
                return stopped(&mut journal, result, step, &at, &reason);
            }
        }
    }
    let blocking: Vec<_> = reviews
        .values()
        .flat_map(review_contract::blocking_findings)
        .collect();
    let approved = blocking.is_empty()
        && reviews
            .values()
            .all(|review| review["verdict"] == "approved");
    let verdict = if approved {
        "approved"
    } else if reviews
        .values()
        .any(|review| review["verdict"] == "blocked")
    {
        "blocked"
    } else {
        "changes_requested"
    };
    result["approved"] = json!(approved);
    result["verdict"] = json!(verdict);
    result["blocking"] = json!(blocking);
    result["review"] = reviews.remove("review").expect("required review");
    result["architecture"] = reviews.remove("architecture").unwrap_or(Value::Null);
    journal.write_value("result.json", &result)?;
    journal.append(json!({ "kind": "finished", "step": "result" }))?;
    Ok(exit(result))
}

fn stopped(journal: &mut Journal, mut result: Value, step: &str, at: &str, reason: &str) -> Result<Exit> {
    journal.append(json!({ "kind": "stop", "step": step, "stoppedAt": at, "what": reason }))?;
    result["stoppedAt"] = json!(at);
    result["infra"] = json!(reason);
    result["approved"] = json!(false);
    Ok(exit(result))
}

fn exit(result: Value) -> Exit {
    Exit {
        code: if result["approved"] == true { 0 } else { 2 },
        result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_review_picks_are_independent_by_provider_and_model() {
        let (mut table, mut claude) = models::test_one_shot_gate(&["reviewer", "architect"], true);
        table.get_mut("architect").unwrap()["candidates"][1]["model"] = json!("opus");
        let pair = review_models(&table, &mut claude, &["codex/author".into()], true, |_, _| Ok(())).unwrap();
        assert_eq!(pair["reviewer"]["provider"], "claude");
        assert_eq!(pair["reviewer"]["account"], "claude-0123456789abcdef");
        assert_eq!(pair["architect"], json!({"provider":"codex","model":"opus","effort":"medium"}));
        assert!(pair["skipped"][0].as_str().unwrap().contains("architect claude/opus: requires a model distinct"));

        let pair = review_models(&table, &mut claude, &["claude/opus".into()], false, |_, _| Ok(())).unwrap();
        assert_eq!(pair["reviewer"]["provider"], "codex");
        assert!(pair["skipped"][0].as_str().unwrap().contains("reviewer claude/opus: requires a model distinct"));
    }
}
