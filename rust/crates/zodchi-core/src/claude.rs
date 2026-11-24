//! Shared transport for one ephemeral request to the local Claude Code subscription.

use crate::{
    appserver::image_type,
    config::Config,
    job::JobState,
    process::{process_start, run, run_recorded, Ran},
    util::{iso, sha256_hex, Result},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// A Claude program to run instead of `claude` on PATH; a `.js` or `.mjs` file runs with the Node on PATH.
pub const ENV_BIN: &str = "ZODCHI_CLAUDE_BIN";
/// The system prompt of every call: Claude Code's own (about tools and a workspace) does not apply.
const SYSTEM: &str = "You answer one request using the text and images provided. You have no tools or workspace access. Follow the requested answer format.";
/// Settings of every call: no hook runs, whatever the person's settings say.
const SETTINGS: &str = "{\"disableAllHooks\": true}\n";

pub fn is_haiku(model: &str) -> bool {
    model == "haiku" || model.starts_with("claude-haiku-")
}

/// The Claude program: an executable, or a script run by Node.
#[derive(Clone, Debug)]
pub struct Program {
    pub exe: PathBuf,
    pub script: Option<PathBuf>,
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|c| c.is_file())
}

/// `ZODCHI_CLAUDE_BIN` when it is set; otherwise the native `claude` on PATH (`claude.exe` on Windows: a `.cmd`
/// shim is a shell script and is never run). The reason when there is none.
pub fn find_program() -> std::result::Result<Program, String> {
    if let Some(bin) = std::env::var_os(ENV_BIN).filter(|v| !v.is_empty()) {
        let bin = PathBuf::from(bin);
        if !bin.is_file() {
            return Err(format!(
                "the claude program is missing ({ENV_BIN} names {}, which is not a file)",
                bin.display()
            ));
        }
        let ext = bin
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "js" || ext == "mjs" {
            let Some(node) = on_path(if cfg!(windows) {
                &["node.exe"]
            } else {
                &["node"]
            }) else {
                return Err(format!(
                    "{ENV_BIN} is a script and there is no node on PATH to run it"
                ));
            };
            return Ok(Program {
                exe: node,
                script: Some(bin),
            });
        }
        return Ok(Program {
            exe: bin,
            script: None,
        });
    }
    match on_path(if cfg!(windows) {
        &["claude.exe"]
    } else {
        &["claude"]
    }) {
        Some(exe) => Ok(Program { exe, script: None }),
        None => Err(format!(
            "the claude program is missing (no native claude on PATH; or set {ENV_BIN})"
        )),
    }
}

/// Whether a variable of the caller stays out of the Claude child: API keys and other providers (no fallback from
/// the subscription to a key or another account), credentials of other tools, and the marks of a parent session.
fn withheld(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    if n == "CLAUDE_CODE_OAUTH_TOKEN" {
        return false; // the person's own subscription sign-in for headless use
    }
    n.starts_with("ANTHROPIC_")
        || n.starts_with("CLAUDE_CODE_USE_")
        || n.starts_with("AWS_BEARER_TOKEN")
        || n == "CLAUDECODE"
        || n == "CLAUDE_CODE_ENTRYPOINT"
        || n.starts_with("ZODCHI_FLOW_")
        || ["API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD"]
            .iter()
            .any(|w| n.contains(w))
}

