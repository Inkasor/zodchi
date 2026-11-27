//! Shared workflow input digests, privacy screening and recorded owner context.

use crate::{checks, journal::Journal};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::ops::{ControlFlow, Range};
use std::path::PathBuf;
use std::sync::LazyLock;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, Result};

pub(crate) fn args_digest(raw: &Value) -> String {
    let mut canonical = raw.clone();
    canonical.sort_all_objects();
    zodchi_core::util::sha256_hex(canonical.to_string())
}

pub(crate) fn args_match(inputs: &Value, raw: &Value) -> bool {
    match inputs["argsSha256"].as_str() {
        Some(digest) => args_digest(raw) == digest,
        None => raw == &inputs["args"],
    }
}

pub fn scrub(config: &Config, raw: &str, places: &[(String, &str)]) -> Result<String> {
    Ok(Scrubber::new(config)?.text(raw, places))
}

pub struct Scrubber {
    words: Vec<String>,
}

pub(crate) const PRIVATE_WITHHELD: &str = "[private text removed]";
pub(crate) const TASK_SCREENING_STEP: &str = "task screening";
const PRIVATE_KEY_MARKER: &str = r"(?i)-----(BEGIN|END) (?:[A-Z0-9-]+ )*PRIVATE KEY-----";

#[derive(Clone, Copy)]
pub(crate) enum Withholding {
    PrivateWord,
    KeyOrShape,
    Value,
}

impl Withholding {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::PrivateWord => "private-word",
            Self::KeyOrShape | Self::Value => "credential",
        }
    }

    pub(crate) fn marker(&self) -> &'static str {
        match self {
            Self::PrivateWord | Self::KeyOrShape => PRIVATE_WITHHELD,
            Self::Value => checks::WITHHELD_LINE,
        }
    }
}

/// A line-by-line scan of recognizable credential shapes and complete private-key blocks.
pub(crate) fn key_or_credential_shape() -> impl FnMut(&str) -> bool {
    let mut inside_block = false;
    move |line| {
        let upper = line.to_ascii_uppercase();
        if upper.contains("-----BEGIN ") && upper.contains("PRIVATE KEY-----") {
            inside_block = true;
        }
        let hidden = inside_block || Scrubber::credential_shape(line);
        if upper.contains("-----END ") && upper.contains("PRIVATE KEY-----") {
            inside_block = false;
        }
        hidden
    }
}

pub(crate) fn private_words(contents: &str) -> Vec<String> {
    contents.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_lowercase).collect()
}

pub(crate) fn withheld_lines(text: &str) -> usize {
    text.lines().filter(|line| matches!(*line, PRIVATE_WITHHELD | checks::WITHHELD_LINE)).count()
}

