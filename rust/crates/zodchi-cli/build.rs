use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

fn git(source: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.current_dir(source).env("GIT_OPTIONAL_LOCKS", "0");
    for name in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(name);
    }
    let output = command.args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn watch(path: &Path) {
    if let Some(path) = path.to_str().filter(|path| !path.contains(['\r', '\n'])) {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn revision(source: &Path) -> Option<String> {
    let git_marker = source.join(".git");
    if !git_marker.exists() {
        return None;
    }
    if git_marker.is_file() {
        watch(&git_marker);
    }

    // Resolve Git's paths for both ordinary checkouts and linked worktrees.
    let branch = git(source, &["symbolic-ref", "--quiet", "HEAD"]);
    let mut args = vec!["rev-parse", "--path-format=absolute"];
    for path in ["HEAD", "index", "packed-refs", "reftable"] {
        args.extend(["--git-path", path]);
    }
    if let Some(branch) = branch.as_deref() {
        args.extend(["--git-path", branch.trim()]);
    }
    let git_paths = git(source, &args)?;
    let mut paths = git_paths.lines().map(Path::new);
    if branch.is_some() {
        // A packed ref can become loose without a change to HEAD or packed-refs.
        let loose = paths.next_back()?;
        if let Some(path) = loose.ancestors().find(|path| path.exists()) {
            watch(path);
        }
    }
    for path in paths.filter(|path| path.exists()) {
        watch(path);
    }

    // Watch worktree inputs without walking ignored build output or the object store.
    if let Some(files) = git(
        source,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    ) {
        for file in files.split_terminator('\0') {
            watch(&source.join(file));
        }
    }
    let commit = git(source, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let status = git(
        source,
        &["status", "--porcelain", "--untracked-files=normal"],
    )?;
    let suffix = if status.is_empty() { "" } else { "-dirty" };
    Some(format!("{}{suffix}", commit.trim()))
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PATH");
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let stamp = if manifest.ends_with("rust/crates/zodchi-cli") {
        manifest.ancestors().nth(3).and_then(revision)
    } else {
        None
    };
    println!(
        "cargo:rustc-env=ZODCHI_BUILD_COMMIT={}",
        stamp.as_deref().unwrap_or("unknown")
    );
}
