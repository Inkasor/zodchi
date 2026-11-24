//! A single paid speech turn over OpenAI's Realtime WebSocket.

use crate::appserver::{TurnFailed, TurnResult, SAFETY_BLOCKED, SAFETY_MESSAGE};
use crate::util::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};
use tungstenite::{
    client::IntoClientRequest,
    http::{header::AUTHORIZATION, HeaderValue},
    protocol::WebSocketConfig,
    stream::MaybeTlsStream,
    Error, Message, WebSocket,
};

pub const MODEL: &str = "gpt-realtime-2.1-mini";
pub const SAMPLE_RATE: u32 = 24_000;
pub const VOICES: [&str; 10] = [
    "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
];
const HOST: &str = "api.openai.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);
const DEADLINE: Duration = Duration::from_secs(75);
const MAX_PCM: usize = SAMPLE_RATE as usize * 2 * 35;

pub struct SpeechRequest<'a> {
    pub voice: &'a str,
    pub speed: f64,
    pub instructions: &'a str,
    pub text: &'a str,
    pub max_output_tokens: u32,
}

pub struct Speech {
    /// Signed little-endian PCM16 mono at SAMPLE_RATE, ready to wrap in WAV.
    pub pcm: Vec<u8>,
    pub receipt: Value,
}

fn transport_error(error: Error, submitted: bool) -> TurnFailed {
    if let Error::Http(reply) = &error {
        let status = reply.status().as_u16();
        let kind = match status {
            401 | 403 => "auth_required",
            429 => "limited",
            _ => "failed",
        };
        return TurnFailed::new(
            kind,
            format!("OpenAI rejected the Realtime connection (HTTP {status})."),
        );
    }
    let (kind, message) = if submitted {
        ("unknown", "The Realtime connection ended before a completed answer. The turn may have been charged.")
    } else {
        (
            "failed",
            "Could not establish or configure the Realtime connection before requesting speech.",
        )
    };
    TurnFailed::new(kind, message)
}

fn provider_error(event: &Value) -> TurnFailed {
    let kind = match event["error"]["code"].as_str() {
        Some("content_filter" | "content_policy_violation") => {
            return TurnFailed::new(SAFETY_BLOCKED, SAFETY_MESSAGE);
        }
        Some("invalid_api_key" | "authentication_error") => "auth_required",
        Some("rate_limit_exceeded" | "insufficient_quota") => "limited",
        _ => "failed",
    };
    // The upstream text can repeat request content. Keep a bounded field name only.
    let param = event["error"]["param"].as_str().filter(|text| {
        text.len() <= 80
            && ["session.", "response.", "item."]
                .iter()
                .any(|prefix| text.starts_with(prefix))
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'[' | b']'))
    });
    let message = match (kind, param) {
        ("auth_required", _) => "The Realtime API refused the OpenAI API key.".into(),
        ("limited", _) => "The Realtime API reported a rate limit or insufficient quota.".into(),
        (_, Some(field)) => format!("The Realtime API rejected the field {field}."),
        _ => "The Realtime API rejected a session event.".into(),
    };
    TurnFailed::new(kind, message)
}

fn connect(key: &str) -> TurnResult<WebSocket<MaybeTlsStream<TcpStream>>> {
    let mut request = format!("wss://{HOST}/v1/realtime?model={MODEL}")
        .into_client_request()
        .map_err(|error| transport_error(error, false))?;
    let mut bearer = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| {
        TurnFailed::new(
            "auth_required",
            "OPENAI_API_KEY cannot be used as an HTTP header.",
        )
    })?;
    bearer.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, bearer);
    let addresses = (HOST, 443)
        .to_socket_addrs()
        .map_err(|_| TurnFailed::new("failed", "Could not resolve api.openai.com."))?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let stream = addresses
        .filter_map(|address| {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            TcpStream::connect_timeout(&address, remaining).ok()
        })
        .next()
        .ok_or_else(|| TurnFailed::new("failed", "Could not connect to api.openai.com."))?;
    stream
        .set_read_timeout(Some(SOCKET_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(SOCKET_TIMEOUT)))
        .map_err(|error| transport_error(Error::Io(error), false))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    tungstenite::client_tls_with_config(request, stream, Some(config), None)
        .map(|(socket, _)| socket)
        .map_err(|error| match error {
            tungstenite::HandshakeError::Failure(error) => transport_error(error, false),
            tungstenite::HandshakeError::Interrupted(_) => {
                TurnFailed::new("failed", "The Realtime WebSocket handshake did not finish.")
            }
        })
}