fn scan_credential_options(
    text: &str,
    option: &Regex,
    mut record: impl FnMut(Range<usize>) -> ControlFlow<()>,
) -> ControlFlow<()> {
    const PROMPT_FLAGS: &[(&str, &str)] = &[("psql", "--password"), ("psql", "-W")];
    static SHELL_WORD: LazyLock<Regex> = LazyLock::new(|| {
        // Keep quoted arguments together so a separator inside one cannot start a command.
        let word_part = r#"[^ \t\r\n;&|<>()"'`\\]+|\\[^\r\n]|"(?:\\[^\r\n]|[^"\\\r\n])*"|'[^'\r\n]*'"#;
        Regex::new(&format!(
            concat!(
                // A Markdown list marker can precede the command on a new line.
                r"(?m:^[ \t]*(?:[-+*]|[0-9]{{1,9}}[.)])[ \t]+)|",
                r#"(?:&>>?|[<>][<>]?&?)[ \t]*(?:{word_part})+|"#,
                r#"(?P<separator>[;&|()\r\n]|`+|\\\r?\n)|"#,
                r#"(?P<word>(?P<assignment>[a-zA-Z_][a-zA-Z0-9_]*=)(?:{word_part})*|(?:{word_part})+)"#,
            ),
            word_part = word_part,
        ))
        .expect("constant command token pattern")
    });
    static SHELL_VARIABLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"\A\$(?:(?i:env:)?[A-Za-z_][A-Za-z0-9_]*|\{(?i:env:)?[A-Za-z_][A-Za-z0-9_]*\})\z",
        )
        .expect("constant shell variable pattern")
    });
    // None expects an executable. An empty name disables tool-specific matches.
    let mut command = None;
    let mut enclosing_commands = Vec::new();
    let mut prompt_offsets = Vec::new();
    let mut before_comment: Option<Vec<(&str, &str)>> = None;
    for capture in SHELL_WORD.captures_iter(text) {
        if let Some(separator) = capture.name("separator") {
            let separator = separator.as_str();
            if let Some(commands) = before_comment.take_if(|commands| {
                separator.ends_with(['\r', '\n'])
                    || (separator.starts_with('`')
                        && commands.last().is_some_and(|&(end, _)| end == separator))
            }) {
                enclosing_commands = commands;
                command = None;
            }
            if separator.starts_with('\\') {
                continue;
            }
            if enclosing_commands
                .last()
                .is_some_and(|&(end, _)| end == separator)
            {
                command = enclosing_commands.pop().map(|(_, tool)| tool);
            } else {
                // Resume the enclosing command after a group or a backtick expression.
                match separator {
                    "(" => enclosing_commands.push((")", command.unwrap_or_default())),
                    ticks if ticks.starts_with('`') => {
                        enclosing_commands.push((ticks, command.unwrap_or_default()));
                    }
                    _ => {}
                }
                command = if separator == ")" { Some("") } else { None };
            }
            continue;
        }
        let Some(word) = capture.name("word") else {
            continue;
        };
        let arg = word.as_str();
        let after_comment_marker = arg.strip_prefix('#').filter(|_| before_comment.is_none());
        if after_comment_marker.is_some() {
            // Keep screening tokens in the comment and restore the command nesting at its end.
            before_comment = Some(enclosing_commands.clone());
        }
        let unquoted = match arg.as_bytes() {
            [b'"', .., b'"'] | [b'\'', .., b'\''] => &arg[1..arg.len() - 1],
            _ => arg,
        };
        if (command.is_none() || before_comment.is_some())
            && arg != "$"
            && capture.name("assignment").is_none()
        {
            let executable = after_comment_marker.unwrap_or(unquoted);
            let name = executable.rsplit(['/', '\\']).next().unwrap_or(executable);
            let name = name.strip_suffix(".exe").unwrap_or(name);
            // A pasted MySQL command in a comment may follow another tool or prose.
            if command.is_none() || (name == "mysql" && !executable.starts_with('-')) {
                command = Some(name);
                continue;
            }
        }
        let Some(tool) = command else {
            continue;
        };
        if unquoted == "--" {
            command = Some("");
        } else if before_comment.is_none() && PROMPT_FLAGS.contains(&(tool, arg)) {
            prompt_offsets.push(word.start());
        } else if tool == "mysql"
            && unquoted.strip_prefix("-p").is_some_and(|value| {
                let expansion = value
                    .strip_prefix('"')
                    .and_then(|value| value.strip_suffix('"'))
                    .unwrap_or(value);
                !matches!(value, "" | "''" | "\"\"")
                    && (arg.starts_with('\'') || !SHELL_VARIABLE.is_match(expansion))
            })
        {
            record(word.range())?;
        }
    }

    let mut offset = 0;
    while let Some(capture) = option.captures_at(text, offset) {
        let flag = capture.name("flag").expect("matched credential option flag");
        if !flag.as_str().eq_ignore_ascii_case("--no-password")
            && prompt_offsets.binary_search(&flag.start()).is_err()
        {
            record(capture.get(0).expect("matched credential option").range())?;
        }
        // Screen the text after the switch, including credential options in an argument.
        offset = flag.end();
    }
    ControlFlow::Continue(())
}

