//! The `zodchi` command: one call to a Codex model in a named role. Commands and options are those of the
//! reference gateway, so workflows and skills do not notice the replacement.

mod release;

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{self, compose_prompt, deliver, is_terminal, Request};
use zodchi_core::role::{load_role, roles, Overrides};
use zodchi_core::util::{fail, is_key, now_ms, parse_iso_ms, GatewayError, Result};

const USAGE: &str = "Usage: zodchi <command> [options]
Run it inside the repository the call is for: jobs are stored in its .agent-tmp/gateway/<key>/.

  run      submit a job and wait for it        submit   submit and return at once
  wait     wait for a submitted job            job      print a job as it is now
  status <key> [<key>...] [--json]             print status and elapsed time in seconds for each key
  roles    the roles a call from this repository can name
  check    open the thread of a role and print its sandbox and MCP servers (no model call)
  account  every subscription in ~/.zodchi/accounts.json: sign-in, limits, credits (no model call)
  flow     run a workflow as code: zodchi flow <workflow> --args <file.json>
           zodchi flow list shows the installed catalog
           (docs/flow.md; exit 0 approved, 2 any other end, 1 a wrong call)
  release  build, install or register a Zodchi distribution

Job options (run, submit):
  --role <name|file.json>  what the call is: kind, mode, model, effort, frame, schema, tools
  --key <key>              idempotency key: the same key returns the same job and spends nothing
  --prompt <file>          the request
  --attach <file>          a text file appended to the prompt; repeatable
  --image <file>           an input image, PNG, JPEG or WebP; repeatable
  --provider codex|claude  Claude is a local subscription for one text expert call, with optional images
  --model <id>  --effort low|medium|high|xhigh|max|ultra  --timeout-min <n>   replace what the role says
  --keep-thread / --no-keep-thread   keep (or not) the Codex thread of a work call so --resume can continue it
  --resume <key>           continue the thread of an earlier work job that kept it
  --credits                let the call spend ChatGPT credits when every subscription's limit is used up
  --questions <file.json>  the questions of a decisions call; they replace those of the role
  --paid                   let a decisions call spend from the OpenAI API key
  --quiet                  submit only: print one line per job, <key> <status>
  submit --list <file.json>  submit the jobs in list order, using their keys, prompts and optional overrides
Result options (run, wait):
  --out <file>             copy the answer there: the image, the JSON by the schema of the role, or the text
  --wait-sec <n>           how long this command waits, default 540; the job goes on after that
  wait (--any | --all) (--list <file.json> [--keys a,b] | --keys a,b) [--wait-sec <n>]
                           wait for any or all selected jobs to finish and deliver successes to their list outputs
Anywhere:
  --root <dir>             the repository, when the command is not run inside it
  --context <dir>          a non-Git project directory for local expert jobs, stored in the Zodchi home

Exit code of run, wait --key and job: 0 succeeded, 2 another final status, 3 still running, 1 a wrong call.
Batch wait exits 3 if the condition timed out, otherwise 0 if every finished job succeeded or 2 if any did not.
A bad batch call or delivery error exits 1.
submit exits 0 once the job is stored or already exists.
status exits 0 when every key was read, 2 for an unknown key or a bad call.";

#[derive(Clone, Default)]
struct Options {
    values: std::collections::HashMap<String, String>,
    attach: Vec<String>,
    image: Vec<String>,
    switches: std::collections::HashSet<String>,
}

impl Options {
    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
    fn has(&self, name: &str) -> bool {
        self.switches.contains(name)
    }
}

fn parse(command: &str, args: &[String]) -> Result<Options> {
    let mut o = Options::default();
    let mut i = 0;
    while i < args.len() {
        let Some(name) = args[i].strip_prefix("--") else { return fail(format!("Unexpected argument: {}", args[i])) };
        if command == "wait" && !matches!(name, "key" | "out" | "wait-sec" | "root" | "context" | "all" | "any" | "list" | "keys") {
            return fail(format!("Unexpected wait option: --{name}"));
        }
        if command == "wait" && matches!(name, "list" | "keys") && o.get(name).is_some() {
            return fail(format!("Repeated option: --{name}"));
        }
        if ["credits", "paid", "keep-thread", "no-keep-thread"].contains(&name)
            || (name == "quiet" && command == "submit")
            || (command == "wait" && matches!(name, "any" | "all"))
        {
            o.switches.insert(name.to_string());
            i += 1;
            continue;
        }
        let Some(value) = args.get(i + 1) else { return fail(format!("Unexpected argument: {}", args[i])) };
        match name {
            "attach" => o.attach.push(value.clone()),
            "image" => o.image.push(value.clone()),
            _ => {
                o.values.insert(name.to_string(), value.clone());
            }
        }
        i += 2;
    }
    Ok(o)
}