fn command(p: &Program) -> Command {
    let mut c = Command::new(&p.exe);
    if let Some(script) = &p.script {
        c.arg(script);
    }
    for (name, _) in std::env::vars_os() {
        if withheld(&name.to_string_lossy()) {
            c.env_remove(&name);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // the whole group goes on a timeout
    }
    c
}

/// The arguments of a call: one turn, the model and effort of the pick, no tools, no MCP, no hooks or plugins, no
/// session kept, the final result as JSON.
pub fn call_args(model: &str, effort: &str, settings: &Path) -> Vec<OsString> {
    print_args(model, effort, settings, false)
}

fn print_args(model: &str, effort: &str, settings: &Path, stream: bool) -> Vec<OsString> {
    let format = if stream { "stream-json" } else { "json" };
    let mut a: Vec<OsString> = [
        "-p",
        "--model",
        model,
        "--effort",
        effort,
        "--output-format",
        format,
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--safe-mode",
        "--settings",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    a.push(settings.as_os_str().to_owned());
    a.push("--system-prompt".into());
    a.push(SYSTEM.into());
    if stream {
        a.extend(
            ["--input-format", "stream-json", "--verbose"]
                .into_iter()
                .map(OsString::from),
        );
    }
    a
}

/// The message Claude gets: the role's frame, the step's prompt, then the form of the answer.
pub fn message(instructions: &str, prompt: &str, schema: &Value) -> String {
    let frame = instructions.trim();
    let mut text = if frame.is_empty() {
        prompt.to_owned()
    } else {
        format!("{frame}\n\n{prompt}")
    };
    if !schema.is_null() {
        let schema = serde_json::to_string_pretty(schema).unwrap_or_default();
        text.push_str(&format!("\n\n# The answer\n\nAnswer with one JSON object that follows this JSON Schema, and nothing else: no text before or after it, no code fence.\n\n{schema}\n"));
    }
    text
}

fn clip(text: &str, n: usize) -> String {
    let t = text.trim();
    if t.chars().count() > n {
        format!("{}...", t.chars().take(n).collect::<String>())
    } else {
        t.to_string()
    }
}

/// The end of the program's error output for a message, without lines that may hold a credential.
fn stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            ![
                "password",
                "token",
                "key",
                "secret",
                "cookie",
                "bearer",
                "authorization",
                "@",
            ]
            .iter()
            .any(|w| low.contains(w))
        })
        .collect();
    let tail = lines[lines.len().saturating_sub(5)..].join(" | ");
    clip(&tail, 400)
}

/// The JSON object of a model's final message: as it is, or inside one code fence.
fn json_of(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let inner = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))?
        .strip_suffix("```")?;
    serde_json::from_str(inner.trim()).ok()
}

/// The validated answer of a call from `claude -p --output-format json`, or why there is none.
pub fn read_answer(stdout: &[u8], schema: &Value) -> std::result::Result<Value, String> {
    let Ok(out) = serde_json::from_slice::<Value>(stdout) else {
        return Err(format!(
            "the output of claude is not its JSON result: {}",
            clip(&String::from_utf8_lossy(stdout), 200)
        ));
    };
    if out["type"] != json!("result") {
        return Err("the output of claude is not a result".into());
    }
    let text = out["result"].as_str().unwrap_or("");
    if out["is_error"] == json!(true) || out["subtype"].as_str().is_some_and(|s| s != "success") {
        return Err(format!(
            "claude ended with an error: {}",
            clip(
                if text.is_empty() {
                    out["subtype"].as_str().unwrap_or("?")
                } else {
                    text
                },
                300
            )
        ));
    }
    if schema.is_null() {
        return if text.trim().is_empty() {
            Err("claude returned an empty answer".into())
        } else {
            Ok(json!(text))
        };
    }
    let Some(data) = json_of(text) else {
        return Err(format!(
            "the answer is not one JSON object: {}",
            clip(text, 200)
        ));
    };
    conforms(&data, schema, "answer")
        .map_err(|why| format!("the answer does not follow the step's schema: {why}"))?;
    Ok(data)
}