fn send<S: Read + Write>(
    socket: &mut WebSocket<S>,
    event: Value,
    submitted: bool,
) -> TurnResult<()> {
    socket
        .send(Message::Text(event.to_string().into()))
        .map_err(|error| transport_error(error, submitted))
}

fn receive<S: Read + Write>(
    socket: &mut WebSocket<S>,
    deadline: Instant,
    submitted: bool,
) -> TurnResult<Value> {
    while Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event: Value = serde_json::from_str(text.as_str()).map_err(|_| {
                    let code = if submitted { "unknown" } else { "failed" };
                    TurnFailed::new(code, "The Realtime API sent a malformed event.")
                })?;
                if event["type"] == "error" {
                    return Err(provider_error(&event));
                }
                return Ok(event);
            }
            Ok(Message::Close(_)) => {
                return Err(transport_error(Error::ConnectionClosed, submitted))
            }
            Ok(_) => {}
            Err(Error::Io(error))
                if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) => return Err(transport_error(error, submitted)),
        }
    }
    let code = if submitted { "unknown" } else { "timeout" };
    Err(TurnFailed::new(
        code,
        "The Realtime turn timed out. Inspect the run before another paid request.",
    ))
}

fn wait_for<S: Read + Write>(
    socket: &mut WebSocket<S>,
    deadline: Instant,
    event_type: &str,
    submitted: bool,
) -> TurnResult<Value> {
    loop {
        let event = receive(socket, deadline, submitted)?;
        if event["type"] == event_type {
            return Ok(event);
        }
    }
}

/// Call only after the owner has authorized API spend. The callback must durably record intent
/// immediately before response.create. Once it runs, recovery must assume the turn may be paid.
pub fn speak(
    request: SpeechRequest<'_>,
    before_response: impl FnOnce() -> Result<()>,
) -> TurnResult<Speech> {
    if !VOICES.contains(&request.voice)
        || request.text.trim().is_empty()
        || !(32..=4096).contains(&request.max_output_tokens)
        || !(0.25..=1.5).contains(&request.speed)
    {
        return Err(TurnFailed::new(
            "failed",
            "A Realtime speech request needs text, a built-in voice, valid speed and an output limit.",
        ));
    }
    let key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            TurnFailed::new(
                "auth_required",
                "Set OPENAI_API_KEY where Zodchi runs to authorize Realtime API access.",
            )
        })?;
    let mut socket = connect(&key)?;
    exchange(&mut socket, request, before_response)
}