impl Scrubber {
    pub fn new(config: &Config) -> Result<Self> {
    let denylist = std::env::var_os("ZODCHI_DENYLIST").map(PathBuf::from)
        .unwrap_or_else(|| config.home.join("private-words.txt"));
    let contents = match fs::read_to_string(&denylist) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return fail(format!("Cannot read the workflow private-words file: {error}")),
    };
        Ok(Self { words: private_words(&contents) })
    }

    #[cfg(test)]
    pub(crate) fn with_private_words(contents: &str) -> Self {
        Self { words: private_words(contents) }
    }

    pub(crate) fn allow_words(mut self, words: &[String]) -> Self {
        self.words.retain(|word| !words.contains(word));
        self
    }

    pub fn private(&self, line: &str) -> bool {
        self.has_private_word(line) || Self::credential_shape(line)
    }

    pub(crate) fn has_private_word(&self, line: &str) -> bool {
        self.matching_words(line).next().is_some()
    }

    pub(crate) fn matching_words(&self, line: &str) -> impl Iterator<Item = &str> {
        let lower = line.to_lowercase();
        self.words.iter().map(String::as_str).filter(move |word| lower.contains(*word))
    }

    pub(crate) fn credential_shape(line: &str) -> bool {
        let lower = line.to_ascii_lowercase();
        ["sk-", "ghp_", "github_pat_", "xoxb-", "akia", "eyj"].iter().any(|prefix| lower.contains(prefix))
    }

    fn secret_patterns() -> &'static (Regex, Regex, Regex, Regex) {
        static PATTERNS: LazyLock<(Regex, Regex, Regex, Regex)> = LazyLock::new(|| {
            let qualifier = r"(?:[a-z_][a-z0-9_.-]*[._-]|_)";
            let names = concat!(
                r"(?:password|passwd|pwd|secret|(?:access|refresh|id|session)?token|",
                r"api[ _-]?key|access[ _-]?key|private[ _-]?key|client[ _-]?secret|",
                r"authorization|auth|bearer|cookies?|credentials?|session[ _-]?id|пароль|токен|ключ)",
            );
            let suffix_name = r"[a-z_][a-z0-9_.-]*(?:password|token|secret|_key|apikey)";
            let value_name = format!("(?:{qualifier}?{names}|{suffix_name})");
            let setting = format!("(?:{value_name}|{qualifier}?pass)");
            let quoted = r#""[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`"#;
            // Match whole setting names, including dotted settings and CLI flags.
            // A numeric attachment prefix such as 1-notes.auth is not a setting.
            let boundary = r"(?:^|[^\w.-])";
            let start = format!(r"{boundary}(?:--?)?");
            let indexed = format!(r#"\[[ \t]*["']{setting}["'][ \t]*\]"#);
            let before_equals = format!(r#"(?:{start}{setting}["'`]?|{indexed})[ \t]*"#);
            let bare_char = r#"[^\s,;&"'`]"#;
            let value = format!("(?:{quoted}|{bare_char}+)");
            // A comparison can expose a literal just like an assignment does.
            let after_equals = format!(r#"(?:\s+{value}|{quoted}|[^=\s,;&"'`]{bare_char}*)"#);
            let equals = format!(r"(?i){before_equals}={after_equals}");
            let operator = r"(?:===?|!==?)";
            let before_literal = format!(r"{before_equals}{operator}\s*");
            let after_literal = format!(
                r"\s*{operator}\s*(?:{setting}|[a-z_][a-z0-9_.]*{indexed})(?:$|[^\w.-])",
            );
            let string_literal = format!(r"(?:br|rb|fr|rf|[bruf])?{quoted}");
            let number_literal = concat!(
                r"[+-]?(?:0x[0-9a-f][0-9a-f_]*|0o[0-7][0-7_]*|0b[01][01_]*|",
                r"[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:e[+-]?[0-9][0-9_]*)?)",
            );
            let comparison = format!(
                r"(?i){before_literal}(?:{string_literal}|{number_literal}(?:$|[^\w.]))",
            );
            let reversed_comparison = format!(
                r"(?i)(?:{string_literal}|(?:^|[^\w.]){number_literal}){after_literal}",
            );
            // A separate option argument can be quoted or start with a bare value character.
            let option = Regex::new(&format!(
                r#"(?i){boundary}(?P<flag>--?{setting})[ \t]+(?:{quoted}|[^\s,;&|<>()"'`-])"#,
            ))
            .expect("constant credential option pattern");
            // A colon after "pass" is ambiguous unless the name is qualified or quoted.
            let colon = format!(
                concat!(
                    r#"(?i)(?:{start}(?:{value_name}|{qualifier}pass)["'`]?"#,
                    r#"|["'`]{qualifier}?pass["'`])[ \t]*:\s*{value}"#,
                ),
                start = start,
                qualifier = qualifier,
                value_name = value_name,
                value = value,
            );
            let patterns = [
                equals.as_str(),
                comparison.as_str(),
                reversed_comparison.as_str(),
                colon.as_str(),
                // ASCII credentials can be adjacent to non-ASCII prose or Markdown emphasis.
                r"(?:^|[^A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}",
                r"(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}",
                r"(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}",
                r"(?:^|[^A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}",
                r"(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?:$|[^A-Za-z0-9])",
                r"(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                PRIVATE_KEY_MARKER,
                // User info is in the authority. An @ in a path or query is ordinary URL text.
                concat!(r"[A-Za-z][A-Za-z0-9+.-]*:", r"//[^\s/?#@]+@[^\s/?#@]+"),
            ];
            let secrets = Regex::new(&format!("(?:{})", patterns.join(")|(?:")))
                .expect("constant credential patterns");
            let raw_start = Regex::new(&format!(
                r#"(?:(?i:(?P<credential_before>{before_literal}))|(?:^|[^\w]))b?r(?P<hashes>#*)""#,
            ))
            .expect("constant raw-string start pattern");
            let after_raw = Regex::new(&format!(r"(?i)^{after_literal}"))
                .expect("constant raw-string comparison suffix");
            (secrets, option, raw_start, after_raw)
        });
        &PATTERNS
    }

    fn secret_value_ranges(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
        static AUTH_VALUE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(
                r"\b(?i:(?P<scheme>bearer|token))[ \t]+(?P<value>[A-Za-z0-9._~+/-]{8,}={0,2})",
            )
            .expect("constant authorization pattern")
        });
        static BASIC_VALUE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"\b(?i:basic)[ \t]+([A-Za-z0-9+/]{4,}={0,2})")
                .expect("constant basic authentication pattern")
        });
        let (secrets, _, raw_start, after_raw) = Self::secret_patterns();
        let mut at = 0;
        // Reuse a trailing delimiter when it is also the boundary before the next value.
        std::iter::from_fn(move || {
            let matched = secrets.find_at(text, at)?;
            let (last, _) = matched.as_str().char_indices().next_back()?;
            at = if last == 0 { matched.end() } else { matched.start() + last };
            Some(matched.range())
        })
            .chain(raw_start.captures_iter(text).filter_map(move |capture| {
                // An interior quote only closes a Rust raw string when the opening hashes follow it.
                let opener = capture.get(0).expect("raw-string opener");
                let content = &text[opener.end()..];
                let closing = format!("\"{}", &capture["hashes"]);
                let end = content.find(&closing)?;
                let tail = end + closing.len();
                (end > 0
                    && (capture.name("credential_before").is_some()
                        || after_raw.is_match(&content[tail..])))
                .then_some(opener.start()..opener.end() + tail)
            }))
            .chain(AUTH_VALUE.captures_iter(text).filter_map(|capture| {
                // Without an Authorization label, look for features of an encoded value.
                let value = &capture["value"];
                let token_field = capture["scheme"].eq_ignore_ascii_case("token")
                    && value
                        .trim_end_matches('.')
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_');
                let private = !token_field
                    && (value.bytes().any(|b| b.is_ascii_digit() || b"_~+/=".contains(&b))
                        || (value.bytes().skip(1).any(|b| b.is_ascii_uppercase())
                            && value.bytes().any(|b| b.is_ascii_lowercase())));
                private.then(|| capture.get(0).expect("authorization value").range())
            }))
            .chain(BASIC_VALUE.captures_iter(text).filter_map(|capture| {
                // A bare Basic credential encodes a user and password separated by a colon.
                let encoded = &capture[1];
                let engine = if encoded.ends_with('=') {
                    &STANDARD
                } else {
                    &STANDARD_NO_PAD
                };
                let private = engine
                    .decode(encoded)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .is_some_and(|decoded| {
                        decoded.contains(':') && !decoded.chars().any(char::is_control)
                    });
                private.then(|| capture.get(0).expect("basic authentication value").range())
            }))
    }

    /// Check model output for private words and recognizable credential values.
    pub(crate) fn answer_is_private(&self, text: &str) -> bool {
        self.has_private_word(text)
            || Self::secret_value_ranges(text).next().is_some()
            || scan_credential_options(text, &Self::secret_patterns().1, |_| ControlFlow::Break(())).is_break()
    }

    pub fn value(&self, value: &mut Value, places: &[(String, &str)]) {
        match value {
            Value::String(text) => *text = self.text(text, places),
            Value::Array(items) => items.iter_mut().for_each(|v| self.value(v, places)),
            Value::Object(fields) => fields.values_mut().for_each(|v| self.value(v, places)),
            _ => {}
        }
    }

    fn screened_lines<'a>(&'a self, raw: &'a str) -> impl Iterator<Item = (&'a str, Option<Withholding>)> {
        let mut key_or_shape = key_or_credential_shape();
        raw.lines().map(move |line| {
            let withholding = if key_or_shape(line) {
                Some(Withholding::KeyOrShape)
            } else if self.has_private_word(line) {
                Some(Withholding::PrivateWord)
            } else if checks::credential_line(line) {
                Some(Withholding::Value)
            } else {
                None
            };
            (line, withholding)
        })
    }

    fn value_lines(raw: &str) -> impl Iterator<Item = (&str, bool, bool)> {
        static KEY_MARKER: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(PRIVATE_KEY_MARKER).expect("constant private-key marker pattern")
        });
        // Match values over the whole input so a line break in an assignment or raw string cannot hide it.
        let mut values: Vec<_> = Self::secret_value_ranges(raw).collect();
        let _ = scan_credential_options(raw, &Self::secret_patterns().1, |value| {
            values.push(value);
            ControlFlow::Continue(())
        });
        values.sort_unstable_by_key(|value| value.start);
        let mut values = values.into_iter().peekable();
        let mut offset = 0;
        let mut inside_block = false;
        raw.lines().zip(raw.split_inclusive('\n')).map(move |(line, original)| {
            let start = offset;
            offset += original.len();
            while values.peek().is_some_and(|value| value.end <= start) {
                values.next();
            }
            let has_value = values.peek().is_some_and(|value| value.start < start + line.len());
            let mut key_line = inside_block;
            for marker in KEY_MARKER.captures_iter(line) {
                key_line = true;
                inside_block = marker[1].eq_ignore_ascii_case("BEGIN");
            }
            (line, key_line, has_value)
        })
    }

    /// A package gate uses the answer rules for values, with line locations for local diagnostics.
    fn input_lines<'a>(&'a self, raw: &'a str) -> impl Iterator<Item = (&'a str, Option<Withholding>)> + 'a {
        Self::value_lines(raw).map(move |(line, key_line, has_value)| {
            let withholding = if key_line {
                Some(Withholding::KeyOrShape)
            } else if self.has_private_word(line) {
                Some(Withholding::PrivateWord)
            } else if checks::credential_url(line) {
                Some(Withholding::Value)
            } else if has_value {
                Some(Withholding::KeyOrShape)
            } else {
                None
            };
            (line, withholding)
        })
    }

    /// Briefs can discuss identifiers. Screen values and key blocks before considering word exceptions.
    pub(crate) fn design_lines<'a>(&'a self, raw: &'a str) -> impl Iterator<Item = (&'a str, Option<Withholding>)> + 'a {
        let mut key_or_shape = key_or_credential_shape();
        Self::value_lines(raw).map(move |(line, key_line, has_value)| {
            let withholding = if key_or_shape(line) || key_line {
                Some(Withholding::KeyOrShape)
            } else if has_value || checks::credential_url(line) {
                Some(Withholding::Value)
            } else if self.has_private_word(line) {
                Some(Withholding::PrivateWord)
            } else {
                None
            };
            (line, withholding)
        })
    }

    pub(crate) fn input_withholdings<'a>(&'a self, raw: &'a str) -> impl Iterator<Item = (usize, &'static str)> + 'a {
        self.input_lines(raw).enumerate().filter_map(|(index, (_, withholding))| {
            withholding.map(|withholding| (index + 1, withholding.reason()))
        })
    }

    /// An editable preview keeps the visible fragments and their original line endings.
    pub(crate) fn redact_lines(&self, raw: &str) -> String {
        let mut preview = String::new();
        for ((line, withholding), original) in self.input_lines(raw).zip(raw.split_inclusive('\n')) {
            if let Some(withholding) = withholding {
                preview.push_str(withholding.marker());
                preview.push_str(&original[line.len()..]);
            } else {
                preview.push_str(original);
            }
        }
        preview
    }

    pub fn text(&self, raw: &str, places: &[(String, &str)]) -> String {
        let lines = self.screened_lines(raw).map(|(line, withholding)| {
            withholding.map_or(line, |withholding| withholding.marker())
        });
        checks::screen_paths(lines, places)
    }
}

