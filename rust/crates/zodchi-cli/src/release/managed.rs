use super::{
    bundle::{self, Archive, MARKETPLACE, MAX_ARCHIVE, VERSION},
    dev,
};
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
    time::Duration,
};
use ureq::Agent;
use zodchi_core::{
    config::{find_codex, user_home},
    process::{command_without_window, run},
    util::{fail, write_json_atomic, GatewayError, Result},
};

const SOURCE: &str = "https://api.github.com/repos/Inkasor/zodchi/releases/latest";
const DOWNLOADS: &str = "https://github.com/Inkasor/zodchi/releases/download/";
const STATE: &str = "managed-release.json";
const TRANSACTION: &str = "release-activation.json";

pub(super) fn home() -> Result<PathBuf> {
    let configured = env::var_os("ZODCHI_HOME").filter(|value| !value.is_empty());
    Ok(std::path::absolute(
        configured
            .map(PathBuf::from)
            .unwrap_or_else(|| user_home().join(".zodchi")),
    )?)
}

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "zodchi.exe"
    } else {
        "zodchi"
    }
}

pub(super) fn launcher(home: &Path) -> PathBuf {
    home.join("bin").join(bin_name())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Client {
    Codex,
    Claude,
}

fn client(name: &str) -> Result<Client> {
    match name {
        "codex" => Ok(Client::Codex),
        "claude" => Ok(Client::Claude),
        _ => fail("The client list accepts codex and claude."),
    }
}

fn clients(names: Option<&str>) -> Result<Vec<Client>> {
    let mut selected = Vec::new();
    if let Some(names) = names {
        for name in names.split(',') {
            let found = client(name)?;
            if !selected.contains(&found) {
                selected.push(found);
            }
        }
    }
    Ok(selected)
}

struct State {
    active: String,
    clients: Vec<Client>,
}

impl State {
    fn read(home: &Path) -> Result<Self> {
        let value = bundle::read_json(&home.join(STATE))?;
        let active = value["active"]
            .as_str()
            .filter(|version| bundle::version_numbers(version).is_some())
            .ok_or_else(|| GatewayError("Invalid managed release version.".into()))?;
        let clients = value["clients"]
            .as_array()
            .ok_or_else(|| GatewayError("Invalid managed release clients.".into()))?
            .iter()
            .map(|name| client(name.as_str().unwrap_or_default()))
            .collect::<Result<_>>()?;
        Ok(Self {
            active: active.into(),
            clients,
        })
    }

    fn save(&self, home: &Path, version: &str) -> Result<()> {
        let clients: Vec<&str> = self
            .clients
            .iter()
            .map(|client| match client {
                Client::Codex => "codex",
                Client::Claude => "claude",
            })
            .collect();
        write_json_atomic(
            &home.join(STATE),
            &json!({ "active": version, "clients": clients }),
        )
    }
}

pub(super) fn try_lock(home: &Path) -> Result<Option<File>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join("release-install.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

fn executable(home: &Path, version: &str) -> Result<PathBuf> {
    if bundle::version_numbers(version).is_none() {
        return fail("Invalid pinned release version.");
    }
    bundle::executable(&home.join("releases").join(version), version)
}

fn plugin(client: Client, root: &Path) -> Result<()> {
    let codex_path = (client == Client::Codex).then(find_codex);
    let market = root.join("marketplace");
    let installed = format!("zodchi@{MARKETPLACE}");
    let invoke = |args: &[&str], missing_ok: bool| -> Result<()> {
        let (name, mut command) = match &codex_path {
            Some(path)
                if path
                    .extension()
                    .is_some_and(|ext| ext == "js" || ext == "mjs") =>
            {
                let mut node = command_without_window("node");
                node.arg(path);
                ("codex", node)
            }
            Some(path) => ("codex", command_without_window(path)),
            None => ("claude", command_without_window("claude")),
        };
        command.args(args);
        let output = run(command, &[], root, Duration::from_secs(30)).map_err(|error| {
            GatewayError(format!("Cannot start {name} {}: {error}", args.join(" ")))
        })?;
        if output.timed_out {
            return fail(format!("{name} {} timed out.", args.join(" ")));
        }
        if output.code != Some(0) && !missing_ok {
            let bytes = if output.stderr.is_empty() {
                output.stdout
            } else {
                output.stderr
            };
            return fail(format!(
                "{name} {} exited {:?}: {}",
                args.join(" "),
                output.code,
                String::from_utf8_lossy(&bytes).trim()
            ));
        }
        Ok(())
    };
    invoke(&["plugin", "marketplace", "remove", MARKETPLACE], true)?;
    let path = market
        .to_str()
        .ok_or_else(|| GatewayError("Marketplace path must be UTF-8.".into()))?;
    invoke(&["plugin", "marketplace", "add", path], false)?;
    match client {
        Client::Codex => invoke(&["plugin", "add", &installed], false),
        Client::Claude => invoke(&["plugin", "install", &installed, "--scope", "user"], false),
    }
}

fn configure(
    root: &Path,
    clients: &[Client],
    register: impl Fn(Client, &Path) -> Result<()>,
) -> Result<()> {
    for &client in clients {
        register(client, root)?;
    }
    Ok(())
}

pub(super) fn validate(binary: &Path, version: &str) -> Result<()> {
    let mut command = command_without_window(binary);
    command.arg("--version");
    let cwd = binary.parent().expect("release bin directory");
    let output = run(command, &[], cwd, Duration::from_secs(10))?;
    if output.timed_out
        || output.code != Some(0)
        || String::from_utf8_lossy(&output.stdout).trim() != format!("zodchi {version}")
    {
        return fail("The CLI version differs from the release manifest.");
    }
    Ok(())
}

fn request(url: &str, timeout: u64, redirects: u32, limit: u64) -> Result<Vec<u8>> {
    let config = Agent::config_builder()
        .https_only(true)
        .max_redirects(redirects)
        .timeout_global(Some(Duration::from_secs(timeout)));
    #[cfg(any(windows, target_os = "macos"))]
    let config = config.tls_config(
        ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build(),
    );
    let agent: Agent = config.build().into();
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", concat!("zodchi/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|error| GatewayError(format!("GitHub release request failed: {error}")))?;
    if !response.status().is_success() {
        return fail(format!(
            "GitHub release request returned {}.",
            response.status()
        ));
    }
    bundle::read_limited(
        response.body_mut().as_reader(),
        limit,
        "GitHub release response",
    )
}

fn latest() -> Result<Value> {
    bundle::json_bytes(&request(SOURCE, 6, 0, 1024 * 1024)?, "GitHub release")
}

struct Download {
    version: String,
    url: String,
    digest: String,
    size: u64,
}

fn newer(release: &Value, current: &str) -> Result<Option<Download>> {
    let tag = release["tag_name"].as_str().unwrap_or_default();
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let Some(candidate) = bundle::version_numbers(version) else {
        return Ok(None);
    };
    let active = bundle::version_numbers(current).expect("validated active version");
    if release["draft"] != false
        || release["prerelease"] != false
        || candidate[0] != active[0]
        || candidate <= active
    {
        return Ok(None);
    }
    let name = bundle::artifact_name();
    let asset = release["assets"]
        .as_array()
        .and_then(|all| all.iter().find(|asset| asset["name"] == name));
    let missing =
        || GatewayError("A verified release download for this platform is missing.".into());
    let asset = asset.ok_or_else(missing)?;
    let digest = asset["digest"]
        .as_str()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| bundle::is_digest(digest))
        .ok_or_else(missing)?;
    let size = asset["size"]
        .as_u64()
        .filter(|size| (1..=MAX_ARCHIVE).contains(size))
        .ok_or_else(missing)?;
    let url = asset["browser_download_url"]
        .as_str()
        .filter(|url| url.eq_ignore_ascii_case(&format!("{DOWNLOADS}{tag}/{name}")))
        .ok_or_else(|| {
            GatewayError("The release download is outside the publisher's repository.".into())
        })?;
    Ok(Some(Download {
        version: version.into(),
        url: url.into(),
        digest: digest.into(),
        size,
    }))
}

