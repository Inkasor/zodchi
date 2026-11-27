//! Managed local fixture process support for candidate acceptance.
use super::{candidate, plan, process};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Stdio},
    sync::mpsc,
    time::Duration,
};
use zodchi_core::{
    process::{command_without_window, kill_tree, process_start},
    util::{fail, GatewayError, Result},
};
use zodchi_flow_engine::{boundary, git::Git, journal::Journal, video_media as media};

pub(super) fn plan(raw: &Value, repo: &Path, git: &Git, head: &str) -> Result<Value> {
    media::fields(
        raw,
        &[
            "script",
            "args",
            "readyPrefix",
            "timeoutSeconds",
            "storageState",
        ],
        "fixture",
    )?;
    let script = media::text(&raw["script"], "fixture.script")?;
    let path = Path::new(script);
    let pinned = if path.is_absolute() {
        plan::pin(repo, &raw["script"], "fixture.script")?
    } else {
        plan::relative(&raw["script"], "fixture.script")?;
        let entry = git.entry_at(head, script)?;
        if !entry
            .is_some_and(|(mode, kind, _)| kind == "blob" && (mode == "100644" || mode == "100755"))
        {
            return fail("fixture.script must be a regular file in the pinned commit.");
        }
        Value::Null
    };
    let args = match raw.get("args") {
        Some(v) => plan::list(v, "fixture.args", 0, 128)?,
        None => &[],
    };
    if args.iter().any(|v| {
        v.as_str()
            .is_none_or(|s| s.len() > 8192 || s.contains('\0'))
    }) {
        return fail("fixture.args must contain bounded strings without NUL.");
    }
    let prefix = raw
        .get("readyPrefix")
        .map(|v| media::text(v, "fixture.readyPrefix"))
        .transpose()?
        .unwrap_or("ZODCHI_FIXTURE_READY ");
    if prefix.len() > 128 || prefix.contains(['\r', '\n']) {
        return fail("fixture.readyPrefix must fit on one line and be at most 128 bytes.");
    }
    if let Some(state) = raw.get("storageState") {
        plan::relative(state, "fixture.storageState")?;
        if media::text(state, "fixture.storageState")?.contains('/') {
            return fail("fixture.storageState must be a direct filename.");
        }
    }
    Ok(
        json!({"script": script, "pin": pinned, "args": args, "readyPrefix": prefix,
        "timeoutSeconds": plan::seconds(&raw["timeoutSeconds"], 30, 120, "fixture.timeoutSeconds")?,
        "storageState": raw["storageState"]}),
    )
}

/// Only literal loopback HTTP origins with an explicit nonzero port are accepted.
pub(super) fn origin(line: &str, prefix: &str) -> Result<String> {
    let url = line
        .strip_prefix(prefix)
        .ok_or_else(|| GatewayError("Fixture readiness line has the wrong prefix.".into()))?;
    let authority = url
        .strip_prefix("http://")
        .ok_or_else(|| GatewayError("Fixture origin must use HTTP on loopback.".into()))?;
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| GatewayError("Fixture origin needs an explicit port.".into()))?;
    if !["127.0.0.1", "localhost", "[::1]"].contains(&host)
        || port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
        || !port.parse::<u16>().is_ok_and(|p| p != 0)
    {
        return fail(
            "Fixture origin must be a loopback HTTP origin with an explicit nonzero port.",
        );
    }
    Ok(url.to_owned())
}

/// Pin only the named direct output file; the browser adapter still screens its contents.
pub(super) fn storage_state(spec: &Value, output: &Path) -> Result<Option<Value>> {
    if spec["storageState"].is_null() {
        return Ok(None);
    }
    let name = media::text(&spec["storageState"], "fixture.storageState")?;
    let path = media::owned(output, name)?;
    if !fs::symlink_metadata(&path)?.is_file() {
        return fail("Fixture storageState must be a regular output file.");
    }
    Ok(Some(media::pin(&path)?))
}

pub(super) struct Fixture {
    child: Child,
    pid: u32,
    active: bool,
    pin: Value,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.active {
            kill_tree(self.pid);
            let _ = self.child.wait();
        }
    }
}
impl Fixture {
    pub(super) fn running(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_some() { return fail("Fixture exited before the browser finished."); }
        Ok(())
    }

