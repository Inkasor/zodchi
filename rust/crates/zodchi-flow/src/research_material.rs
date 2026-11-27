use crate::input_common;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use zodchi_core::{
    config::Config,
    util::{fail, sha256_hex, GatewayError, Result},
};

pub fn path(value: &Value, field: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute() && path.components().all(|part| part != Component::ParentDir)
        })
        .ok_or_else(|| {
            GatewayError(format!(
                "{field} needs an absolute path without parent components."
            ))
        })
}

pub fn bounded(file: &Path, max: usize, what: &str) -> Result<String> {
    let mut text = String::new();
    fs::File::open(file)
        .map_err(|_| GatewayError(format!("Cannot open {what}.")))?
        .take((max + 1) as u64)
        .read_to_string(&mut text)
        .map_err(|_| GatewayError(format!("{what} needs valid UTF-8.")))?;
    if text.len() > max || text.contains('\0') {
        return fail(format!("{what} is too large or contains NUL."));
    }
    Ok(text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n"))
}

pub fn word_snapshot(cfg: &Config, allow_empty: bool) -> Result<Value> {
    let file = std::env::var_os("ZODCHI_DENYLIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| cfg.home.join("private-words.txt"));
    let contents = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return fail("The private-words file could not be read."),
    };
    let words: Vec<String> = contents
        .lines()
        .map(str::trim)
        .filter(|word| !word.is_empty() && !word.starts_with('#'))
        .map(str::to_lowercase)
        .collect();
    if words.is_empty() && !allow_empty {
        return fail("Supply a private-words file or, only with the owner's approval, set allowNoScrub for this run.");
    }
    let salt = format!("{:032x}", rand::random::<u128>());
    Ok(json!({"salt": salt, "entries": words.iter().map(|word|
        json!({"len": word.chars().count(), "hash": sha256_hex(format!("{salt}:{word}"))})
    ).collect::<Vec<_>>()}))
}

pub struct Privacy {
    current: input_common::Scrubber,
    salt: String,
    sizes: BTreeSet<usize>,
    fingerprints: HashSet<String>,
    places: Vec<(String, &'static str)>,
}

impl Privacy {
    #[cfg(test)]
    pub fn new(cfg: &Config, snapshot: &Value, repo: &Path, tmp: &Path) -> Result<Self> {
        Self::with_aliases(cfg, snapshot, repo, tmp, &Value::Null)
    }

    pub fn with_aliases(
        cfg: &Config,
        snapshot: &Value,
        repo: &Path,
        tmp: &Path,
        aliases: &Value,
    ) -> Result<Self> {
        let rows = snapshot["entries"]
            .as_array()
            .ok_or_else(|| GatewayError("The private-words receipt is invalid.".into()))?;
        let salt = snapshot["salt"]
            .as_str()
            .ok_or_else(|| GatewayError("The private-words receipt has no salt.".into()))?;
        let current = input_common::Scrubber::new(cfg)?;
        let mut places = vec![
            (cfg.home.to_string_lossy().into_owned(), "<zodchi-home>"),
            (repo.to_string_lossy().into_owned(), "<repo>"),
        ];
        // Remarks are recorded with only these canonical places, before research
        // applies its additional caller aliases.
        let remark_places = places.clone();
        if let Some(repo_alias) = aliases["repo"].as_str() {
            places.push((repo_alias.to_owned(), "<repo>"));
        }
        let research_prefixes = places.clone();
        let tmp = tmp.to_string_lossy().into_owned();
        // A stored owner remark may already have had the checkout or home prefix redacted.
        for spelling in std::iter::once(tmp.as_str()).chain(aliases["tmp"].as_str()) {
            for prefixes in [&remark_places, &research_prefixes] {
                let exact_prefix = screen_exact_paths(spelling, prefixes);
                for value in [spelling, exact_prefix.as_str()] {
                    let alias = crate::checks::screen_paths(std::iter::once(value), prefixes);
                    if alias != spelling && alias != "<repo>" && alias != "<zodchi-home>" {
                        places.push((alias, "<research>"));
                    }
                }
            }
        }
        places.push((tmp, "<research>"));
        if let Some(tmp_alias) = aliases["tmp"].as_str() {
            places.push((tmp_alias.to_owned(), "<research>"));
        }
        Ok(Self {
            current,
            salt: salt.into(),
            sizes: rows
                .iter()
                .filter_map(|row| row["len"].as_u64().map(|len| len as usize))
                .filter(|len| *len > 0)
                .collect(),
            fingerprints: rows
                .iter()
                .filter_map(|row| row["hash"].as_str().map(String::from))
                .collect(),
            places,
        })
    }

    pub fn text(&self, text: &str) -> String {
        let normalized = text
            .lines()
            .map(|line| {
                let folded = line.to_lowercase();
                if self.matches(&folded) {
                    "[private text removed]"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        self.current
            .text(&screen_exact_paths(&normalized, &self.places), &self.places)
    }

    pub fn answer_is_private(&self, text: &str) -> bool {
        self.current.answer_is_private(text)
            || text.lines().any(|line| self.matches(&line.to_lowercase()))
            || screen_exact_paths(text, &self.places) != text
            || crate::checks::screen_paths(std::iter::once(text), &self.places) != text
    }

    fn matches(&self, text: &str) -> bool {
        if self.sizes.is_empty() {
            return false;
        }
        let indexes: Vec<_> = text
            .char_indices()
            .map(|(pos, _)| pos)
            .chain([text.len()])
            .collect();
        (0..indexes.len() - 1).any(|start| {
            self.sizes
                .iter()
                .copied()
                .take_while(|size| start + size < indexes.len())
                .any(|size| {
                    self.fingerprints.contains(&sha256_hex(format!(
                        "{}:{}",
                        self.salt,
                        &text[indexes[start]..indexes[start + size]]
                    )))
                })
        })
    }
}

// The shared path scrubber handles uniform slash variants. Preserve exact mixed
// spellings first, before a shorter checkout prefix can obscure a temp path.
fn screen_exact_paths(text: &str, places: &[(String, &str)]) -> String {
    let mut mixed: Vec<_> = places
        .iter()
        .filter(|(path, _)| path.contains('/') && path.contains('\\'))
        .collect();
    mixed.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    let mut result = text.to_owned();
    for (path, replacement) in mixed {
        let lower = result.to_ascii_lowercase();
        let needle = path.to_ascii_lowercase();
        let mut output = String::new();
        let mut at = 0;
        while let Some(offset) = lower[at..].find(&needle) {
            output.push_str(&result[at..at + offset]);
            output.push_str(replacement);
            at += offset + needle.len();
        }
        output.push_str(&result[at..]);
        result = output;
    }
    result
}

#[cfg(test)]
mod exact_path_tests {
    use super::{screen_exact_paths, Privacy};
    use crate::input_common;
    use serde_json::json;
    use zodchi_core::config::Config;

    #[test]
    fn mixed_spelling_prefers_longer_path_and_ignores_ascii_case() {
        let places = vec![
            (concat!("C:", r"\work/repo").to_owned(), "<repo>"),
            (
                concat!("C:", r"\work/repo\.\notes").to_owned(),
                "<research>",
            ),
            (r"<repo>\.\notes/more".to_owned(), "<research>"),
        ];
        assert_eq!(
            screen_exact_paths(
                concat!("C:", r"\WORK/repo\.\notes and <repo>\.\notes/more"),
                &places,
            ),
            "<research> and <research>"
        );
    }

    #[test]
    fn caller_repo_alias_does_not_hide_recorded_home_prefix() {
        let home = std::env::temp_dir().join(crate::journal::new_run_id());
        let repo = home.join("private-repo");
        let tmp = repo.join("working-notes");
        let sep = std::path::MAIN_SEPARATOR;
        let repo_alias = format!("{}{sep}.{sep}private-repo", home.display());
        let tmp_alias = format!("{repo_alias}/.{sep}working-notes");
        let mut cfg = Config::tenant(&home, "fixture").unwrap();
        cfg.home = home.clone();
        let snapshot = json!({"salt":"fixture", "entries":[]});
        let privacy = Privacy::with_aliases(
            &cfg,
            &snapshot,
            &repo,
            &tmp,
            &json!({"repo":repo_alias, "tmp":tmp_alias}),
        )
        .unwrap();
        let recorder_places = [
            (home.to_string_lossy().into_owned(), "<zodchi-home>"),
            (repo.to_string_lossy().into_owned(), "<repo>"),
        ];
        let recorded = input_common::scrub(&cfg, &tmp_alias, &recorder_places).unwrap();
        assert!(recorded.starts_with("<zodchi-home>"), "{recorded}");
        assert_eq!(privacy.text(&recorded), "<research>");
        assert_eq!(privacy.text(&tmp_alias), "<research>");
        assert_eq!(privacy.text("Use oak."), "Use oak.");
    }
}

pub fn stage(raw: &Value, privacy: &Privacy) -> Result<Value> {
    let request = path(&raw["request"], "args.request")?;
    let request = privacy.text(&bounded(&request, 100_000, "request")?);
    if request.trim().is_empty() {
        return fail("The research needs a request.");
    }
    let questions = raw["questions"]
        .as_array()
        .filter(|rows| (1..=5).contains(&rows.len()))
        .ok_or_else(|| GatewayError("Supply one to five question files.".into()))?;
    let mut staged_questions = Vec::new();
    for (i, question) in questions.iter().enumerate() {
        let file = path(&question["file"], "question file")?;
        let text = privacy.text(&bounded(&file, 50_000, "question file")?);
        if text.trim().is_empty() {
            return fail(format!("Question {} is empty.", i + 1));
        }
        let title = match question.get("title") {
            None => format!("Вопрос {}", i + 1),
            Some(Value::String(text)) if text.trim().is_empty() => format!("Вопрос {}", i + 1),
            Some(Value::String(text)) => privacy.text(text.trim()),
            Some(_) => return fail("A question title must be text."),
        };
        if title.is_empty() || title.contains('\n') || title.chars().count() > 80 {
            return fail(format!(
                "Question {} needs a single-line title of up to 80 characters after scrubbing.",
                i + 1
            ));
        }
        staged_questions.push(json!({"title": title, "text": text}));
    }
    let attachments = match raw.get("attachments") {
        None => &[][..],
        Some(Value::Array(files)) if files.len() <= 12 => files,
        _ => return fail("Supply up to twelve distinct attachments."),
    };
    let mut names = HashSet::new();
    let mut staged = Vec::new();
    for (i, file) in attachments.iter().enumerate() {
        let file = fs::canonicalize(path(file, "attachment")?)
            .map_err(|_| GatewayError("An attachment cannot be opened.".into()))?;
        if !names.insert(file.clone()) || !file.is_file() {
            return fail("Attachments must be distinct regular files.");
        }
        let basename = file
            .file_name()
            .and_then(|part| part.to_str())
            .unwrap_or("evidence.md");
        if privacy.text(basename) != basename {
            return fail(format!(
                "Attachment {} has private text in its name.",
                i + 1
            ));
        }
        let alias: String = basename
            .chars()
            .take(64)
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let text = privacy.text(&bounded(&file, 200_000, "attachment")?);
        staged.push(json!({"name": format!("{}-{alias}", i + 1), "text": text}));
    }
    Ok(json!({"request": request, "questions": staged_questions, "attachments": staged}))
}
