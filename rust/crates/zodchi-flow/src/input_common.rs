//! Shared workflow input digests, privacy screening and recorded owner context.

use crate::{checks, journal::Journal};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use regex::{Regex, RegexSet};
use serde_json::Value;
use std::fs;
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

pub(crate) fn private_words(contents: &str) -> Vec<String> {
    contents.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_lowercase).collect()
}

pub(crate) fn withheld_lines(text: &str) -> usize {
    text.lines().filter(|line| matches!(*line, PRIVATE_WITHHELD | checks::WITHHELD_LINE)).count()
}

fn answer_has_credential_option(text: &str, option: &Regex) -> bool {
    const PROMPT_FLAGS: &[(&str, &str)] = &[("psql", "--password"), ("psql", "-W")];
    static COMMAND_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
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
    for capture in COMMAND_TOKEN.captures_iter(text) {
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
            return true;
        }
    }

    let mut offset = 0;
    while let Some(capture) = option.captures_at(text, offset) {
        let flag = capture.name("flag").expect("matched credential option flag");
        if !flag.as_str().eq_ignore_ascii_case("--no-password")
            && prompt_offsets.binary_search(&flag.start()).is_err()
        {
            return true;
        }
        // Screen the text after the switch, including credential options in an argument.
        offset = flag.end();
    }
    false
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
        let lower = line.to_lowercase();
        self.words.iter().any(|word| lower.contains(word))
    }

    pub(crate) fn credential_shape(line: &str) -> bool {
        let lower = line.to_ascii_lowercase();
        ["sk-", "ghp_", "github_pat_", "xoxb-", "akia", "eyj"].iter().any(|prefix| lower.contains(prefix))
    }

    /// Check model output for private words and recognizable credential values.
    pub(crate) fn answer_is_private(&self, text: &str) -> bool {
        static PATTERNS: LazyLock<(RegexSet, Regex, Regex, Regex)> = LazyLock::new(|| {
            let qualifier = r"(?:[a-z_][a-z0-9_.-]*[._-]|_)";
            let names = concat!(
                r"(?:password|passwd|pwd|secret|(?:access|refresh|id|session)?token|",
                r"api[ _-]?key|access[ _-]?key|private[ _-]?key|client[ _-]?secret|",
                r"authorization|auth|bearer|cookies?|credentials?|session[ _-]?id|пароль|токен|ключ)",
            );
            let suffix_name = r"[a-z_][a-z0-9_.-]*(?:password|token|secret|_key|apikey)";
            let credential = format!("(?:{qualifier}?{names}|{suffix_name})");
            let setting = format!("(?:{credential}|{qualifier}?pass)");
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
                    r#"(?i)(?:{start}(?:{credential}|{qualifier}pass)["'`]?"#,
                    r#"|["'`]{qualifier}?pass["'`])[ \t]*:\s*{value}"#,
                ),
                start = start,
                qualifier = qualifier,
                credential = credential,
                value = value,
            );
            let secrets = RegexSet::new([
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
                r"(?i)-----(?:BEGIN|END) (?:[A-Z0-9-]+ )*PRIVATE KEY-----",
                // User info is in the authority. An @ in a path or query is ordinary URL text.
                r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/?#@]+@[^\s/?#@]+",
            ])
            .expect("constant credential patterns");
            let raw_start = Regex::new(&format!(
                r#"(?:(?i:(?P<credential_before>{before_literal}))|(?:^|[^\w]))b?r(?P<hashes>#*)""#,
            ))
            .expect("constant raw-string start pattern");
            let after_raw = Regex::new(&format!(r"(?i)^{after_literal}"))
                .expect("constant raw-string comparison suffix");
            (secrets, option, raw_start, after_raw)
        });
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
        let (secrets, option, raw_start, after_raw) = &*PATTERNS;
        if self.has_private_word(text) || secrets.is_match(text) {
            return true;
        }
        if answer_has_credential_option(text, option) {
            return true;
        }
        raw_start
            .captures_iter(text)
            .any(|capture| {
                // An interior quote only closes a Rust raw string when the opening hashes follow it.
                let content = &text[capture.get(0).expect("raw-string opener").end()..];
                let closing = format!("\"{}", &capture["hashes"]);
                content.find(&closing).is_some_and(|end| {
                    end > 0
                        && (capture.name("credential_before").is_some()
                            || after_raw.is_match(&content[end + closing.len()..]))
                })
            })
            || AUTH_VALUE.captures_iter(text).any(|capture| {
                // Without an Authorization label, look for features of an encoded value.
                let value = &capture["value"];
                let token_field = capture["scheme"].eq_ignore_ascii_case("token")
                    && value
                        .trim_end_matches('.')
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_');
                !token_field
                    && (value.bytes().any(|b| b.is_ascii_digit() || b"_~+/=".contains(&b))
                        || (value.bytes().skip(1).any(|b| b.is_ascii_uppercase())
                            && value.bytes().any(|b| b.is_ascii_lowercase())))
            })
            || BASIC_VALUE.captures_iter(text).any(|capture| {
                // A bare Basic credential encodes a user and password separated by a colon.
                let encoded = &capture[1];
                let engine = if encoded.ends_with('=') {
                    &STANDARD
                } else {
                    &STANDARD_NO_PAD
                };
                engine
                    .decode(encoded)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .is_some_and(|decoded| {
                        decoded.contains(':') && !decoded.chars().any(char::is_control)
                    })
            })
    }

    pub fn value(&self, value: &mut Value, places: &[(String, &str)]) {
        match value {
            Value::String(text) => *text = self.text(text, places),
            Value::Array(items) => items.iter_mut().for_each(|v| self.value(v, places)),
            Value::Object(fields) => fields.values_mut().for_each(|v| self.value(v, places)),
            _ => {}
        }
    }

    pub fn text(&self, raw: &str, places: &[(String, &str)]) -> String {
        let mut private_key = false;
        let lines = raw.lines().map(|line| {
            let upper = line.to_ascii_uppercase();
            if upper.contains("-----BEGIN ") && upper.contains("PRIVATE KEY-----") {
                private_key = true;
            }
            let hidden = private_key || self.private(line);
            if upper.contains("-----END ") && upper.contains("PRIVATE KEY-----") {
                private_key = false;
            }
            if hidden { PRIVATE_WITHHELD } else { line }
        }).collect::<Vec<_>>().join("\n");
        checks::sanitize(&lines, places)
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
    fn answer_privacy_checks_literal_credential_comparisons_and_suffix_assignments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            r#"if password == "hunter2xyz":"#,
            r#"if os.environ["API_KEY"] == 'fixture-value':"#,
            r#"if (config.DB_TOKEN === "fixture-value") {}"#,
            r#"if password != b"fixture-value":"#,
            r#"if "fixture-value" == os.environ["API_KEY"]:"#,
            r#"if "fixture-value"==password:"#,
            "if pwd == 123456:",
            "if pwd == 12_345:",
            "if pwd == 0x1a2b:",
            "if 0b0010_1100 != pwd:",
            "if pwd == 0o1735:",
            "PGPASSWORD=hunter2xyz psql",
            "SERVICETOKEN=fixture-value",
            "APPSECRET=fixture-value",
            "SERVICE_KEY=fixture-value",
            "SERVICEAPIKEY=fixture-value",
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
            r##"if password == r#"fixture-value"#"##,
            r###"if password != br##""#fixture-value"##"###,
            r###"if r##"fixture-value"## == config.DB_TOKEN"###,
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
            "if password == r\"fixture-\nvalue\"",
            "if br\"fixture-\nvalue\" != config.DB_TOKEN",
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
            "mysql --password fixture-value",
            "psql --no-password catalog; mysql --password fixture-value",
            r#"psql --no-password "log entry: mysql --password fixture-value""#,
            "client --no-password=fixture-value",
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_distinguishes_cli_prompts_from_password_values() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "psql --password catalog",
            "psql -W catalog",
            "psql --no-password catalog",
            "Run `psql -U reader --password \"test catalog\"` to check the connection.",
            "APP_MODE=test ./psql --password catalog",
            "summary= psql --password catalog",
            "mysql -p catalog",
            "mysql -P3306 catalog",
            r#"mysql -p"" catalog"#,
            "ssh -o PasswordAuthentication=no example.org",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "mysql --password fixture-value",
            "mysql -pfixture-value",
            r#"mysql -p"fixture value""#,
            "client --password fixture-value",
            "psql --password=fixture-value",
            "psql --password catalog\nif password == r#\"fixture-value\"#",
            "psql --password catalog; mysql -pfixture-value",
            "psql --password catalog && client --password fixture-value",
            r#"psql --password "log entry: client --password fixture-value""#,
            r#"mysql -e "select 1; psql catalog" --password fixture-value"#,
            "mysql psql --password fixture-value",
            "APP=./psql mysql --password fixture-value",
            "mysql &>psql --password fixture-value",
            "mysql -h $(printf host) psql --password fixture-value",
            "mysql -h `printf host` psql --password fixture-value",
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_screens_credential_options_in_shell_comments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "psql catalog # previously used mysql --password fixture-value",
            "psql --password catalog # previous invocation: psql --password fixture-value",
            "psql catalog # trailing backslash \\\nmysql --password fixture-value",
            "mysql -h $(printf host # note; psql (ignored\n) --password fixture-value",
            "mysql catalog # -pfixture-value",
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "psql --password catalog # interactive prompt",
            r##"psql -h "#catalog" --password catalog"##,
            r"psql -h \#catalog --password catalog",
            "psql catalog # interactive prompt\npsql --password catalog",
            "Run `psql catalog # connection` and `psql --password catalog`.",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_checks_pasted_mysql_commands_in_shell_comments() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "psql catalog # previously used mysql -pfixture-value",
            "psql catalog #mysql -pfixture-value",
        ] {
            assert!(scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "psql --password catalog # use -p5432 for the port",
            "psql catalog # previously used mysql -p catalog",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
    }

    #[test]
    fn answer_privacy_recognizes_commands_in_markdown_lists() {
        let scrubber = Scrubber { words: vec![] };
        for answer in [
            "- psql --password catalog",
            "  * psql --password catalog",
            "1) psql --password catalog",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        for answer in [
            "- mysql -pfixture-value",
            "+ mysql -pfixture-value",
            "2. mysql -pfixture-value",
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
            r#"mysql -p"${DB_PASSWORD:-fixture-value}" catalog"#,
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
        assert!(scrubber.answer_is_private("Bearer mnbvcxza_qwertyui"));
        assert!(scrubber.answer_is_private(r#"The value was "bearer mnbvcxza_qwertyui"."#));
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
            "An empty value is password=\"\".",
            "Use a token.\r\nRotate it.\r\n",
            "Use https://registry.example/@scope/package or https://example.org/?tag=@demo.",
            "See 1-auth:2 and attach/2-pwd:2-4.",
            "See 3-notes.auth:5.",
            "See 4-notes.pass:5.",
        ] {
            assert!(!scrubber.answer_is_private(answer), "{answer:?}");
        }
        assert_eq!(scrubber.text("Use a token.", &[]), checks::WITHHELD_LINE);
        assert_eq!(
            scrubber.text("Use https://registry.example/@scope/package.", &[]),
            checks::WITHHELD_LINE
        );
    }

    #[test]
    fn answer_privacy_refuses_private_words_and_credentials() {
        let scrubber = Scrubber { words: vec!["fixture-private-word".into()] };
        for answer in [
            "A FIXTURE-PRIVATE-WORD appears.".into(),
            "password=hunter2xyz".into(),
            "token: \"value with spaces\"".into(),
            "_TOKEN=fixture-value".into(),
            "--password=fixture-value".into(),
            "api_key=fixture-value".into(),
            r#"os.environ["API_KEY"] = "fixture-value""#.into(),
            r#"settings['db.password'] = 'fixture-value'"#.into(),
            "PASS=fixture-value".into(),
            r#""pass": "fixture-value""#.into(),
            r#"db.pass: "fixture-value""#.into(),
            "DB_PASS: fixture-value".into(),
            "db.password=fixture-value".into(),
            "password=fixture=value".into(),
            "\"GITHUB_TOKEN\": \"fixture-value\"".into(),
            "`apiKey`: `fixture-value`".into(),
            "Authorization: Bearer abc123def456".into(),
            "Bearer abc123def456".into(),
            "Token abc123def456".into(),
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
            "eyJhbGciOiJIUzI1NiJ9.e30.fixture_signature".into(),
            "eyJhbGciOiJIUzI1NiJ9.e30.----".into(),
            concat!("-----BEGIN RSA ", "PRIVATE KEY-----").into(),
            "https://user@localhost/fixture".into(),
            "https://user:fixture-value@localhost/fixture".into(),
        ] {
            assert!(scrubber.answer_is_private(&answer), "{answer:?}");
        }
    }
}
