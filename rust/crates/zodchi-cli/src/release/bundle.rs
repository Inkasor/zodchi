use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zodchi_core::{
    process::command_without_window,
    util::{fail, sha256_hex, GatewayError, Result},
};

pub(super) const VERSION: &str = env!("CARGO_PKG_VERSION");
pub(super) const MARKETPLACE: &str = "zodchi-local";
pub(super) const MAX_ARCHIVE: u64 = 64 * 1024 * 1024;
const MAX_CONTENTS: u64 = 128 * 1024 * 1024;
const CLI: &str = if cfg!(windows) {
    "bin/zodchi.exe"
} else {
    "bin/zodchi"
};
const PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    std::env::consts::OS
};
const ARCH: &str = if cfg!(target_arch = "x86_64") {
    "x64"
} else if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    std::env::consts::ARCH
};
const PLUGIN: &str = "marketplace/plugins/zodchi";
const BUILD_INFO: &str = "marketplace/plugins/zodchi/zodchi-build.json";
const SKILLS: &[&str] = &["verify", "zodchi-flow"];
const REQUIRED: &[&str] = &[
    CLI,
    "models.json",
    "roles/flow-work.json",
    "marketplace/.agents/plugins/marketplace.json",
    "marketplace/.claude-plugin/marketplace.json",
    "marketplace/plugins/zodchi/.codex-plugin/plugin.json",
    "marketplace/plugins/zodchi/.claude-plugin/plugin.json",
    "marketplace/plugins/zodchi/assets/workflows/catalog.json",
    "marketplace/plugins/zodchi/skills/verify/SKILL.md",
    "marketplace/plugins/zodchi/skills/zodchi-flow/SKILL.md",
];

pub(super) fn artifact_name() -> String {
    format!("zodchi-{PLATFORM}-{ARCH}.bundle.json.gz")
}

pub(super) fn version_numbers(version: &str) -> Option<[u32; 3]> {
    let mut parts = version.split('.');
    let mut numbers = [0; 3];
    for number in &mut numbers {
        let part = parts.next()?;
        if part.len() > 9
            || part.starts_with('0') && part.len() > 1
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(numbers)
}

pub(super) fn is_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(super) fn read_json(file: &Path) -> Result<Value> {
    json_bytes(&fs::read(file)?, &file.display().to_string())
}

pub(super) fn json_bytes(bytes: &[u8], label: &str) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|err| GatewayError(format!("{label}: {err}")))
}

pub(super) fn read_limited(reader: impl Read, limit: u64, label: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return fail(format!("{label} exceeds the {limit} byte limit."));
    }
    Ok(bytes)
}

fn directory(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return fail(format!(
            "Expected a regular directory at {}.",
            path.display()
        ));
    }
    Ok(())
}

fn regular(path: &Path) -> Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.is_file() {
        return fail(format!("Expected a regular file at {}.", path.display()));
    }
    fs::read(path).map_err(Into::into)
}

fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let parent = path.parent().expect("release file destination");
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    if executable {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("serializable JSON value");
    bytes.push(b'\n');
    write_new(path, &bytes, false)
}

