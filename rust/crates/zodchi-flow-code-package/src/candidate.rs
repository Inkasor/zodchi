//! A private checkout for a package and an explicit, recoverable application of its reviewed commit.

use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
};
use zodchi_core::{
    config::Config,
    util::{fail, read_stored, sha256_hex, write_json_atomic, GatewayError, Result},
};
use zodchi_flow_engine::{
    boundary::{cut, Exit},
    checks, claims, cleanup,
    git::Git,
    journal::{candidate_applied, Journal},
    package_source::Source,
    patch::{self, Plan},
};

pub const BRANCH: &str = "refs/heads/flow-candidate";

pub(crate) fn latest(project: &Git, id: &str) -> Result<Option<Value>> {
    let prefix = format!("refs/zodchi/candidates/{id}/");
    let refs = project.run(&["for-each-ref", "--format=%(refname)", &prefix])?;
    let Some((round, reference)) = refs.lines()
        .filter_map(|reference| Some((reference.strip_prefix(&prefix)?.parse::<u32>().ok()?, reference)))
        .max_by_key(|(round, _)| *round)
    else {
        return Ok(None);
    };
    let commit = project.rev(reference)?;
    let tree = project.rev(&format!("{commit}^{{tree}}"))?;
    Ok(Some(json!({ "commit": commit, "tree": tree, "ref": reference, "round": round })))
}

pub fn prepare(project: &Git, stage: &Git, base: &str) -> Result<()> {
    if stage.root.exists() {
        let top = stage.run(&["rev-parse", "--show-toplevel"])?;
        if fs::canonicalize(top.trim())? != fs::canonicalize(&stage.root)? {
            return fail("The saved private checkout is not its own Git root.");
        }
        return Ok(());
    }
    let tmp = stage
        .root
        .with_extension(format!("prepare-{:08x}", rand::random::<u32>()));
    fs::create_dir_all(tmp.parent().expect("private checkout parent"))?;
    fs::create_dir(&tmp)?;
    let create = || -> Result<()> {
        let snapshot = project.init_snapshot(&tmp)?;
        for (key, fallback) in [("user.name", "Zodchi"), ("user.email", "flow@localhost")] {
            let value = project.run(&["config", "--get", key]).unwrap_or_default();
            snapshot.run(&[
                "config",
                key,
                if value.trim().is_empty() {
                    fallback
                } else {
                    value.trim()
                },
            ])?;
        }
        for key in ["core.autocrlf", "core.eol"] {
            if let Ok(value) = project.run(&["config", "--get", key]) {
                snapshot.run(&["config", key, value.trim()])?;
            }
        }
        snapshot.run(&["config", "commit.gpgsign", "false"])?;
        snapshot.run(&["symbolic-ref", "HEAD", BRANCH])?;
        snapshot.run(&[
            "reset",
            "--hard",
            "--quiet",
            "--no-recurse-submodules",
            base,
        ])?;
        fs::rename(&tmp, &stage.root)?;
        Ok(())
    };
    let result = create();
    if result.is_err() {
        checks::remove(&tmp);
    }
    result
}

/// Hold the exact, cumulative commit reviewed by Sol under a private ref in the target repository.
pub fn pin(
    project: &Git,
    stage: &Git,
    id: &str,
    round: u32,
    base: &str,
    tree: &str,
    label: &str,
) -> Result<Value> {
    let reference = format!("refs/zodchi/candidates/{id}/{round}");
    let commit = match project.rev(&reference) {
        Ok(existing) => existing,
        Err(_) => {
            let commit = if project.rev(&format!("{base}^{{tree}}"))? == tree {
                base.to_string()
            } else {
                stage
                    .run(&["commit-tree", tree, "-p", base, "-m", label])?
                    .trim()
                    .to_string()
            };
            stage.run(&["update-ref", &reference, &commit])?;
            project.run(&[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--no-recurse-submodules",
                "--",
                stage
                    .root
                    .to_str()
                    .ok_or_else(|| GatewayError("Invalid private checkout path.".into()))?,
                &format!("{reference}:{reference}"),
            ])?;
            commit
        }
    };
    if project.rev(&reference)? != commit
        || project.rev(&format!("{commit}^{{tree}}"))? != tree
        || (commit != base && project.rev(&format!("{commit}^1"))? != base)
    {
        return fail(format!(
            "Candidate ref {reference} does not identify the checked tree and base."
        ));
    }
    Ok(json!({ "commit": commit, "tree": tree, "ref": reference, "round": round }))
}

