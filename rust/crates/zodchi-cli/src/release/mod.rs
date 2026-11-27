//! Build and activate one native distribution for both client plugins and the workflow engine.

mod bundle;
mod dev;
mod managed;
mod notes;

use serde_json::{json, Value};
use std::{collections::BTreeMap, env, path::Path};
use zodchi_core::util::{fail, GatewayError, Result};

const USAGE: &str =
    "Usage: zodchi release build --out <new-directory> [--source <checkout>] [--archive]
       zodchi release marketplace --out <new-directory> [--source <checkout>]
       zodchi release install --archive <file> --sha256 <digest> [--clients codex,claude]
       zodchi release dev --archive <file> --sha256 <digest>
       zodchi release notes [--hook]
       zodchi release current
       zodchi release register --clients codex,claude  (from a portable bundle)
       zodchi release skill --print | --into <skills-dir> [--force]";

#[derive(Clone, Copy)]
enum Command {
    Build,
    Marketplace,
    Install,
    Dev,
    Notes,
    Current,
    Register,
    Skill,
}

type Flags = &'static [(&'static str, &'static str)];

const COMMANDS: &[(&str, Command, Flags)] = &[
    (
        "build",
        Command::Build,
        &[("--out", "directory"), ("--source", "directory"), ("--archive", "boolean")],
    ),
    (
        "marketplace",
        Command::Marketplace,
        &[("--out", "directory"), ("--source", "directory")],
    ),
    (
        "install",
        Command::Install,
        &[("--archive", "file"), ("--sha256", "digest"), ("--clients", "client-list")],
    ),
    (
        "dev",
        Command::Dev,
        &[("--archive", "file"), ("--sha256", "digest")],
    ),
    ("notes", Command::Notes, &[("--hook", "boolean")]),
    ("current", Command::Current, &[]),
    ("register", Command::Register, &[("--clients", "client-list")]),
    (
        "skill",
        Command::Skill,
        &[("--print", "boolean"), ("--into", "directory"), ("--force", "boolean")],
    ),
];

pub fn usage() -> Value {
    let subcommands: Vec<_> = COMMANDS
        .iter()
        .map(|&(name, _, flags)| {
            let flags: Vec<_> = flags
                .iter()
                .map(|&(name, kind)| json!({ "name": name, "valueKind": kind }))
                .collect();
            json!({ "name": name, "flags": flags, "subcommands": [] })
        })
        .collect();
    json!({ "name": "release", "flags": [], "subcommands": subcommands })
}

pub enum Output {
    Json(Value),
    Text(String),
}

pub fn route(args: &[String], agent: bool) -> Result<Option<u8>> {
    managed::route(args, agent)
}

pub fn cli(args: &[String]) -> Result<Output> {
    let Some((command, tail)) = args.split_first() else {
        return fail(USAGE);
    };
    let Some(&(_, command, flags)) = COMMANDS
        .iter()
        .find(|(name, _, _)| *name == command.as_str())
    else {
        return fail(USAGE);
    };
    let mut items = tail.iter();
    let mut options = BTreeMap::new();
    while let Some(key) = items.next() {
        let flag = flags.iter().find(|(name, _)| *name == key.as_str());
        let Some(&(_, kind)) = flag.filter(|_| !options.contains_key(key.as_str())) else {
            return fail(format!("Invalid or repeated option {key}.\n{USAGE}"));
        };
        let value = if kind == "boolean" {
            ""
        } else {
            items
                .next()
                .map(String::as_str)
                .filter(|value| !value.is_empty() && !value.starts_with("--"))
                .ok_or_else(|| GatewayError(format!("Missing value for {key}.\n{USAGE}")))?
        };
        options.insert(key.as_str(), value);
    }
    let required = |key: &str| {
        options
            .get(key)
            .copied()
            .ok_or_else(|| GatewayError(format!("Missing {key}.\n{USAGE}")))
    };
    let result = match command {
        Command::Build | Command::Marketplace => {
            let source = options
                .get("--source")
                .map_or_else(env::current_dir, |path| std::path::absolute(path))?;
            let out = std::path::absolute(required("--out")?)?;
            if matches!(command, Command::Build) {
                bundle::build_release(&out, &source, options.contains_key("--archive"))
            } else {
                bundle::build_marketplace(&out, &source)
            }
        }
        Command::Install => managed::install(
            Path::new(required("--archive")?),
            required("--sha256")?,
            options.get("--clients").copied(),
        ),
        Command::Dev => dev::activate(Path::new(required("--archive")?), required("--sha256")?),
        Command::Current => dev::report(),
        Command::Notes => notes::report(options.contains_key("--hook")),
        Command::Register => managed::register(required("--clients")?),
        Command::Skill => return skill(&options),
    }?;
    Ok(Output::Json(result))
}

fn skill(options: &BTreeMap<&str, &str>) -> Result<Output> {
    let force = options.contains_key("--force");
    let into = match (
        options.contains_key("--print"),
        options.get("--into"),
        force,
    ) {
        (true, None, false) => None,
        (false, Some(dir), _) => Some(std::path::absolute(dir)?),
        _ => return fail(USAGE),
    };
    let bytes = bundle::read_flow_skill(&managed::packaged_root()?)?;
    if let Some(dir) = into {
        let path = bundle::write_flow_skill(&dir, &bytes, force)?;
        return Ok(Output::Json(
            json!({ "skill": path, "version": bundle::VERSION }),
        ));
    }

    let text = std::str::from_utf8(&bytes).map_err(|error| {
        GatewayError(format!("The packaged Zodchi skill is not UTF-8: {error}"))
    })?;
    let mut lines = text.lines();
    if lines.next() != Some("---") || !lines.by_ref().any(|line| line == "---") {
        return fail("The packaged Zodchi skill has invalid front matter.");
    }
    let body = lines.collect::<Vec<_>>().join("\n");
    Ok(Output::Text(format!(
        "# Zodchi {}\n\n{}\n\n`zodchi flow list` and `zodchi flow <workflow> --help` are the source of truth.",
        bundle::VERSION,
        body.trim_matches('\n'),
    )))
}
