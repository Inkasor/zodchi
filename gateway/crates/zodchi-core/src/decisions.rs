//! The Decisions API of OpenAI: probabilities for the questions of the role over the request and its images. It is
//! paid for by the caller's API key and not by a subscription, so no Codex is started. The key is read by the worker
//! from its environment, is sent to the API and nowhere else, and is written into nothing.

use crate::appserver::TurnFailed;
use crate::job::Call;
use crate::role::{asked_questions, verdict};
use crate::util::iso;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

const DECISIONS_URL: &str = "https://api.openai.com/v1/decisions";

fn mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        _ => "image/webp",
    }
}

/// The usage of the API under the names a Codex job counts its tokens by. Only the numbers are taken.
pub fn decision_tokens(usage: &Value) -> Value {
    if !usage.is_object() {
        return Value::Null;
    }
    let count = |v: Option<&Value>| v.and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).unwrap_or(0);
    let input = count(usage.get("input_tokens"));
    let output = count(usage.get("output_tokens"));
    let total = match count(usage.get("total_tokens")) {
        0 => input + output,
        t => t,
    };
    json!({ "totalTokens": total, "inputTokens": input,
        "cachedInputTokens": count(usage.get("input_tokens_details").and_then(|d| d.get("cached_tokens"))),
        "cacheWriteInputTokens": count(usage.get("input_tokens_details").and_then(|d| d.get("cache_write_tokens"))),
        "outputTokens": output,
        "reasoningOutputTokens": count(usage.get("output_tokens_details").and_then(|d| d.get("reasoning_tokens"))) })
}

struct Scrubber {
    key: String,
}

impl Scrubber {
    /// Removes the key itself.
    fn hide(&self, text: &str) -> String {
        if self.key.is_empty() { text.to_string() } else { text.replace(&self.key, "***") }
    }
    /// For the text of an error: also what looks like a key written short ("sk-ab...yz").
    fn quiet(&self, text: &str) -> String {
        let hidden = self.hide(text);
        let mut out = String::new();
        let mut rest = hidden.as_str();
        while let Some(at) = rest.find("sk-") {
            let boundary = at == 0 || !rest[..at].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_');
            out.push_str(&rest[..at]);
            let tail = &rest[at + 3..];
            let len = tail.chars().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '*' | '.' | '-')).map(char::len_utf8).sum::<usize>();
            if boundary && len >= 4 {
                out.push_str("***");
                rest = &tail[len..];
            } else {
                out.push_str("sk-");
                rest = tail;
            }
        }
        out.push_str(rest);
        out
    }
    /// The key again in a parsed answer, where JSON escapes no longer cover it.
    fn scrub(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.hide(s)),
            Value::Array(a) => Value::Array(a.iter().map(|v| self.scrub(v)).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (self.hide(k), self.scrub(v))).collect::<Map<_, _>>()),
            other => other.clone(),
        }
    }
}

pub fn call(call: &Call) -> Result<Value, TurnFailed> {
    let key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    // The worker asks again what `submit` asked: the request on disk is what spends, whoever wrote it there.
    if call.request.get("paid") != Some(&json!(true)) || call.state.get().get("paid") != Some(&json!(true)) {
        return Err(TurnFailed::new("failed", "This decisions job was not stored with --paid; the API was not asked and nothing was spent."));
    }
    if key.is_empty() {
        return Err(TurnFailed::new("auth_required", "OPENAI_API_KEY is not set where the gateway runs; the API was not asked and nothing was spent."));
    }
    let s = Scrubber { key: key.clone() };
    let mut content = vec![json!({ "type": "input_text", "text": call.request["prompt"] })];
    for image in call.request.get("images").and_then(Value::as_array).cloned().unwrap_or_default() {
        let ext = image["ext"].as_str().unwrap_or("png");
        let bytes = std::fs::read(call.dir.join(format!("in-{}.{ext}", image["index"]))).map_err(|e| TurnFailed::new("failed", e.to_string()))?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        content.push(json!({ "type": "input_image", "image_url": format!("data:{};base64,{data}", mime(ext)) }));
    }
    let mut input = Vec::new();
    if let Some(frame) = call.role.get("instructions").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        input.push(json!({ "role": "developer", "content": [{ "type": "input_text", "text": frame }] }));
    }
    input.push(json!({ "role": "user", "content": content }));
    let body = json!({ "model": call.role["model"], "input": input, "questions": asked_questions(&call.role["questions"]) });
    if call.state.decided() {
        return Err(TurnFailed::new("timeout", "The call was cut off before the API was asked."));
    }
    call.state.save(json!({ "turnRequestedAt": iso() })).map_err(|e| TurnFailed::new("failed", e.0))?;
    let started = Instant::now();
    let (status, text) = post(call, &key, &body.to_string(), &s)?;
    let accepted = (200..=299).contains(&status);
    if accepted {
        call.state.keep(json!({ "turnStartedAt": iso() }));
    }
    // Only what was parsed and scrubbed goes on from here; the raw body is kept nowhere.
    let parsed: Option<Value> = serde_json::from_str(&text).ok().map(|v| s.scrub(&v));
    if !accepted {
        let refused = status == 401 || status == 403;
        let said = if refused {
            "it refused the key. Its message is not kept".to_string()
        } else {
            match &parsed {
                None if text.is_empty() => "no message".into(),
                None => "a body that is not JSON. It is not kept".into(),
                Some(answer) => {
                    let message = answer.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(String::from).unwrap_or_else(|| answer.to_string());
                    s.quiet(&message).chars().take(400).collect()
                }
            }
        };
        let code = if refused { "auth_required" } else if status == 429 { "limited" } else { "failed" };
        return Err(TurnFailed::new(code, format!("The Decisions API answered {status}: {said}")));
    }
    let answer = parsed.unwrap_or(Value::Null);
    let Some(answers) = answer.get("answers").and_then(Value::as_array).cloned() else {
        return Err(TurnFailed::new("failed", "The Decisions API answered without answers. It accepted the request: count it as charged."));
    };
    let mut data = json!({ "model": answer.get("model").cloned().unwrap_or(Value::Null), "answers": answers });
    if let Some(judged) = verdict(&call.role["questions"], &answers) {
        data["verdict"] = judged;
    }
    Ok(json!({ "tokens": decision_tokens(answer.get("usage").unwrap_or(&Value::Null)),
        "result": { "text": Value::Array(answers.clone()).to_string(), "data": data, "images": [], "durationMs": started.elapsed().as_millis() as u64 } }))
}

