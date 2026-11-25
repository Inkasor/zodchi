use super::{candidate, fixture, CANDIDATE, PLAYER, RELEASE};
use crate::{catalog, git::Git, input, journal, models, video_media as media};
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use zodchi_core::{
    config::Config,
    job,
    role::{load_role, Overrides},
    util::{fail, iso, sha256_hex, GatewayError, Result},
};

pub(super) fn list<'a>(value: &'a Value, at: &str, min: usize, max: usize) -> Result<&'a [Value]> {
    value
        .as_array()
        .filter(|items| (min..=max).contains(&items.len()))
        .map(Vec::as_slice)
        .ok_or_else(|| GatewayError(format!("{at} needs {min} to {max} entries.")))
}

fn identifier(value: &Value, at: &str) -> Result<String> {
    let id = media::text(value, at)?;
    if id.len() > 40
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return fail(format!(
            "{at} needs a lower-case identifier of up to 40 characters."
        ));
    }
    Ok(id.into())
}

fn ids(items: &[Value], at: &str) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for item in items {
        let name = identifier(&item["id"], at)?;
        if names.contains(&name) {
            return fail(format!("Duplicate {at}: {name}."));
        }
        names.push(name);
    }
    Ok(names)
}

fn pointer(value: &Value, at: &str) -> Result<()> {
    if !value
        .as_str()
        .is_some_and(|s| s.is_empty() || (s.len() <= 300 && s.starts_with('/')))
    {
        return fail(format!("{at} needs a JSON pointer."));
    }
    Ok(())
}

pub(super) fn relative(value: &Value, at: &str) -> Result<()> {
    let s = media::text(value, at)?;
    if !crate::patch::plain(s) || s.contains('\\') {
        return fail(format!("{at} needs a relative file path."));
    }
    Ok(())
}

fn url_path(value: &Value, at: &str) -> Result<()> {
    let path = media::text(value, at)?;
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path.chars().any(char::is_whitespace)
    {
        return fail(format!("{at} needs a path on the same origin."));
    }
    Ok(())
}

pub(super) fn seconds(value: &Value, default: u64, max: u64, at: &str) -> Result<u64> {
    if value.is_null() {
        return Ok(default);
    }
    value
        .as_u64()
        .filter(|s| (1..=max).contains(s))
        .ok_or_else(|| GatewayError(format!("{at} needs a duration from 1 to {max} seconds.")))
}

pub(super) fn pin(repo: &Path, value: &Value, at: &str) -> Result<Value> {
    media::pin(&media::file(repo, value, at)?)
}

pub(super) fn from_path(name: &str) -> Result<PathBuf> {
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|dir| dir.join(&name))
        .find(|p| p.is_file())
        .ok_or_else(|| GatewayError(format!("The acceptance runner needs {name} on PATH.")))
}