fn type_ok(v: &Value, t: &str) -> bool {
    match t {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "null" => v.is_null(),
        "boolean" => v.is_boolean(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64(),
        _ => true,
    }
}

/// The JSON Schema keywords the flow schemas use: type (one or a list), enum, const, required, properties,
/// additionalProperties and items. Other keywords (descriptions, titles) say nothing about validity.
pub fn conforms(v: &Value, schema: &Value, at: &str) -> std::result::Result<(), String> {
    let Some(s) = schema.as_object() else {
        return Ok(());
    };
    match s.get("type") {
        Some(Value::String(t)) if !type_ok(v, t) => return Err(format!("{at} is not of type {t}")),
        Some(Value::Array(ts)) if !ts.iter().filter_map(Value::as_str).any(|t| type_ok(v, t)) => {
            return Err(format!(
                "{at} is none of the types {}",
                Value::Array(ts.clone())
            ));
        }
        _ => {}
    }
    if let Some(list) = s.get("enum").and_then(Value::as_array) {
        if !list.contains(v) {
            return Err(format!("{at} is not one of {}", Value::Array(list.clone())));
        }
    }
    if let Some(c) = s.get("const") {
        if c != v {
            return Err(format!("{at} is not {c}"));
        }
    }
    if let Some(obj) = v.as_object() {
        let empty = Map::new();
        let props = s
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        for r in s
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !obj.contains_key(r) {
                return Err(format!("{at} has no {r}"));
            }
        }
        for (k, val) in obj {
            match (props.get(k), s.get("additionalProperties")) {
                (Some(p), _) => conforms(val, p, &format!("{at}.{k}"))?,
                (None, Some(Value::Bool(false))) => {
                    return Err(format!("{at} has {k}, which the schema does not allow"))
                }
                (None, Some(extra @ Value::Object(_))) => {
                    conforms(val, extra, &format!("{at}.{k}"))?
                }
                _ => {}
            }
        }
    }
    if let (Some(list), Some(items)) = (v.as_array(), s.get("items")) {
        for (i, item) in list.iter().enumerate() {
            conforms(item, items, &format!("{at}[{i}]"))?;
        }
    }
    Ok(())
}

/// The program's version (`claude --version`), or why it does not run.
pub fn version(p: &Program, cwd: &Path) -> std::result::Result<String, String> {
    let mut c = command(p);
    c.arg("--version");
    let ran = run(c, b"", cwd, Duration::from_secs(60))
        .map_err(|e| format!("claude --version did not start: {e}"))?;
    let text = String::from_utf8_lossy(&ran.stdout).trim().to_string();
    match (ran.timed_out, ran.code) {
        (true, _) => Err("claude --version did not answer within a minute".into()),
        (false, Some(0)) if !text.is_empty() => Ok(clip(text.lines().next().unwrap_or(""), 80)),
        (false, code) => Err(format!(
            "claude --version exited {}: {}",
            code.map_or("without a code".into(), |c| c.to_string()),
            stderr_tail(&ran.stderr)
        )),
    }
}

/// The account a sign-in names, as a local binding that holds no secret and no address: a digest of the e-mail and
/// the organization `claude auth status` reports. A sign-in that names neither cannot be bound to a run.
pub fn account_of(status: &Value) -> std::result::Result<String, String> {
    let email = status["email"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let org = status["orgId"].as_str().unwrap_or("").trim().to_string();
    if email.is_empty() && org.is_empty() {
        return Err("claude auth status names no account (no email or orgId), so the run cannot be bound to it".into());
    }
    Ok(format!(
        "claude-{}",
        &sha256_hex(format!("zodchi claude account\n{email}\n{org}"))[..16]
    ))
}

/// Whether Claude Code is signed in with a Claude subscription (`claude auth status --json`), with the variables of
/// the call: an API key, a key helper or another provider is refused. Only the kind of sign-in is named; the account
/// comes back as its binding (`account_of`), never as its name.
pub fn signed_in(p: &Program, cwd: &Path) -> std::result::Result<String, String> {
    let mut c = command(p);
    c.args(["auth", "status", "--json"]);
    let ran = run(c, b"", cwd, Duration::from_secs(60))
        .map_err(|e| format!("claude auth status did not start: {e}"))?;
    auth_verdict(&ran)
}

/// What a finished `claude auth status --json` says. A probe that timed out authorizes nothing; a negative answer is
/// the signed-out diagnostic whatever the exit code; a positive one counts only with exit code 0.
fn auth_verdict(ran: &Ran) -> std::result::Result<String, String> {
    let code = ran.code.map_or("none".into(), |c| c.to_string());
    if ran.timed_out {
        return Err("claude auth status did not answer within a minute".into());
    }
    let Ok(v) = serde_json::from_slice::<Value>(&ran.stdout) else {
        return Err(format!("claude auth status gave no JSON (exit {code})"));
    };
    let method = v["authMethod"].as_str().unwrap_or("none");
    let provider = v["apiProvider"].as_str().unwrap_or("firstParty");
    if v["loggedIn"] != json!(true) || method != "claude.ai" || provider != "firstParty" {
        return Err(format!("Claude Code is not signed in with a Claude subscription (claude auth status: authMethod {}, apiProvider {})", clip(method, 40), clip(provider, 40)));
    }
    if ran.code != Some(0) {
        return Err(format!(
            "claude auth status exited {code}: {}",
            stderr_tail(&ran.stderr)
        ));
    }
    account_of(&v)
}

/// How far a failed call came.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sent {
    /// The program never started: nothing was sent.
    No,
    /// The program ran and ended without a valid answer.
    Yes,
    /// The program ran past the time limit and was stopped.
    TimedOut,
}