fn activate(
    home: &Path,
    previous: &State,
    root: &Path,
    version: &str,
    register: impl Fn(Client, &Path) -> Result<()>,
) -> Result<()> {
    let journal = home.join(TRANSACTION);
    write_json_atomic(&journal, &json!({ "from": previous.active, "to": version }))?;
    let result =
        configure(root, &previous.clients, &register).and_then(|()| previous.save(home, version));
    if let Err(error) = result {
        let old_root = home.join("releases").join(&previous.active);
        configure(&old_root, &previous.clients, register).map_err(|rollback| {
            GatewayError(format!(
                "{error} Restoring the client registrations failed: {rollback}"
            ))
        })?;
        fs::remove_file(&journal)?;
        return Err(error);
    }
    if let Err(error) = fs::remove_file(&journal) {
        eprintln!("Zodchi activated {version}. Could not remove the completed activation record: {error}.");
    }
    Ok(())
}

fn recover(
    home: &Path,
    state: &State,
    register: impl Fn(Client, &Path) -> Result<()>,
) -> Result<()> {
    let journal = home.join(TRANSACTION);
    if journal.exists() {
        let transaction = bundle::read_json(&journal)?;
        if transaction["to"] != state.active {
            configure(
                &home.join("releases").join(&state.active),
                &state.clients,
                register,
            )?;
        }
        fs::remove_file(journal)?;
    }
    Ok(())
}