fn source_commit(source: &Path) -> Option<String> {
    let git = |args: &[&str]| {
        let out = command_without_window("git")
            .arg("-C")
            .arg(source)
            .args(args)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    if !git(&["rev-parse", "--show-prefix"])?.is_empty()
        || !git(&["status", "--porcelain"])?.is_empty()
    {
        return None;
    }
    git(&["rev-parse", "--verify", "HEAD^{commit}"])
}

pub(super) fn build_marketplace(root: &Path, source: &Path) -> Result<Value> {
    let declared = read_json(&source.join("package.json"))?;
    if declared["version"] != VERSION {
        return fail("Build the CLI from the version being packaged.");
    }
    let catalog = regular(&source.join("workflows/catalog.json"))?;
    if json_bytes(&catalog, "workflow catalog")? != zodchi_flow::cli(&["list".into()])?.result {
        return fail("The CLI and marketplace contain different workflow catalogs.");
    }
    let folder = "./plugins/zodchi";
    let plugin = root.join(folder);
    fs::create_dir(root)?;
    for skill in SKILLS {
        let file = format!("skills/{skill}/SKILL.md");
        let content = regular(&source.join(&file))?;
        let text = String::from_utf8_lossy(&content).replace("\r\n", "\n");
        if !text.starts_with(&format!("---\nname: {skill}\n"))
            || !text
                .lines()
                .skip(1)
                .take_while(|line| *line != "---")
                .any(|line| {
                    line.strip_prefix("description: ")
                        .is_some_and(|value| !value.trim().is_empty())
                })
        {
            return fail(format!("Invalid skill frontmatter: {file}"));
        }
        write_new(&plugin.join(file), &content, false)?;
    }
    for doc in [
        "acceptance.md",
        "method-question.md",
        "research.md",
        "rubric-probe.md",
        "asset-round.md",
        "unity-check.md",
        "workspace-audit.md",
        "design-brief.md",
        "incident-triage.md",
        "incident-adapter.md",
        "flow.md",
        "ops-script.md",
        "flow-video.md",
        "voiceover.md",
        "youtube-publish.md",
        "video-manifest.md",
        "flow-claude.md",
        "model-roles.md",
        "verification.md",
        "flow-server.md",
        "subscriptions.md",
        "install.md",
        "install.ru.md",
        "install-from-source.md",
        "install-from-source.ru.md",
    ] {
        let file = Path::new("docs").join(doc);
        write_new(&plugin.join(&file), &regular(&source.join(file))?, false)?;
    }
    write_new(
        &plugin.join("assets/workflows/catalog.json"),
        &catalog,
        false,
    )?;
    write_new(
        &plugin.join("hooks/hooks.json"),
        &regular(&source.join("install/session-start-hooks.json"))?,
        false,
    )?;
    write_new(
        &plugin.join("LICENSE"),
        &regular(&source.join("LICENSE"))?,
        false,
    )?;
    write_json(
        &plugin.join("zodchi-build.json"),
        &json!({ "sourceCommit": source_commit(source) }),
    )?;
    let metadata = json!({
        "name": "zodchi", "version": VERSION,
        "description": "Use the local Zodchi workflow catalog, CLI and shared run journal.",
        "author": { "name": "Zodchi" }, "license": "MIT",
        "repository": env!("CARGO_PKG_REPOSITORY")
    });
    write_json(&plugin.join(".claude-plugin/plugin.json"), &metadata)?;
    let mut codex = metadata.clone();
    codex["skills"] = json!("./skills/");
    write_json(&plugin.join(".codex-plugin/plugin.json"), &codex)?;
    let mut portable = metadata;
    portable["$schema"] = json!("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    write_json(&plugin.join("plugin.json"), &portable)?;
    write_json(
        &root.join(".agents/plugins/marketplace.json"),
        &json!({
            "name": MARKETPLACE, "interface": { "displayName": "Zodchi" },
            "plugins": [{ "name": "zodchi", "source": { "source": "local", "path": folder },
                "category": "Productivity", "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" } }]
        }),
    )?;
    write_json(
        &root.join(".claude-plugin/marketplace.json"),
        &json!({
            "name": MARKETPLACE, "owner": { "name": "Zodchi" },
            "plugins": [{ "name": "zodchi", "source": folder }]
        }),
    )?;
    Ok(
        json!({ "name": "zodchi", "version": VERSION, "root": plugin, "skills": SKILLS, "marketplace": root }),
    )
}

fn files(root: &Path, prefix: &str, contents: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    directory(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| GatewayError("Release paths must be UTF-8.".into()))?;
        let relative = format!("{prefix}{name}");
        if entry.file_type()?.is_dir() {
            files(&entry.path(), &format!("{relative}/"), contents)?;
        } else {
            contents.insert(relative, regular(&entry.path())?);
        }
    }
    Ok(())
}

