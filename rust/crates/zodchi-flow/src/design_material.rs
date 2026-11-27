//! Capture Git sources for design-brief. Models receive aliases, screened material, and actual cited lines.

use crate::{args, checks, claims, git::Git, input_common, patch};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use zodchi_core::config::Config;
use zodchi_core::job::{compose_prompt, LIMIT_PROMPT};
use zodchi_core::util::{fail, GatewayError, Result};

const MAX_SOURCE: usize = LIMIT_PROMPT / 3;

enum SourceText {
    Screened(String),
    TooLarge(usize),
    Unavailable,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    Repository,
    Context,
}

pub(crate) struct Source {
    pub text: String,
    pub origin: Origin,
}

impl Source {
    pub fn context(text: String) -> Self {
        Self { text, origin: Origin::Context }
    }
}

pub fn absolute(value: &Value, name: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute()
                && !path
                    .components()
                    .any(|component| component == Component::ParentDir)
        })
        .ok_or_else(|| {
            GatewayError(format!(
                "{name} must be an absolute path without parent components."
            ))
        })
}

fn text_list(value: &Value, name: &str) -> Result<Vec<String>> {
    match value {
        Value::String(text) => Ok(vec![text.to_string()]),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(String::from)
                    .ok_or_else(|| GatewayError(format!("{name} contains non-text data.")))
            })
            .collect(),
        _ => fail(format!("{name} must be text or an array of text.")),
    }
}

