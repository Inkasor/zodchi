//! The `zodchi-server` command: serve the API, manage users (local only), and run one job as the worker the server
//! spawns for it.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::ExitCode;
use zodchi_core::config::{user_home, Config};
use zodchi_core::job;
use zodchi_core::util::{fail, GatewayError, Result};
use zodchi_server::api::{serve, Options, MIN_THREADS};
use zodchi_server::auth::TokenAuthenticator;
use zodchi_server::registry;

const USAGE: &str = "Usage: zodchi-server <command> [options]

  serve                 serve the API until Ctrl+C or SIGTERM
      --listen <addr>        default 127.0.0.1:8787 (TLS belongs to the reverse proxy in front)
      --threads <n>          HTTP threads, default 16, at least 2; at most half of them wait in long polls
      --max-user-jobs <n>    unfinished jobs per user, default 4
      --max-jobs <n>         unfinished jobs on the server, default 16
  user add <name>       add a user and print their token (shown once)
  user list             the users, without tokens
  user remove <id>      remove a user (their folder stays on disk until you delete it)
  user token <id>       issue a new token; the user's earlier tokens stop working
  work --data <dir> --user <id> --key <key>   run one job (the server starts this itself)

Anywhere:
  --data <dir>          the data folder, default ~/.zodchi/server ($ZODCHI_HOME/server when ZODCHI_HOME is set)";

fn default_data() -> PathBuf {
    match std::env::var_os("ZODCHI_HOME").filter(|v| !v.is_empty()) {
        Some(home) => PathBuf::from(home).join("server"),
        None => user_home().join(".zodchi").join("server"),
    }
}

struct Args {
    positional: Vec<String>,
    options: std::collections::HashMap<String, String>,
}

fn parse(args: &[String]) -> Result<Args> {
    let mut out = Args { positional: Vec::new(), options: Default::default() };
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            let Some(value) = args.get(i + 1) else { return fail(format!("--{name} needs a value")) };
            out.options.insert(name.to_string(), value.clone());
            i += 2;
        } else {
            out.positional.push(args[i].clone());
            i += 1;
        }
    }
    Ok(out)
}

fn number(args: &Args, name: &str, default: usize) -> Result<usize> {
    match args.options.get(name) {
        None => Ok(default),
        Some(v) => v.parse::<usize>().ok().filter(|n| *n > 0).ok_or_else(|| GatewayError(format!("--{name} is a whole number above 0"))),
    }
}

/// `--threads`: a long poll holds one HTTP thread, so one thread alone would be taken by the first poll.
fn threads(args: &Args, default: usize) -> Result<usize> {
    let n = number(args, "threads", default)?;
    if n < MIN_THREADS {
        return fail(format!("--threads is at least {MIN_THREADS}: a long poll holds one HTTP thread, and one more must stay free for every other request."));
    }
    Ok(n)
}

fn print(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

fn main_inner(raw: Vec<String>) -> Result<u8> {
    let args = parse(&raw)?;
    let known = ["data", "listen", "threads", "max-user-jobs", "max-jobs", "user", "key"];
    if let Some(name) = args.options.keys().find(|k| !known.contains(&k.as_str())) {
        return fail(format!("Unknown option --{name}"));
    }
    let data = args.options.get("data").map(PathBuf::from).unwrap_or_else(default_data);
    let words: Vec<&str> = args.positional.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] | ["help"] => {
            println!("{USAGE}");
            Ok(0)
        }
        ["serve"] => {
            let mut opts = Options::new(data.clone());
            if let Some(listen) = args.options.get("listen") {
                opts.listen = listen.clone();
            }
            opts.threads = threads(&args, opts.threads)?;
            opts.max_user_jobs = number(&args, "max-user-jobs", opts.max_user_jobs)?;
            opts.max_jobs = number(&args, "max-jobs", opts.max_jobs)?;
            serve(&opts, Box::new(TokenAuthenticator { data: std::path::absolute(&data)? }))?;
            Ok(0)
        }
        ["user", "add", name] => {
            let (user, token) = registry::add(&data, name)?;
            print(&json!({ "id": user.id, "name": user.name, "token": token,
                "note": "The token is shown once; the server keeps only its hash. The user signs in with POST /v1/login." }));
            Ok(0)
        }
        ["user", "list"] => {
            let users = registry::load(&data)?;
            print(&Value::Array(users.iter().map(|u| json!({ "id": u.id, "name": u.name, "createdAt": u.created_at, "tokens": u.token_hashes.len() })).collect()));
            Ok(0)
        }
        ["user", "remove", id] => {
            let user = registry::remove(&data, id)?;
            print(&json!({ "removed": user.id, "name": user.name,
                "folder": registry::user_dir(&std::path::absolute(&data)?, &user.id).display().to_string(),
                "note": "Accepted jobs run to the end. The folder (jobs and sign-in) stays until you delete it." }));
            Ok(0)
        }
        ["user", "token", id] => {
            let token = registry::reissue(&data, id)?;
            print(&json!({ "id": id, "token": token, "note": "The earlier tokens of this user no longer work." }));
            Ok(0)
        }
        ["work"] => {
            let (Some(user), Some(key)) = (args.options.get("user"), args.options.get("key")) else {
                return fail("work needs --data <dir> --user <id> --key <key>");
            };
            // The same factory as the HTTP handlers: this user's jobs and this user's Codex home, nothing else.
            let cfg = Config::tenant(&data, user)?;
            job::work(&cfg, key)?;
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