fn read_file(file: &str, what: &str) -> Result<Vec<u8>> {
    std::fs::read(file).map_err(|_| GatewayError(format!("Cannot read {what}: {file}")))
}

fn role(cfg: &Config, o: &Options) -> Result<Value> {
    let questions = match o.get("questions") {
        Some(file) => Some(serde_json::from_slice(&read_file(file, "the questions")?).map_err(|_| GatewayError(format!("The questions are not JSON: {file}")))?),
        None => None,
    };
    let timeout_min = match o.get("timeout-min") {
        Some(t) => Some(t.parse::<f64>().map_err(|_| GatewayError(format!("--timeout-min is a number: {t}")))?),
        None => None,
    };
    load_role(cfg, o.get("role").unwrap_or(""), &Overrides { model: o.get("model").map(String::from), effort: o.get("effort").map(String::from), timeout_min, questions })
}

fn request(cfg: &Config, o: &Options) -> Result<Request> {
    let Some(prompt) = o.get("prompt") else { return fail("--prompt <file> is required") };
    if o.has("keep-thread") && o.has("no-keep-thread") {
        return fail("--keep-thread and --no-keep-thread exclude each other");
    }
    let mut attachments = Vec::new();
    for file in &o.attach {
        attachments.push((file.replace('\\', "/"), read_file(file, "the attachment")?));
    }
    let text = String::from_utf8_lossy(&read_file(prompt, "the prompt")?).into_owned();
    Ok(Request {
        key: o.get("key").unwrap_or("").to_string(),
        role: role(cfg, o)?,
        prompt: compose_prompt(&text, &attachments)?,
        images: o.image.iter().map(|f| read_file(f, "the image")).collect::<Result<_>>()?,
        credits: o.has("credits"),
        paid: o.has("paid"),
        resume: o.get("resume").map(String::from),
        keep_thread: if o.has("keep-thread") { Some(true) } else if o.has("no-keep-thread") { Some(false) } else { None },
        fingerprint: None,
    })
}

fn provider(options: &Options) -> Result<&str> {
    match options.get("provider").unwrap_or("codex") {
        "codex" => Ok("codex"),
        "claude" if options.get("model").is_some() => Ok("claude"),
        "claude" => fail("--provider claude needs an explicit --model."),
        _ => fail("--provider must be codex or claude."),
    }
}

fn configuration(root: Option<&Path>, context: Option<&Path>) -> Result<Config> {
    match (root, context) {
        (Some(_), Some(_)) => fail("--root and --context exclude each other."),
        (None, Some(path)) => Config::context(path),
        _ => Config::new(root),
    }
}

fn read_list(file: &str) -> Result<Value> {
    serde_json::from_slice(&read_file(file, "the job list")?)
        .map_err(|error| GatewayError(format!("{file}: {error}")))
}

fn check_key<'a>(key: &'a str, seen: &mut HashSet<&'a str>, source: &str) -> Result<()> {
    if !is_key(key) {
        return fail(format!("{source}: invalid job key '{key}'"));
    }
    if !seen.insert(key) {
        return fail(format!("{source}: repeated job key '{key}'"));
    }
    Ok(())
}

fn list_entries<'a>(list: &'a Value, file: &str) -> Result<Vec<(&'a str, &'a Value)>> {
    let jobs = list["jobs"].as_array()
        .ok_or_else(|| GatewayError(format!("{file}: jobs must be an array")))?;
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(jobs.len());
    for entry in jobs {
        let key = entry["key"].as_str().ok_or_else(|| GatewayError(format!("{file}: every job needs a key")))?;
        check_key(key, &mut seen, file)?;
        entries.push((key, entry));
    }
    Ok(entries)
}

fn string_field<'a>(entry: &'a Value, field: &str, context: &str) -> Result<Option<&'a str>> {
    entry.get(field).map(|value| {
        value.as_str().ok_or_else(|| GatewayError(format!("{context}: {field} must be a string")))
    }).transpose()
}

