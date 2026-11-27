//! Source diffs can show names used to look up configuration. Keep the stricter
//! screening for other material, and describe omissions in the local receipt.

use crate::{
    checks,
    input_common::{key_or_credential_shape, Scrubber, PRIVATE_WITHHELD},
    patch,
};
use serde_json::{json, Value};
use std::path::Path;

const LITERAL: &str = "[literal withheld]";

pub fn source_path(path: &str) -> bool {
    if !patch::plain(path) {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    !name.starts_with(".env")
        && !["auth.json", "credentials.json", "id_rsa", "id_ed25519"].contains(&name.as_str())
        && ![".pem", ".key", ".pfx", ".p12"]
            .iter()
            .any(|extension| name.ends_with(extension))
}

pub struct File<'a> {
    pub path: &'a str,
    pub regular: bool,
}

#[derive(Clone, Copy)]
pub enum FileLine {
    Base(usize),
    Candidate(usize),
}

pub struct Omission<'a> {
    pub file: Option<&'a str>,
    pub diff_line: usize,
    pub reason: &'static str,
    scope: &'static str,
    pub file_line: Option<FileLine>,
}

fn hunk_start(header: &str) -> Option<(usize, usize)> {
    let mut fields = header.strip_prefix("@@ ")?.split_ascii_whitespace();
    let start = |field: &str, prefix: char| field.strip_prefix(prefix)?.split(',').next()?.parse::<usize>().ok();
    Some((start(fields.next()?, '-')?, start(fields.next()?, '+')?))
}

fn hunk_line((base, candidate): &mut (usize, usize), line: &str) -> Option<FileLine> {
    match *line.as_bytes().first()? {
        b'-' => {
            let location = FileLine::Base(*base);
            *base += 1;
            Some(location)
        }
        b'+' | b' ' => {
            let location = FileLine::Candidate(*candidate);
            *candidate += 1;
            *base += line.starts_with(' ') as usize;
            Some(location)
        }
        _ => None,
    }
}

fn source_file(file: &File<'_>) -> bool {
    file.regular
        && matches!(
            Path::new(file.path)
                .extension()
                .and_then(|ext| ext.to_str()),
            Some("rs" | "js" | "mjs" | "jsx" | "ts" | "tsx")
        )
}