pub fn apply(id: &str) -> Result<Exit> {
    match apply_approved(id) {
        Ok(result) => Ok(Exit { code: 0, result }),
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({ "runId": id, "status": "blocked", "reason": error.0 }),
        }),
    }
}

fn apply_approved(id: &str) -> Result<Value> {
    let home = Config::new(None)?.home;
    let (mut journal, run) = Journal::open(&home, id)?;
    let _run_lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = candidate_applied(journal.events()) {
        return Ok(result);
    }
    let repo = Path::new(text(&run, "repo")?);
    let mut source = Source::load(&home, repo, id)?;
    if !source.args.isolated || source.result["approved"] != true {
        return fail("Only an approved isolated package can be applied.");
    }
    source.args.allow_owner_check_changes(journal.events());
    let base = source.base()?;
    let candidate = &source.result["candidate"];
    let commit = text(candidate, "commit")?;
    let tree = text(candidate, "tree")?;
    let reference = text(candidate, "ref")?;
    let branch = text(&run, "branch")?;
    let git = Git::new(repo);
    let changes = git.changes(base, commit)?;
    let paths: Vec<_> = changes.into_iter().map(|(_, p)| p).collect();
    source.check_range(&git, commit, &paths)?;
    if !reference.starts_with(&format!("refs/zodchi/candidates/{id}/"))
        || git.rev(reference)? != commit
        || git.rev(&format!("{commit}^{{tree}}"))? != tree
        || (commit != base && git.rev(&format!("{commit}^1"))? != base)
    {
        return fail("The retained candidate differs from the approved commit, tree or base.");
    }
    let claims_dir = claims::claims_dir(&source.args.repo_norm);
    let applications = claims_dir.join("applications");
    fs::create_dir_all(&applications)?;
    let _checkout_lock = Journal::lock_directory(applications.join("lock"))?;
    let pending = applications.join("pending.json");
    if let Some(other) = read_stored(&pending)
        .and_then(|p| p["runId"].as_str().map(String::from))
        .filter(|s| s != id)
    {
        let (other_journal, _) = Journal::open(&home, &other)?;
        if candidate_applied(&other_journal.snapshot()?).is_none() {
            return fail(format!("Application of run {other} was interrupted. Resolve it before applying another candidate."));
        }
    }
    let tip = branch_tip(&git, branch)?;
    let intent = journal
        .events()
        .iter()
        .find(|e| e["kind"] == "application intent")
        .cloned();
    let target = if let Some(intent) = &intent {
        // An older application intent always uses the original candidate on its base.
        Application {
            parent: intent["parent"].as_str().unwrap_or(base).to_owned(),
            commit: intent["commit"].as_str().unwrap_or(commit).to_owned(),
            tree: intent["tree"].as_str().unwrap_or(tree).to_owned(),
        }
    } else if tip == base || tip == commit {
        Application { parent: base.to_owned(), commit: commit.to_owned(), tree: tree.to_owned() }
    } else {
        moved_application(&git, &source.args.repo_norm, base, &tip, commit, tree, &paths, &journal.file("tmp"))?
    };
    let Application { parent, commit: landed, tree: landed_tree } = target;
    if tip != parent && tip != landed {
        return fail(format!(
            "The target branch moved from {parent} to {tip} during an interrupted application. The planned commit is {landed}."
        ));
    }
    if tip == parent && landed != parent {
        let keys: Vec<_> = source.files.iter().map(|p| p.to_lowercase()).collect();
        let plan = if let Some(intent) = &intent {
            if !claims::holds(&claims_dir, &source.args.label, id, &keys) {
                return fail("The interrupted application no longer holds its file claim.");
            }
            journal
                .read_value("plans/application.json")
                .and_then(|v| Plan::from_json(&v))
                .filter(|p| {
                    sha256_hex(p.to_json().to_string()) == intent["digest"].as_str().unwrap_or("")
                })
                .ok_or_else(|| {
                    GatewayError("The interrupted application has no intact plan.".into())
                })?
        } else {
            let scratch = checks::temp_dir(id, "application")?;
            let plan = plan_application(&git, &parent, &landed, &paths, &scratch);
            checks::remove(&scratch);
            let plan = plan?;
            let conflicts = claims::open(
                &claims_dir,
                &source.args.label,
                id,
                &keys,
                &source.args.brief,
                &parent,
            )?;
            if !conflicts.is_empty() {
                return fail(format!(
                    "Application claim conflict: {}",
                    conflicts.join("; ")
                ));
            }
            // A package from an older release may be creating its first shared receipt now.
            cleanup::note_package_home(&home, id);
            journal.write_value("plans/application.json", &plan.to_json())?;
            write_json_atomic(&pending, &json!({ "runId": id }))?;
            journal.append(json!({
                "kind": "application intent", "step": "apply candidate", "digest": sha256_hex(plan.to_json().to_string()),
                "parent": parent, "commit": landed, "tree": landed_tree,
            }))?;
            plan
        };
        index_transition(&git, &parent, &landed, &paths, intent.is_some())?;
        if branch_tip(&git, branch)? != parent {
            return fail("The target branch moved before candidate files were written.");
        }
        match patch::reconcile(&git, &plan)? {
            "applied" => {},
            "partial" => patch::apply_recoverable(&git, &plan)?,
            _ => return fail("A path of the application differs from both the original and approved states. Inspect the saved plan before resuming."),
        }
        cut("candidate files");
        let verified = git.candidate_tree(&parent, &paths, &plan.exec, &journal.file("tmp"))?;
        if verified != landed_tree {
            return fail("The applied files do not reproduce the approved tree. The branch was not advanced.");
        }
        if branch_tip(&git, branch)? != parent {
            return fail("The target branch moved before updating the index.");
        }
        let to_reset = index_transition(&git, &parent, &landed, &paths, intent.is_some())?;
        git.reset_index_paths(&landed, &to_reset)?;
        cut("candidate index");
        if branch_tip(&git, branch)? != parent {
            return fail("The target branch moved before publishing the approved commit.");
        }
        git.run(&[
            "update-ref",
            "-m",
            "zodchi: apply approved candidate",
            branch,
            &landed,
            &parent,
        ])?;
        cut("candidate branch");
    }
    if journal
        .events()
        .iter()
        .any(|e| e["kind"] == "application intent")
        && !claims::close(&claims_dir, &source.args.label, id, "done")?
    {
        return fail("The commit landed, but the application claim could not be closed.");
    }
    let mut result = json!({ "runId": id, "status": "applied", "branch": branch, "commit": landed, "tree": landed_tree });
    if landed != commit {
        result["candidateCommit"] = json!(commit);
    }
    journal.append(
        json!({ "kind": "application finished", "step": "apply candidate", "result": result }),
    )?;
    Ok(result)
}