pub fn capture(raw: &Value, cfg: &Config) -> Result<Value> {
    let repos = text_list(&raw["repos"], "args.repos")?;
    if repos.is_empty() {
        return fail("Design brief needs at least one repository.");
    }
    let mut sources = Vec::new();
    let mut inventory = Vec::new();
    let mut oversized = BTreeMap::new();
    let public = raw["publicRepo"] == true;
    let allowed = allowed_words(&raw["allowPrivateWords"], public)?;
    let scrubber = input_common::Scrubber::new(cfg)?.allow_words(&allowed);
    for (index, value) in repos.iter().enumerate() {
        let root = absolute(&json!(value), "args.repos")?;
        let git = Git::new(&root);
        let top = git.run(&["rev-parse", "--show-toplevel"])?;
        if fs::canonicalize(top.trim())? != fs::canonicalize(&root)? {
            return fail("Each design source must be the top folder of a Git checkout.");
        }
        let id = format!("repo{}", index + 1);
        let head = git.rev("HEAD^{commit}")?;
        let paths = git.run(&["ls-tree", "-r", "--full-tree", "-l", "-z", &head])?;
        for (entry, file) in paths.split('\0').filter_map(|row| row.split_once('\t')) {
            if !entry.starts_with("100") || !source_path(file) || scrubber.private(file) {
                continue;
            }
            let Some(size) = entry.split_ascii_whitespace().nth(3).and_then(|size| size.parse::<usize>().ok()) else {
                continue;
            };
            let alias = format!("{id}/{file}");
            if size > MAX_SOURCE {
                oversized.insert(alias, size);
            } else {
                inventory.push(alias);
            }
        }
        sources.push(json!({ "id": id, "root": root, "head": head }));
    }
    let places = places(cfg, &sources);
    let screen = |text: &str| clean(&scrubber, text, &places, public);
    let goal = raw["goal"]
        .as_str()
        .filter(|goal| !goal.trim().is_empty())
        .ok_or_else(|| GatewayError("Design brief needs args.goal.".into()))?;
    let goal = screen(goal);
    let mut documents = Vec::new();
    let mut extracts = BTreeMap::new();
    for key in ["context", "template"] {
        if let Some(files) = raw.get(key) {
            for (index, value) in text_list(files, key)?.into_iter().enumerate() {
                let file = absolute(&json!(value), key)?;
                if !source_path(
                    file.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(""),
                ) || !fs::symlink_metadata(&file)?.file_type().is_file()
                {
                    return fail("A design input document must be a regular text file.");
                }
                let mut text = String::new();
                fs::File::open(file)?
                    .take((MAX_SOURCE + 1) as u64)
                    .read_to_string(&mut text)?;
                if text.len() > MAX_SOURCE || text.contains('\0') {
                    return fail(
                        "A design input document is larger than the supported prompt material.",
                    );
                }
                let text = screen(&text);
                let alias = format!("{key}-{}.md", index + 1);
                if key == "context" {
                    extracts.insert(alias.clone(), text.clone());
                }
                documents.push((alias, text.into_bytes()));
            }
        }
    }
    for source in &sources {
        let alias = source["id"].as_str().unwrap_or("");
        for path in ["AGENTS.md", "CLAUDE.md"] {
            let name = format!("{alias}/{path}");
            if inventory.contains(&name) {
                if let SourceText::Screened(text) = read_source(&sources, &name, &screen)? {
                    documents.push((name, text.into_bytes()));
                }
            }
        }
    }
    let context = compose_prompt(&goal, &documents)?;
    let research_context = if extracts.is_empty() {
        None
    } else {
        let other: Vec<_> = documents.iter().filter(|(name, _)| !extracts.contains_key(name)).cloned().collect();
        Some(compose_prompt(&goal, &other)?)
    };
    let max_context = LIMIT_PROMPT / 2;
    if context.len() > max_context {
        return fail(format!(
            "The goal and screened context need {} UTF-8 bytes (limit {max_context}). Shorten the goal or the input documents.",
            context.len()
        ));
    }
    let mut questions = Vec::new();
    if let Some(input_questions) = raw.get("questions") {
        let list = input_questions
            .as_array()
            .ok_or_else(|| GatewayError("args.questions is an array.".into()))?;
        if list.len() > 8 {
            return fail(
                "Design brief handles up to eight supplied questions in a single package.",
            );
        }
        for question in list {
            let text = question
                .as_str()
                .or_else(|| question["question"].as_str())
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| GatewayError("A design question needs nonempty text.".into()))?;
            let repo = match question.get("repo") {
                Some(value) => {
                    let wanted = value.as_str().ok_or_else(|| {
                        GatewayError("A question's repo is an absolute path.".into())
                    })?;
                    sources
                        .iter()
                        .find(|source| paths_equal(source["root"].as_str().unwrap_or(""), wanted))
                        .ok_or_else(|| {
                            GatewayError(
                                "A question refers to a repository outside args.repos.".into(),
                            )
                        })?
                }
                None => &sources[0],
            };
            let mut files = Vec::new();
            if let Some(hints) = question.get("files") {
                for hint in text_list(hints, "question.files")? {
                    let root = claims::norm(repo["root"].as_str().unwrap_or(""))?;
                    let name = args::rel(&root, &hint).map_err(GatewayError)?;
                    let alias = format!("{}/{name}", repo["id"].as_str().unwrap_or(""));
                    if let Some(bytes) = oversized.get(&alias) {
                        return fail(source_size_error(&alias, *bytes));
                    }
                    if !inventory.contains(&alias)
                        || question_source(&sources, &alias, &screen)?.is_none()
                    {
                        return fail(
                            "A question file is outside the available, screened Git source.",
                        );
                    }
                    if !files.contains(&alias) {
                        files.push(alias);
                    }
                }
            }
            questions.push(json!({ "question": screen(text), "files": files }));
        }
    }
    let needs_plan = questions.is_empty()
        || questions
            .iter()
            .any(|question| question["files"].as_array().is_some_and(Vec::is_empty));
    Ok(
        json!({ "context": context, "inventory": inventory, "sources": sources, "questions": questions,
        "needsPlan": needs_plan, "public": public, "allowPrivateWords": allowed,
        "oversized": oversized, "extracts": extracts, "researchContext": research_context }),
    )
}

fn allowed_words(value: &Value, public: bool) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let values = value.as_array().ok_or_else(|| {
        GatewayError("args.allowPrivateWords is an array of private-word entries.".into())
    })?;
    if public && !values.is_empty() {
        return fail("args.allowPrivateWords is available only for private design briefs.");
    }
    values
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty() && !text.contains(['\r', '\n', '\0']))
                .map(str::to_lowercase)
                .ok_or_else(|| {
                    GatewayError(
                        "args.allowPrivateWords requires nonempty, single-line entries.".into(),
                    )
                })
        })
        .collect()
}