pub fn screen(
    diff: &str,
    files: &[File<'_>],
    scrubber: &Scrubber,
    places: &[(String, &str)],
) -> (String, Vec<Value>) {
    let (text, omissions) = screen_with_locations(diff, files, scrubber, places);
    let receipt = omissions.into_iter().map(|omission| json!({
        "file": omission.file, "diffLine": omission.diff_line,
        "reason": omission.reason, "scope": omission.scope,
    })).collect();
    (text, receipt)
}

pub fn screen_with_locations<'a>(
    diff: &str,
    files: &[File<'a>],
    scrubber: &Scrubber,
    places: &[(String, &str)],
) -> (String, Vec<Omission<'a>>) {
    let aligned = diff
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .count()
        == files.len();
    let mut next = files.iter();
    let mut file = None;
    let mut hunk = false;
    let mut position = None;
    let mut key_or_shape = key_or_credential_shape();
    let mut withheld = Vec::new();
    let mut screened = Vec::new();
    for (index, line) in diff.lines().enumerate() {
        if line.starts_with("diff --git ") {
            file = if aligned { next.next() } else { None };
            hunk = false;
            position = None;
        } else if line.starts_with("@@ ") {
            hunk = true;
            position = hunk_start(line);
        }
        let file_line = position.as_mut().and_then(|position| hunk_line(position, line));
        let reason =
            if key_or_shape(line) || checks::credential_url(line) {
                Some("credential")
            } else if scrubber.has_private_word(line) {
                Some("private-word")
            } else {
                None
            };
        let record = |reason, scope| Omission {
            file: file.map(|entry| entry.path),
            diff_line: index + 1,
            reason,
            scope,
            file_line,
        };
        let hide = |reason| {
            let marker = if reason == "private-word" {
                PRIVATE_WITHHELD
            } else {
                checks::WITHHELD_LINE
            };
            (marker.to_string(), Some(record(reason, "line")))
        };
        let (visible, note) = if let Some(reason) = reason {
            hide(reason)
        } else if !checks::credential_line(line) {
            (line.to_string(), None)
        } else if let Some(code) = hunk
            .then(|| line.as_bytes().first())
            .flatten()
            .filter(|&&prefix| matches!(prefix, b'+' | b'-' | b' '))
            .filter(|_| file.is_some_and(source_file))
            .and_then(|_| source_line(&line[1..]))
        {
            let note = (code != line[1..]).then(|| record("credential", "literal"));
            (format!("{}{code}", &line[..1]), note)
        } else {
            hide("credential")
        };
        withheld.extend(note);
        screened.push(visible);
    }
    (
        checks::screen_paths(screened.iter().map(String::as_str), places),
        withheld,
    )
}

fn env_name(name: &str) -> bool {
    name.len() <= 96
        && name.starts_with(|c: char| c.is_ascii_uppercase())
        && name.contains('_')
        && name
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
}

fn header_name(name: &str) -> bool {
    name.len() <= 96
        && !name.is_empty()
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn format_slot(text: &str) -> bool {
    text.strip_prefix('{')
        .and_then(|text| text.strip_suffix('}'))
        .is_some_and(|name| name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'))
}

/// Retain request header names and placeholders. Keep the request target screened.
fn http_template(value: &str) -> Option<String> {
    let mut lines = value.split(r"\r\n");
    let request = lines.next()?.split_ascii_whitespace().collect::<Vec<_>>();
    let [
        method @ ("GET" | "POST" | "PUT" | "PATCH" | "DELETE"),
        target,
        "HTTP/1.1",
    ] = request.as_slice()
    else {
        return None;
    };
    let target = if format_slot(target) { target } else { LITERAL };
    let mut out = format!("{method} {target} HTTP/1.1");
    let mut body = false;
    for line in lines {
        out.push_str(r"\r\n");
        if line.is_empty() {
            body = true;
            continue;
        }
        if body {
            out.push_str(if format_slot(line) { line } else { LITERAL });
            continue;
        }
        let (name, value) = line.split_once(':')?;
        if !header_name(name) {
            return None;
        }
        out.push_str(name);
        out.push(':');
        let trimmed = value.trim();
        if format_slot(trimmed)
            || trimmed.strip_prefix("Bearer ").is_some_and(format_slot)
            || matches!(
                (name.to_ascii_lowercase().as_str(), trimmed),
                ("content-type", "application/json") | ("connection", "close" | "keep-alive")
            )
        {
            out.push_str(value);
        } else {
            out.push(' ');
            out.push_str(LITERAL);
        }
    }
    Some(out)
}

fn visible_literal(before: &str, value: &str) -> bool {
    let before = before.trim_end();
    value.is_empty()
        || (env_name(value)
            && [
                "env::var(",
                "env::var_os(",
                "getenv(",
                "env.get(",
                "process.env[",
            ]
            .iter()
            .any(|prefix| before.ends_with(prefix)))
        || (header_name(value)
            && [
                ".header(",
                ".equiv(",
                ".get_header(",
                ".set_header(",
                "HeaderName::from_static(",
            ]
            .iter()
            .any(|prefix| before.ends_with(prefix)))
}

/// Screen literals in a single syntactically simple source line. Comments,
/// alternate literal syntax and incomplete lines use the original whole-line rule.
fn source_line(code: &str) -> Option<String> {
    let line = code.trim_start();
    let declaration = ["let ", "const ", "export const ", "pub ", "if ", "return "]
        .iter()
        .any(|prefix| line.starts_with(prefix));
    let lookup = [
        ".header(",
        ".equiv(",
        ".get_header(",
        ".set_header(",
        "HeaderName::from_static(",
        "format!(",
    ]
    .iter()
    .any(|operation| line.contains(operation));
    if !declaration && !lookup {
        return None;
    }
    let bytes = code.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut cursor = 0;
    while let Some(&byte) = bytes.get(cursor) {
        let start = cursor;
        cursor += 1;
        if matches!(byte, b'"' | b'\'') {
            if start != 0 && bytes[start - 1].is_ascii_alphanumeric() {
                return None;
            }
            loop {
                match *bytes.get(cursor)? {
                    b'\\' => cursor += 2,
                    end if end == byte => break,
                    _ => cursor += 1,
                }
            }
            let value = &code[start + 1..cursor];
            cursor += 1;
            let before = &code[..start];
            out.push(byte as char);
            if visible_literal(before, value) {
                out.push_str(value);
            } else if let Some(template) = before
                .trim_end()
                .ends_with("format!(")
                .then(|| http_template(value))
                .flatten()
            {
                out.push_str(&template);
            } else {
                out.push_str(LITERAL);
            }
            out.push(byte as char);
        } else if byte.is_ascii_digit()
            && (start == 0
                || !matches!(bytes[start - 1], b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z'))
        {
            while bytes
                .get(cursor)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            {
                cursor += 1;
            }
            // A numeric or encoded literal could be a PIN or raw key bytes.
            out.push_str(LITERAL);
        } else if byte.is_ascii_alphanumeric() || b" \t_()[]{}.,;:=+-*%<>!&|?".contains(&byte) {
            out.push(byte as char);
        } else {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_preserves_values_in_recognized_name_positions() {
        let source = r#"let secret = std::env::var("SVC_INTERNAL_SECRET")?;"#;
        assert_eq!(source_line(source).as_deref(), Some(source));
        assert_eq!(
            source_line(r#"req.header("X-Service-Secret", "OTHER_STRING");"#).as_deref(),
            Some(r#"req.header("X-Service-Secret", "[literal withheld]");"#)
        );
        assert_eq!(
            source_line(r#"const secret = String(env.SVC_INTERNAL_SECRET || "inline value");"#)
                .as_deref(),
            Some(r#"const secret = String(env.SVC_INTERNAL_SECRET || "[literal withheld]");"#)
        );
        assert_eq!(
            source_line("const secret = 1234;").as_deref(),
            Some("const secret = [literal withheld];")
        );
        assert_eq!(source_line("// password = inline value"), None);
        assert_eq!(source_line("secret=inline-value"), None);
        assert_eq!(
            source_line("const secret = \u{60}inline value\u{60};"),
            None
        );
        assert_eq!(source_line("let secret = \"incomplete"), None);
    }

    #[test]
    fn a_request_template_never_preserves_a_header_value() {
        let source = r#"format!("POST {} HTTP/1.1\r\nX-Service-Secret: {}\r\nConnection: close\r\n\r\n{}", path, self.secret, body)"#;
        assert_eq!(source_line(source).as_deref(), Some(source));
        let source = r#"format!("POST /connect HTTP/1.1\r\nX-Service-Secret: literal-value\r\n\r\n", self.secret)"#;
        assert_eq!(
            source_line(source).as_deref(),
            Some(
                r#"format!("POST [literal withheld] HTTP/1.1\r\nX-Service-Secret: [literal withheld]\r\n\r\n", self.secret)"#
            )
        );
    }
}