    pub(super) fn stop(mut self, journal: &mut Journal, step: &str) -> Result<()> {
        kill_tree(self.pid);
        let _ = self.child.wait();
        self.active = false;
        journal.append(json!({"kind":"check ended", "step":step, "attempt":1, "pid":self.pid}))?;
        if !self.pin.is_null() {
            media::checked(&self.pin)?;
        }
        Ok(())
    }
}

pub(super) fn start(
    spec: &Value,
    node: &Path,
    checkout: &Path,
    output: &Path,
    log: &Path,
    journal: &mut Journal,
    step: &str,
) -> Result<(Fixture, String)> {
    let script = if spec["pin"].is_null() {
        checkout.join(media::text(&spec["script"], "fixture.script")?)
    } else {
        media::checked(&spec["pin"])?.to_path_buf()
    };
    // Fixture diagnostics can contain caller-owned paths or secrets. Never
    // persist the process's raw stderr; keep only a fixed explanation.
    let mut log = fs::File::create_new(log)?;
    log.write_all(b"Fixture stderr was discarded.\n")?;
    let mut command = command_without_window(node);
    // The wrapper cannot execute the fixture until the parent has durably
    // recorded its identity. EOF before the byte means the parent died.
    const GATE: &str = r#"const fs = require('node:fs');
const { spawn } = require('node:child_process');
const byte = Buffer.alloc(1);
if (fs.readSync(0, byte, 0, 1, null) !== 1 || byte[0] !== 1) process.exit(1);
const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', windowsHide: true });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code === null ? 1 : code));"#;
    command
        .arg("-e")
        .arg(GATE)
        .arg(candidate::node_path(&script))
        .args(
            spec["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap()),
        )
        .current_dir(checkout)
        .env_clear()
        .envs(process::environment())
        .env("ZODCHI_FIXTURE_OUTPUT", output)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let mut fixture = Fixture {
        child,
        pid,
        active: true,
        pin: spec["pin"].clone(),
    };
    let start = process_start(pid).ok_or_else(|| GatewayError("Could not identify fixture process before startup.".into()))?;
    journal.append(json!({"kind":"check started", "step":step, "attempt":1, "pid":pid, "start":start}))?;
    boundary::cut("fixture recorded before start");
    fixture.child.stdin.as_mut().unwrap().write_all(&[1])?;
    boundary::cut("fixture started before readiness");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let result = reader
            .by_ref()
            .take(4097)
            .read_until(b'\n', &mut line)
            .map(|_| line);
        let _ = send.send(result);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let ready = (|| -> Result<String> {
        let line = receive
            .recv_timeout(Duration::from_secs(
                spec["timeoutSeconds"].as_u64().unwrap(),
            ))
            .map_err(|_| GatewayError("Fixture readiness timed out.".into()))??;
        if line.len() > 4096 || !line.ends_with(b"\n") {
            return fail("Fixture readiness line is missing or too long.");
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| GatewayError("Fixture readiness must be UTF-8.".into()))?
            .trim_end_matches(['\r', '\n']);
        let origin = origin(
            line,
            media::text(&spec["readyPrefix"], "fixture.readyPrefix")?,
        )?;
        if fixture.child.try_wait()?.is_some() {
            return fail("Fixture exited before browser startup.");
        }
        Ok(origin)
    })();
    match ready {
        Ok(origin) => Ok((fixture, origin)),
        Err(error) => {
            // Record cleanup even when readiness fails, and check the caller-owned
            // program pin after every use. An unsuccessful start is never a pass.
            fixture.stop(journal, step)?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::origin;

    #[test]
    fn readiness_requires_a_literal_loopback_origin_and_bound_port() {
        for url in [
            "http://127.0.0.1:1",
            "http://localhost:65535",
            "http://[::1]:80",
        ] {
            assert_eq!(origin(&format!("baseUrl {url}"), "baseUrl ").unwrap(), url);
        }
        for url in [
            "https://localhost:1",
            "http://example.com:1",
            "http://localhost:0",
            "http://localhost:65536",
            "http://localhost:1/path",
            "http://localhost:1?x=1",
            "http://user@localhost:1",
            "http://127.0.0.2:1",
            "http://localhost",
        ] {
            assert!(
                origin(&format!("baseUrl {url}"), "baseUrl ").is_err(),
                "{url}"
            );
        }
        assert!(origin("ZODCHI_FIXTURE_READY http://localhost:1", "baseUrl ").is_err());
    }
}