/// One POST through the system `curl` (Windows 10 and later, macOS and Linux have it), so the gateway carries no
/// TLS stack of its own. The key goes in a header read from stdin, never on the command line; the body is a file in
/// the job folder that holds no key. HTTPS only, no redirect. Returns the HTTP status and the body.
fn post(call: &Call, key: &str, body: &str, s: &Scrubber) -> Result<(u16, String), TurnFailed> {
    let body_file = call.dir.join("decisions-request.json");
    std::fs::write(&body_file, body).map_err(|e| TurnFailed::new("failed", format!("{e}; the API was not asked.")))?;
    let seconds = (call.timeout_ms / 1000).max(1).to_string();
    let mut command = Command::new("curl");
    // --disable first: no curlrc of the user (retries, tracing, proxies of its own) takes part.
    command
        .args(["--disable", "-sS", "--proto", "=https", "--max-redirs", "0", "--max-time", &seconds, "-X", "POST", DECISIONS_URL,
            "-H", "@-", "-H", "content-type: application/json", "--data-binary"])
        .arg(format!("@{}", body_file.display()))
        .args(["-w", "\n%{http_code}"])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let unspent = |e: String| {
        let _ = std::fs::remove_file(&body_file);
        TurnFailed::new("failed", format!("{e}; the API was not asked and nothing was spent."))
    };
    // curl is recorded like Codex: whoever settles a dead worker stops it by pid and start before deciding.
    call.note_spawn(&call.state).map_err(|e| unspent(e.message))?;
    let mut child = command.spawn().map_err(|e| {
        let _ = Call::note_pid(&call.state, None);
        unspent(format!("curl could not be started: {e}"))
    })?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    *call.helper.lock().unwrap() = Some(child);
    if let Err(e) = Call::note_pid(&call.state, Some(pid)) {
        call.stop();
        return Err(unspent(format!("curl could not be recorded: {}", e.message)));
    }
    if call.abort.load(std::sync::atomic::Ordering::SeqCst) {
        call.stop();
        return Err(unspent("The call was cut off before the API was asked".into()));
    }
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(format!("authorization: Bearer {key}\n").as_bytes());
    }
    let out_reader = std::thread::spawn(move || { let mut b = Vec::new(); let _ = std::io::Read::read_to_end(&mut stdout, &mut b); b });
    let err_reader = std::thread::spawn(move || { let mut b = Vec::new(); let _ = std::io::Read::read_to_end(&mut stderr, &mut b); b });
    // Waits for curl while stop() can still reach it: the child stays in the shared slot until it has exited.
    let status = loop {
        {
            let mut slot = call.helper.lock().unwrap();
            match slot.as_mut() {
                None => break None, // stop() took it, killed and reaped it
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *slot = None;
                        break Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => break None,
                },
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let _ = std::fs::remove_file(&body_file);
    let output = std::process::Output {
        status: status.ok_or_else(|| TurnFailed::new("timeout", "The call was stopped while the Decisions API was asked; whether the request was charged is unknown."))?,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let (text, code) = match stdout.rfind('\n') {
        Some(at) => (stdout[..at].to_string(), stdout[at + 1..].trim().parse::<u16>().unwrap_or(0)),
        None => (String::new(), stdout.trim().parse::<u16>().unwrap_or(0)),
    };
    match output.status.code() {
        Some(0) if code != 0 => Ok((code, text)),
        // 28: the time ran out. With an HTTP status already read, the API had accepted the request.
        Some(28) if (200..=299).contains(&code) => Err(TurnFailed::new("timeout", "The Decisions API accepted the request and its answer did not arrive in the allowed time. Count the request as charged.")),
        Some(28) => Err(TurnFailed::new("timeout", "The Decisions API did not answer in the allowed time; whether the request was charged is unknown.")),
        _ => {
            let said = s.quiet(String::from_utf8_lossy(&output.stderr).trim());
            if (200..=299).contains(&code) {
                Err(TurnFailed::new("unknown", format!("The Decisions API accepted the request and its answer broke off: {said}. Count the request as charged.")))
            } else {
                Err(TurnFailed::new("unknown", format!("The request to the Decisions API broke off: {said}. Whether it was charged is unknown.")))
            }
        }
    }
}