fn update(home: &Path, state: &State) -> Result<Option<String>> {
    let Some(_lock) = try_lock(home)? else {
        return Ok(None);
    };
    let current = State::read(home)?;
    if current.active != state.active {
        return Ok(Some(current.active));
    }
    recover(home, &current, plugin)?;
    let Some(candidate) = newer(&latest()?, &current.active)? else {
        return Ok(None);
    };
    let bytes = request(&candidate.url, 20, 3, candidate.size)?;
    if bytes.len() as u64 != candidate.size {
        return fail("The release archive differs from its published size.");
    }
    let archive = Archive::read(&bytes, &candidate.digest, Some(&candidate.version))?;
    let root = archive.install(home)?;
    validate(
        &bundle::executable(&root, &candidate.version)?,
        &candidate.version,
    )?;
    activate(home, &current, &root, &candidate.version, plugin)?;
    eprintln!("Zodchi activated release {}.", candidate.version);
    Ok(Some(candidate.version))
}

pub(super) fn install(archive: &Path, digest: &str, selected: Option<&str>) -> Result<Value> {
    let clients = clients(selected)?;
    let home = home()?;
    let archive = bundle::load_archive(archive, digest)?;
    fs::create_dir_all(&home)?;
    let Some(_lock) = try_lock(&home)? else {
        return fail("Another release installation is working.");
    };
    if home.join(STATE).exists() {
        return fail("The chosen Zodchi home already has a managed release.");
    }
    let root = archive.install(&home)?;
    let version = archive.version();
    let binary = bundle::executable(&root, version)?;
    validate(&binary, version)?;
    let launcher = launcher(&home);
    bundle::copy_launcher(&binary, &launcher)?;
    // The launcher belongs to this install. A failed registration can be retried with the same archive.
    configure(&root, &clients, plugin)?;
    State {
        active: version.into(),
        clients,
    }
    .save(&home, version)?;
    Ok(json!({ "launcher": launcher, "version": version, "root": root }))
}