pub fn model_context(journal: &Journal) -> Result<String> {
    let mut context = Vec::new();
    match fs::read_dir(journal.file("remarks")) {
        Ok(entries) => {
            let mut files: Vec<_> = entries.collect::<std::io::Result<Vec<_>>>()?.into_iter()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .map(|entry| entry.file_name()).collect();
            files.sort();
            for file in files {
                let name = format!("remarks/{}", file.to_string_lossy());
                if let Some(value) = journal.read_value(&name) {
                    if let Some(text) = value["text"].as_str() {
                        context.push(format!("Owner remark:\n{text}"));
                    }
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for event in journal.events() {
        let step = event["step"].as_str().unwrap_or("the pending step");
        if step == TASK_SCREENING_STEP {
            continue;
        }
        if let Some(text) = event["ownerAnswer"].as_str() {
            context.push(format!("Owner answer for {step}:\n{text}"));
        } else if let Some(text) = event["ownerClarification"].as_str() {
            context.push(format!("Owner clarification for {step} (updates earlier answers):\n{text}"));
        }
    }
    Ok(context.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_gate_reports_lines_with_private_material() {
        let scrubber = Scrubber::with_private_words("fixture-private-word");
        let key_block = [
            "Before the key",
            concat!("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
            "fixture key body",
            concat!("-----END OPENSSH ", "PRIVATE KEY-----"),
            "After the key",
        ].join("\r\n");
        let key_assignment = format!(concat!("api_", "key = \"", "sk", "-live-{}\""), "fixturevalue".repeat(3));
        let shaped_value = format!("ghp_{}", "fixturevalue".repeat(3));
        let adjacent_keys = format!("{}\n{shaped_value}", concat!("AKIA", "0123456789ABCDEF"));
        let cases: &[(&str, &[(usize, &str)])] = &[
            (r#"const tasks = "task-list"; // disk-usage"#, &[]),
            ("Use the API key from the vault", &[]),
            ("Literal prefixes: sk-, ghp_, AKIA, eyJ", &[]),
            ("A FIXTURE-PRIVATE-WORD appears.", &[(1, "private-word")]),
            (&key_assignment, &[(1, "credential")]),
            (&shaped_value, &[(1, "credential")]),
            (&adjacent_keys, &[(1, "credential"), (2, "credential")]),
            (concat!("if pass", r#"word == "fixture-value" {}"#), &[(1, "credential")]),
            (concat!("https:", "//fixture:fixture-value", "@localhost/"), &[(1, "credential")]),
            (&key_block, &[(2, "credential"), (3, "credential"), (4, "credential")]),
            (concat!("Notes\r\nconst to", "ken =\r\n    \"fixture-value\";\r\nFooter"), &[(2, "credential"), (3, "credential")]),
        ];
        for &(text, expected) in cases {
            assert_eq!(scrubber.input_withholdings(text).collect::<Vec<_>>(), expected, "{text:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_literal_credential_comparisons_and_suffix_assignments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("if pass", r#"word == "hunter2xyz":"#),
            concat!(r#"if os.environ["API_"#, r#"KEY"] == 'fixture-value':"#),
            concat!("if (config.DB_TO", r#"KEN === "fixture-value") {}"#),
            concat!("if pass", r#"word != b"fixture-value":"#),
            concat!(r#"if "fixture-value" == os.environ["API_"#, r#"KEY"]:"#),
            concat!(r#"if "fixture-value"==pa"#, "ssword:"),
            concat!("if pw", "d == 123456:"),
            concat!("if pw", "d == 12_345:"),
            concat!("if pw", "d == 0x1a2b:"),
            concat!("if 0b0010_1100 != pw", "d:"),
            concat!("if pw", "d == 0o1735:"),
            concat!("PGPASS", "WORD=hunter2xyz psql"),
            concat!("SERVICETO", "KEN=fixture-value"),
            concat!("APPSE", "CRET=fixture-value"),
            concat!("SERVICE_", "KEY=fixture-value"),
            concat!("SERVICEAPI", "KEY=fixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            r#"if os.environ["API_KEY"] == "":"#,
            r#"if password != b"":"#,
            r#"if "" == password:"#,
            "if password == expected_password:",
            "if expected_password == password:",
            r#"PGPASSWORD="" psql"#,
            "Use a second pass: inspect the joints.",
            "The token expired.",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_rust_raw_string_comparisons() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("if pass", r##"word == r#"fixture-value"#"##),
            concat!("if pass", r###"word != br##""#fixture-value"##"###),
            concat!(r###"if r##"fixture-value"## == config.DB_TO"###, "KEN"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            r##"if password == r#""#"##,
            r###"if password != br##""##"###,
            r###"if r##""## == config.DB_TOKEN"###,
            r##"if password == r#""# || mode == r#"fixture-value"#"##,
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_multiline_raw_string_comparisons() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("if pass", "word == r\"fixture-\nvalue\""),
            concat!("if br\"fixture-\nvalue\" != config.DB_TO", "KEN"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        assert!(!scrubber.answer_is_private(r#"if password == r"" || mode == r"read""#));
    }

    #[test]
    fn answer_privacy_checks_option_values_but_accepts_no_password_flag() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "psql --no-password catalog",
            r#"Run `psql --no-password "test catalog"` to check the connection."#,
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            concat!("mysql --pass", "word fixture-value"),
            concat!("psql --no-password catalog; mysql --pass", "word fixture-value"),
            concat!(r#"psql --no-password "log entry: mysql --pass"#, r#"word fixture-value""#),
            concat!("client --no-pass", "word=fixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_distinguishes_cli_prompts_from_password_values() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("psql --pass", "word catalog"),
            "psql -W catalog",
            "psql --no-password catalog",
            concat!("Run `psql -U reader --pass", "word \"test catalog\"` to check the connection."),
            concat!("APP_MODE=test ./psql --pass", "word catalog"),
            concat!("summary= psql --pass", "word catalog"),
            "mysql -p catalog",
            "mysql -P3306 catalog",
            r#"mysql -p"" catalog"#,
            "ssh -o PasswordAuthentication=no example.org",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            concat!("mysql --pass", "word fixture-value"),
            concat!("mysql -", "pfixture-value"),
            concat!("mysql -", r#"p"fixture value""#),
            concat!("client --pass", "word fixture-value"),
            concat!("psql --pass", "word=fixture-value"),
            concat!("psql --pass", "word catalog\nif pass", "word == r#\"fixture-value\"#"),
            concat!("psql --pass", "word catalog; mysql -", "pfixture-value"),
            concat!("psql --pass", "word catalog && client --pass", "word fixture-value"),
            concat!("psql --pass", r#"word "log entry: client --pass"#, r#"word fixture-value""#),
            concat!(r#"mysql -e "select 1; psql catalog" --pass"#, "word fixture-value"),
            concat!("mysql psql --pass", "word fixture-value"),
            concat!("APP=./psql mysql --pass", "word fixture-value"),
            concat!("mysql &>psql --pass", "word fixture-value"),
            concat!("mysql -h $(printf host) psql --pass", "word fixture-value"),
            concat!("mysql -h `printf host` psql --pass", "word fixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_screens_credential_options_in_shell_comments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("psql catalog # previously used mysql --pass", "word fixture-value"),
            concat!("psql --pass", "word catalog # previous invocation: psql --pass", "word fixture-value"),
            concat!("psql catalog # trailing backslash \\\nmysql --pass", "word fixture-value"),
            concat!("mysql -h $(printf host # note; psql (ignored\n) --pass", "word fixture-value"),
            concat!("mysql catalog # -", "pfixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            concat!("psql --pass", "word catalog # interactive prompt"),
            concat!(r##"psql -h "#catalog" --pass"##, "word catalog"),
            concat!(r"psql -h \#catalog --pass", "word catalog"),
            concat!("psql catalog # interactive prompt\npsql --pass", "word catalog"),
            concat!("Run `psql catalog # connection` and `psql --pass", "word catalog`."),
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_pasted_mysql_commands_in_shell_comments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("psql catalog # previously used mysql -", "pfixture-value"),
            concat!("psql catalog #mysql -", "pfixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            concat!("psql --pass", "word catalog # use -p5432 for the port"),
            "psql catalog # previously used mysql -p catalog",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_recognizes_commands_in_markdown_lists() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            concat!("- psql --pass", "word catalog"),
            concat!("  * psql --pass", "word catalog"),
            concat!("1) psql --pass", "word catalog"),
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            concat!("- mysql -", "pfixture-value"),
            concat!("+ mysql -", "pfixture-value"),
            concat!("2. mysql -", "pfixture-value"),
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_distinguishes_mysql_password_variables_from_literals() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "mysql -p$DB_PASSWORD catalog",
            "mysql -p${DB_PASSWORD} catalog",
            r#"mysql -p"$DB_PASSWORD" catalog"#,
            r#"mysql -p"${DB_PASSWORD}" catalog"#,
            r#"mysql "-p$DB_PASSWORD" catalog"#,
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "mysql -p'$DB_PASSWORD' catalog",
            "mysql '-p$DB_PASSWORD' catalog",
            r#"mysql -p"\$DB_PASSWORD" catalog"#,
            concat!(r#"mysql -p"${DB_PASS"#, r#"WORD:-fixture-value}" catalog"#),
            r#"mysql -p"${DB_PASSWORD}fixture-value" catalog"#,
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_powershell_mysql_password_arguments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            r#"mysql -p"$env:DB_PASSWORD" catalog"#,
            "mysql -p$env:DB_PASSWORD catalog",
            r#"mysql -p"${ENV:DB_PASSWORD}" catalog"#,
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "mysql -p'$env:DB_PASSWORD' catalog",
            r#"mysql -p"$env:DB_PASSWORD-fixture-value" catalog"#,
            r#"mysql -p"${env:DB_PASSWORD}fixture-value" catalog"#,
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_distinguishes_token_fields_from_bearer_values() {
        let scrubber = Scrubber { words: vec![] };
        assert!(!scrubber.answer_is_private("The token expires_in field is missing."));
        assert!(scrubber.answer_is_private(concat!("Bear", "er mnbvcxza_qwertyui")));
        assert!(scrubber.answer_is_private(concat!(r#"The value was "bear"#, r#"er mnbvcxza_qwertyui"."#)));
    }

    #[test]
    fn answer_privacy_accepts_ordinary_words() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "хранить access token в httpOnly cookie",
            "Use a risk-based approach and task-specific checks in Slovakia.",
            "Review the task-specific-validation steps.",
            "Use disk-encryption-and-backup.",
            "Never commit credentials or a private key.",
            "Use a second pass: inspect the joints.",
            r#"Read os.environ["API_KEY"] to find the setting."#,
            r#"os.environ["API_KEY"] = """#,
            r#"if os.environ["API_KEY"] == "":"#,
            r#"if password=="":"#,
            "Discuss passwords, secrets, authorization and bearer schemes.",
            "The token expires_in field is missing.",
            "Check token expires_in.",
            "Run a basic IPv6-connectivity check.",
            "The short prefixes sk-, ghp_, AKIA and eyJ are examples.",
            concat!("An empty value is pass", "word=\"\"."),
            "Use a token.\r\nRotate it.\r\n",
            concat!("Use https:", "//registry.example/@scope/package or https:", "//example.org/?tag=@demo."),
            "See 1-auth:2 and attach/2-pwd:2-4.",
            "See 3-notes.auth:5.",
            "See 4-notes.pass:5.",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        assert_eq!(scrubber.text("Use a token.", &[]), checks::WITHHELD_LINE);
        assert_eq!(
            scrubber.text(concat!("Use https:", "//registry.example/@scope/package."), &[]),
            checks::WITHHELD_LINE
        );
    }

    #[test]
    fn answer_privacy_refuses_private_words_and_credentials() {
        let scrubber = Scrubber { words: vec!["fixture-private-word".into()] };
        for answer in [
            "A FIXTURE-PRIVATE-WORD appears.".into(),
            concat!("pass", "word=hunter2xyz").into(),
            concat!("to", "ken: \"value with spaces\"").into(),
            concat!("_TO", "KEN=fixture-value").into(),
            concat!("--pass", "word=fixture-value").into(),
            concat!("api_", "key=fixture-value").into(),
            concat!(r#"os.environ["API_"#, r#"KEY"] = "fixture-value""#).into(),
            concat!("settings['db.pass", r#"word'] = 'fixture-value'"#).into(),
            concat!("PA", "SS=fixture-value").into(),
            concat!("\"pa", r#"ss": "fixture-value""#).into(),
            concat!("db.pa", r#"ss: "fixture-value""#).into(),
            concat!("DB_PA", "SS: fixture-value").into(),
            concat!("db.pass", "word=fixture-value").into(),
            concat!("pass", "word=fixture=value").into(),
            concat!("\"GITHUB_TO", "KEN\": \"fixture-value\"").into(),
            concat!("`api", "Key`: `fixture-value`").into(),
            concat!("Authoriz", "ation: Bear", "er abc123def456").into(),
            concat!("Bear", "er abc123def456").into(),
            concat!("To", "ken abc123def456").into(),
            format!("Basic {}", STANDARD.encode("fixture:sample")),
            format!("sk-{}", "a".repeat(20)),
            format!("_sk-{}_", "a".repeat(20)),
            format!("pk-{}", "a".repeat(16)),
            format!("rk-{}", "a".repeat(16)),
            format!("ghp_{}", "a".repeat(20)),
            format!("gho_{}", "a".repeat(20)),
            format!("github_pat_{}", "a_".repeat(20)),
            format!("xoxb-{}", "a".repeat(10)),
            concat!("AKIA", "0123456789ABCDEF").into(),
            concat!("__AKIA", "0123456789ABCDEF__").into(),
            concat!("eyJ", "hbGciOiJIUzI1NiJ9.e30.fixture_signature").into(),
            concat!("eyJ", "hbGciOiJIUzI1NiJ9.e30.----").into(),
            concat!("-----BEGIN RSA ", "PRIVATE KEY-----").into(),
            concat!("https:", "//user", "@localhost/fixture").into(),
            concat!("https:", "//user:fixture-value", "@localhost/fixture").into(),
        ] {
            assert!(scrubber.answer_is_private(&answer), "{answer:?}");
        }
    }
}
