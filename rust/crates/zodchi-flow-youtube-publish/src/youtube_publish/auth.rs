//! Desktop authorization runs separately from a publication worker.

use super::api::{self, Google, READ_SCOPE, UPLOAD_SCOPE};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    thread,
    time::{Duration, Instant},
};
use zodchi_core::{
    config::{agent_requested, Config},
    util::{fail, sha256_hex, GatewayError, Result},
};
use zodchi_flow_engine::{video_media as media, Exit};

pub(super) trait Vault {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn put(&self, key: &str, value: &str) -> Result<()>;
    fn forget(&self, key: &str) -> Result<()>;
}

pub(super) struct SystemVault {
    namespace: String,
}

impl SystemVault {
    pub(super) fn new(home: &Path) -> Result<Self> {
        fs::create_dir_all(home)?;
        let home = fs::canonicalize(home)?;
        Ok(Self {
            namespace: format!(
                "zodchi-youtube-{}",
                sha256_hex(home.to_string_lossy().as_bytes())
            ),
        })
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.namespace, key).map_err(|_| {
            GatewayError("Cannot open the system credential store for YouTube.".into())
        })
    }
}

impl Vault for SystemVault {
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn get(&self, key: &str) -> Result<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => {
                fail("Cannot read the YouTube credential. Check the system credential store.")
            }
        }
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn put(&self, key: &str, value: &str) -> Result<()> {
        self.entry(key)?.set_password(value).map_err(|_| {
            GatewayError(
                "Cannot save the YouTube credential in the system credential store.".into(),
            )
        })
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn forget(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => fail("Cannot clear the saved YouTube upload session."),
        }
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    fn get(&self, _: &str) -> Result<Option<String>> {
        fail("YouTube authorization needs a supported system credential store.")
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    fn put(&self, _: &str, _: &str) -> Result<()> {
        fail("YouTube authorization needs a supported system credential store.")
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    fn forget(&self, _: &str) -> Result<()> {
        fail("YouTube authorization needs a supported system credential store.")
    }
}

pub(super) fn profile(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|name| {
            (1..=40).contains(&name.len())
                && name.starts_with(|c: char| c.is_ascii_alphanumeric())
                && name.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_')
                })
        })
        .ok_or_else(|| {
            GatewayError(
                "profile needs 1–40 lowercase ASCII letters, digits, hyphens or underscores."
                    .into(),
            )
        })
}

pub(super) fn channel_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| id.starts_with("UC") && api::id(id, 24))
        .ok_or_else(|| {
            GatewayError("channelId needs the full YouTube channel ID beginning with UC.".into())
        })
}

fn client(input: &Value) -> Result<&Value> {
    if !input["client_id"]
        .as_str()
        .is_some_and(|id| id.ends_with(".apps.googleusercontent.com") && id.len() <= 200)
        || input
            .get("client_secret")
            .is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 512))
    {
        return fail("Use a valid Desktop app OAuth client downloaded from Google Auth Platform.");
    }
    Ok(input)
}

fn fields_of(client: &Value) -> Vec<(&str, &str)> {
    let mut fields = vec![(
        "client_id",
        client["client_id"].as_str().expect("validated client"),
    )];
    if let Some(secret) = client["client_secret"].as_str() {
        fields.push(("client_secret", secret));
    }
    fields
}

fn scopes(reply: &Value) -> Result<()> {
    let granted = reply["scope"].as_str().unwrap_or("");
    if [READ_SCOPE, UPLOAD_SCOPE]
        .iter()
        .any(|need| !granted.split_ascii_whitespace().any(|scope| &scope == need))
    {
        return fail("Google must grant both the YouTube read and upload permissions.");
    }
    Ok(())
}