pub(super) fn register(selected: &str) -> Result<Value> {
    let clients = clients(Some(selected))?;
    let binary = env::current_exe()?;
    let root = binary
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| GatewayError("Use the binary inside the packaged release.".into()))?;
    bundle::executable(root, VERSION)?;
    configure(root, &clients, plugin)?;
    Ok(json!({ "root": root, "version": VERSION }))
}

pub(super) fn existing_run(args: &[String]) -> Option<&str> {
    if args.first().is_none_or(|command| command != "flow") {
        return None;
    }
    if let Some(flag) = args.iter().position(|arg| arg == "--resume") {
        return args.get(flag + 1).map(String::as_str);
    }
    match args.get(1)?.as_str() {
        "status" | "apply" | "reply" | "remark" | "budget" => args.get(2).map(String::as_str),
        "video"
            if args
                .get(2)
                .is_some_and(|arg| arg == "publish" || arg == "stats") =>
        {
            args.get(3).map(String::as_str)
        }
        _ => None,
    }
}

pub(super) fn run_record(home: &Path, id: &str) -> Result<Value> {
    let mut name = id.bytes();
    if id.len() > 64
        || !name.next().is_some_and(|c| c.is_ascii_alphanumeric())
        || !name.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return fail("Invalid run ID.");
    }
    bundle::read_json(&home.join("flows").join(id).join("run.json"))
}

fn pinned_version(home: &Path, id: &str, state: &State) -> Result<String> {
    let record = run_record(home, id)?;
    let release = record["release"].as_str();
    match release {
        // Journals created before managed stable releases share the backward-compatible reader.
        None | Some("1.0.0-dev") => Ok(state.active.clone()),
        Some(version) if bundle::version_numbers(version).is_some() => Ok(version.into()),
        Some(_) => fail("The run has an invalid pinned release."),
    }
}

pub(super) fn retained_release(home: &Path, run: &Value) -> Result<Option<PathBuf>> {
    let Some(version) = run["release"]
        .as_str()
        .filter(|v| bundle::version_numbers(v).is_some())
    else {
        return Ok(None);
    };
    let root = home.join("releases").join(version);
    if root.exists() {
        return bundle::executable(&root, version).map(Some);
    }
    Ok(None)
}

pub(super) fn current(home: &Path) -> Result<Option<Value>> {
    if !home.join(STATE).is_file() {
        return Ok(None);
    }
    let state = State::read(home)?;
    let binary = executable(home, &state.active)?;
    Ok(Some(
        json!({ "channel": "stable", "version": state.active, "cli": binary, "journalHome": home }),
    ))
}

pub(super) fn route(args: &[String]) -> Result<Option<u8>> {
    let binary = env::current_exe()?;
    let Some(home) = binary.parent().and_then(Path::parent) else {
        return Ok(None);
    };
    if binary != launcher(home)
        || (args.first().is_some_and(|arg| arg == "release")
            && args
                .get(1)
                .is_some_and(|arg| arg == "current" || arg == "dev"))
    {
        return Ok(None);
    }
    if let Some(binary) = dev::route(home, args)? {
        return launch(&binary, home, args).map(Some);
    }
    if !home.join(STATE).is_file() {
        return Ok(None);
    }
    let state = State::read(home)?;
    let version = if let Some(id) = existing_run(args) {
        pinned_version(home, id, &state)?
    } else if args.first().is_some_and(|command| command == "flow")
        && args.iter().any(|arg| arg == "--args")
    {
        match update(home, &state) {
            Ok(Some(version)) => version,
            Ok(None) => state.active,
            Err(error) => {
                eprintln!("Zodchi update: {error} Using {}.", state.active);
                state.active
            }
        }
    } else {
        state.active
    };
    launch(&executable(home, &version)?, home, args).map(Some)
}

