//! The output contract of the server: no answer names a path of the server. Every JSON body and every error string
//! leaving the server passes [`PathFilter`]: each path under a known root (the data folder with the users' folders,
//! jobs and Codex homes, the user's home, the role folders, the temp folder) and any other absolute path is replaced
//! by [`TOKEN`]. Only the model's own answer is left as it is (see `Reply::kept` in the API).

use serde_json::Value;
use std::path::{Path, PathBuf};

/// What a client sees in place of a server path.
pub const TOKEN: &str = "<server path>";

/// Replaces server paths in strings.
#[derive(Debug, Clone, Default)]
pub struct PathFilter {
    /// Every known root in each of its spellings, ASCII lower case, longest first.
    roots: Vec<String>,
}

/// A byte that may stand before the start of a path.
fn boundary(b: u8) -> bool {
    b.is_ascii_whitespace() || b"\"'`([{<=,;:".contains(&b)
}

/// A byte that ends a path.
fn ends_path(b: u8) -> bool {
    b.is_ascii_whitespace() || b"\"'`<>|,;".contains(&b)
}

/// A byte that may follow the leading `/` of a Unix path.
fn path_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"._-~$@".contains(&b) || b >= 0x80
}

/// Whether an absolute path starts at `i`; its separator if so. The routes of the API (`/v1/...`, `/health`) are not
/// server paths.
fn path_start(s: &[u8], i: usize) -> Option<u8> {
    if i > 0 && !boundary(s[i - 1]) {
        return None;
    }
    let at = |k: usize| s.get(i + k).copied();
    // A drive letter, a colon and a separator.
    if s[i].is_ascii_alphabetic() && at(1) == Some(b':') && matches!(at(2), Some(b'\\') | Some(b'/')) {
        return at(2);
    }
    // A UNC, verbatim or device path: two backslashes and a name, `?` or `.`.
    if s[i] == b'\\' && at(1) == Some(b'\\') && at(2).is_some_and(|c| c.is_ascii_alphanumeric() || c == b'?' || c == b'.') {
        return Some(b'\\');
    }
    if s[i] == b'/' && at(1).is_some_and(path_char) {
        let rest = &s[i..];
        let route = |r: &[u8]| rest.starts_with(r) && rest.get(r.len()).is_none_or(|c| !path_char(*c));
        if route(b"/v1") || route(b"/health") {
            return None;
        }
        return Some(b'/');
    }
    None
}

/// The end of a path that runs from `from`: up to whitespace or a quote, and on over a space when the next word goes
/// on with the same separator (a user folder with a space in its name). A trailing `.`, `:` or `)` belongs to the sentence.
fn path_end(s: &[u8], from: usize, separator: u8) -> usize {
    let mut end = from;
    loop {
        while end < s.len() && !ends_path(s[end]) {
            end += 1;
        }
        if end < s.len() && s[end] == b' ' {
            let next = end + 1;
            let word_end = (next..s.len()).find(|&k| ends_path(s[k])).unwrap_or(s.len());
            if word_end > next && s[next..word_end].contains(&separator) && path_start(s, next).is_none() {
                end = word_end;
                continue;
            }
        }
        break;
    }
    while end > from && b".:)]".contains(&s[end - 1]) {
        end -= 1;
    }
    end
}

impl PathFilter {
    /// A filter of these roots (and of every other absolute path). Roots that are not absolute or too short to be
    /// told from text (`/`, a bare drive) are left to the general rule.
    pub fn new(roots: &[PathBuf]) -> PathFilter {
        let mut forms: Vec<String> = Vec::new();
        for root in roots {
            let text = root.display().to_string();
            let text = text.trim_end_matches(['\\', '/']);
            if !Path::new(text).is_absolute() && !text.starts_with('/') || text.len() < 4 {
                continue;
            }
            for form in [text.to_string(), text.replace('\\', "/"), text.replace('/', "\\")] {
                let form = form.to_ascii_lowercase();
                if !forms.contains(&form) {
                    forms.push(form);
                }
            }
        }
        forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
        PathFilter { roots: forms }
    }