fn access_token(data: &Value) -> Result<&str> {
    data["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains(char::is_whitespace))
        .ok_or_else(|| GatewayError("Google returned no usable OAuth access token.".into()))
}

fn load(vault: &dyn Vault, profile: &str) -> Result<Value> {
    let raw = vault.get(&format!("profile/{profile}"))?.ok_or_else(|| {
        GatewayError(format!(
            "Connect YouTube profile {profile} before resuming."
        ))
    })?;
    serde_json::from_str(&raw).map_err(|_| {
        GatewayError(
            "The saved YouTube connection is unreadable. Connect the same profile again.".into(),
        )
    })
}

fn refresh(google: &Google, grant: &Value) -> Result<String> {
    let mut fields = fields_of(client(&grant["client"])?);
    let refresh = grant["refreshToken"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            GatewayError(
                "The YouTube profile has no refresh token. Connect the same profile again.".into(),
            )
        })?;
    fields.extend([("grant_type", "refresh_token"), ("refresh_token", refresh)]);
    let data = google.token(&fields)?;
    if data.get("scope").is_some() {
        scopes(&data)?;
    }
    Ok(access_token(&data)?.to_owned())
}

pub(super) fn token(
    google: &Google,
    vault: &dyn Vault,
    profile: &str,
    expected: &str,
) -> Result<String> {
    let grant = load(vault, profile)?;
    if grant["channelId"] != expected {
        return fail("The saved YouTube profile points to a different channel ID.");
    }
    refresh(google, &grant)
}

pub fn whoami(name: &str) -> Result<Exit> {
    let vault = SystemVault::new(&Config::new(None)?.home)?;
    let input = json!(name);
    let profile = profile(&input)?;
    let grant = load(&vault, profile)?;
    let google = Google::new();
    let channel = google.channel(&refresh(&google, &grant)?, channel_id(&grant["channelId"])?)?;
    Ok(Exit {
        code: 0,
        result: json!({ "profile": profile, "channel": channel }),
    })
}

pub fn connect(
    args: &Value,
    controlling_terminal: fn() -> io::Result<fs::File>,
    no_consent_terminal: &str,
) -> Result<Exit> {
    media::fields(
        args,
        &["profile", "channelId", "clientFile"],
        "YouTube connection",
    )?;
    let profile = profile(&args["profile"])?;
    let expected = channel_id(&args["channelId"])?;
    let client_file = Path::new(media::text(&args["clientFile"], "clientFile")?);
    if !client_file.is_absolute() {
        return fail("clientFile must be an absolute path to the downloaded Desktop app JSON.");
    }
    let terminal_error = |_| GatewayError(no_consent_terminal.into());
    let terminal = if agent_requested() {
        Some(controlling_terminal().map_err(terminal_error)?)
    } else {
        None
    };
    let mut credentials = Vec::new();
    fs::File::open(client_file)?
        .take(16_385)
        .read_to_end(&mut credentials)?;
    if credentials.len() > 16_384 {
        return fail("The Desktop app JSON is too large.");
    }
    let input: Value = serde_json::from_slice(
        credentials
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&credentials),
    )
    .map_err(|_| GatewayError("The Desktop app credential file is not valid JSON.".into()))?;
    let installed = client(&input["installed"])?;
    let client = json!({ "client_id": installed["client_id"], "client_secret": installed.get("client_secret") });
    let mut fields = fields_of(installed);
    let vault = SystemVault::new(&Config::new(None)?.home)?;
    let _ = vault.get(&format!("profile/{profile}"))?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let redirect = format!("http://{}/oauth2/callback", listener.local_addr()?);
    let state = nonce();
    let verifier = nonce();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let requested = format!("{READ_SCOPE} {UPLOAD_SCOPE}");
    let request = api::form(&[
        ("client_id", fields[0].1),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", &requested),
        ("state", &state),
        ("code_challenge_method", "S256"),
        ("code_challenge", &challenge),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ]);
    let prompt = "Open this Google consent page in your browser. The local connection waits for five minutes.";
    let url = format!("https://accounts.google.com/o/oauth2/v2/auth?{request}");
    if let Some(mut terminal) = terminal {
        writeln!(terminal, "{prompt}\n{url}").map_err(terminal_error)?;
    } else {
        ::std::eprintln!("{prompt}");
        ::std::eprintln!("{url}");
    }
    let code = await_consent(listener, &state)?;
    fields.extend([
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ]);
    let google = Google::new();
    let data = google.token(&fields)?;
    scopes(&data)?;
    let refresh = data["refresh_token"]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            GatewayError("Google did not grant offline access for this YouTube connection.".into())
        })?;
    let channel = google.channel(access_token(&data)?, expected)?;
    // Keep only the original client fields required for token refresh.
    let mut grant = json!({ "client": client, "refreshToken": refresh, "channelId": expected });
    if grant["client"]["client_secret"].is_null() {
        grant["client"]
            .as_object_mut()
            .expect("client object")
            .remove("client_secret");
    }
    vault.put(&format!("profile/{profile}"), &grant.to_string())?;
    Ok(Exit {
        code: 0,
        result: json!({ "profile": profile, "channel": channel }),
    })
}