// Match exactly the numbered filenames produced by deliver, including stems with dots and extensionless outputs.
fn image_sibling(base: &Path, candidate: &Path) -> bool {
    if base.parent() != candidate.parent() {
        return false;
    }
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let extension = base.extension().and_then(|s| s.to_str()).map(|s| format!(".{s}")).unwrap_or_default();
    let number = candidate.file_name().and_then(|s| s.to_str())
        .and_then(|name| name.strip_suffix(&extension))
        .and_then(|name| name.strip_prefix(stem))
        .and_then(|suffix| suffix.strip_prefix('-'));
    number.is_some_and(|n| !n.is_empty() && !n.starts_with('0') && n != "1" && n.bytes().all(|b| b.is_ascii_digit()))
}

struct Destination {
    key: String,
    absolute: PathBuf,
    folded: PathBuf,
    image: bool,
}

fn check_destination(previous: &mut Vec<Destination>, key: &str, out: &str, image: bool) -> Result<()> {
    let absolute = std::path::absolute(out).map_err(|error| GatewayError(format!("{key}: {out}: {error}")))?;
    let mut folded = PathBuf::new();
    for component in absolute.components() {
        if component == std::path::Component::ParentDir {
            folded.pop();
        } else {
            folded.push(component.as_os_str().to_string_lossy().to_lowercase());
        }
    }
    for other in previous.iter() {
        let overlap = if other.folded == folded || (other.image && image_sibling(&other.folded, &folded)) {
            &absolute
        } else if image && image_sibling(&folded, &other.folded) {
            &other.absolute
        } else {
            continue;
        };
        return fail(format!("{} and {key} both write {}", other.key, overlap.display()));
    }
    previous.push(Destination { key: key.to_owned(), absolute, folded, image });
    Ok(())
}

fn submit_list(cfg: &Config, options: &Options) -> Result<u8> {
    let provider = provider(options)?;
    let file = options.get("list").unwrap();
    for name in ["key", "prompt", "resume", "questions"] {
        if options.get(name).is_some() {
            return fail(format!("{file}: --list excludes --{name}"));
        }
    }
    if !options.attach.is_empty() || !options.image.is_empty() {
        return fail(format!("{file}: --list excludes --attach and --image"));
    }
    let list = read_list(file)?;
    if let Some(object) = list.as_object() {
        for name in object.keys() {
            if !matches!(name.as_str(), "role" | "jobs") {
                return fail(format!("{file}: unknown field '{name}'"));
            }
        }
    }
    let default_role = string_field(&list, "role", file)?.or(options.get("role"));
    let mut requests = Vec::new();
    let mut destinations = Vec::new();
    for (key, entry) in list_entries(&list, file)? {
        let mut options = options.clone();
        // list_entries already checked that this object has a string key.
        for name in entry.as_object().unwrap().keys() {
            if !matches!(name.as_str(), "key" | "prompt" | "role" | "attach" | "image" | "out") {
                return fail(format!("{key}: unknown field '{name}'"));
            }
        }
        options.values.insert("key".into(), key.into());
        if let Some(prompt) = string_field(entry, "prompt", key)? {
            options.values.insert("prompt".into(), prompt.into());
        }
        if let Some(role) = string_field(entry, "role", key)?.or(default_role) {
            options.values.insert("role".into(), role.into());
        }
        for (name, paths) in [("attach", &mut options.attach), ("image", &mut options.image)] {
            if let Some(value) = entry.get(name) {
                *paths = serde_json::from_value(value.clone())
                    .map_err(|_| GatewayError(format!("{key}: {name} must be an array of paths")))?;
            }
        }
        let req = request(cfg, &options).map_err(|error| GatewayError(format!("{key}: {error}")))?;
        if let Some(out) = string_field(entry, "out", key)? {
            check_destination(&mut destinations, key, out, req.role["kind"] == "image")?;
        }
        requests.push(req);
    }

    let mut jobs = Vec::new();
    for req in requests {
        let (current, created) = job::submit_for(cfg, &req, true, provider)
            .map_err(|error| GatewayError(format!("{}: {error}", req.key)))?;
        jobs.push(json!({ "key": req.key, "status": current["status"], "created": created }));
    }
    if options.has("quiet") {
        for row in jobs {
            println!("{} {}", row["key"].as_str().unwrap(), row["status"].as_str().unwrap());
        }
    } else {
        print(&json!({ "jobs": jobs }));
    }
    Ok(0)
}

