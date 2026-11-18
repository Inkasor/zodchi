//! The `zodchi` command: one call to a Codex model in a named role. Commands and options are those of the
//! reference gateway, so workflows and skills do not notice the replacement.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{self, compose_prompt, deliver, is_terminal, Request};
use zodchi_core::role::{load_role, roles, Overrides};
use zodchi_core::util::{fail, GatewayError, Result};

const USAGE: &str = "Usage: zodchi <command> [options]
Run it inside the repository the call is for: jobs are stored in its .agent-tmp/gateway/<key>/.

  run      submit a job and wait for it        submit   submit and return at once
  wait     wait for a submitted job            job      print a job as it is now
  roles    the roles a call from this repository can name
  check    open the thread of a role and print its sandbox and MCP servers (no model call)
  account  every subscription in ~/.zodchi/accounts.json: sign-in, limits, credits (no model call)
  flow     run a workflow as code: zodchi flow code-package --args <file.json> [--resume <run-id>]
           (docs/flow.md; exit 0 approved, 2 any other end, 1 a wrong call)

Job options (run, submit):
  --role <name|file.json>  what the call is: kind, mode, model, effort, frame, schema, tools
  --key <key>              idempotency key: the same key returns the same job and spends nothing
  --prompt <file>          the request
  --attach <file>          a text file appended to the prompt; repeatable
  --image <file>           an input image, PNG, JPEG or WebP; repeatable
  --model <id>  --effort low|medium|high|xhigh|max|ultra  --timeout-min <n>   replace what the role says
  --keep-thread / --no-keep-thread   keep (or not) the Codex thread of a work call so --resume can continue it
  --resume <key>           continue the thread of an earlier work job that kept it
  --credits                let the call spend ChatGPT credits when every subscription's limit is used up
  --questions <file.json>  the questions of a decisions call; they replace those of the role
  --paid                   let a decisions call spend from the OpenAI API key
Result options (run, wait):
  --out <file>             copy the answer there: the image, the JSON by the schema of the role, or the text
  --wait-sec <n>           how long this command waits, default 540; the job goes on after that
Anywhere:
  --root <dir>             the repository, when the command is not run inside it

Exit code of run, wait and job: 0 succeeded, 2 another final status, 3 still running, 1 a wrong call.
submit exits 0 once the job is stored or already exists; read its status from the JSON.";

#[derive(Default)]
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

fn parse(args: &[String]) -> Result<Options> {
    let mut o = Options::default();
    let mut i = 0;
    while i < args.len() {
        let Some(name) = args[i].strip_prefix("--") else { return fail(format!("Unexpected argument: {}", args[i])) };
        if ["credits", "paid", "keep-thread", "no-keep-thread"].contains(&name) {
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

fn main_inner(args: Vec<String>) -> Result<u8> {
    let Some(command) = args.first().cloned() else {
        println!("{USAGE}");
        return Ok(0);
    };
    if command == "flow" {
        let exit = zodchi_flow::cli(&args[1..])?;
        print(&exit.result);
        return Ok(exit.code);
    }
    let o = parse(&args[1..])?;
    let root = o.get("root").map(PathBuf::from);
    let cfg = Config::new(root.as_deref())?;
    match command.as_str() {
        "run" => {
            let req = request(&cfg, &o)?;
            let (_, created) = job::submit(&cfg, &req, true)?;
            wait_and_report(&cfg, &o, &req.key, json!({ "created": created }))
        }
        "submit" => {
            let req = request(&cfg, &o)?;
            let (current, created) = job::submit(&cfg, &req, true)?;
            report(&current, json!({ "created": created }));
            Ok(0)
        }
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