/// The outcome of a call: `Ok` with the validated answer and the raw output, or `Err` with how far it came, why, and
/// the raw output.
pub type Outcome = std::result::Result<(Value, String), (Sent, String, String)>;

/// What a program that ran left, judged: an answer counts only when it is valid and the program exited 0. A valid
/// answer followed by a crash or another exit code is a failure, with the raw output kept.
pub fn judge(ran: &Ran, schema: &Value, limit: Duration) -> Outcome {
    let raw = String::from_utf8_lossy(&ran.stdout).into_owned();
    if ran.timed_out {
        return Err((
            Sent::TimedOut,
            format!(
                "no answer within {} min: the call was stopped",
                limit.as_secs().div_ceil(60)
            ),
            raw,
        ));
    }
    let exit = format!(
        "claude exited {}",
        ran.code.map_or("without a code".into(), |c| c.to_string())
    );
    match (read_answer(&ran.stdout, schema), ran.code) {
        (Ok(data), Some(0)) => Ok((data, raw)),
        (Ok(_), _) => Err((
            Sent::Yes,
            format!(
                "{exit} after an answer in the schema, so the call is not taken as done: {}",
                stderr_tail(&ran.stderr)
            ),
            raw,
        )),
        (Err(_), code) if code != Some(0) && raw.trim().is_empty() => Err((
            Sent::Yes,
            format!("{exit}: {}", stderr_tail(&ran.stderr)),
            raw,
        )),
        (Err(why), Some(0)) => Err((Sent::Yes, why, raw)),
        (Err(why), _) => Err((Sent::Yes, format!("{why} ({exit})"), raw)),
    }
}

/// One call in `dir`, which the caller owns: the settings and an empty working folder are made there. `started`
/// runs right before the program is started; an error from it starts nothing.
#[allow(clippy::too_many_arguments)]
pub fn call(
    p: &Program,
    dir: &Path,
    model: &str,
    effort: &str,
    text: &str,
    schema: &Value,
    limit: Duration,
    started: impl FnOnce() -> Result<()>,
) -> Outcome {
    let settings = dir.join("settings.json");
    let cwd = dir.join("cwd");
    let prepared = fs::write(&settings, SETTINGS).and_then(|_| fs::create_dir_all(&cwd));
    if let Err(e) = prepared {
        return Err((
            Sent::No,
            format!("cannot prepare the call folder: {e}"),
            String::new(),
        ));
    }
    let mut c = command(p);
    c.args(call_args(model, effort, &settings));
    if let Err(e) = started() {
        return Err((
            Sent::No,
            format!("cannot record the start of the call: {}", e.0),
            String::new(),
        ));
    }
    match run(c, text.as_bytes(), &cwd, limit) {
        Ok(ran) => judge(&ran, schema, limit),
        Err(e) => Err((
            Sent::No,
            format!("claude did not start: {e}"),
            String::new(),
        )),
    }
}

/// Whether the person enabled Claude as an executor: `"claude": true` in `~/.zodchi/flow.json` (`$ZODCHI_HOME`
/// respected). Anything else, an absent or unreadable file included, is "not enabled".
pub fn enabled(cfg: &Config) -> bool {
    opt_in(cfg, &["claude"])
}