fn wait_targets(options: &Options) -> Result<Vec<(String, Option<String>)>> {
    let mut selected = HashSet::new();
    let mut targets = Vec::new();
    if let Some(keys) = options.get("keys") {
        for key in keys.split(',') {
            check_key(key, &mut selected, "--keys")?;
            if options.get("list").is_none() {
                targets.push((key.to_owned(), None));
            }
        }
    }
    if let Some(file) = options.get("list") {
        let list = read_list(file)?;
        for (key, entry) in list_entries(&list, file)? {
            let out = string_field(entry, "out", key)?.map(String::from);
            if options.get("keys").is_none() || selected.remove(key) {
                targets.push((key.to_owned(), out));
            }
        }
        if let Some(keys) = options.get("keys") {
            for key in keys.split(',') {
                if selected.contains(key) {
                    return fail(format!("{file}: no entry for '{key}'"));
                }
            }
        }
    }
    if targets.is_empty() {
        return fail("batch wait needs at least one key");
    }
    Ok(targets)
}

fn elapsed_seconds(current: &Value) -> Option<u64> {
    current["createdAt"].as_str().and_then(parse_iso_ms).map(|created| {
        let end = current["finishedAt"].as_str().and_then(parse_iso_ms).unwrap_or_else(now_ms);
        ((end - created).max(0) / 1000) as u64
    })
}

fn wait_batch(cfg: &Config, options: &Options) -> Result<u8> {
    let all = options.has("all");
    if all == options.has("any") || (options.get("list").is_none() && options.get("keys").is_none()) {
        return fail("wait needs one of --all or --any and a --list or --keys");
    }
    if options.get("key").is_some() || options.get("out").is_some() {
        return fail("batch wait excludes --key and --out");
    }
    let seconds = options.get("wait-sec").unwrap_or("540").parse::<u64>()
        .map_err(|_| GatewayError("--wait-sec must be a nonnegative integer".into()))?;
    let targets = wait_targets(options)?;
    let mut destinations = Vec::new();
    let mut keys = Vec::with_capacity(targets.len());
    for (key, out) in &targets {
        if let Some(out) = out {
            let current = job::job(cfg, key)?;
            check_destination(&mut destinations, key, out, current["kind"] == "image")?;
        }
        keys.push(key.clone());
    }
    let current = job::wait_many(cfg, &keys, all, Duration::from_secs(seconds))?;
    let mut jobs = Vec::new();
    let mut done = Vec::new();
    let mut pending = Vec::new();
    let mut failed = false;
    for ((key, out), job) in targets.iter().zip(current) {
        let status = job["status"].as_str().unwrap_or("");
        let mut written = Vec::new();
        if is_terminal(status) {
            done.push(key);
            if status == "succeeded" {
                if let Some(path) = out {
                    written = deliver(&job, Path::new(path)).map_err(|error| GatewayError(format!("deliver {key}: {error}")))?;
                }
            } else {
                failed = true;
            }
        } else {
            pending.push(key);
        }
        jobs.push(json!({ "key": key, "status": status, "elapsedSeconds": elapsed_seconds(&job), "written": written }));
    }
    let timed_out = if all { !pending.is_empty() } else { done.is_empty() };
    print(&json!({ "mode": if all { "all" } else { "any" }, "jobs": jobs, "done": done, "pending": pending }));
    Ok(if timed_out { 3 } else if failed { 2 } else { 0 })
}

fn print(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

fn report(current: &Value, extra: Value) -> u8 {
    let mut out = json!({ "job": current });
    if let (Some(m), Some(e)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            m.insert(k.clone(), v.clone());
        }
    }
    print(&out);
    match current.get("status").and_then(Value::as_str).unwrap_or("") {
        "succeeded" => 0,
        s if is_terminal(s) => 2,
        _ => 3,
    }
}

fn wait_and_report(cfg: &Config, o: &Options, key: &str, mut extra: Value) -> Result<u8> {
    let seconds: u64 = o.get("wait-sec").map(|s| s.parse().unwrap_or(540)).unwrap_or(540);
    let done = job::wait(cfg, key, Duration::from_secs(seconds))?;
    if let Some(out) = o.get("out") {
        if done.get("status").and_then(Value::as_str) == Some("succeeded") {
            extra["written"] = json!(deliver(&done, Path::new(out))?);
        }
    }
    Ok(report(&done, extra))
}