fn browser_plan(raw: &Value, cfg: &Config, repo: &Path, managed: bool) -> Result<Value> {
    let browser = &raw["browser"];
    media::fields(
        browser,
        &["executable", "module", "node", "isolation"],
        "browser",
    )?;
    let isolation = browser["isolation"].as_str().unwrap_or("headless");
    if !["headless", "private-desktop"].contains(&isolation)
        || (!cfg!(windows) && isolation == "private-desktop")
        || (managed && isolation != "headless")
    {
        return fail("Choose headless, or private-desktop on Windows.");
    }
    let base_url = if managed { "" } else { media::text(&raw["baseUrl"], "baseUrl")? };
    let host = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"));
    if !managed && !host.is_some_and(|h| {
        let h = h.strip_suffix('/').unwrap_or(h);
        !h.is_empty()
            && !h.contains(['@', '/', '\\', '?', '#'])
            && !h.chars().any(char::is_whitespace)
            && (base_url.starts_with("https://")
                || ["127.0.0.1", "localhost", "[::1]"].iter().any(|local| {
                    h == *local
                        || h.strip_prefix(local).is_some_and(|rest| {
                            rest.strip_prefix(':')
                                .is_some_and(|p| p.parse::<u16>().is_ok())
                        })
                }))
    }) {
        return fail("baseUrl needs an HTTPS product origin, or HTTP on loopback.");
    }
    let health = &raw["health"];
    if !managed {
        media::fields(health, &["path", "pointer"], "health")?;
        url_path(&health["path"], "health.path")?;
        pointer(&health["pointer"], "health.pointer")?;
    }
    let node = if browser.get("node").is_some() {
        pin(repo, &browser["node"], "browser.node")?
    } else {
        media::pin(&fs::canonicalize(from_path("node")?)?)?
    };
    let default_module = json!(cfg
        .home
        .join("acceptance-browser/node_modules/playwright/index.js"));
    let module = pin(
        repo,
        browser.get("module").unwrap_or(&default_module),
        "browser.module",
    )?;
    let storage = if raw.get("storageState").is_some() {
        pin(repo, &raw["storageState"], "storageState")?
    } else {
        Value::Null
    };
    Ok(
        json!({ "isolation": isolation, "baseUrl": base_url, "health": health, "node": node,
        "module": module, "executable": pin(repo, &browser["executable"], "browser.executable")?, "storageState": storage }),
    )
}

fn conditions(value: &Value, at: &str) -> Result<()> {
    let rules = if value.is_array() {
        list(value, at, 1, 8)?
    } else {
        std::slice::from_ref(value)
    };
    for rule in rules {
        media::fields(rule, &["selector", "text", "count", "normalizeWhitespace"], at)?;
        if rule.get("count").is_some() && !rule["count"].as_u64().is_some_and(|n| n <= 10000) { return fail(format!("{at}.count needs an integer from 0 to 10000.")); }
        if rule.get("normalizeWhitespace").is_some() && !rule["normalizeWhitespace"].is_boolean() { return fail(format!("{at}.normalizeWhitespace must be boolean.")); }
        if rule.get("text").is_some() && rule.get("count").is_some_and(|n| n != 1) { return fail(format!("{at}.text requires count 1.")); }
        media::text(&rule["selector"], &format!("{at}.selector"))?;
        if let Some(text) = rule.get("text") {
            media::text(text, &format!("{at}.text"))?;
        }
    }
    Ok(())
}

