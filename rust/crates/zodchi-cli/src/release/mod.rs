//! Build and activate one native distribution for both client plugins and the workflow engine.

mod bundle;
mod dev;
mod managed;

use serde_json::Value;
use std::{collections::BTreeMap, env, path::Path};
use zodchi_core::util::{fail, GatewayError, Result};

const USAGE: &str =
    "Usage: zodchi release build --out <new-directory> [--source <checkout>] [--archive]
       zodchi release marketplace --out <new-directory> [--source <checkout>]
       zodchi release install --archive <file> --sha256 <digest> [--clients codex,claude]
       zodchi release dev --archive <file> --sha256 <digest>
       zodchi release current
       zodchi release register --clients codex,claude  (from a portable bundle)";

pub fn route(args: &[String]) -> Result<Option<u8>> {
    managed::route(args)
}

pub fn cli(args: &[String]) -> Result<Value> {
    let Some((command, tail)) = args.split_first() else {
        return fail(USAGE);
    };
    let (keys, toggle): (&[&str], bool) = match command.as_str() {
        "build" => (&["--out", "--source", "--archive"], true),
        "marketplace" => (&["--out", "--source"], false),
        "install" => (&["--archive", "--sha256", "--clients"], false),
        "dev" => (&["--archive", "--sha256"], false),
        "current" => (&[], false),
        "register" => (&["--clients"], false),
        _ => return fail(USAGE),
    };
    let mut items = tail.iter();
    let mut options = BTreeMap::new();
    while let Some(key) = items.next() {
        if !keys.contains(&key.as_str()) || options.contains_key(key.as_str()) {
            return fail(format!("Invalid or repeated option {key}.\n{USAGE}"));
        }
        let value = if toggle && key == "--archive" {
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
    match command.as_str() {
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
        "register" => managed::register(required("--clients")?),
        _ => unreachable!(),
    }
}
