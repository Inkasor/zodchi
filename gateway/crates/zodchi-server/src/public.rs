//! The output contract of the server: no raw diagnostic text reaches a client.
//!
//! Every error a client sees is a **public error**: a stable `code` and a fixed `message` written here or at the
//! place that raises it, and, where it helps, a `field` the client sent. No part of it is a server value (a path, the
//! text of an I/O error, a Codex or role-file message, the stored `error` of a job). The raw diagnostic goes to the
//! server's standard error (see [`log`]); a job's own error also stays in its job folder.
//!
//! The contract is structural, not a filter over text: an error body is built only from a code, a fixed message and
//! a field name, and a job is shown through [`job_view`], which names the fields a client sees. The model's own
//! answer (a job's `result`, the result routes) is returned as the model gave it.

use serde_json::{json, Map, Value};

/// The codes of public errors.
///
/// | code | status | meaning |
/// |---|---|---|
/// | `bad_request` | 400 | the request is wrong (the message is composed from the request itself) |
/// | `unauthorized` | 401 | no token, or a wrong one |
/// | `not_found` | 404 | no such route, job or image |
/// | `method_not_allowed` | 405 | the route does not take the method |
/// | `key_conflict` | 409 | the key belongs to another request |
/// | `not_final` | 409 | the job has no final status yet |
/// | `busy` | 429 | over the limit of unfinished jobs |
/// | `role_not_found` | 400 | the role is not installed on the server |
/// | `role_not_allowed` | 400 | the role is installed but a call to this server may not name it |
/// | `role_invalid` | 400 | the role is installed but cannot be loaded |
/// | `storage_error` | 500 | the server cannot read or write its own files |
/// | `unavailable` | 500 | the server cannot answer now (registry, authenticator, shutdown) |
/// | `codex_unavailable` | 200/500 | Codex cannot read or change the caller's sign-in |
/// | `sign_in_failed` | 200 | a device-code sign-in ended without a sign-in |
/// | `auth_required` | job | the job found no ChatGPT sign-in |
/// | `limited` | job | the subscription's limit is used up |
/// | `timeout` | job, sign-in | the call (or the device code) ran out of time |
/// | `job_failed` | job | the call failed |
/// | `unknown` | job | whether the call ran is not known |
pub const CODES: [&str; 19] = [
    "bad_request", "unauthorized", "not_found", "method_not_allowed", "key_conflict", "not_final", "busy", "role_not_found", "role_not_allowed",
    "role_invalid", "storage_error", "unavailable", "codex_unavailable", "sign_in_failed", "auth_required", "limited", "timeout", "job_failed",
    "unknown",
];

/// A public error with the status it is answered with.
#[derive(Debug, Clone, PartialEq)]
pub struct PublicError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub field: Option<String>,
}

impl PublicError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> PublicError {
        debug_assert!(CODES.contains(&code), "{code} is not a public code");
        PublicError { status, code, message: message.into(), field: None }
    }

    /// The same error naming the field of the request it is about.
    pub fn field(mut self, field: &str) -> PublicError {
        self.field = Some(field.to_string());
        self
    }

    /// A public error whose raw `detail` goes to the server's log and nowhere else.
    pub fn logged(status: u16, code: &'static str, message: impl Into<String>, detail: &str) -> PublicError {
        let error = PublicError::new(status, code, message);
        log(&error.message, detail);
        error
    }

    /// `{code, message, field?}`.
    pub fn value(&self) -> Value {
        error_value(self.code, &self.message, self.field.as_deref())
    }
}

impl std::fmt::Display for PublicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// `{code, message, field?}`.
pub fn error_value(code: &str, message: &str, field: Option<&str>) -> Value {
    let mut map = Map::new();
    map.insert("code".into(), json!(code));
    map.insert("message".into(), json!(message));
    if let Some(field) = field {
        map.insert("field".into(), json!(field));
    }
    Value::Object(map)
}

/// A raw diagnostic, for the operator: the standard error of the server.
pub fn log(public: &str, detail: &str) {
    eprintln!("zodchi-server: {public} [{}]", detail.trim());
}