fn launch(binary: &Path, home: &Path, args: &[String]) -> Result<u8> {
    let exit = command_without_window(binary)
        .args(args)
        .env("ZODCHI_HOME", home)
        .status()?;
    Ok(exit
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn state(home: &Path) -> State {
        let state = State {
            active: "1.0.0".into(),
            clients: vec![Client::Codex, Client::Claude],
        };
        state.save(home, &state.active).unwrap();
        state
    }

    #[test]
    fn activates_both_clients_and_keeps_the_version_of_an_existing_run() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let old = state(home);
        let run_dir = home.join("flows/original");
        fs::create_dir_all(&run_dir).unwrap();
        write_json_atomic(&run_dir.join("run.json"), &json!({ "release": old.active })).unwrap();
        let root = home.join("releases/1.1.0");
        let calls = RefCell::new(Vec::new());
        activate(home, &old, &root, "1.1.0", |client, root| {
            calls.borrow_mut().push((client, root.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            calls.into_inner(),
            [(Client::Codex, root.clone()), (Client::Claude, root)]
        );
        let current = State::read(home).unwrap();
        assert_eq!(current.active, "1.1.0");
        assert!(!home.join(TRANSACTION).exists());
        assert_eq!(pinned_version(home, "original", &current).unwrap(), "1.0.0");
        let args = ["flow", "code-package", "--resume", "original"].map(String::from);
        assert_eq!(existing_run(&args), Some("original"));
    }

    #[test]
    fn failed_second_client_and_interrupted_activation_restore_the_original() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let old = state(home);
        let assigned = RefCell::new(["1.0.0".to_owned(), "1.0.0".to_owned()]);
        let register = |client, root: &Path| {
            let version = root.file_name().unwrap().to_str().unwrap();
            if client == Client::Claude && version == "1.1.0" {
                return fail("fixture refused plugin registration");
            }
            assigned.borrow_mut()[usize::from(client == Client::Claude)] = version.into();
            Ok(())
        };
        let err =
            activate(home, &old, &home.join("releases/1.1.0"), "1.1.0", register).unwrap_err();
        assert!(err.0.contains("fixture refused"));
        assert_eq!(State::read(home).unwrap().active, "1.0.0");
        assert_eq!(*assigned.borrow(), ["1.0.0", "1.0.0"]);
        assert!(!home.join(TRANSACTION).exists());
        write_json_atomic(
            &home.join(TRANSACTION),
            &json!({ "from": "1.0.0", "to": "1.1.0" }),
        )
        .unwrap();
        assigned.borrow_mut()[0] = "1.1.0".into();
        recover(home, &old, register).unwrap();
        assert_eq!(*assigned.borrow(), ["1.0.0", "1.0.0"]);
        assert!(!home.join(TRANSACTION).exists());
    }

    #[test]
    fn updates_only_to_a_stable_compatible_release_with_a_published_digest() {
        let asset = bundle::artifact_name();
        let release = |tag: &str, url: &str, prerelease: bool| {
            json!({
                "tag_name": tag, "draft": false, "prerelease": prerelease,
                "assets": [{ "name": asset, "size": 123, "digest": "sha256:".to_owned() + &"a".repeat(64),
                    "browser_download_url": url }]
            })
        };
        let url = format!("{DOWNLOADS}v1.1.0/{asset}");
        assert!(newer(&release("v1.1.0", &url, false), "1.0.0")
            .unwrap()
            .is_some());
        assert!(newer(&release("v1.1.0", &url, true), "1.0.0")
            .unwrap()
            .is_none());
        assert!(newer(&release("v2.0.0", &url, false), "1.0.0")
            .unwrap()
            .is_none());
        assert!(newer(
            &release("v1.1.0", "https://example.org/asset", false),
            "1.0.0"
        )
        .is_err());
        let mut unsigned = release("v1.1.0", &url, false);
        unsigned["assets"][0]["digest"] = Value::Null;
        assert!(newer(&unsigned, "1.0.0").is_err());
    }
}