pub(super) fn build_release(root: &Path, source: &Path, archive: bool) -> Result<Value> {
    let mut contents = BTreeMap::new();
    contents.insert(CLI.into(), fs::read(std::env::current_exe()?)?);
    contents.insert("LICENSE".into(), regular(&source.join("LICENSE"))?);
    contents.insert("models.json".into(), regular(&source.join("models.json"))?);
    files(&source.join("roles"), "roles/", &mut contents)?;
    fs::create_dir(root)?;
    let marketplace = root.join("marketplace");
    build_marketplace(&marketplace, source)?;
    for (file, bytes) in &contents {
        write_new(&root.join(file), bytes, file == CLI)?;
    }
    files(&marketplace, "marketplace/", &mut contents)?;
    let checksums: Map<String, Value> = contents
        .iter()
        .map(|(file, bytes)| (file.clone(), json!(sha256_hex(bytes))))
        .collect();
    let manifest = json!({
        "version": VERSION, "platform": PLATFORM, "architecture": ARCH,
        "cli": CLI, "marketplace": "marketplace", "sha256": checksums, "devJournalVersion": 1
    });
    check_manifest(&manifest)?;
    write_json(&root.join("release.json"), &manifest)?;
    let mut result =
        json!({ "root": root, "version": VERSION, "cli": CLI, "marketplace": "marketplace" });
    if archive {
        let files = contents
            .into_iter()
            .map(|(name, data)| (name, Value::String(STANDARD.encode(data))))
            .collect::<Map<_, _>>();
        let data = serde_json::to_vec(&json!({ "manifest": manifest, "files": files }))
            .expect("serializable release");
        if data.len() as u64 > MAX_CONTENTS {
            return fail("The uncompressed release is too large.");
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&data)?;
        let compressed = encoder.finish()?;
        if compressed.len() as u64 > MAX_ARCHIVE {
            return fail("The release archive is too large.");
        }
        let output = root
            .parent()
            .expect("absolute bundle path")
            .join(artifact_name());
        write_new(&output, &compressed, false)?;
        result["archive"] = json!(output);
        result["sha256"] = json!(sha256_hex(&compressed));
    }
    Ok(result)
}