struct Application {
    parent: String,
    commit: String,
    tree: String,
}

#[allow(clippy::too_many_arguments)]
fn moved_application(git: &Git, repo: &str, base: &str, tip: &str, commit: &str, tree: &str, paths: &[String], scratch: &Path) -> Result<Application> {
    let folded = |path: &str| claims::fold(repo, path);
    let changed: Vec<_> = git.changes(base, tip)?.into_iter().map(|(_, path)| folded(&path)).collect();
    let within = |path: &str, prefix: &str| path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'));
    let overlapping: Vec<_> = paths.iter().filter(|path| {
        let path = folded(path);
        changed.iter().any(|other| *other == path || within(&path, other) || within(other, &path))
    }).cloned().collect();
    if !overlapping.is_empty() {
        return fail(format!("The target branch moved from {base} to {tip}. Overlapping files: {}.", overlapping.join(", ")));
    }
    let (commit, tree) = if paths.is_empty() {
        (tip.to_owned(), git.rev(&format!("{tip}^{{tree}}"))?)
    } else {
        let combined = git.overlay_tree(tip, commit, paths, scratch)?;
        let rewritten = git.copy_commit(commit, base, tree, tip, &combined)?;
        (rewritten, combined)
    };
    Ok(Application { parent: tip.to_owned(), commit, tree })
}