fn nonce() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn await_consent(listener: TcpListener, state: &str) -> Result<String> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Some(code) = callback(&mut stream, state)? {
                    return Ok(code);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80))
            }
            Err(error) => return Err(error.into()),
        }
    }
    fail("The Google authorization window expired. Start connect again when ready.")
}

fn callback(stream: &mut TcpStream, state: &str) -> Result<Option<String>> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut line = String::new();
    let read = BufReader::new((&mut *stream).take(8193)).read_line(&mut line);
    let decision = if read.is_ok() {
        callback_decision(&line, state)
    } else {
        Ok(None)
    };
    let (status, text) = match &decision {
        Ok(Some(_)) => (
            "200 OK",
            "Google consent received. Return to Zodchi to verify the channel.",
        ),
        Err(_) => (
            "400 Bad Request",
            "Google did not grant access. Return to Zodchi.",
        ),
        _ => (
            "400 Bad Request",
            "This request does not match the active Zodchi connection.",
        ),
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{text}", text.len());
    decision
}

fn callback_decision(line: &str, state: &str) -> Result<Option<String>> {
    let mut words = line.split_ascii_whitespace();
    if line.len() > 8192 || !line.ends_with('\n') || words.next() != Some("GET") {
        return Ok(None);
    }
    let Some(query) = words
        .next()
        .and_then(|path| path.strip_prefix("/oauth2/callback?"))
    else {
        return Ok(None);
    };
    let fields: Vec<_> = form_urlencoded::parse(query.as_bytes()).collect();
    let unique = |name: &str| {
        let mut found = fields.iter().filter(|(key, _)| key == name);
        found
            .next()
            .filter(|_| found.next().is_none())
            .map(|(_, value)| value.as_ref())
    };
    if unique("state") != Some(state) {
        return Ok(None);
    }
    if unique("error").is_some() {
        return fail("Google authorization was denied.");
    }
    Ok(unique("code")
        .filter(|code| {
            !code.is_empty() && code.len() <= 4096 && !code.contains(char::is_whitespace)
        })
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::callback_decision;

    #[test]
    fn callback_only_accepts_one_matching_state_and_code() {
        assert_eq!(
            callback_decision(
                "GET /oauth2/callback?code=a%2Fb&state=right HTTP/1.1\r\n",
                "right"
            )
            .unwrap()
            .as_deref(),
            Some("a/b")
        );
        for query in [
            "code=a",
            "code=a&state=wrong",
            "code=a&state=right&state=wrong",
            "code=a&code=b&state=right",
        ] {
            assert!(callback_decision(
                &format!("GET /oauth2/callback?{query} HTTP/1.1\r\n"),
                "right"
            )
            .unwrap()
            .is_none());
        }
        assert!(callback_decision(
            "GET /oauth2/callback?error=access_denied&state=right HTTP/1.1\r\n",
            "right"
        )
        .is_err());
    }
}
