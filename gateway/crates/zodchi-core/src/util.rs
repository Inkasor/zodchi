//! Small shared pieces: the error type, time stamps, hashes and the file operations that the job folder relies on
//! (an atomic replace for job.json, and a publish that only one process can win).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// A refusal of the gateway: a wrong call, a role that does not hold, a key that belongs to another request.
/// The message is meant for the caller as it is.
#[derive(Debug, Clone)]
pub struct GatewayError(pub String);

impl fmt::Display for GatewayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GatewayError {}

impl From<io::Error> for GatewayError {
    fn from(error: io::Error) -> Self {
        GatewayError(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, GatewayError>;

pub fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(GatewayError(message.into()))
}

/// The current time as an ISO 8601 string in UTC with milliseconds, the form `new Date().toISOString()` writes.
pub fn iso() -> String {
    let t = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// Milliseconds since the Unix epoch of an ISO time stamp, or None when it does not parse.
pub fn parse_iso_ms(text: &str) -> Option<i128> {
    let parsed = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some(parsed.unix_timestamp_nanos() / 1_000_000)
}

pub fn now_ms() -> i128 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}

pub fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

pub fn pause(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

/// Reads a JSON file that may be in the middle of being replaced: a missing file is None at once, anything else
/// is tried again for a short while, so the queue sees every job.
pub fn read_stored(file: &Path) -> Option<Value> {
    for attempt in 0.. {
        match fs::read_to_string(file) {
            Ok(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    return Some(value);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
            Err(_) => {}
        }
        if attempt >= 20 {
            return None;
        }
        pause(10);
    }
    None
}

/// Writes `value` to `file` through a temporary file and a rename. On Windows a rename over a file that a reader
/// holds open fails for a moment, so it is tried again.
pub fn write_json_atomic(file: &Path, value: &Value) -> Result<()> {
    let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temp, pretty(value))?;
    for attempt in 0.. {
        match fs::rename(&temp, file) {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= 20 => {
                let _ = fs::remove_file(&temp);
                return Err(error.into());
            }
            Err(_) => pause(25),
        }
    }
    Ok(())
}

/// Puts a file in place together with its content, unless the name is taken. A hard link appears whole or not at
/// all, so of several processes exactly one gets the name and nobody reads half a file.
pub fn publish(file: &Path, text: &str) -> Result<bool> {
    let temp = file.with_extension(format!("{}.{}.tmp", std::process::id(), rand::random::<u32>()));
    fs::write(&temp, text)?;
    let linked = fs::hard_link(&temp, file);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// JSON with two-space indentation, as `JSON.stringify(value, null, 2)` writes it.
pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// Merges the fields of `fields` (an object) into `base` (an object), the later ones winning.
pub fn merge(base: &Value, fields: &Value) -> Value {
    let mut out = base.clone();
    if let (Some(target), Some(source)) = (out.as_object_mut(), fields.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    out
}

pub fn is_key(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 96
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn is_role_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 48
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}