fn text<'a>(record: &'a Value, field: &str) -> Result<&'a str> {
    record[field]
        .as_str()
        .ok_or_else(|| GatewayError(format!("The candidate record is missing {field}.")))
}

fn branch_tip(git: &Git, branch: &str) -> Result<String> {
    if git.branch()?.as_deref() != Some(branch) {
        return fail(format!(
            "Check out {branch} before applying this candidate."
        ));
    }
    git.rev(branch)
}

fn index_transition(
    git: &Git,
    base: &str,
    commit: &str,
    paths: &[String],
    recovering: bool,
) -> Result<Vec<String>> {
    let from_base = git.staged_paths(base, paths)?;
    let from_candidate = git.staged_paths(commit, paths)?;
    let conflicts: Vec<_> = from_base
        .iter()
        .filter(|p| from_candidate.contains(p) || !recovering)
        .collect();
    if !conflicts.is_empty() {
        return fail(format!("Staged work in application paths: {conflicts:?}"));
    }
    Ok(from_candidate)
}

fn plan_application(
    git: &Git,
    base: &str,
    commit: &str,
    paths: &[String],
    scratch: &Path,
) -> Result<Plan> {
    let dirty = Git::with_preview(|| git.dirty())?;
    let mut present = vec![];
    for path in paths {
        if patch::claimed_as(&dirty, path).is_some() || !patch::no_links(&git.root, path) {
            return fail(format!("Application would overwrite local work at {path}."));
        }
        for revision in [base, commit] {
            if let Some((mode, kind, _)) = git.entry_at(revision, path)? {
                if kind != "blob" || !matches!(mode.as_str(), "100644" | "100755") {
                    return fail(format!("Application requires a regular file at {path}."));
                }
                if revision == commit {
                    present.push(path.clone());
                }
            }
        }
        if !git.exists_at(base, path)? && fs::symlink_metadata(git.root.join(path)).is_ok() {
            return fail(format!("An untracked path already exists at {path}."));
        }
    }
    let export = scratch.join("files");
    git.export_paths(commit, &export, scratch, Some(&present))?;
    let mut plan = Plan {
        writes: BTreeMap::new(),
        before: BTreeMap::new(),
        after: BTreeMap::new(),
        exec: vec![],
        modes: BTreeMap::new(),
    };
    for path in paths {
        let bytes = present
            .contains(path)
            .then(|| fs::read(export.join(path)))
            .transpose()?;
        let executable = git
            .entry_at(commit, path)?
            .is_some_and(|(mode, _, _)| mode == "100755");
        if executable {
            plan.exec.push(path.clone());
        }
        #[cfg(unix)]
        if bytes.is_some() {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(git.root.join(path))
                .map(|m| m.permissions().mode() & 0o7777)
                .unwrap_or(if executable { 0o755 } else { 0o644 });
            plan.modes.insert(
                path.clone(),
                if executable {
                    mode | 0o100
                } else {
                    mode & !0o111
                },
            );
        }
        plan.before.insert(path.clone(), git.blob_of_file(path)?);
        plan.after.insert(
            path.clone(),
            bytes.as_ref().map(|b| git.blob_of(b)).transpose()?,
        );
        plan.writes.insert(path.clone(), bytes);
    }
    if let Some(path) = Git::with_preview(|| git.dirty())?
        .iter()
        .find(|p| patch::claimed_as(paths, p).is_some())
    {
        return fail(format!("Application would overwrite local work at {path}."));
    }
    Ok(plan)
}
