use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use zodchi_core::{
    process::{self, Ran},
    util::{fail, GatewayError, Result},
};

pub fn fields(value: &Value, allowed: &[&str], at: &str) -> Result<()> {
    let map = value
        .as_object()
        .ok_or_else(|| GatewayError(format!("{at} needs an object.")))?;
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return fail(format!("{at}.{key} is unknown."));
    }
    Ok(())
}

pub fn text<'a>(value: &'a Value, at: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or_else(|| GatewayError(format!("{at} needs nonempty text.")))
}

pub fn owner_words(value: &Value) -> Result<&str> {
    let words = text(value, "ownerWords")?;
    if words.chars().count() > 2000 {
        return fail("ownerWords cannot exceed 2000 characters.");
    }
    Ok(words)
}

pub fn directory(value: &Value, at: &str) -> Result<PathBuf> {
    let path = Path::new(text(value, at)?);
    if !path.is_absolute() || !path.is_dir() || path.components().any(|c| c == Component::ParentDir)
    {
        return fail(format!("{at} needs an existing absolute directory."));
    }
    Ok(fs::canonicalize(path)?)
}

pub fn file(dir: &Path, value: &Value, at: &str) -> Result<PathBuf> {
    let p = PathBuf::from(text(value, at)?);
    if p.components().any(|c| c == Component::ParentDir)
        || (!p.is_absolute()
            && p.components()
                .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)))
    {
        return fail(format!(
            "{at} needs a relative or absolute file without parent components."
        ));
    }
    let p = if p.is_absolute() { p } else { dir.join(p) };
    if !p.is_file() {
        return fail(format!(
            "{at} is not an existing regular file: {}",
            p.display()
        ));
    }
    Ok(fs::canonicalize(p)?)
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// An owned output cannot pass through a symlink, junction, or another reparse point in the video directory.
pub fn owned(dir: &Path, relative: &str) -> Result<PathBuf> {
    let mut result = dir.to_owned();
    for part in Path::new(relative).components() {
        let Component::Normal(name) = part else {
            return fail("An owned video path must be relative.");
        };
        result.push(name);
        match fs::symlink_metadata(&result) {
            Ok(meta) if is_link(&meta) => {
                return fail(format!("Video output crosses a link: {}", result.display()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(result)
}

pub fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return fail(format!("JSON input exceeds 16 MiB: {}", path.display()));
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice(bytes)
        .map_err(|error| GatewayError(format!("{}: {error}", path.display())))
}

pub fn stamp(path: &Path) -> Result<Value> {
    let mut input = File::open(path)?;
    let before = input.metadata()?;
    if !before.is_file() || before.len() == 0 {
        return fail(format!(
            "An artifact must be a nonempty regular file: {}",
            path.display()
        ));
    }
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut input, &mut digest)?;
    let after = input.metadata()?;
    if bytes != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return fail(format!(
            "The file changed while it was being hashed: {}",
            path.display()
        ));
    }
    Ok(json!({ "bytes": bytes, "sha256": format!("{:x}", digest.finalize()) }))
}

pub fn pin(path: &Path) -> Result<Value> {
    let mut value = stamp(path)?;
    value["path"] = json!(path);
    Ok(value)
}

pub fn checked(pin: &Value) -> Result<&Path> {
    let path = Path::new(text(&pin["path"], "pinned path")?);
    let actual = stamp(path)?;
    if actual["bytes"] != pin["bytes"] || actual["sha256"] != pin["sha256"] {
        return fail(format!(
            "The file differs from its recorded bytes: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// A trusted caller supplies a native program and each argument separately. The output argument is owned by Flow.
pub fn tool_plan(dir: &Path, raw: &Value) -> Result<Value> {
    fields(raw, &["program", "args", "timeoutSeconds"], "tool")?;
    let program = file(dir, &raw["program"], "tool.program")?;
    let args = raw["args"]
        .as_array()
        .filter(|args| {
            args.len() <= 128
                && args
                    .iter()
                    .all(|v| v.as_str().is_some_and(|s| !s.contains('\0')))
        })
        .ok_or_else(|| GatewayError("tool.args needs an array of up to 128 strings.".into()))?;
    if args.iter().filter(|arg| *arg == "{out}").count() != 1 {
        return fail("tool.args needs exactly one {out} argument for the output path.");
    }
    let seconds = raw
        .get("timeoutSeconds")
        .map(|v| {
            v.as_u64()
                .filter(|n| (1..=14400).contains(n))
                .ok_or_else(|| {
                    GatewayError("tool.timeoutSeconds must be between 1 and 14400.".into())
                })
        })
        .transpose()?
        .unwrap_or(1800);
    Ok(json!({ "program": program, "args": args, "timeoutSeconds": seconds }))
}

pub fn run_tool(
    plan: &Value,
    cwd: &Path,
    out: &Path,
    spawned: impl FnOnce(u32) -> io::Result<()>,
) -> Result<Ran> {
    let mut command = process::command_without_window(text(&plan["program"], "tool.program")?);
    let args = plan["args"]
        .as_array()
        .ok_or_else(|| GatewayError("Missing saved tool arguments.".into()))?;
    for arg in args {
        let arg = arg
            .as_str()
            .ok_or_else(|| GatewayError("Invalid saved tool argument.".into()))?;
        command.arg(if arg == "{out}" {
            out.as_os_str()
        } else {
            arg.as_ref()
        });
    }
    Ok(process::run_recorded(
        command,
        b"",
        cwd,
        Duration::from_secs(plan["timeoutSeconds"].as_u64().unwrap_or(1800)),
        spawned,
    )?)
}

pub fn verify(dir: &Path, tools: &Value, path: &Path, expect: &Value) -> Result<Value> {
    let before = stamp(path)?;
    let mut probe = process::command_without_window(text(&tools["ffprobe"], "ffprobe")?);
    probe
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type,width,height,r_frame_rate:format=duration,format_name",
            "-of",
            "json",
        ])
        .arg(path);
    let ran = process::run(probe, b"", dir, Duration::from_secs(120))?;
    require_success(&ran, "ffprobe")?;
    let info: Value = serde_json::from_slice(&ran.stdout)
        .map_err(|e| GatewayError(format!("ffprobe returned invalid JSON: {e}")))?;
    if !info["format"]["format_name"]
        .as_str()
        .is_some_and(|formats| formats.split(',').any(|format| format == "mp4"))
    {
        return fail("ffprobe did not identify an MP4-compatible container.");
    }
    let video = info["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|v| v["codec_type"] == "video"))
        .ok_or_else(|| GatewayError("The rendered MP4 has no video stream.".into()))?;
    let seconds: f64 = info["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .filter(|n: &f64| n.is_finite() && *n > 0.0)
        .ok_or_else(|| GatewayError("ffprobe did not measure a positive duration.".into()))?;
    if ["width", "height"].iter().any(|field| {
        let field = *field;
        video[field].as_u64().is_none_or(|n| n == 0)
            || expect.get(field).is_some_and(|n| n != &video[field])
    }) || expect["seconds"]
        .as_f64()
        .is_some_and(|expected| (seconds - expected).abs() > 0.05)
    {
        return fail("The render does not match the declared resolution or duration.");
    }
    let mut decode = process::command_without_window(text(&tools["ffmpeg"], "ffmpeg")?);
    decode
        .args(["-nostdin", "-v", "error", "-xerror", "-i"])
        .arg(path)
        .args(["-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
    require_success(
        &process::run(decode, b"", dir, Duration::from_secs(3600))?,
        "full FFmpeg decode",
    )?;
    let mut proof = pin(path)?;
    if proof["sha256"] != before["sha256"] || proof["bytes"] != before["bytes"] {
        return fail("The render changed during verification.");
    }
    proof["seconds"] = json!(seconds);
    proof["streams"] = info["streams"].clone();
    proof["ffprobeExit"] = json!(0);
    proof["decodeExit"] = json!(0);
    Ok(proof)
}

pub fn require_success(ran: &Ran, name: &str) -> Result<()> {
    if ran.timed_out {
        return fail(format!("{name} exceeded its time limit."));
    }
    if ran.code != Some(0) {
        let detail: String = String::from_utf8_lossy(&ran.stderr)
            .chars()
            .take(1600)
            .collect();
        return fail(format!("{name} exited {:?}: {detail}", ran.code));
    }
    Ok(())
}