pub(crate) fn scrubber(cfg: &Config, material: &Value) -> Result<input_common::Scrubber> {
    let allowed = allowed_words(&material["allowPrivateWords"], material["public"] == true)?;
    Ok(input_common::Scrubber::new(cfg)?.allow_words(&allowed))
}

fn paths_equal(a: &str, b: &str) -> bool {
    match (claims::norm(a), claims::norm(b)) {
        (Ok(a), Ok(b)) => claims::fold(&a, &a) == claims::fold(&a, &b),
        _ => false,
    }
}

pub(crate) fn source_path(path: &str) -> bool {
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

pub fn places(cfg: &Config, sources: &[Value]) -> Vec<(String, &'static str)> {
    let mut places = vec![(cfg.home.to_string_lossy().into_owned(), "<zodchi-home>")];
    for source in sources {
        if let Some(root) = source["root"].as_str() {
            places.push((root.to_string(), "<repo>"));
        }
    }
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(path) = std::env::var(name) {
            places.push((path, "<home>"));
        }
    }
    places
}

pub fn public_path(line: &str) -> bool {
    line.contains("/Users/")
        || line.contains("/home/")
        || line.as_bytes().windows(3).any(|part| {
            part[0].is_ascii_alphabetic() && part[1] == b':' && matches!(part[2], b'/' | b'\\')
        })
}

