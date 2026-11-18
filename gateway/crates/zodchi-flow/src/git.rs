//! Git, run as a program in the repository of the run. Every call names its arguments exactly (no shell), and an
//! alternate index (`GIT_INDEX_FILE`) keeps the candidate tree and the export away from the user's own index.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use zodchi_core::util::{fail, GatewayError, Result};

pub struct Git {
    pub root: PathBuf,
}

impl Git {
    pub fn new(root: &Path) -> Git {
        Git { root: root.to_path_buf() }
    }

    fn command(&self, env: &[(&str, OsString)]) -> Command {
        let mut c = Command::new("git");
        c.arg("-C").arg(&self.root).args(["-c", "core.quotepath=false"]);
        c.env("GIT_TERMINAL_PROMPT", "0").env_remove("GIT_INDEX_FILE").env_remove("GIT_DIR").env_remove("GIT_WORK_TREE");
        for (k, v) in env {
            c.env(k, v);
        }
        c
    }

    /// Runs git and returns its output, whatever the exit code.
    pub fn output(&self, args: &[&str], env: &[(&str, OsString)], stdin: Option<&[u8]>) -> Result<Output> {
        let mut c = self.command(env);
        c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        let mut child = c.spawn().map_err(|e| GatewayError(format!("git could not start: {e}")))?;
        if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(bytes)?;
        }
        Ok(child.wait_with_output()?)
    }

    /// Runs git and returns its stdout; a non-zero exit is an error that quotes git.
    pub fn run_env(&self, args: &[&str], env: &[(&str, OsString)], stdin: Option<&[u8]>) -> Result<String> {
        let out = self.output(args, env, stdin)?;
        if !out.status.success() {
            return fail(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn run(&self, args: &[&str]) -> Result<String> {
        self.run_env(args, &[], None)
    }

    /// Exit 0 is true, 1 is false, anything else an error.
    pub fn test(&self, args: &[&str]) -> Result<bool> {
        let out = self.output(args, &[], None)?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => fail(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim())),
        }
    }

    pub fn rev(&self, what: &str) -> Result<String> {
        Ok(self.run(&["rev-parse", "--verify", "--quiet", what])?.trim().to_string())
    }

    /// The branch HEAD names, or None when HEAD is detached.
    pub fn branch(&self) -> Result<Option<String>> {
        let out = self.output(&["symbolic-ref", "-q", "HEAD"], &[], None)?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if out.status.success() && !name.is_empty() { Some(name) } else { None })
    }

    /// Every path `git status` lists (both sides of a rename), relative to the repository.
    pub fn dirty(&self) -> Result<Vec<String>> {
        let text = self.run(&["status", "--porcelain=v1", "-z", "-uall"])?;
        let mut out = Vec::new();
        let mut parts = text.split('\0').filter(|s| !s.is_empty());
        while let Some(entry) = parts.next() {
            if entry.len() < 4 {
                continue;
            }
            out.push(entry[3..].to_string());
            if entry.starts_with('R') || entry.starts_with('C') {
                if let Some(from) = parts.next() {
                    out.push(from.to_string());
                }
            }
        }
        Ok(out)
    }

    pub fn exists_at(&self, commit: &str, path: &str) -> Result<bool> {
        self.test(&["cat-file", "-e", &format!("{commit}:{path}")])
    }

    pub fn show(&self, commit: &str, path: &str) -> Result<Option<Vec<u8>>> {
        if !self.exists_at(commit, path)? {
            return Ok(None);
        }
        let out = self.output(&["cat-file", "blob", &format!("{commit}:{path}")], &[], None)?;
        if !out.status.success() {
            return fail(format!("git cat-file {commit}:{path} failed"));
        }
        Ok(Some(out.stdout))
    }

    /// The blob id of bytes as they are, without the filters of `git add` (the id a patch is written against).
    pub fn blob_of(&self, bytes: &[u8]) -> Result<String> {
        Ok(self.run_env(&["hash-object", "--no-filters", "--stdin"], &[], Some(bytes))?.trim().to_string())
    }

    /// The blob id of a file in the work tree as it is, or None when there is no such file.
    pub fn blob_of_file(&self, rel: &str) -> Result<Option<String>> {
        match std::fs::read(self.root.join(rel)) {
            Ok(bytes) => Ok(Some(self.blob_of(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// The tree of `parent` with the claimed paths taken from the work tree as `git add -A` takes them (deleted ones
    /// removed), written through an index of its own. The user's index and work tree stay as they are.
    pub fn candidate_tree(&self, parent: &str, paths: &[String], scratch: &Path) -> Result<String> {
        std::fs::create_dir_all(scratch)?;
        let index = scratch.join(format!("index-{}", rand::random::<u32>()));
        let env = [("GIT_INDEX_FILE", index.clone().into_os_string())];
        self.run_env(&["read-tree", parent], &env, None)?;
        // A path that is neither in the work tree nor in the parent has nothing to add (git would refuse it).
        let mut present = Vec::new();
        for p in paths {
            if self.root.join(p).exists() || self.exists_at(parent, p)? {
                present.push(p.as_str());
            }
        }
        let mut args = vec!["add", "-A", "-f", "--"];
        args.extend(present.iter().copied());
        let added = if present.is_empty() { Ok(String::new()) } else { self.run_env(&args, &env, None) };
        let tree = added.and_then(|_| self.run_env(&["write-tree"], &env, None));
        let _ = std::fs::remove_file(&index);
        Ok(tree?.trim().to_string())
    }

    /// Writes the files of `tree` into `dir` (which must not exist yet), through an index of its own.
    pub fn export(&self, tree: &str, dir: &Path, scratch: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let index = scratch.join(format!("index-{}", rand::random::<u32>()));
        let env = [("GIT_INDEX_FILE", index.clone().into_os_string())];
        let prefix = format!("{}/", dir.display().to_string().replace('\\', "/"));
        let done = self.run_env(&["read-tree", tree], &env, None).and_then(|_| self.run_env(&["checkout-index", "-a", "-f", &format!("--prefix={prefix}")], &env, None));
        let _ = std::fs::remove_file(&index);
        done.map(|_| ())
    }
}
