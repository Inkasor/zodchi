//! Compile the pre-split facade as an external Rust consumer.
//! Keep inter-crate dispatch and child adapters behind the facade.
#![allow(dead_code)]

use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Output,
    time::Duration,
};
use zodchi_core::{config::Config, util::Result};
use zodchi_flow::{
    args::{self, Args},
    checks::{self, Phase},
    claims, code_package,
    executor::{self, claude, local::LocalGateway, server::Server, Executor},
    gateway::{self, Call, CallError},
    git::Git,
    journal::{self, Journal, RunLock},
    models::{self, ClaudeGate, Pick},
    patch::{self, Change, Edit, Patch, Plan, Refusal},
    verify, Exit, CUT_EXIT, USAGE,
};

type Decoded<T> = std::result::Result<T, String>;
type Blobs = Vec<(String, String)>;
type ModelPair = (Pick, Pick, Vec<String>);

macro_rules! signatures {
    ($($path:path : $ty:ty;)*) => { $(const _: $ty = $path;)* };
}

signatures! {
    zodchi_flow::cli: fn(&[String]) -> Result<Exit>;
    code_package::start: fn(&Value) -> Result<Exit>;
    code_package::start_detached: fn(&Value) -> Result<Exit>;
    code_package::resume: fn(&str, Option<&Value>, Option<&str>) -> Result<Exit>;
    args::rel: fn(&str, &str) -> Decoded<String>;
    args::parse: fn(&Value) -> Decoded<Args>;
    args::is_protected: fn(&Args, &str) -> bool;
    args::is_project_configuration: fn(&str) -> bool;
    Args::writer_role: fn(&Args) -> &'static str;
    Args::mode: fn(&Args) -> &'static str;
    checks::find_bash: fn() -> PathBuf;
    checks::preflight: fn() -> Result<()>;
    checks::preflight_tools: fn(&[String]) -> Result<()>;
    checks::end_group: fn(u32) -> Decoded<()>;
    checks::run_list: fn(&[String], &str, &Path, &Path, Duration, &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool);
    checks::name: fn(&[Value], usize) -> String;
    checks::sanitize: fn(&str, &[(String, &str)]) -> String;
    checks::passed: fn(&[Value]) -> bool;
    checks::tail: fn(&str, usize) -> String;
    checks::temp_dir: fn(&str, &str) -> Result<PathBuf>;
    checks::remove: fn(&Path);
    checks::result: fn(&[Value]) -> Result<Value>;
    claims::norm: fn(&str) -> Result<String>;
    claims::caseless: fn(&str) -> bool;
    claims::fold: fn(&str, &str) -> String;
    claims::claims_dir: fn(&str) -> PathBuf;
    claims::file: fn(&Path, &str) -> PathBuf;
    claims::open: fn(&Path, &str, &str, &[String], &str, &str) -> Result<Vec<String>>;
    claims::extend: fn(&Path, &str, &str, &[String]) -> Result<Vec<String>>;
    claims::holds: fn(&Path, &str, &str, &[String]) -> bool;
    claims::close: fn(&Path, &str, &str, &str) -> Result<bool>;
    executor::flow_server: fn(&Config) -> Option<String>;
    executor::for_pick: fn(&Config, &Pick) -> Decoded<Box<dyn Executor>>;
    Claude::new: fn(Config) -> Claude;
    Claude::job_dir: fn(&Claude, &str) -> PathBuf;
    LocalGateway::new: fn(Config) -> LocalGateway;
    Server::new: fn(Config, String) -> Server;
    Server::preflight: fn(&Server, &[&str]) -> Result<()>;
    claude::find_program: fn() -> Decoded<claude::Program>;
    claude::message: fn(&str, &str, &Value) -> String;
    claude::signed_in: fn(&claude::Program, &Path) -> Decoded<String>;
    claude::version: fn(&claude::Program, &Path) -> Decoded<String>;
    gateway::slug: fn(&str) -> String;
    gateway::base_key: fn(&str, &str, u32) -> String;
    gateway::summary: fn(&Value) -> Value;
    Git::new: fn(&Path) -> Git;
    Git::output: fn(&Git, &[&str], &[(&str, OsString)], Option<&[u8]>) -> Result<Output>;
    Git::run_env: fn(&Git, &[&str], &[(&str, OsString)], Option<&[u8]>) -> Result<String>;
    Git::run: fn(&Git, &[&str]) -> Result<String>;
    Git::test: fn(&Git, &[&str]) -> Result<bool>;
    Git::rev: fn(&Git, &str) -> Result<String>;
    Git::branch: fn(&Git) -> Result<Option<String>>;
    Git::dirty: fn(&Git) -> Result<Vec<String>>;
    Git::entry_at: fn(&Git, &str, &str) -> Result<Option<(String, String, String)>>;
    Git::exists_at: fn(&Git, &str, &str) -> Result<bool>;
    Git::show: fn(&Git, &str, &str) -> Result<Option<Vec<u8>>>;
    Git::index_mode: fn(&Git, &str) -> Result<Option<String>>;
    Git::staged_paths: fn(&Git, &str, &[String]) -> Result<Vec<String>>;
    Git::reset_index_paths: fn(&Git, &str, &[String]) -> Result<()>;
    Git::tracked_link: fn(&Git, &str, &str) -> Result<bool>;
    Git::changes: fn(&Git, &str, &str) -> Result<Blobs>;
    Git::blob_of: fn(&Git, &[u8]) -> Result<String>;
    Git::blob_of_file: fn(&Git, &str) -> Result<Option<String>>;
    Git::candidate_tree: fn(&Git, &str, &[String], &[String], &Path) -> Result<String>;
    Git::export: fn(&Git, &str, &Path, &Path) -> Result<()>;
    Git::export_paths: fn(&Git, &str, &Path, &Path, Option<&[String]>) -> Result<()>;
    Git::checkout_for_checks: fn(&Git, &str, &Path) -> Result<()>;
    Git::init_snapshot: fn(&Git, &Path) -> Result<Git>;
    journal::flows_dir: fn(&Path) -> PathBuf;
    journal::is_run_id: fn(&str) -> bool;
    journal::new_run_id: fn() -> String;
    Journal::create: fn(&Path, &str, &Value) -> Result<Journal>;
    Journal::open: fn(&Path, &str) -> Result<(Journal, Value)>;
    Journal::load: fn(&mut Journal) -> Result<()>;
    Journal::snapshot: fn(&Journal) -> Result<Vec<Value>>;
    Journal::active: fn(&Journal) -> bool;
    Journal::lock: fn(&Journal) -> Result<RunLock>;
    Journal::events: fn(&Journal) -> &[Value];
    Journal::append: fn(&mut Journal, Value) -> Result<()>;
    Journal::last: for<'a> fn(&'a Journal, &str, &str, u32) -> Option<&'a Value>;
    Journal::all: for<'a> fn(&'a Journal, &str, &str, u32) -> Vec<&'a Value>;
    Journal::attempt: fn(&Journal, &str) -> u32;
    Journal::last_event: fn(&Journal) -> Option<&Value>;
    Journal::file: fn(&Journal, &str) -> PathBuf;
    Journal::write_text: fn(&Journal, &str, &str) -> Result<PathBuf>;
    Journal::write_value: fn(&Journal, &str, &Value) -> Result<PathBuf>;
    Journal::read_value: fn(&Journal, &str) -> Option<Value>;
    Journal::read_verified: fn(&Journal, &str, &Value) -> Result<String>;
    Pick::to_json: fn(&Pick) -> Value;
    Pick::from_json: fn(&Value) -> Pick;
    models::table: fn(&Config, &Path, &Map<String, Value>) -> Decoded<Map<String, Value>>;
    models::claude_enabled: fn(&Config) -> bool;
    models::codex_usable: fn(&Value) -> Decoded<()>;
    ClaudeGate::of: fn(&Map<String, Value>) -> ClaudeGate;
    ClaudeGate::usable: fn(&mut ClaudeGate, &Pick) -> Decoded<String>;
    models::resolve: fn(&Map<String, Value>, &Decoded<()>, &str, bool, &[String]) -> Decoded<ModelPair>;
    patch::parse: fn(&Value) -> Decoded<Patch>;
    Plan::to_json: fn(&Plan) -> Value;
    Plan::from_json: fn(&Value) -> Option<Plan>;
    patch::no_links: fn(&Path, &str) -> bool;
    patch::claimed_as: fn(&[String], &str) -> Option<String>;
    patch::outside: fn(&Patch, &[String]) -> Vec<String>;
    patch::plan: fn(&Git, &Args, &str, &Patch, &[String]) -> Result<std::result::Result<Plan, Refusal>>;
    patch::apply: fn(&Path, &Plan) -> Result<()>;
    patch::apply_recoverable: fn(&Git, &Plan) -> Result<()>;
    patch::reconcile: fn(&Git, &Plan) -> Result<&'static str>;
    verify::Plan::legacy: fn(&Args) -> verify::Plan;
    verify::Plan::to_json: fn(&verify::Plan) -> Value;
    verify::Plan::from_run: fn(&Value, &Args) -> Result<verify::Plan>;
}