pub fn clean(
    scrubber: &input_common::Scrubber,
    text: &str,
    places: &[(String, &str)],
    public: bool,
) -> String {
    let screened = scrubber.text(text, places);
    if public {
        screened
            .lines()
            .map(|line| {
                if public_path(line) {
                    "[private path removed]"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        screened
    }
}

fn read_source(
    sources: &[Value],
    name: &str,
    screen: &impl Fn(&str) -> String,
) -> Result<SourceText> {
    let Some((repo, file)) = name.split_once('/').filter(|(_, file)| source_path(file)) else {
        return Ok(SourceText::Unavailable);
    };
    let Some(source) = sources.iter().find(|source| source["id"] == repo) else {
        return Ok(SourceText::Unavailable);
    };
    let git = Git::new(Path::new(source["root"].as_str().unwrap_or("")));
    let Some(bytes) = git.show(source["head"].as_str().unwrap_or(""), file)? else {
        return Ok(SourceText::Unavailable);
    };
    if bytes.len() > MAX_SOURCE {
        return Ok(SourceText::TooLarge(bytes.len()));
    }
    if bytes.contains(&0) {
        return Ok(SourceText::Unavailable);
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(SourceText::Unavailable);
    };
    Ok(SourceText::Screened(screen(text)))
}

fn question_source(
    sources: &[Value],
    name: &str,
    screen: &impl Fn(&str) -> String,
) -> Result<Option<String>> {
    match read_source(sources, name, screen)? {
        SourceText::Screened(text) => Ok(Some(text)),
        SourceText::Unavailable => Ok(None),
        SourceText::TooLarge(bytes) => fail(source_size_error(name, bytes)),
    }
}

fn source_size_error(name: &str, bytes: usize) -> String {
    format!("The question file {name} has {bytes} bytes (limit {MAX_SOURCE}). Select a smaller source or put a focused extract in args.context.")
}

pub(crate) fn repository_alias(material: &Value, alias: &str) -> bool {
    material["extracts"].get(alias).is_none()
        && (material["oversized"].get(alias).is_some()
            || material["inventory"].as_array()
                .is_some_and(|files| files.iter().any(|file| file.as_str() == Some(alias))))
}

pub(crate) fn question_sources(
    cfg: &Config,
    material: &Value,
    question: &Value,
) -> Result<(BTreeMap<String, Source>, Vec<String>)> {
    let available = material["sources"].as_array().expect("pinned Git sources");
    let scrubber = scrubber(cfg, material)?;
    let places = places(cfg, available);
    let screen = |text: &str| clean(&scrubber, text, &places, material["public"] == true);
    let mut sources = BTreeMap::new();
    let mut omitted = Vec::new();
    for file in text_list(&question["files"], "question.files")? {
        if let Some(extract) = material["extracts"][&file].as_str() {
            sources.insert(file, Source::context(extract.to_owned()));
            continue;
        }
        if let Some(bytes) = material["oversized"][&file].as_u64() {
            omitted.push(source_size_error(&file, bytes as usize));
            continue;
        }
        match read_source(available, &file, &screen)? {
            SourceText::Screened(text) => {
                sources.insert(file, Source { text, origin: Origin::Repository });
            }
            SourceText::TooLarge(bytes) => omitted.push(source_size_error(&file, bytes)),
            SourceText::Unavailable => omitted.push(format!("The question file {file} is unavailable as screened text.")),
        }
    }
    if sources.is_empty() || !omitted.is_empty() {
        for (file, value) in material["extracts"].as_object().into_iter().flatten() {
            if let Some(text) = value.as_str() {
                sources.entry(file.clone()).or_insert_with(|| Source::context(text.to_owned()));
            }
        }
    }
    Ok((sources, omitted))
}

pub(crate) fn retain_verified_facts(
    data: &mut Value,
    sources: &BTreeMap<String, Source>,
) -> std::result::Result<usize, String> {
    if !data["unknowns"]
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        return Err("The research response needs an array of unknowns.".into());
    }
    let Some(facts) = data["facts"].as_array_mut() else {
        return Err("The research response needs facts.".into());
    };
    let mut accepted = Vec::with_capacity(facts.len());
    let mut rejected = Vec::new();
    let mut repository_facts = 0;
    for (index, mut fact) in facts.drain(..).enumerate() {
        match cited_line(&fact, sources) {
            Ok((line, origin)) => {
                if origin == Origin::Repository {
                    repository_facts += 1;
                }
                fact["quote"] = json!(line);
                accepted.push(fact);
            }
            Err(reason) => rejected.push(json!({ "fact": index + 1, "reason": reason })),
        }
    }
    *facts = accepted;
    if !rejected.is_empty() {
        if facts.is_empty() {
            data["unknowns"]
                .as_array_mut()
                .expect("validated unknowns")
                .push(json!("No cited facts could be verified for this question."));
        }
        data["rejectedFacts"] = json!(rejected);
    }
    Ok(repository_facts)
}

fn cited_line<'a>(
    fact: &Value,
    sources: &'a BTreeMap<String, Source>,
) -> std::result::Result<(&'a str, Origin), &'static str> {
    if fact["claim"]
        .as_str()
        .is_none_or(|claim| claim.trim().is_empty())
    {
        return Err("missing claim");
    }
    let source = fact["file"]
        .as_str()
        .and_then(|name| sources.get(name))
        .ok_or("source unavailable")?;
    let number = fact["line"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or("invalid line number")?;
    let line = source.text
        .lines()
        .nth(number - 1)
        .map(str::trim)
        .ok_or("line unavailable")?;
    if line.starts_with("[private ")
        || matches!(line, checks::WITHHELD_LINE | checks::LEGACY_WITHHELD_LINE)
    {
        return Err("source line withheld");
    }
    let quote = fact["quote"]
        .as_str()
        .map(str::trim)
        .filter(|quote| !quote.is_empty())
        .ok_or("missing quote")?;
    if line.contains(quote) {
        return Ok((line, source.origin));
    }
    // The source attachment displays each line with its number before the text.
    let prefix = format!("{number} ");
    let excerpt = quote.strip_prefix(&prefix).unwrap_or(quote).trim_start();
    if !excerpt.is_empty()
        && (line.contains(excerpt) || line.contains(&excerpt.replace("\\`", "`")))
    {
        Ok((line, source.origin))
    } else {
        Err("quote does not match the stated line")
    }
}
