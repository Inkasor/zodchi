use crate::{checks, journal::Journal};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::PipeWriter,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use zodchi_core::{
    process::{command_without_window, kill_tree, process_start},
    util::{fail, Result},
};

#[cfg(windows)]
#[path = "desktop.rs"]
mod desktop;

pub(super) fn environment() -> Vec<(&'static str, std::ffi::OsString)> {
    checks::KEEP
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (key, value)))
        .collect()
}

pub(super) struct Tool<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub log: &'a Path,
    pub seconds: u64,
    pub private_desktop: bool,
    pub stdout: Option<PipeWriter>,
    pub stdout_file: Option<File>,
}

pub(super) fn run(
    tool: Tool<'_>,
    journal: &mut Journal,
    step: &str,
    attempt: u32,
) -> Result<Value> {
    run_with_env(tool, journal, step, attempt, &[])
}

pub(super) fn run_with_env(
    tool: Tool<'_>, journal: &mut Journal, step: &str, attempt: u32,
    extra: &[(&str, &Path)],
) -> Result<Value> {
    let began = Instant::now();
    let log = File::create_new(tool.log)?;
    if tool.private_desktop {
        #[cfg(windows)]
        {
            let mut child = desktop::Child::launch(&tool, &log)?;
            drop(tool.stdout);
            started(journal, step, attempt, child.pid())?;
            let exit = child.wait(tool.seconds)?;
            ended(journal, step, attempt, child.pid())?;
            return Ok(
                json!({ "exitCode": exit, "pid": child.pid(), "elapsedMs": began.elapsed().as_millis(),
                "desktop": child.desktop(), "inputDesktopPreserved": child.input_preserved()?, "log": tool.log }),
            );
        }
        #[cfg(not(windows))]
        return fail("A private Windows desktop requires a Windows host.");
    }
    let mut command = command_without_window(tool.program);
    let stdout = match (tool.stdout, tool.stdout_file) {
        (_, Some(file)) => Stdio::from(file),
        (Some(pipe), None) => Stdio::from(pipe),
        (None, None) => Stdio::from(log.try_clone()?),
    };
    command
        .args(tool.args)
        .current_dir(tool.cwd)
        .env_clear()
        .envs(environment())
        .envs(extra.iter().map(|(key, value)| (*key, *value)))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    if let Err(error) = started(journal, step, attempt, pid) {
        kill_tree(pid);
        let _ = child.wait();
        return Err(error);
    }
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.code()),
            Ok(None) if began.elapsed() < Duration::from_secs(tool.seconds) => {
                std::thread::sleep(Duration::from_millis(100))
            }
            other => {
                kill_tree(pid);
                let _ = child.wait();
                break match other {
                    Err(error) => Err(error.into()),
                    _ => fail("The acceptance tool timed out."),
                };
            }
        }
    };
    #[cfg(unix)]
    checks::end_group(pid).map_err(zodchi_core::util::GatewayError)?;
    ended(journal, step, attempt, pid)?;
    Ok(
        json!({ "exitCode": exit?, "pid": pid, "elapsedMs": began.elapsed().as_millis(), "log": tool.log, "isolation": "headless" }),
    )
}

fn started(journal: &mut Journal, step: &str, attempt: u32, pid: u32) -> Result<()> {
    journal.append(json!({ "kind": "check started", "step": step, "attempt": attempt, "pid": pid, "start": process_start(pid) }))
}

fn ended(journal: &mut Journal, step: &str, attempt: u32, pid: u32) -> Result<()> {
    journal.append(json!({ "kind": "check ended", "step": step, "attempt": attempt, "pid": pid }))
}