use claude::{Claude, Program};

// These signatures take generic closures. Arbitrary consumer closures must continue to type-check.
fn callbacks(
    journal: &mut Journal,
    cfg: &Config,
    call: Call<'_>,
    validate: impl Fn(&Value) -> Decoded<()>,
    program: &claude::Program,
    dir: &Path,
    started: impl FnOnce() -> Result<()>,
    log: &Path,
    clean: impl FnOnce(&str) -> String,
) {
    let _: std::result::Result<Value, CallError> = gateway::ask(journal, cfg, call, validate);
    let _: std::result::Result<(Value, String), (claude::Sent, String, String)> = claude::call(
        program,
        dir,
        "model",
        "high",
        "prompt",
        &Value::Null,
        Duration::from_secs(1),
        started,
    );
    let _: String = checks::review_output(log, 100, clean);
}

// Check implementability as well as method calls and object safety.
struct FixtureExecutor;
impl Executor for FixtureExecutor {
    fn role(&self, _: &str, _: &Pick, _: &Value) -> Result<Value> {
        Ok(Value::Null)
    }
    fn submit(&self, _: &str, _: &Value) -> Result<bool> {
        Ok(false)
    }
    fn exists(&self, _: &str) -> bool {
        false
    }
    fn wait_final(&self, _: &str) -> Result<Value> {
        Ok(Value::Null)
    }
    fn died_before_turn(&self, _: &Value) -> bool {
        false
    }
    fn name(&self) -> &'static str {
        "fixture"
    }
}