fn browser_scenario(scenario: &Value, steps: &[Value], managed: bool) -> Result<Value> {
    let mut downloads = Vec::new();
    if let Some(ready) = scenario.get("ready") {
        conditions(ready, "scenario.ready").map_err(|error| GatewayError(format!("Scenario {}: {}", scenario["id"].as_str().unwrap_or("?"), error.0)))?;
    }
    for (index, step) in steps.iter().enumerate() {
        (|| -> Result<()> {
        if index == 0 && step.get("open").is_none() {
            return fail("A browser scenario must start by opening a page.");
        }
        media::fields(
            step,
            &[
                "id",
                "open",
                "click",
                "select",
                "check",
                "fill",
                "hover",
                "press",
                "expect",
                "maxSeconds",
            ],
            "browser step",
        )?;
        if ["open", "click", "select", "check", "fill", "hover", "press"]
            .iter()
            .filter(|name| step.get(**name).is_some())
            .count()
            != 1
        {
            return fail(
                "Each browser step needs exactly one open, click, select or check action.",
            );
        }
        if let Some(open) = step.get("open") {
            url_path(open, "open")?;
        }
        if let Some(click) = step.get("click") {
            if click.is_string() { media::text(click, "click selector")?; } else {
                media::fields(click, &["selector", "popup", "download"], "click")?;
                media::text(&click["selector"], "click.selector")?;
                if !managed && (click.get("popup").is_some() || click.get("download").is_some()) { return fail("Popup and download clicks require a managed fixture."); }
                if click.get("popup").is_some() && click["popup"] != true { return fail("click.popup must be true."); }
                if let Some(name) = click.get("download") {
                    let name = media::text(name, "click.download")?;
                    if !name.starts_with("download-") || name.len() > 100 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) || name.ends_with('.') { return fail("click.download needs a safe direct filename starting with download-."); }
                    if downloads.iter().any(|existing: &&str| existing.eq_ignore_ascii_case(name)) || steps.iter().any(|s| { let id = s["id"].as_str().unwrap_or(""); name.eq_ignore_ascii_case(&format!("{id}-before.png")) || name.eq_ignore_ascii_case(&format!("{id}-after.png")) }) { return fail("Download filename conflicts with another artifact."); }
                    downloads.push(name);
                }
                if click.get("popup").is_some() && click.get("download").is_some() { return fail("A click cannot declare both popup and download."); }
            }
        }
        for action in ["fill", "press"] {
            if let Some(value) = step.get(action) {
                media::fields(value, &["selector", "value"], action)?;
                media::text(&value["selector"], &format!("{action}.selector"))?;
                if !value["value"].as_str().is_some_and(|s| s.len() <= 4096 && !s.contains('\0')) { return fail(format!("{action}.value needs a bounded string.")); }
            }
        }
        if let Some(hover) = step.get("hover") { media::text(hover, "hover selector")?; }
        if let Some(select) = step.get("select") {
            media::fields(select, &["selector", "value"], "select")?;
            media::text(&select["selector"], "select.selector")?;
            media::text(&select["value"], "select.value")?;
        }
        if let Some(check) = step.get("check") {
            media::fields(check, &["selector", "checked"], "check")?;
            media::text(&check["selector"], "check.selector")?;
            if !check["checked"].is_boolean() {
                return fail("check.checked must be true or false.");
            }
        }
        conditions(&step["expect"], "expect")?;
        seconds(&step["maxSeconds"], 5, 60, "maxSeconds")?;
        Ok(())
        })().map_err(|error| GatewayError(format!("Scenario {} step {}: {}", scenario["id"].as_str().unwrap_or("?"), step["id"].as_str().unwrap_or("?"), error.0)))?;
    }
    if let Some(check) = scenario.get("apiCheck") {
        media::fields(
            check,
            &[
                "selector",
                "path",
                "pointer",
                "decimal",
                "tolerance",
                "extract",
            ],
            "apiCheck",
        )?;
        media::text(&check["selector"], "apiCheck.selector")?;
        url_path(&check["path"], "apiCheck.path")?;
        pointer(&check["pointer"], "apiCheck.pointer")?;
        if check.get("decimal").is_some()
            && ![Some("."), Some(",")].contains(&check["decimal"].as_str())
        {
            return fail("apiCheck.decimal must be a dot or comma.");
        }
        if check.get("extract").is_some() && check["extract"] != "first-number" {
            return fail("apiCheck.extract, when set, must be first-number.");
        }
        if check.get("tolerance").is_some()
            && !check["tolerance"].as_f64().is_some_and(|n| n >= 0.0)
        {
            return fail("apiCheck.tolerance must be a nonnegative number.");
        }
    }
    Ok(scenario.clone())
}

