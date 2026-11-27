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

pub enum Output {
    Json(Value),
    Text(String),
}

pub fn route(args: &[String]) -> Result<Option<u8>> {
    managed::route(args)
}

pub fn cli(args: &[String]) -> Result<Output> {
    let Some((command, tail)) = args.split_first() else {
        return fail(USAGE);
    };
    let (keys, switches): (&[&str], &[&str]) = match command.as_str() {
        "build" => (&["--out", "--source"], &["--archive"]),
        "marketplace" => (&["--out", "--source"], &[]),
        "install" => (&["--archive", "--sha256", "--clients"], &[]),
        "dev" => (&["--archive", "--sha256"], &[]),
        "current" => (&[], &[]),
        "notes" => (&[], &["--hook"]),
        "register" => (&["--clients"], &[]),
        "skill" => (&["--into"], &["--print", "--force"]),
        _ => return fail(USAGE),
    };
    let mut items = tail.iter();
    let mut options = BTreeMap::new();
    while let Some(key) = items.next() {
        let switch = switches.contains(&key.as_str());
        if (!switch && !keys.contains(&key.as_str())) || options.contains_key(key.as_str()) {
            return fail(format!("Invalid or repeated option {key}.\n{USAGE}"));
        }
        let value = if switch {
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
    let result = match command.as_str() {
        "build" | "marketplace" => {
            let source = options
                .get("--source")
                .map_or_else(env::current_dir, |path| std::path::absolute(path))?;
            let out = std::path::absolute(required("--out")?)?;
            if command == "build" {
                bundle::build_release(&out, &source, options.contains_key("--archive"))
            } else {
                bundle::build_marketplace(&out, &source)
            }
        }
        "install" => managed::install(
            Path::new(required("--archive")?),
            required("--sha256")?,
            options.get("--clients").copied(),
        ),
        "dev" => dev::activate(Path::new(required("--archive")?), required("--sha256")?),
        "current" => dev::report(),
        "notes" => notes::report(options.contains_key("--hook")),
        "register" => managed::register(required("--clients")?),
        "skill" => return skill(&options),
        _ => unreachable!(),
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