fn executor_implementations(local: LocalGateway, server: Server, claude: Claude) {
    let _: [&dyn Executor; 4] = [&FixtureExecutor, &local, &server, &claude];
}

fn public_trait_bounds() {
    fn clone_debug<T: Clone + std::fmt::Debug>() {}
    fn copy_eq<T: Copy + Eq>() {}
    clone_debug::<Args>();
    clone_debug::<Pick>();
    clone_debug::<Change>();
    clone_debug::<Edit>();
    clone_debug::<Patch>();
    clone_debug::<Plan>();
    clone_debug::<verify::Plan>();
    clone_debug::<claude::Program>();
    clone_debug::<claude::Sent>();
    clone_debug::<Phase>();
    copy_eq::<claude::Sent>();
    copy_eq::<Phase>();
    fn debug<T: std::fmt::Debug>() {}
    debug::<Refusal>();
}

macro_rules! fields {
    ($value:ident; $($field:ident : $ty:ty),+ $(,)?) => { $(let _: &$ty = &$value.$field;)+ };
}

// Exhaustive patterns keep externally constructible types constructible.
macro_rules! public_struct {
    ($value:ident, $name:ident; $($field:ident : $ty:ty),+ $(,)?) => {{
        let $name { $($field),+ } = $value;
        let _: ($($ty,)+) = ($($field,)+);
    }};
}