/// The public error of a job that ended in `status` without a result: its code is the status (the core classified the
/// failure when it settled the job) and its message is fixed. None for a status that is not a failure.
pub fn job_error(status: &str) -> Option<Value> {
    let (code, message) = match status {
        "failed" => ("job_failed", "The job failed. The server's operator has the details."),
        "limited" => ("limited", "The ChatGPT subscription's limit is used up; try again after it resets."),
        "auth_required" => ("auth_required", "The ChatGPT subscription is not signed in; sign in with POST /v1/login."),
        "timeout" => ("timeout", "The call did not end in its time and was stopped."),
        "unknown" => ("unknown", "Whether the model turn ran is not known."),
        _ => return None,
    };
    Some(error_value(code, message, None))
}

/// The fields of a stored job a client sees. Anything else (the job's folder, the Codex process and thread, the
/// servers of a role, the request's hash) is the server's own.
const JOB_FIELDS: [&str; 20] = [
    "key", "role", "kind", "mode", "model", "effort", "status", "timeoutMs", "account", "accountsSkipped", "tokens", "credits", "result",
    "workerPid", "createdAt", "startedAt", "turnRequestedAt", "turnStartedAt", "finishedAt", "resetsAt",
];

/// What a client sees of a stored job: the fields of [`JOB_FIELDS`], and `error` as `{code, message}` mapped from the
/// status (null while the job has none). The stored error text is dropped. `resetsAt` stays only as a number.
pub fn job_view(job: &Value) -> Value {
    let mut out = Map::new();
    let stored = job.as_object();
    for name in JOB_FIELDS {
        let Some(value) = stored.and_then(|m| m.get(name)) else { continue };
        if name == "resetsAt" && !(value.is_number() || value.is_null()) {
            continue;
        }
        out.insert(name.to_string(), value.clone());
    }
    let status = job.get("status").and_then(Value::as_str).unwrap_or("");
    let stored_error = job.get("error").is_some_and(|e| !e.is_null());
    let error = job_error(status).or_else(|| stored_error.then(|| job_error("failed").unwrap_or(Value::Null)));
    out.insert("error".into(), error.unwrap_or(Value::Null));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_job_shows_a_code_and_a_fixed_message() {
        let job = json!({ "key": "k", "status": "failed", "error": "Cannot read /v1/private/auth.json", "dir": "/srv/x", "servers": { "a": 1 },
            "result": null, "codexPid": 5 });
        let shown = job_view(&job);
        assert_eq!(shown["error"]["code"], json!("job_failed"));
        assert!(!shown.to_string().contains("private"), "{shown}");
        assert!(shown.get("dir").is_none() && shown.get("servers").is_none() && shown.get("codexPid").is_none());
        assert_eq!(shown["key"], json!("k"));
    }

    #[test]
    fn every_final_status_has_its_code() {
        for (status, code) in [("failed", "job_failed"), ("limited", "limited"), ("auth_required", "auth_required"), ("timeout", "timeout"), ("unknown", "unknown")] {
            assert_eq!(job_error(status).unwrap()["code"], json!(code));
            assert!(CODES.contains(&code));
        }
        assert!(job_error("succeeded").is_none() && job_error("running").is_none());
        assert_eq!(job_view(&json!({ "status": "succeeded", "error": null }))["error"], Value::Null);
        // A stored error on a job that has no failure status is still not shown.
        assert_eq!(job_view(&json!({ "status": "running", "error": "x /etc/passwd" }))["error"]["code"], json!("job_failed"));
    }

    #[test]
    fn resets_at_is_a_number_or_nothing() {
        assert_eq!(job_view(&json!({ "status": "limited", "resetsAt": 1760000000 }))["resetsAt"], json!(1760000000));
        assert!(job_view(&json!({ "status": "limited", "resetsAt": "see /etc/passwd" })).get("resetsAt").is_none());
    }

    #[test]
    fn an_error_value_carries_only_what_it_is_given() {
        let error = PublicError::new(400, "role_not_found", "No role x.").field("role");
        assert_eq!(error.value(), json!({ "code": "role_not_found", "message": "No role x.", "field": "role" }));
        assert_eq!(error_value("storage_error", "m", None), json!({ "code": "storage_error", "message": "m" }));
    }
}
