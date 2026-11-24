//! Immutable input from a finished code package in the same checkout.

use crate::{args, claims, code_package, git::Git, journal::Journal, patch};
use serde_json::{json, Value};
use std::{fs, path::Path};
use zodchi_core::util::{fail, GatewayError, Result};

pub(crate) struct Source {
    pub id: String,
    pub run: Value,
    pub result: Value,
    pub brief: Vec<u8>,
    pub args: args::Args,
    pub files: Vec<String>,
}

impl Source {
    pub fn load(home: &Path, repo: &Path, id: &str) -> Result<Self> {
        let (journal, run) = Journal::open(home, id)?;
        if run["workflow"] != code_package::WORKFLOW || run["runId"] != id {
            return fail(format!("Run {id} is not a code package."));
        }
        let same_repo = run["repo"]
            .as_str()
            .filter(|p| Path::new(p).is_absolute())
            .and_then(|p| fs::canonicalize(p).ok());
        if same_repo.as_deref() != Some(fs::canonicalize(repo)?.as_path()) {
            return fail(format!("Run {id} belongs to a different checkout."));
        }
        if !journal
            .snapshot()?
            .iter()
            .any(|event| event["kind"] == "finished")
        {
            return fail(format!(
                "Run {id} has not finished. Resume it before using its result."
            ));
        }
        let result = journal
            .read_value("result.json")
            .filter(|r| r["runId"] == id)
            .ok_or_else(|| GatewayError(format!("Run {id} has no readable final result.")))?;
        let brief = journal
            .read_verified("brief.md", &run["inputs"]["briefSha256"])?
            .into_bytes();
        let mut raw = run["inputs"]["args"].clone();
        raw["repo"] = run["repo"].clone();
        let args = args::parse(&raw).map_err(GatewayError)?;
        let mut files = args.files.clone();
        if let Some(added) = result["claimAdded"].as_array() {
            for v in added {
                let p = v.as_str().filter(|p| patch::plain(p)).ok_or_else(|| {
                    GatewayError(format!("Run {id} has an invalid claimed path."))
                })?;
                if !files.contains(&p.to_string()) {
                    files.push(p.to_string());
                }
            }
        }
        Ok(Self {
            id: id.into(),
            run,
            result,
            brief,
            args,
            files,
        })
    }

    pub fn base(&self) -> Result<&str> {
        self.run["base"]
            .as_str()
            .ok_or_else(|| GatewayError(format!("Run {} has no base.", self.id)))
    }

    pub fn writer(&self) -> Result<String> {
        let pick = &self.run["pair"][self.args.writer_role()];
        let provider = pick["provider"].as_str();
        let model = pick["model"].as_str();
        match (provider, model) {
            (Some(provider), Some(model)) => Ok(format!("{provider}/{model}")),
            _ => fail(format!("Run {} has no recorded writer.", self.id)),
        }
    }

    pub fn initial_brief(&self) -> &[u8] {
        self.run["history"]["originalBrief"]
            .as_str()
            .map(str::as_bytes)
            .unwrap_or(&self.brief)
    }

    pub fn writers(&self) -> Result<Vec<String>> {
        let mut authors: Vec<_> = self.run["priorWriters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();
        let writer = self.writer()?;
        if !authors.contains(&writer) {
            authors.push(writer);
        }
        Ok(authors)
    }

    pub fn check_range(&self, git: &Git, head: &str, files: &[String]) -> Result<()> {
        let fold = |p: &str| claims::fold(&self.args.repo_norm, p);
        let allowed: Vec<_> = self.files.iter().map(|p| fold(p)).collect();
        for path in files {
            if !allowed.contains(&fold(path)) {
                return fail(format!("{path} is outside the approved files of run {}. Review a range containing only that package.", self.id));
            }
        }
        // A successor can keep an already-authorized test change from its seed. Compare against that seed
        // too, so deleting a test introduced by the previous run is detected even when it disappears from
        // the cumulative diff against the original base.
        let seed = self.run["seed"].as_str().unwrap_or(self.base()?);
        for (status, path) in git.changes(seed, head)? {
            if (status != "A" || args::is_project_configuration(&path))
                && args::is_protected(&self.args, &path)
                && !self.args.allow_check_changes.contains(&path.to_lowercase())
            {
                return fail(format!(
                    "{path} is protected by the verification plan of run {}.",
                    self.id
                ));
            }
        }
        Ok(())
    }

    pub fn seed(&self, git: &Git, base: &str, branch: &str, files: &[String]) -> Result<String> {
        if !self.args.isolated || self.base()? != base || self.run["branch"] != branch {
            return fail(format!(
                "Run {} must have a retained candidate on this target branch and base.",
                self.id
            ));
        }
        let candidate = &self.result["candidate"];
        let reference = candidate["ref"]
            .as_str()
            .filter(|r| r.starts_with(&format!("refs/zodchi/candidates/{}/", self.id)))
            .ok_or_else(|| GatewayError(format!("Run {} has no retained candidate.", self.id)))?;
        let commit = git.rev(reference)?;
        let tree = git.rev(&format!("{commit}^{{tree}}"))?;
        if candidate["commit"] != commit || candidate["tree"] != tree {
            return fail(format!(
                "The retained candidate for run {} has changed.",
                self.id
            ));
        }
        for (_, path) in git.changes(base, &commit)? {
            if patch::claimed_as(files, &path).is_none() {
                return fail(format!(
                    "Claim {path} to carry forward all changes from run {}.",
                    self.id
                ));
            }
        }
        Ok(commit)
    }

    pub fn review_context(&self) -> Value {
        let last = self.result["rounds"]
            .as_array()
            .and_then(|rounds| rounds.iter().rev().find(|r| r["review"].is_object()));
        let findings = if last.is_some() {
            &self.result["openFindings"]
        } else {
            &self.run["history"]["openFindings"]
        };
        let failed: Vec<_> = self.result["verification"]["evidence"].as_array().into_iter().flatten()
            .filter(|e| e["exitCode"] != 0).map(|e| json!({ "command": e["command"], "source": e["source"], "exitCode": e["exitCode"] })).collect();
        json!({
            "sourceRun": self.id, "base": self.run["base"], "approvedFiles": self.files,
            "reviewedCommit": last.map(|r| &r["commit"]["commit"]), "round": last.map(|r| &r["n"]),
            "reviewVerdict": last.map(|r| &r["review"]["verdict"]),
            "previousVerdict": self.result["verdict"], "previousStop": self.result["stoppedAt"], "openFindings": findings, "failedChecks": failed,
        })
    }

    /// Evidence is reusable only for the checked tree, and is still attributed to its original run.
    pub fn evidence(&self, tree: &str) -> Option<Value> {
        let checked = self.result["rounds"].as_array()?.iter().rev().find(|r| {
            let checks = &r["checks"];
            checks["tree"] == tree
                && checks["ok"] == true
                && checks["evidence"].as_array().is_some_and(|items| {
                    !items.is_empty() && items.iter().all(|e| e["exitCode"] == 0)
                })
        })?;
        let commands: Vec<_> = checked["checks"]["evidence"]
            .as_array()?
            .iter()
            .map(|e| {
                json!({
                    "command": e["command"], "source": e["source"], "exitCode": e["exitCode"],
                })
            })
            .collect();
        Some(json!({ "tree": tree, "runId": self.id, "round": checked["n"], "commands": commands }))
    }
}