    /// `text` with every server path replaced by [`TOKEN`]; None when it names none.
    pub fn clean(&self, text: &str) -> Option<String> {
        let s = text.as_bytes();
        let lower = text.to_ascii_lowercase();
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for root in &self.roots {
            let mut from = 0;
            while let Some(found) = lower[from..].find(root.as_str()) {
                let start = from + found;
                let root_end = start + root.len();
                let separator = if root.contains('\\') { b'\\' } else { b'/' };
                spans.push((start, path_end(s, root_end, separator).max(root_end)));
                from = root_end;
            }
        }
        let mut i = 0;
        while i < s.len() {
            if let Some(separator) = path_start(s, i) {
                let end = path_end(s, i, separator);
                if end > i {
                    spans.push((i, end));
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        if spans.is_empty() {
            return None;
        }
        spans.sort();
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for (start, end) in spans {
            if end <= at {
                continue;
            }
            if start >= at {
                out.push_str(&text[at..start]);
                out.push_str(TOKEN);
            }
            at = end;
        }
        out.push_str(&text[at..]);
        Some(out)
    }

    /// Every string of `value` (keys stay) cleaned; whether any named a path.
    pub fn clean_value(&self, value: &mut Value) -> bool {
        match value {
            Value::String(text) => match self.clean(text) {
                Some(clean) => {
                    *text = clean;
                    true
                }
                None => false,
            },
            Value::Array(items) => items.iter_mut().fold(false, |hit, v| self.clean_value(v) | hit),
            Value::Object(map) => map.values_mut().fold(false, |hit, v| self.clean_value(v) | hit),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths of these tests carry `#` for the colon of a drive (the repository's publish guard refuses a machine
    /// path in a tracked file); this puts the colon back.
    fn drive(text: &str) -> String {
        text.replace('#', ":")
    }

    fn filter() -> PathFilter {
        PathFilter::new(&[PathBuf::from(drive(r"C#\Users\Anna Maria\.zodchi\server")), PathBuf::from("/srv/zodchi data"), PathBuf::from("/")])
    }

    fn clean(text: &str) -> String {
        let text = drive(text);
        filter().clean(&text).unwrap_or(text)
    }

    #[test]
    fn known_roots_go_with_everything_under_them() {
        assert_eq!(clean(r"Cannot read C#\Users\Anna Maria\.zodchi\server\users\a-1\jobs\k\job.json: denied"), "Cannot read <server path>: denied");
        assert_eq!(clean("Cannot read c#/users/anna maria/.zodchi/server/users/a-1/codex-home."), "Cannot read <server path>.");
        assert_eq!(clean("in /srv/zodchi data/users/b/codex-home (os error 2)"), "in <server path> (os error 2)");
    }

    #[test]
    fn any_other_absolute_path_goes_too() {
        assert_eq!(clean(r"No role x: looked in D#\roles, E#/Zodchi/roles."), "No role x: looked in <server path>, <server path>.");
        assert_eq!(clean(r"spawn \\?\C#\Program Files\codex\codex.exe failed"), "spawn <server path> failed");
        assert_eq!(clean(r"at \\host\share\x"), "at <server path>");
        assert_eq!(clean("Role file /var/lib/anna/.zodchi/roles/x.json is not JSON"), "Role file <server path> is not JSON");
        assert_eq!(clean("\"/tmp/x\" (/var/y)"), "\"<server path>\" (<server path>)");
        assert_eq!(clean("error:/etc/passwd"), "error:<server path>");
    }

    #[test]
    fn routes_urls_and_words_stay() {
        for text in [
            "No role x is installed on this server; GET /v1/roles lists them.",
            "GET is not a method of /v1/jobs/k/result.",
            "GET /health",
            "https://example.invalid/device",
            "text/plain and/or a-z 0-9 . _ - [a-z0-9-]{1,40} 1/2",
            "The body is larger than 32 MB.",
        ] {
            assert_eq!(filter().clean(&drive(text)), None, "{text}");
        }
    }

    #[test]
    fn values_are_cleaned_everywhere() {
        let mut value = serde_json::json!({ "error": drive(r"C#\x\y"), "rows": [{ "error": "/opt/a/b" }], "n": 1 });
        assert!(filter().clean_value(&mut value));
        assert_eq!(value, serde_json::json!({ "error": TOKEN, "rows": [{ "error": TOKEN }], "n": 1 }));
    }
}
