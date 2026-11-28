//! The YouTube upload protocol. A resumable session URL belongs in the credential store.

use serde_json::{json, Value};
use std::{io::Read, time::Duration};
use ureq::{
    http::{header, HeaderValue, Method, Request, Response, Uri},
    Agent, Body,
};
use zodchi_core::util::{fail, GatewayError, Result};

pub(super) const UPLOAD_SCOPE: &str = "https://www.googleapis.com/auth/youtube.upload";
pub(super) const READ_SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const UPLOAD_PATH: &str = "/upload/youtube/v3/videos";
const JSON_LIMIT: u64 = 512 * 1024;

pub(super) struct Google {
    agent: Agent,
    api: String,
    oauth: String,
}

pub(super) enum Transfer {
    Offset(u64),
    Stored(String),
}

pub(super) fn form(fields: &[(&str, &str)]) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields.iter().copied())
        .finish()
}

pub(super) fn id(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

impl Google {
    pub(super) fn new() -> Self {
        Self::with_origins(
            "https://www.googleapis.com",
            "https://oauth2.googleapis.com",
            true,
        )
    }

    #[cfg(test)]
    pub(super) fn fixture(origin: &str) -> Self {
        Self::with_origins(origin, origin, false)
    }

    fn with_origins(api: &str, oauth: &str, https: bool) -> Self {
        let config = Agent::config_builder()
            .https_only(https)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(120)));
        #[cfg(any(windows, target_os = "macos"))]
        let config = config.tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        );
        let config = if https { config } else { config.proxy(None) };
        Self {
            agent: config.build().into(),
            api: api.into(),
            oauth: oauth.into(),
        }
    }

    fn request(
        &self,
        method: Method,
        uri: &str,
        operation: &str,
        token: Option<&str>,
        headers: &[(&str, &str)],
        bytes: &[u8],
    ) -> Result<Response<Body>> {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| GatewayError("Google supplied an invalid access token.".into()))?;
            auth.set_sensitive(true);
            req = req.header(header::AUTHORIZATION, auth);
        }
        for &(key, value) in headers {
            req = req.header(key, value);
        }
        let req = req.body(bytes).map_err(|_| {
            GatewayError(format!(
                "Cannot prepare the Google request for {operation}."
            ))
        })?;
        self.agent.run(req)
            .map_err(|_| GatewayError(format!("Google did not return a response during {operation}. Resume this run to reconcile its state.")))
    }

    pub(super) fn token(&self, fields: &[(&str, &str)]) -> Result<Value> {
        let response = self.request(
            Method::POST,
            &format!("{}/token", self.oauth),
            "OAuth",
            None,
            &[("content-type", "application/x-www-form-urlencoded")],
            form(fields).as_bytes(),
        )?;
        let status = response.status();
        if !status.is_success() {
            let explanation = match json_body(response)
                .ok()
                .as_ref()
                .and_then(|data| data["error"].as_str())
            {
                Some("invalid_grant") => {
                    " The grant is no longer valid. Connect the same channel again."
                }
                Some("invalid_client") => " Check the Google Desktop app credentials.",
                Some("invalid_scope") => {
                    " Google refused one of the requested YouTube permissions."
                }
                _ => "",
            };
            return fail(format!(
                "Google refused OAuth (HTTP {}).{explanation}",
                status.as_u16()
            ));
        }
        json_body(response)
    }

    pub(super) fn channel(&self, token: &str, expected: &str) -> Result<Value> {
        let items = self.get(
            "channels",
            &[("part", "id,snippet"), ("mine", "true")],
            token,
        )?;
        let [channel] = items["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        else {
            return fail("Google must return exactly one authorized YouTube channel.");
        };
        if channel["id"] != expected || !items["nextPageToken"].is_null() {
            return fail("The authorized YouTube channel does not match the chosen channel ID.");
        }
        Ok(json!({ "id": expected, "title": channel["snippet"]["title"].as_str() }))
    }

    pub(super) fn video(&self, token: &str, id: &str) -> Result<Option<Value>> {
        let response = self.get(
            "videos",
            &[("part", "snippet,status,processingDetails"), ("id", id)],
            token,
        )?;
        match response["items"].as_array().map(Vec::as_slice) {
            Some([]) => Ok(None),
            Some([row]) if row["id"] == id => Ok(Some(row.clone())),
            _ => fail("YouTube returned an unexpected video in the verification response."),
        }
    }

    fn get(&self, resource: &str, fields: &[(&str, &str)], token: &str) -> Result<Value> {
        let url = format!("{}/youtube/v3/{resource}?{}", self.api, form(fields));
        let response = self.request(Method::GET, &url, resource, Some(token), &[], &[])?;
        successful(response.status().as_u16(), resource)?;
        json_body(response)
    }

    pub(super) fn start(&self, token: &str, size: u64, metadata: &Value) -> Result<String> {
        let url = format!(
            "{}{UPLOAD_PATH}?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false",
            self.api
        );
        let bytes = size.to_string();
        let response = self.request(
            Method::POST,
            &url,
            "opening the upload",
            Some(token),
            &[
                ("x-upload-content-length", &bytes),
                ("x-upload-content-type", "video/mp4"),
                ("content-type", "application/json"),
            ],
            metadata.to_string().as_bytes(),
        )?;
        successful(response.status().as_u16(), "opening the upload")?;
        let session = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| GatewayError("YouTube returned no resumable upload session.".into()))?;
        self.check_session(session)?;
        Ok(session.to_string())
    }

    fn check_session(&self, session: &str) -> Result<()> {
        let origin: Uri = self.api.parse().expect("configured YouTube API origin");
        let target: Uri = session
            .parse()
            .map_err(|_| GatewayError("YouTube returned an invalid upload session URL.".into()))?;
        let same_service = target.authority() == origin.authority()
            || (self.api == "https://www.googleapis.com"
                && target
                    .authority()
                    .is_some_and(|a| a.as_str() == "youtube.googleapis.com"));
        if target.scheme() != origin.scheme()
            || !same_service
            || target.path() != UPLOAD_PATH
            || target.query().is_none_or(|query| {
                !form_urlencoded::parse(query.as_bytes())
                    .any(|(key, value)| key == "upload_id" && !value.is_empty())
            })
        {
            return fail("YouTube returned an upload session outside the expected service.");
        }
        Ok(())
    }

    pub(super) fn probe(&self, token: &str, session: &str, size: u64) -> Result<Transfer> {
        self.transfer(token, session, size, &format!("bytes */{size}"), &[])
    }

    pub(super) fn chunk(
        &self,
        token: &str,
        session: &str,
        size: u64,
        offset: u64,
        data: &[u8],
    ) -> Result<Transfer> {
        let last = offset + data.len() as u64 - 1;
        self.transfer(
            token,
            session,
            size,
            &format!("bytes {offset}-{last}/{size}"),
            data,
        )
    }

    fn transfer(
        &self,
        token: &str,
        session: &str,
        size: u64,
        range: &str,
        data: &[u8],
    ) -> Result<Transfer> {
        self.check_session(session)?;
        let response = self.request(
            Method::PUT,
            session,
            "the resumable upload",
            Some(token),
            &[("content-range", range), ("content-type", "video/mp4")],
            data,
        )?;
        match response.status().as_u16() {
            200 | 201 => {
                let body = json_body(response)?;
                let video = body["id"].as_str().filter(|text| id(text, 11))
                    .ok_or_else(|| GatewayError("YouTube confirmed the transfer without a usable video ID. Resume to reconcile the same session.".into()))?;
                Ok(Transfer::Stored(video.to_string()))
            }
            308 => {
                let Some(range) = response.headers().get(header::RANGE) else {
                    return Ok(Transfer::Offset(0));
                };
                let offset = range.to_str().ok().and_then(|text| text.strip_prefix("bytes=0-"))
                    .and_then(|end| end.parse::<u64>().ok()).and_then(|end| end.checked_add(1))
                    .filter(|offset| *offset <= size)
                    .ok_or_else(|| GatewayError("YouTube returned an invalid acknowledged upload range.".into()))?;
                Ok(Transfer::Offset(offset))
            }
            404 | 410 => fail("The saved YouTube upload session expired. Reconcile the upload in Studio before starting another one."),
            status => fail(format!("YouTube returned HTTP {status} for the saved upload session. Resume to reconcile it.")),
        }
    }
}

fn successful(status: u16, operation: &str) -> Result<()> {
    if !(200..300).contains(&status) {
        return fail(format!("YouTube refused {operation} (HTTP {status})."));
    }
    Ok(())
}

fn json_body(response: Response<Body>) -> Result<Value> {
    let mut payload = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut payload)
        .map_err(|_| GatewayError("Google returned an incomplete response.".into()))?;
    if payload.len() as u64 > JSON_LIMIT {
        return fail("Google returned an oversized response.");
    }
    serde_json::from_slice(&payload)
        .map_err(|_| GatewayError("Google returned invalid JSON.".into()))
}