fn public_fields(
    args: Args,
    check: verify::Plan,
    journal: Journal,
    git: Git,
    exit: code_package::Exit,
    call: Call<'_>,
    pick: Pick,
    program: Program,
    change: Change,
    patch: Patch,
    plan: Plan,
) {
    fields!(args; label: String, brief: String, repo: String, repo_norm: String,
        files: Vec<String>, review_context: Vec<String>, agent: bool, browser: Option<(String, String)>,
        isolated: bool, source_run: Option<String>, continuations: u32, rounds: u32, fixes: u32,
        setup: Vec<String>, checks: Vec<String>, verify: Vec<String>, protect: Vec<String>,
        allow_check_changes: Vec<String>, models: Map<String, Value>, extend_claim: bool, check_timeout_min: f64);
    fields!(check; setup: Vec<String>, setup_source: &'static str, checks: Vec<String>, verify: Vec<String>,
        check_source: &'static str, verify_source: &'static str, full_local: Vec<String>, full_in_ci: bool);
    fields!(journal; dir: PathBuf);
    public_struct!(git, Git; root: PathBuf);
    public_struct!(exit, Exit; result: Value, code: u8);
    public_struct!(call, Call; id: &str, step: &str, round: u32, role: &str, pick: &Pick,
        schema: &Value, prompt: String, writer_workspace: Option<&Path>);
    public_struct!(pick, Pick; provider: String, model: String, effort: String, account: String);
    public_struct!(program, Program; exe: PathBuf, script: Option<PathBuf>);
    public_struct!(change, Change; op: String, path: String, from: Option<String>, base_blob: Option<String>,
        content: Option<Vec<u8>>, edits: Option<Vec<Edit>>);
    public_struct!(patch, Patch; status: String, summary: String, changes: Vec<Change>,
        unverified: Vec<String>, questions: Vec<String>);
    public_struct!(plan, Plan; writes: BTreeMap<String, Option<Vec<u8>>>, before: BTreeMap<String, Option<String>>,
        after: BTreeMap<String, Option<String>>, exec: Vec<String>, modes: BTreeMap<String, u32>);
}

fn original_program(program: claude::Program, sent: claude::Sent) {
    let _: (zodchi_core::claude::Program, zodchi_core::claude::Sent) = (program, sent);
}

fn variants(phase: Phase, error: CallError, refusal: Refusal, sent: claude::Sent) {
    match phase {
        Phase::Started | Phase::Ended => {}
    }
    match error {
        CallError::Stop { at, reason } => {
            let _: (String, String) = (at, reason);
        }
        CallError::Context { bytes } => {
            let _: usize = bytes;
        }
    }
    match refusal {
        Refusal::Outside(paths) | Refusal::Protected(paths) => {
            let _: Vec<String> = paths;
        }
        Refusal::BadPath(path) | Refusal::Stale(path) | Refusal::EditConflict(path) => {
            let _: String = path;
        }
    }
    match sent {
        claude::Sent::No | claude::Sent::Yes | claude::Sent::TimedOut => {}
    }
}

const _: [&str; 11] = [
    USAGE,
    code_package::WORKFLOW,
    code_package::VERSION,
    code_package::WRITER_GATEWAY_ROLE,
    code_package::REVIEWER_GATEWAY_ROLE,
    models::WRITER_ROLE,
    models::REVIEWER_ROLE,
    models::CLAUDE_ENTRY,
    verify::CONFIG,
    verify::LEGACY_SKILL,
    verify::PROJECT_SKILL,
];
const _: [i32; 2] = [CUT_EXIT, code_package::CUT_EXIT];