fn safe_path(file: &str) -> bool {
    file.split('/').all(|part| {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let reserved = ["con", "prn", "aux", "nul"].contains(&stem.as_str())
            || stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit();
        !part.is_empty()
            && !part.ends_with('.')
            && !reserved
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}

fn check_manifest(manifest: &Value) -> Result<&Map<String, Value>> {
    if manifest["version"]
        .as_str()
        .and_then(version_numbers)
        .is_none()
        || manifest["platform"] != PLATFORM
        || manifest["architecture"] != ARCH
        || manifest["cli"] != CLI
        || manifest["marketplace"] != "marketplace"
    {
        return fail("The release manifest does not match this platform.");
    }
    let checksums = manifest["sha256"]
        .as_object()
        .ok_or_else(|| GatewayError("The release is missing its file digests.".into()))?;
    let mut paths = HashSet::new();
    for (file, digest) in checksums {
        if !safe_path(file)
            || file.eq_ignore_ascii_case("release.json")
            || !paths.insert(file.to_ascii_lowercase())
            || !digest.as_str().is_some_and(is_digest)
        {
            return fail("The release manifest contains an invalid file or digest.");
        }
    }
    if REQUIRED.iter().any(|file| !checksums.contains_key(*file)) {
        return fail("The release is missing required components.");
    }
    Ok(checksums)
}

pub(super) struct Archive {
    manifest: Value,
    contents: BTreeMap<String, Vec<u8>>,
}

impl Archive {
    pub(super) fn read(bytes: &[u8], digest: &str, expected_version: Option<&str>) -> Result<Self> {
        if !is_digest(digest) || sha256_hex(bytes) != digest {
            return fail("The release archive failed its published digest check.");
        }
        if bytes.len() as u64 > MAX_ARCHIVE {
            return fail("The release archive is too large.");
        }
        let data = read_limited(GzDecoder::new(bytes), MAX_CONTENTS, "Uncompressed release")?;
        let payload = json_bytes(&data, "release archive")?;
        let manifest = &payload["manifest"];
        let checksums = check_manifest(manifest)?;
        let version = manifest["version"]
            .as_str()
            .expect("validated release version");
        if expected_version.is_some_and(|expected| expected != version) {
            return fail("The archive version differs from the release tag.");
        }
        let files = payload["files"]
            .as_object()
            .filter(|files| files.len() == checksums.len())
            .ok_or_else(|| GatewayError("The archive does not match its file list.".into()))?;
        let mut contents = BTreeMap::new();
        for (file, digest) in checksums {
            let data = files
                .get(file)
                .and_then(Value::as_str)
                .and_then(|b64| STANDARD.decode(b64).ok())
                .filter(|bytes| digest == &sha256_hex(bytes))
                .ok_or_else(|| {
                    GatewayError(format!("Release file failed its digest check: {file}"))
                })?;
            contents.insert(file.clone(), data);
        }
        for client in ["codex", "claude"] {
            let file = format!("{PLUGIN}/.{client}-plugin/plugin.json");
            let plugin = json_bytes(&contents[&file], &file)?;
            if plugin["version"] != version || plugin["name"] != "zodchi" {
                return fail("The client plugins differ from the release version.");
            }
        }
        Ok(Self {
            manifest: manifest.clone(),
            contents,
        })
    }

    pub(super) fn version(&self) -> &str {
        self.manifest["version"]
            .as_str()
            .expect("validated release version")
    }

    pub(super) fn install(&self, home: &Path) -> Result<PathBuf> {
        self.install_at(&home.join("releases"), self.version())
    }

    pub(super) fn install_dev(&self, home: &Path) -> Result<(PathBuf, String)> {
        use zodchi_core::config::is_source_commit;
        if self.manifest["devJournalVersion"] != 1 {
            return fail("Build a DEV archive with support for recording its revision in Flow.");
        }
        let metadata = self
            .contents
            .get(BUILD_INFO)
            .ok_or_else(|| GatewayError("The bundle has no source revision.".into()))?;
        let metadata = json_bytes(metadata, BUILD_INFO)?;
        let commit = metadata["sourceCommit"]
            .as_str()
            .filter(|commit| is_source_commit(commit))
            .ok_or_else(|| {
                GatewayError("Build the DEV bundle from a clean Git checkout.".into())
            })?;
        Ok((
            self.install_at(&home.join("dev-builds"), commit)?,
            commit.into(),
        ))
    }

    fn install_at(&self, releases: &Path, name: &str) -> Result<PathBuf> {
        fs::create_dir_all(releases)?;
        directory(releases)?;
        let root = releases.join(name);
        if root.exists() {
            directory(&root)?;
            if self.manifest != read_json(&root.join("release.json"))? {
                return fail("The installed release directory differs from this archive.");
            }
            for (file, data) in &self.contents {
                if regular(&root.join(file))? != *data {
                    return fail(format!(
                        "The installed release file differs from this archive: {file}"
                    ));
                }
            }
        } else {
            let staged = tempfile::Builder::new()
                .prefix(".prepare-")
                .tempdir_in(releases)?;
            for (file, data) in &self.contents {
                write_new(&staged.path().join(file), data, file == CLI)?;
            }
            write_json(&staged.path().join("release.json"), &self.manifest)?;
            fs::rename(staged.path(), &root)?;
        }
        Ok(root)
    }
}

pub(super) fn executable(root: &Path, version: &str) -> Result<PathBuf> {
    let manifest = read_json(&root.join("release.json"))?;
    check_manifest(&manifest)?;
    if manifest["version"] != version {
        return fail(format!("The pinned release {version} is incomplete."));
    }
    let executable = root.join(CLI);
    if !fs::symlink_metadata(&executable)?.is_file() {
        return fail(format!("The pinned release {version} has no executable."));
    }
    Ok(executable)
}

pub(super) fn copy_launcher(source: &Path, launcher: &Path) -> Result<()> {
    let bytes = fs::read(source)?;
    if launcher.exists() {
        if regular(launcher)? != bytes {
            return fail(format!(
                "The selected home has a different launcher at {}.",
                launcher.display()
            ));
        }
        return Ok(());
    }
    write_new(launcher, &bytes, true)
}

pub(super) fn load_archive(path: &Path, digest: &str) -> Result<Archive> {
    Archive::read(
        &read_limited(File::open(path)?, MAX_ARCHIVE, "Release archive")?,
        digest,
        None,
    )
}