fn exchange<S: Read + Write>(
    socket: &mut WebSocket<S>,
    request: SpeechRequest<'_>,
    before_response: impl FnOnce() -> Result<()>,
) -> TurnResult<Speech> {
    let deadline = Instant::now() + DEADLINE;
    wait_for(socket, deadline, "session.created", false)?;
    send(
        socket,
        json!({
            "type": "session.update",
            "session": {
                "type": "realtime", "instructions": request.instructions,
                "output_modalities": ["audio"],
                "audio": { "input": { "turn_detection": null },
                    "output": { "format": { "type": "audio/pcm", "rate": SAMPLE_RATE },
                        "voice": request.voice, "speed": request.speed } }
            }
        }),
        false,
    )?;
    let updated = wait_for(socket, deadline, "session.updated", false)?;
    let session = &updated["session"];
    if session["audio"]["output"]["voice"] != request.voice
        || !session["id"].as_str().is_some_and(|id| !id.is_empty())
        || session["audio"]["output"]["format"]["type"] != "audio/pcm"
        || session["audio"]["output"]["format"]["rate"] != SAMPLE_RATE
        || (session["audio"]["output"]["speed"].as_f64().unwrap_or(1.0) - request.speed).abs()
            > 0.0001
    {
        return Err(TurnFailed::new(
            "failed",
            "The Realtime session did not confirm the requested voice, speed and PCM format.",
        ));
    }
    before_response().map_err(|error| TurnFailed::new("failed", error.0))?;
    let started = Instant::now();
    send(
        socket,
        json!({
            "type": "response.create",
            "response": {
                "conversation": "none",
                "max_output_tokens": request.max_output_tokens,
                "output_modalities": ["audio"],
                "input": [{"type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": request.text}]}]
            }
        }),
        true,
    )?;
    let created = wait_for(socket, deadline, "response.created", true)?;
    let response_id = created["response"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| TurnFailed::new("unknown", "The Realtime response has no ID."))?;
    let mut pcm = Vec::new();
    let mut first_audio = None;
    let response = loop {
        let event = receive(socket, deadline, true)?;
        match event["type"].as_str() {
            Some("response.output_audio.delta") if event["response_id"] == response_id => {
                let bytes = event["delta"]
                    .as_str()
                    .and_then(|chunk| STANDARD.decode(chunk).ok())
                    .ok_or_else(|| {
                        TurnFailed::new(
                            "unknown",
                            "OpenAI returned an invalid Realtime audio chunk.",
                        )
                    })?;
                if pcm.len() + bytes.len() > MAX_PCM {
                    return Err(TurnFailed::new(
                        "unknown",
                        "The audio exceeded the maximum size for a speech cue.",
                    ));
                }
                if !bytes.is_empty() {
                    first_audio.get_or_insert_with(|| started.elapsed().as_millis() as u64);
                    pcm.extend_from_slice(&bytes);
                }
            }
            Some("response.done") if event["response"]["id"] == response_id => break event,
            _ => {}
        }
    };
    let response = &response["response"];
    let status = response["status"].as_str().unwrap_or("");
    if status != "completed" {
        if response["status_details"]["reason"] == "content_filter"
            || response["status_details"]["error"]["code"] == "content_policy_violation"
        {
            return Err(TurnFailed::new(SAFETY_BLOCKED, SAFETY_MESSAGE));
        }
        let reason = match status {
            "incomplete" => "was incomplete, possibly at the output limit",
            "cancelled" => "was cancelled",
            _ => "failed on the provider",
        };
        return Err(TurnFailed::new(
            "failed",
            format!("The Realtime response {reason}. The turn may have been charged."),
        ));
    }
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err(TurnFailed::new(
            "failed",
            "The completed Realtime response has no usable PCM16 audio.",
        ));
    }
    let transcript = response["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "output_audio")
        .filter_map(|part| part["transcript"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Speech {
        pcm,
        receipt: json!({
            "requestedModel": MODEL, "model": session["model"], "voice": request.voice, "speed": request.speed,
            "sessionId": session["id"], "responseId": response_id, "transcript": transcript,
            "usage": response["usage"], "firstAudioMs": first_audio,
            "responseMs": started.elapsed().as_millis() as u64
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, net::TcpListener, thread};

    #[test]
    fn receives_audio_and_usage_after_recording_intent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let provider = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut server = tungstenite::accept(stream).unwrap();
            send(&mut server, json!({ "type": "session.created" }), false).unwrap();
            let update =
                receive(&mut server, Instant::now() + Duration::from_secs(3), false).unwrap();
            assert_eq!(update["type"], "session.update");
            let output = &update["session"]["audio"]["output"];
            assert_eq!(output["speed"], 1.08);
            send(
                &mut server,
                json!({ "type": "session.updated", "session": {
                    "id": "session-fixture", "model": MODEL, "audio": { "output": output }
                }}),
                false,
            )
            .unwrap();
            let request =
                receive(&mut server, Instant::now() + Duration::from_secs(3), false).unwrap();
            assert_eq!(request["type"], "response.create");
            assert_eq!(
                request["response"]["input"][0]["content"][0]["text"],
                "Keep this wording."
            );
            assert_eq!(request["response"]["max_output_tokens"], 350);
            send(
                &mut server,
                json!({ "type": "response.created", "response": { "id": "reply-fixture" }}),
                true,
            )
            .unwrap();
            for id in ["different-response", "reply-fixture"] {
                send(
                    &mut server,
                    json!({ "type": "response.output_audio.delta",
                        "response_id": id, "delta": STANDARD.encode([0, 1, 2, 3])
                    }),
                    true,
                )
                .unwrap();
            }
            send(&mut server, json!({ "type": "response.done", "response": {
                "id": "reply-fixture", "status": "completed", "usage": { "input_tokens": 18 },
                "output": [{"content": [{"type": "output_audio", "transcript": "Keep this wording."}]}]
            }}), true).unwrap();
        });
        let (mut socket, _) = tungstenite::connect(format!("ws://{address}")).unwrap();
        let called = Cell::new(false);
        let result = exchange(
            &mut socket,
            SpeechRequest {
                voice: "cedar",
                speed: 1.08,
                instructions: "Read as written.",
                text: "Keep this wording.",
                max_output_tokens: 350,
            },
            || {
                assert!(!called.replace(true));
                Ok(())
            },
        )
        .unwrap();
        provider.join().unwrap();
        assert!(called.get());
        assert_eq!(result.pcm, [0, 1, 2, 3]);
        assert_eq!(result.receipt["usage"]["input_tokens"], 18);
        assert_eq!(result.receipt["transcript"], "Keep this wording.");
    }
}
