use crate::input;
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
        return fail("Supply a private-words file or grant allowNoScrub for this run.");
    }
    let salt = format!("{:032x}", rand::random::<u128>());
    Ok(json!({"salt": salt, "entries": words.iter().map(|word|
        json!({"len": word.chars().count(), "hash": sha256_hex(format!("{salt}:{word}"))})
    ).collect::<Vec<_>>()}))
}

pub struct Privacy {
    current: input::Scrubber,
    salt: String,
    sizes: BTreeSet<usize>,
    fingerprints: HashSet<String>,
    places: Vec<(String, &'static str)>,
}

impl Privacy {
    pub fn new(cfg: &Config, snapshot: &Value, repo: &Path, tmp: &Path) -> Result<Self> {
        let rows = snapshot["entries"]
            .as_array()
            .ok_or_else(|| GatewayError("The private-words receipt is invalid.".into()))?;
        let salt = snapshot["salt"]
            .as_str()
            .ok_or_else(|| GatewayError("The private-words receipt has no salt.".into()))?;
        let current = input::Scrubber::new(cfg)?;
        let mut places = vec![
            (cfg.home.to_string_lossy().into_owned(), "<zodchi-home>"),
            (repo.to_string_lossy().into_owned(), "<repo>"),
        ];
        let tmp = tmp.to_string_lossy().into_owned();
        // A stored owner remark may already have had the checkout or home prefix redacted.
        let alias = crate::checks::screen_paths(std::iter::once(tmp.as_str()), &places);
        if alias != tmp && alias != "<repo>" && alias != "<zodchi-home>" {
            places.push((alias, "<research>"));
        }
        places.push((tmp, "<research>"));
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
        self.current.text(&normalized, &self.places)
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