fn player_scenario(
    repo: &Path,
    scenario: &Value,
    steps: &[Value],
    names: &[String],
) -> Result<Value> {
    let mut pinned_steps = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        media::fields(
            step,
            &[
                "id",
                "program",
                "args",
                "inputs",
                "timeoutSeconds",
                "receipt",
                "expect",
                "match",
                "artifacts",
            ],
            "player step",
        )?;
        let mut pinned = step.clone();
        pinned["program"] = pin(repo, &step["program"], "player program")?;
        let argv = list(&step["args"], "args", 0, 128)?;
        if argv
            .iter()
            .any(|val| val.as_str().is_none_or(|s| s.contains('\0')))
        {
            return fail("Player args must be strings without NUL.");
        }
        let mut inputs = Vec::new();
        if let Some(paths) = step.get("inputs") {
            for path in list(paths, "inputs", 0, 64)? {
                inputs.push(pin(repo, path, "player input")?);
            }
        }
        pinned["inputs"] = json!(inputs);
        pinned["timeoutSeconds"] = json!(seconds(
            &step["timeoutSeconds"],
            120,
            1200,
            "timeoutSeconds"
        )?);
        relative(&step["receipt"], "receipt")?;
        if let Some(expect) = step.get("expect") {
            let checks = expect
                .as_object()
                .ok_or_else(|| GatewayError("expect must map JSON pointers to values.".into()))?;
            for field in checks.keys() {
                pointer(&json!(field), "expect key")?;
            }
        }
        if let Some(compare) = step.get("match") {
            media::fields(compare, &["step", "pointers"], "match")?;
            let earlier = identifier(&compare["step"], "match.step")?;
            if !names[..index].contains(&earlier) {
                return fail("match.step must name an earlier step in this scenario.");
            }
            for field in list(&compare["pointers"], "match.pointers", 1, 64)? {
                pointer(field, "match pointer")?;
            }
        }
        if let Some(artifacts) = step.get("artifacts") {
            for file in list(artifacts, "artifacts", 0, 32)? {
                relative(file, "artifact")?;
            }
        }
        pinned_steps.push(pinned);
    }
    let mut result = scenario.clone();
    result["steps"] = json!(pinned_steps);
    Ok(result)
}

fn role(raw: &Value, cfg: &Config, repo: &Path) -> Result<Value> {
    if raw.get("choose").is_none() && raw.get("review").is_none() {
        return Ok(Value::Null);
    }
    for field in ["choose", "review"] {
        if let Some(value) = raw.get(field) {
            media::owner_words(value)?;
        }
    }
    job::ensure_ignored(cfg)?;
    let args_models = match raw.get("models") {
        Some(value) => value
            .as_object()
            .cloned()
            .ok_or_else(|| GatewayError("models needs a role table.".into()))?,
        None => Map::new(),
    };
    let table = models::table(cfg, repo, &args_models).map_err(GatewayError)?;
    let pick = models::candidates(&table, "acceptor")
        .map_err(GatewayError)?
        .into_iter()
        .find(|p| p.provider == "codex")
        .ok_or_else(|| {
            GatewayError("Acceptance needs a Codex candidate in models.acceptor.".into())
        })?;
    models::codex_usable(&job::account(cfg)).map_err(GatewayError)?;
    let role = load_role(
        cfg,
        "acceptance-observer",
        &Overrides {
            model: Some(pick.model),
            effort: Some(pick.effort),
            ..Overrides::default()
        },
    )?;
    if role["kind"] != "text" || role["mode"] != "expert" {
        return fail("Acceptance requires a text expert role.");
    }
    Ok(role)
}