fn opt_in(cfg: &Config, fields: &[&str]) -> bool {
    std::fs::read_to_string(cfg.home.join("flow.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|v| fields.iter().any(|field| v[*field] == true))
}

fn attachment_input(text: &str, request: &Value, dir: &Path) -> Result<Option<String>> {
    let images = request["images"].as_array().filter(|rows| !rows.is_empty());
    let Some(images) = images else {
        return Ok(None);
    };
    let mut content = vec![json!({ "type": "text", "text": text })];
    for (i, image) in images.iter().enumerate() {
        let ext = image["ext"].as_str().unwrap_or("");
        let media = match ext {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => {
                return crate::util::fail(
                    "The stored Claude attachment has an unsupported image type.",
                )
            }
        };
        let bytes = fs::read(dir.join(format!("in-{i}.{ext}")))?;
        if image["sha256"] != sha256_hex(&bytes) || image_type(&bytes) != Some(ext) {
            return crate::util::fail(
                "A stored Claude attachment no longer matches the submitted image.",
            );
        }
        content.push(json!({
            "type": "image", "source": { "type": "base64", "media_type": media, "data": STANDARD.encode(bytes) }
        }));
    }
    Ok(Some(format!(
        "{}\n",
        json!({
            "type": "user", "message": { "role": "user", "content": content }
        })
    )))
}

/// Execute a gateway job with the same subscription, environment and ephemeral CLI transport as Flow.
pub(crate) fn gateway_call(
    cfg: &Config,
    dir: &Path,
    request: &Value,
    state: &JobState,
) -> Result<(&'static str, Value)> {
    let failed = |message: String| ("failed", json!({ "error": message }));
    if !opt_in(cfg, &["claudeExperts", "claude"]) {
        return Ok(failed(
            "Claude experts are disabled in the local Zodchi flow.json. Set claudeExperts to true to enable this route.".into(),
        ));
    }
    let p = match find_program() {
        Ok(p) => p,
        Err(reason) => return Ok(failed(reason)),
    };
    let cwd = dir.join("cwd");
    fs::create_dir(&cwd)?;
    let account = match signed_in(&p, &cwd) {
        Ok(account) => account,
        Err(reason) => return Ok(("auth_required", json!({ "error": reason }))),
    };
    let settings = dir.join("settings.json");
    fs::write(&settings, SETTINGS)?;
    let role = &request["role"];
    let model = role["model"].as_str().expect("validated model");
    let schema = &role["outputSchema"];
    let text = message(
        role["instructions"].as_str().unwrap_or(""),
        request["prompt"].as_str().unwrap_or(""),
        schema,
    );
    let input = attachment_input(&text, request, dir)?;
    let effort = role["effort"].as_str().expect("validated effort");
    let mut command = command(&p);
    command.args(print_args(model, effort, &settings, input.is_some()));
    if !opt_in(cfg, &["claudeExperts", "claude"]) {
        return Ok(failed(
            "Claude was disabled before the model request.".into(),
        ));
    }
    let limit =
        Duration::from_millis(state.get()["timeoutMs"].as_f64().unwrap_or(1_800_000.0) as u64);
    state.save(json!({ "account": account, "turnRequestedAt": iso() }))?;
    let mut ran = match run_recorded(
        command,
        input.as_deref().unwrap_or(&text).as_bytes(),
        &cwd,
        limit,
        |pid| {
            state.save(json!({ "providerPid": pid, "providerStart": process_start(pid), "turnStartedAt": iso() }))
            .map_err(|error| io::Error::other(error.0))
        },
    ) {
        Ok(ran) => ran,
        Err(error) => {
            return Ok(failed(format!(
                "Claude Code could not be started or its process recorded: {error}"
            )))
        }
    };
    let mut models = std::collections::BTreeSet::new();
    if input.is_some() {
        let mut result = None;
        for row in ran
            .stdout
            .split(|byte| *byte == b'\n')
            .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        {
            if row["type"] == "assistant" {
                if let Some(model) = row["message"]["model"].as_str() {
                    models.insert(model.to_owned());
                }
            } else if row["type"] == "result" {
                result = Some(row);
            }
        }
        ran.stdout = result.map_or_else(Vec::new, |row| row.to_string().into_bytes());
    }
    match judge(&ran, schema, limit) {
        Ok((answer, raw)) => {
            let receipt: Value = serde_json::from_str(&raw).unwrap_or_default();
            let usage = &receipt["usage"];
            models.extend(
                receipt["modelUsage"]
                    .as_object()
                    .into_iter()
                    .flat_map(|v| v.keys().cloned()),
            );
            let result = if schema.is_null() {
                json!({ "text": answer })
            } else {
                json!({ "data": answer })
            };
            Ok((
                "succeeded",
                json!({
                    "result": result, "actualModels": models,
                    "tokens": {
                        "inputTokens": usage["input_tokens"], "outputTokens": usage["output_tokens"],
                        "cachedInputTokens": usage["cache_read_input_tokens"], "cacheCreationInputTokens": usage["cache_creation_input_tokens"]
                    }
                }),
            ))
        }
        Err((Sent::TimedOut, reason, _)) => Ok(("timeout", json!({ "error": reason }))),
        Err((_, reason, _)) => Ok(failed(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn result(text: &str) -> Vec<u8> {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": text })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn the_auth_probe_needs_a_clean_exit() {
        let ran = |code: Option<i32>, timed_out: bool, status: Value| Ran {
            code,
            stdout: status.to_string().into_bytes(),
            stderr: b"failed".to_vec(),
            timed_out,
        };
        let yes = json!({ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "a", "orgId": "o" });
        let no = json!({ "loggedIn": false, "authMethod": "none" });
        assert!(auth_verdict(&ran(Some(0), false, yes.clone()))
            .unwrap()
            .starts_with("claude-"));
        assert!(
            auth_verdict(&ran(Some(1), false, yes.clone()))
                .unwrap_err()
                .starts_with("claude auth status exited 1"),
            "a positive answer with a failed exit"
        );
        assert!(
            auth_verdict(&ran(None, false, yes.clone()))
                .unwrap_err()
                .starts_with("claude auth status exited none"),
            "a positive answer of a crashed probe"
        );
        assert!(
            auth_verdict(&ran(Some(0), true, yes))
                .unwrap_err()
                .contains("within a minute"),
            "a positive answer of a probe that hung"
        );
        assert!(
            auth_verdict(&ran(Some(1), false, no))
                .unwrap_err()
                .starts_with("Claude Code is not signed in"),
            "the signed-out diagnostic stays"
        );
    }

    #[test]
    fn answers_are_read_and_checked() {
        let schema = json!({ "type": "object", "additionalProperties": false, "required": ["ok", "list"],
            "properties": { "ok": { "type": "boolean" }, "list": { "type": "array", "items": { "type": ["string", "null"] } } } });
        assert_eq!(
            read_answer(&result(r#"{"ok": true, "list": ["a", null]}"#), &schema).unwrap(),
            json!({ "ok": true, "list": ["a", null] })
        );
        assert!(read_answer(
            &result("```json\n{\"ok\": false, \"list\": []}\n```"),
            &schema
        )
        .is_ok());
        assert!(read_answer(&result(r#"{"ok": true}"#), &schema)
            .unwrap_err()
            .contains("has no list"));
        assert!(
            read_answer(&result(r#"{"ok": true, "list": [], "more": 1}"#), &schema)
                .unwrap_err()
                .contains("does not allow")
        );
        assert!(
            read_answer(&result(r#"{"ok": "yes", "list": []}"#), &schema)
                .unwrap_err()
                .contains("not of type boolean")
        );
        assert!(
            read_answer(&result(r#"{"ok": true, "list": [1]}"#), &schema)
                .unwrap_err()
                .contains("none of the types")
        );
        assert!(read_answer(&result("Here it is: {}"), &schema)
            .unwrap_err()
            .contains("not one JSON object"));
        assert!(read_answer(b"not json", &schema).is_err());
        let refused = json!({ "type": "result", "subtype": "success", "is_error": true, "result": "There's an issue with the selected model" });
        assert!(read_answer(refused.to_string().as_bytes(), &schema)
            .unwrap_err()
            .starts_with("claude ended with an error"));
    }

    #[test]
    fn keys_and_credentials_stay_out() {
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "OPENAI_API_KEY",
            "GH_TOKEN",
            "CLAUDECODE",
            "ZODCHI_FLOW_CUT",
        ] {
            assert!(withheld(name), "{name}");
        }
        for name in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR",
            "HTTPS_PROXY",
        ] {
            assert!(!withheld(name), "{name}");
        }
        let args: Vec<String> = call_args("opus", "high", Path::new("s.json"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let at = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[at + 1], "");
        for flag in [
            "-p",
            "--strict-mcp-config",
            "--safe-mode",
            "--no-session-persistence",
            "--disable-slash-commands",
        ] {
            assert!(args.contains(&flag.to_string()), "{flag}");
        }
        assert!(!args.iter().any(|a| a.contains("fallback")));
        assert!(stderr_tail(b"fine\nAuthorization: Bearer abc\napi key x\n").ends_with("fine"));
    }

    #[test]
    fn an_answer_counts_only_with_a_clean_exit() {
        let schema = json!({ "type": "object", "required": ["ok"], "properties": { "ok": { "type": "boolean" } } });
        let ran = |code: Option<i32>, out: &[u8]| Ran {
            code,
            stdout: out.to_vec(),
            stderr: b"crashed after the answer\n".to_vec(),
            timed_out: false,
        };
        let limit = Duration::from_secs(60);
        assert_eq!(
            judge(&ran(Some(0), &result(r#"{"ok": true}"#)), &schema, limit)
                .unwrap()
                .0,
            json!({ "ok": true })
        );
        for code in [Some(1), Some(3), None] {
            let (sent, why, raw) =
                judge(&ran(code, &result(r#"{"ok": true}"#)), &schema, limit).unwrap_err();
            assert_eq!(sent, Sent::Yes);
            assert!(
                why.starts_with("claude exited")
                    && why.contains("not taken as done")
                    && raw.contains(r#""type":"result""#),
                "{why}"
            );
        }
        assert!(judge(&ran(Some(2), b""), &schema, limit)
            .unwrap_err()
            .1
            .ends_with("crashed after the answer"));
        assert!(judge(&ran(Some(1), &result("prose")), &schema, limit)
            .unwrap_err()
            .1
            .contains("not one JSON object"));
        let mut late = ran(Some(0), &result(r#"{"ok": true}"#));
        late.timed_out = true;
        assert_eq!(judge(&late, &schema, limit).unwrap_err().0, Sent::TimedOut);
    }

    #[test]
    fn an_account_is_a_digest_of_the_sign_in() {
        let one = account_of(&json!({ "email": format!("Person@{}", "example.test"), "orgId": "org-1", "subscriptionType": "max" })).unwrap();
        assert!(
            one.starts_with("claude-") && one.len() == 23 && !one.contains("org-1"),
            "{one}"
        );
        assert_eq!(
            one,
            account_of(&json!({ "email": format!("person@{}", "example.test"), "orgId": "org-1" }))
                .unwrap()
        );
        assert_ne!(
            one,
            account_of(&json!({ "email": format!("person@{}", "example.test"), "orgId": "org-2" }))
                .unwrap()
        );
        assert!(account_of(&json!({ "loggedIn": true, "authMethod": "claude.ai" })).is_err());
    }

    #[test]
    fn a_call_past_its_limit_is_stopped() {
        let Some(node) = on_path(if cfg!(windows) {
            &["node.exe"]
        } else {
            &["node"]
        }) else {
            return;
        };
        let mut c = Command::new(node);
        c.args(["-e", "process.stdin.resume(); setTimeout(() => {}, 60000)"]);
        let started = Instant::now();
        let ran = run(
            c,
            b"input",
            &std::env::temp_dir(),
            Duration::from_millis(500),
        )
        .unwrap();
        assert!(ran.timed_out && started.elapsed() < Duration::from_secs(30));
        let mut c = Command::new(
            on_path(if cfg!(windows) {
                &["node.exe"]
            } else {
                &["node"]
            })
            .unwrap(),
        );
        c.args(["-e", "let s = ''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(s.toUpperCase()))"]);
        let ran = run(c, b"echo", &std::env::temp_dir(), Duration::from_secs(30)).unwrap();
        assert_eq!(
            (ran.code, ran.stdout.as_slice(), ran.timed_out),
            (Some(0), b"ECHO".as_slice(), false)
        );
    }
}