fn status(args: &[String]) -> Result<u8> {
    let mut root = None;
    let mut context = None;
    let mut json_output = false;
    let mut keys = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" if !json_output => json_output = true,
            "--root" | "--context" if root.is_none() && context.is_none() => {
                let Some(path) = args.next().filter(|p| !p.is_empty() && !p.starts_with("--")) else {
                    return fail(format!("{arg} needs a directory"));
                };
                if arg == "--root" {
                    root = Some(Path::new(path));
                } else {
                    context = Some(Path::new(path));
                }
            }
            key if zodchi_core::util::is_key(key) => keys.push(key),
            _ => return fail(format!("Unexpected status argument: {arg}")),
        }
    }
    if keys.is_empty() {
        return fail("Usage: zodchi status <key> [<key>...] [--json]");
    }
    let cfg = configuration(root, context)?;
    let mut rows = Vec::new();
    let mut code = 0;
    for key in keys {
        let current = match job::job(&cfg, key) {
            Ok(current) => current,
            Err(error) => {
                eprintln!("{error}");
                code = 2;
                continue;
            }
        };
        let state = current["status"].as_str().unwrap_or("");
        let elapsed = elapsed_seconds(&current);
        if json_output {
            rows.push(json!({ "key": key, "status": state, "elapsedSeconds": elapsed }));
        } else if let Some(seconds) = elapsed {
            println!("{key} {state} {seconds}s");
        } else {
            println!("{key} {state}");
        }
    }
    if json_output {
        print(&Value::Array(rows));
    }
    Ok(code)
}

fn main_inner(args: Vec<String>) -> Result<u8> {
    if let Some(code) = release::route(&args)? {
        return Ok(code);
    }
    let Some(command) = args.first().cloned() else {
        println!("{USAGE}");
        return Ok(0);
    };
    if args == ["--version"] {
        println!("zodchi {}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    if command == "release" {
        print(&release::cli(&args[1..])?);
        return Ok(0);
    }
    if command == "flow" {
        let exit = zodchi_flow::cli(&args[1..])?;
        print(&exit.result);
        return Ok(exit.code);
    }
    if command == "status" {
        return status(&args[1..]).or_else(|error| {
            eprintln!("{error}");
            Ok(2)
        });
    }
    let o = parse(&command, &args[1..])?;
    let cfg = configuration(o.get("root").map(Path::new), o.get("context").map(Path::new))?;
    match command.as_str() {
        "run" => {
            let req = request(&cfg, &o)?;
            let (_, created) = job::submit_for(&cfg, &req, true, provider(&o)?)?;
            wait_and_report(&cfg, &o, &req.key, json!({ "created": created }))
        }
        "submit" if o.get("list").is_some() => submit_list(&cfg, &o),
        "submit" => {
            let req = request(&cfg, &o)?;
            let (current, created) = job::submit_for(&cfg, &req, true, provider(&o)?)?;
            if o.has("quiet") {
                println!("{} {}", req.key, current["status"].as_str().unwrap_or(""));
            } else {
                report(&current, json!({ "created": created }));
            }
            Ok(0)
        }
        "wait" if o.has("all") || o.has("any") || o.get("keys").is_some() || o.get("list").is_some() => wait_batch(&cfg, &o),
        "wait" => wait_and_report(&cfg, &o, o.get("key").unwrap_or(""), json!({})),
        "job" => Ok(report(&job::job(&cfg, o.get("key").unwrap_or(""))?, json!({}))),
        "work" => {
            job::work(&cfg, o.get("key").unwrap_or(""))?;
            Ok(0)
        }
        "roles" => {
            print(&Value::Array(roles(&cfg)));
            Ok(0)
        }
        "check" => {
            let result = job::check(&cfg, &role(&cfg, &o)?)?;
            print(&result);
            Ok(if result.get("ok") == Some(&json!(true)) { 0 } else { 2 })
        }
        "account" => {
            print(&job::account(&cfg));
            Ok(0)
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(0)
        }
        _ => {
            println!("{USAGE}");
            Ok(1)
        }
    }
}

fn main() -> ExitCode {
    match main_inner(std::env::args().skip(1).collect()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