pub(super) fn prepare(workflow: &str, raw: &Value) -> Result<(Config, Value)> {
    let common = [
        "repo",
        "head",
        "label",
        "scenarios",
        "choose",
        "review",
        "models",
    ];
    let extras: &[&str] = if workflow == RELEASE {
        &["baseUrl", "health", "browser", "storageState"]
    } else if workflow == CANDIDATE {
        &["browser", "setup", "fixture"]
    } else {
        &[]
    };
    let allowed: Vec<_> = common.into_iter().chain(extras.iter().copied()).collect();
    media::fields(raw, &allowed, "args")?;
    let repo = media::directory(&raw["repo"], "repo")?;
    let git = Git::new(&repo);
    if fs::canonicalize(git.run(&["rev-parse", "--show-toplevel"])?.trim())? != repo {
        return fail("repo must be the top of the Git checkout.");
    }
    let head = if let Some(value) = raw.get("head") {
        let head = media::text(value, "head")?;
        if !(7..=64).contains(&head.len()) || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
            return fail("head must be a Git commit SHA.");
        }
        git.rev(&format!("{head}^{{commit}}"))?
    } else if workflow == PLAYER {
        git.rev("HEAD^{commit}")?
    } else {
        return fail(if workflow == RELEASE { "release-acceptance requires the deployed commit in head." } else { "candidate-acceptance requires an explicit commit in head." });
    };
    catalog::require(&git, &head, workflow)?;
    if workflow == PLAYER && !cfg!(windows) {
        return fail("player-acceptance needs a Windows host with a private desktop.");
    }
    let cfg = Config::new(Some(&repo))?;
    let managed = workflow == CANDIDATE && raw.get("fixture").is_some();
    let browser = if workflow == RELEASE || managed {
        browser_plan(raw, &cfg, &repo, managed)?
    } else if workflow == CANDIDATE {
        candidate::browser_plan(raw, &repo)?
    } else {
        Value::Null
    };
    let label = media::owner_words(&raw["label"])?;
    let sources = list(&raw["scenarios"], "scenarios", 1, 32)?;
    ids(sources, "scenario id")?;
    let mut scenarios = Vec::with_capacity(sources.len());
    for scenario in sources {
        let fields: &[&str] = if workflow == RELEASE || managed {
            &["id", "label", "steps", "ready", "apiCheck"]
        } else if workflow == CANDIDATE {
            &["id", "label", "test", "timeoutSeconds", "frames"]
        } else {
            &["id", "label", "steps"]
        };
        media::fields(scenario, fields, "scenario")?;
        if let Some(label) = scenario.get("label") {
            media::owner_words(label)?;
        }
        if workflow == CANDIDATE && !managed {
            scenarios.push(candidate::scenario(&git, &head, scenario)?);
            continue;
        }
        let steps = list(&scenario["steps"], "steps", 1, 64)?;
        let names = ids(steps, "step id")?;
        scenarios.push(if workflow == RELEASE || managed {
            browser_scenario(scenario, steps, managed)?
        } else {
            player_scenario(&repo, scenario, steps, &names)?
        });
    }
    let role = role(raw, &cfg, &repo)?;
    let setup = if workflow == CANDIDATE { candidate::setup(raw)? } else { Value::Null };
    let tree = if workflow == CANDIDATE { json!(git.rev(&format!("{head}^{{tree}}"))?) } else { Value::Null };
    let mut plan = json!({ "scenarios": scenarios, "browser": browser, "choose": raw["choose"], "review": raw["review"], "role": role });
    if workflow == CANDIDATE {
        plan["setup"] = setup;
        plan["tree"] = tree;
        if managed {
            let mut fixture_raw = raw["fixture"].clone();
            let writes = fixture_raw.as_object_mut().and_then(|o| o.remove("allowedWrites")).unwrap_or(json!([]));
            for write in list(&writes, "fixture.allowedWrites", 0, 32)? {
                media::fields(write, &["method", "path"], "fixture.allowedWrites entry")?;
                let method = media::text(&write["method"], "fixture.allowedWrites.method")?;
                if !["POST", "PUT", "PATCH", "DELETE"].contains(&method) { return fail("fixture.allowedWrites.method must be POST, PUT, PATCH or DELETE."); }
                url_path(&write["path"], "fixture.allowedWrites.path")?;
                if write["path"].as_str().unwrap().split('/').any(|part| part == "." || part == "..") || write["path"].as_str().unwrap().contains(['?', '%', '*']) { return fail("fixture.allowedWrites.path must be an exact unescaped pathname."); }
            }
            plan["fixture"] = fixture::plan(&fixture_raw, &repo, &git, &head)?;
            plan["fixture"]["allowedWrites"] = writes;
        }
    }
    let pair = if role.is_null() {
        Value::Null
    } else {
        json!({ "acceptor": { "provider": "codex", "model": role["model"], "effort": role["effort"] } })
    };
    let run = json!({ "workflow": workflow, "version": "1", "runId": journal::new_run_id(), "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": repo, "head": head, "label": label, "pair": pair,
        "inputs": { "argsSha256": input::args_digest(raw), "planSha256": sha256_hex(plan.to_string()), "plan": plan } });
    Ok((cfg, run))
}
