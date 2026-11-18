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
        // Every path the engine passes is a literal file path, never a pattern.
        c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_LITERAL_PATHSPECS", "1").env_remove("GIT_INDEX_FILE").env_remove("GIT_DIR").env_remove("GIT_WORK_TREE");
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

    /// The tree entry of a path in a commit: (mode, type, object id), or None when the commit has no such path. A
    /// commit Git cannot read is an error, never a missing path.
    pub fn entry_at(&self, commit: &str, path: &str) -> Result<Option<(String, String, String)>> {
        let out = self.run(&["ls-tree", "-z", commit, "--", path])?;
        for entry in out.split('\0') {
            let Some((meta, name)) = entry.split_once('\t') else { continue };
            if name != path {
                continue;
            }
            let mut f = meta.split(' ');
            if let (Some(mode), Some(kind), Some(id)) = (f.next(), f.next(), f.next()) {
                return Ok(Some((mode.to_string(), kind.to_string(), id.to_string())));
            }
        }
        Ok(None)
    }

    pub fn exists_at(&self, commit: &str, path: &str) -> Result<bool> {
        Ok(self.entry_at(commit, path)?.is_some())
    }

    /// The bytes of a file (a blob) in a commit, or None when the commit has no file at that path.
    pub fn show(&self, commit: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let Some((_, kind, id)) = self.entry_at(commit, path)? else { return Ok(None) };
        if kind != "blob" {
            return Ok(None);
        }
        let out = self.output(&["cat-file", "blob", &id], &[], None)?;
        if !out.status.success() {
            return fail(format!("git cat-file {commit}:{path} failed"));
        }
        Ok(Some(out.stdout))
    }

    /// The mode of a path in the user's index ("100755", ...), or None when it is not there.
    pub fn index_mode(&self, path: &str) -> Result<Option<String>> {
        let out = self.run(&["ls-files", "-s", "-z", "--", path])?;
        Ok(out.split('\0').find(|e| e.split_once('\t').map(|(_, n)| n) == Some(path)).and_then(|e| e.split(' ').next()).map(String::from))
    }

    /// The paths that differ between two tree-ishes, with their status letter (A, M, D, T), renames as add and delete.
    pub fn changes(&self, from: &str, to: &str) -> Result<Vec<(String, String)>> {
        let out = self.run(&["diff-tree", "-r", "-z", "--name-status", "--no-renames", from, to])?;
        let mut parts = out.split('\0').filter(|s| !s.is_empty());
        let mut list = Vec::new();
        while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
            list.push((status.to_string(), path.to_string()));
        }
        Ok(list)
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
    /// removed), written through an index of its own; the paths of `exec` keep their executable mode (a renamed
    /// script). The user's index and work tree stay as they are. A tree that differs from the parent anywhere but at
    /// the claimed paths themselves is refused.
    pub fn candidate_tree(&self, parent: &str, paths: &[String], exec: &[String], scratch: &Path) -> Result<String> {
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
        let mut chmod = vec!["update-index", "--chmod=+x", "--"];
        chmod.extend(exec.iter().filter(|p| paths.contains(p) && self.root.join(p).is_file()).map(String::as_str));
        let moded = added.and_then(|_| if chmod.len() > 3 { self.run_env(&chmod, &env, None) } else { Ok(String::new()) });
        let tree = moded.and_then(|_| self.run_env(&["write-tree"], &env, None));
        let _ = std::fs::remove_file(&index);
        let tree = tree?.trim().to_string();
        // Claims compare without case, as the claim files keep them.
        let stray: Vec<String> = self.changes(parent, &tree)?.into_iter().map(|(_, p)| p).filter(|p| !paths.iter().any(|c| c.to_lowercase() == p.to_lowercase())).collect();
        if !stray.is_empty() {
            return fail(format!("the candidate tree changes paths that are not claimed files: {}", stray.join(", ")));
        }
        Ok(tree)
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
