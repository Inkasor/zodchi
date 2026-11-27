// The three entry points of `zodchi flow code-package` (docs/flow.md, "Three ways to start it"): the Codex skill
// (plugins/codex/skills/zodchi-flow) and the Claude Code skill (plugins/claude-code/core/skills/zodchi-flow).
// The portable shared plugin and native installation are covered by flow-client-plugin.mjs.
//
// The skills are followed as written, not paraphrased: the brief is made from the skill's own brief template, the args
// file from its own JSON example, and every command line of its `sh` blocks is run, with its placeholders filled, against
// the real `zodchi` and the fakes of the other scenarios (fake Codex, a real zodchi-server, fake Claude). A real run
// with real Codex and Claude sessions belongs to the before-release run, not to CI.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const WIN = process.platform === "win32";
const FIXED = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const KEY = "not-a-real-key-for-the-flow-entry-scenarios";
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const SKILLS = { codex: "plugins/codex/skills/zodchi-flow/SKILL.md", claude: "plugins/claude-code/core/skills/zodchi-flow/SKILL.md" };
// The foreground examples in the skill, in the order of its steps.
const COMMANDS = [
  'zodchi flow code-package --args "<args-file>"',
  "zodchi flow code-package --resume <run-id>",
  'zodchi flow code-package --resume <run-id> --rerun "<step>"',
];
// The fields the skill tells the agent to read in the result of an approved run.
const FIELDS = ["verdict", "approved", "openFindings", "verifiedBy", "verification", "rounds", "models", "runId", "journal"];
// The fields it names for a run that did not end approved.
const STOP_FIELDS = ["refused", "stoppedAt", "next", "question", "questions", "infra"];

export default function register(h) {
  const { scenario, flowWorld, serve, user, run, zodchi, ZODCHI, gitOut, samePath, STUB, ROOT } = h;
  const FAKE_CLAUDE = path.join(ROOT, "scripts", "e2e", "fake-claude.mjs");

  // ------------------------------------------------------------------------------------------------ the skills

  /** A skill read as an agent reads it: front matter, body, fenced blocks, and the commands of its `sh` blocks. */
  function readSkill(rel) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`${rel} has no front matter`);
    const front = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    const blocks = [...m[2].matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((b) => ({ lang: b[1], text: b[2] }));
    const lines = blocks.filter((b) => b.lang === "sh").flatMap((b) => b.text.split("\n").filter((l) => l.trim()));
    const block = (lang) => blocks.find((b) => b.lang === lang).text;
    return { rel, front, body: m[2], blocks, lines, brief: block("markdown"), argsExample: JSON.parse(block("json")) };
  }

  /** The bash an agent's shell tool runs: on Windows the one of Git for Windows (as the engine finds it, from Git's
   *  exec path), elsewhere the one on PATH. */
  function findBash() {
    if (!WIN) return "bash";
    const g = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
    for (let d = path.resolve((g.stdout || "").trim()); d && path.dirname(d) !== d; d = path.dirname(d)) {
      for (const c of [path.join(d, "bin", "bash.exe"), path.join(d, "usr", "bin", "bash.exe")]) if (fs.existsSync(c)) return c;
    }
    throw new Error("no bash of Git for Windows found");
  }
  const BASH = findBash();

  /** A command line of the skill, as written, run by bash: its placeholders replaced by the given text where they
   *  stand (so the quotes round them are the skill's own), forward slashes in a path as a shell tool is told to write
   *  them. Only the program name `zodchi` is replaced, by the release binary this run built (it is not on PATH). */
  function byShell(t, f, skill, shape, fill, { env = {} } = {}) {
    const line = skill.lines.find((l) => l === shape);
    if (!line) throw new Error(`${skill.rel} has no command line "${shape}"`);
    if (!line.startsWith("zodchi ")) throw new Error(`${skill.rel}: "${line}" does not start with zodchi`);
    let text = `"$ZODCHI_BIN" ${line.slice("zodchi ".length)}`;
    for (const [ph, value] of Object.entries(fill)) text = text.split(ph).join(value.replace(/\\/g, "/"));
    t.log(`bash -c ${JSON.stringify(text)}`);
    return run(t, BASH, ["-c", text], { cwd: f.w.dir, env: { ...f.w.env, ...env, ZODCHI_BIN: ZODCHI }, label: "bash" });
  }

  /** A brief made from the skill's template: each section of it filled with the fixture's words. */
  function briefFrom(t, skill) {
    const [head, ...sections] = skill.brief.split(/^## /m);
    t.ok(/^# Brief: /.test(head), "the brief template starts with its title");
    const names = sections.map((s) => s.split("\n")[0].trim());
    t.eq(names, ["Goal", "Files", "Done", "Checks", "Verify", "Review boundary"], "the brief template has the sections the doc names, the review boundary last");
    const words = {
      Goal: "Make clamp(x, lo, hi) keep x between lo and hi.",
      Files: "- src/math.mjs",
      Done: "node test/math.test.mjs passes.",
      Checks: "- node test/math.test.mjs: clamp stays in range",
      Verify: "- node smoke.mjs",
      "Review boundary": "Important: a clamp that lets a value out of its range.\nOut of scope: a second run started at the same instant by the same person.",
    };
    return "# Brief: clamp\n\n" + names.map((n) => `## ${n}\n${words[n]}\n`).join("\n");
  }

  /** The newest run folder of the zodchi home whose run.json names the repository and the label, a saved result.json
   *  or not: how the skill says to find the id of a cut run. */
  function runIdOf(zhome, repo, label) {
    const flows = path.join(zhome, "flows");
    for (const id of fs.readdirSync(flows).sort().reverse()) {
      const file = path.join(flows, id, "run.json");
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      if (samePath(run.repo, repo) && run.inputs.args.label === label) return id;
    }
    return null;
  }

  /** The brief from the skill template and the args from its example, in a folder with a space in its name. */
  function skillArgs(t, f, skill, args) {
    const dir = path.join(f.r, ".agent-tmp", "flow", "two words");
    fs.mkdirSync(dir, { recursive: true });
    const brief = path.join(dir, "clamp-brief.md");
    fs.writeFileSync(brief, briefFrom(t, skill));
    const given = { ...skill.argsExample, label: "clamp", brief, repo: f.r, files: ["src/math.mjs"], checks: ["node test/math.test.mjs"], verify: ["node smoke.mjs"], ...args };
    const file = path.join(dir, "clamp-args.json");
    fs.writeFileSync(file, JSON.stringify(given, null, 2));
    t.eq(gitOut(f.r, ["status", "--porcelain"]), "", "the brief and the args are in the ignored .agent-tmp/: the work tree is clean");
    t.ok(/ /.test(file), "the args file is at a path with a space in it");
    return file;
  }

  /** Start from another folder through the skill's shell command, with an optional environment override for cuts. */
  const startBySkill = (t, f, skill, { env = {}, args = {} } = {}) =>
    byShell(t, f, skill, COMMANDS[0], { "<args-file>": skillArgs(t, f, skill, args) }, { env });

  /** The resume command of the skill. */
  const resumeBySkill = (t, f, skill, id, extra = {}) => byShell(t, f, skill, COMMANDS[1], { "<run-id>": id }, { env: extra });
  /** The rerun command of the skill, `<step>` filled from the step the stop names. */
  const rerunBySkill = (t, f, skill, id, step) => byShell(t, f, skill, COMMANDS[2], { "<run-id>": id, "<step>": step });

  /** What the skill says about an approved result: every field it names is there, the journal holds the same result,
   *  and the engine is the same one in every way of starting it. */
  function readLikeSkill(t, f, skill, res) {
    t.eq([res.code, res.json && res.json.verdict, res.json && res.json.approved], [0, "approved", true], "the run ends approved, exit 0");
    for (const k of FIELDS) t.ok(res.json && k in res.json && skill.body.includes(`\`${k}\``), `the skill names \`${k}\` and the result has it`);
    t.eq([res.json.workflow, res.json.mode], ["code-package", "expert"], "the result is the engine's code-package result");
    t.eq(JSON.parse(fs.readFileSync(path.join(res.json.journal, "result.json"), "utf8")).runId, res.json.runId, "result.json in the journal folder is this run's result (the skill's fallback read)");
    t.eq([f.commits().length, gitOut(f.r, ["show", "--name-only", "--format=", "HEAD"])], [1, "src/math.mjs"], "one commit on top of the base, the claimed file only");
    t.ok(skill.body.includes("`rounds[].commit.commit`") && !/git log <base>/.test(skill.body), "the skill reports the commits from `rounds[].commit.commit` of the result, not from a git log range");
    t.eq(res.json.rounds.map((r) => r.commit && r.commit.commit), f.commits().reverse(), "the commit ids of the result are the commits of this run, in order");
    t.eq(gitOut(f.r, ["show", "--stat", "--format=%H", res.json.rounds[0].commit.commit]).split("\n")[0], res.json.rounds[0].commit.commit, "and `git -C <repo> show` of one of them names it");
    t.eq(gitOut(f.r, ["rev-list", "-1", "--skip=1", "HEAD"]), res.json.base, "the base in the result is the commit the run started from");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8"), FIXED, "the patch is in the work tree");
    t.eq(f.claim().status, "done", "the claim is closed as done");
  }

  // ------------------------------------------------------------------------------------------------ the three ways

  /** A flow world with a fake Claude: claude/opus is the first writer candidate (as flowWorld has it), "claude": true is
   *  in flow.json, and the fake `claude` is on PATH (named by ZODCHI_CLAUDE_BIN on Windows). */
  function claudeWorld(t, name) {
    const f = flowWorld(t, name);
    const env = f.w.env;
    const home = path.join(f.w.dir, "claude-home");
    fs.mkdirSync(path.join(home, "answers"), { recursive: true });
    fs.writeFileSync(path.join(home, "fake-auth.json"), "{}");
    env.FAKE_CLAUDE_HOME = home;
    env.ANTHROPIC_API_KEY = KEY;
    delete env.ZODCHI_CLAUDE_BIN;
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: true }));
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    if (WIN) env.ZODCHI_CLAUDE_BIN = FAKE_CLAUDE;
    else {
      const bin = path.join(f.w.dir, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node '${FAKE_CLAUDE.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
      env[pathKey] = [bin, ...(env[pathKey] || "").split(path.delimiter).filter(Boolean)].join(path.delimiter);
    }
    const answer = (step, value) => fs.writeFileSync(path.join(home, "answers", `${step.replace(/ /g, "-")}.json`), typeof value === "string" ? value : JSON.stringify(value));
    const calls = () => readJsonl(path.join(home, "calls.jsonl")).filter((c) => c.kind === "call");
    return { f, home, answer, calls };
  }

  /** A flow world whose model steps go to a real zodchi-server on 127.0.0.1: the user's token in a token file, the
   *  server named in flow.json, no local Codex sign-in (a person who has none). */
  async function serverWorld(t, name) {
    const f = flowWorld(t, name);
    const data = path.join(f.w.dir, "server-data");
    const u = await user(t, f.w, data, "Flow user");
    const server = await serve(t, f.w, data);
    const origin = `http://${server.address}`;
    const tokenFile = path.join(f.w.dir, "flow-token");
    fs.writeFileSync(tokenFile, `${u.token}\n`);
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ server: origin, tokenFile }));
    fs.rmSync(path.join(f.w.codex, "fake-auth.json"), { force: true });
    const answer = (step, value) => {
      fs.mkdirSync(path.join(u.home, "fake-flow"), { recursive: true });
      fs.writeFileSync(path.join(u.home, "fake-flow", `${step.replace(/ /g, "-")}.json`), JSON.stringify(value));
    };
    const steps = () => readJsonl(path.join(u.home, "fake-turns.jsonl")).map((x) => x.step);
    return { f, u, origin, answer, steps };
  }

  // ------------------------------------------------------------------------------------------------ scenarios

  function directorySnapshot(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir).sort().map(name => {
      const file = path.join(dir, name);
      return [name, fs.statSync(file).isDirectory()
        ? directorySnapshot(file)
        : createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
    });
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }

  function dryRunState(f) {
    return {
      zodchiHome: directorySnapshot(f.w.zhome),
      packages: directorySnapshot(path.join(f.w.home, ".zodchi", "packages")),
      repo: directorySnapshot(f.r),
      status: gitOut(f.r, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"]),
      turns: f.steps(),
    };
  }

  async function checkDryRunClaims(t) {
    const f = flowWorld(t, "flow-entry-claimed-preview");
    f.answer("write", { ...f.patch([]), status: "blocked", questions: ["Please confirm the edit."] });
    const held = await f.flow(["--args", f.args()]);
    t.eq([held.code, held.json?.status, f.claim()?.status], [2, "waiting", "open"], "the first run holds the file claim without editing the checkout");
    for (const [overlap, conflict] of [
      [{ label: "another-clamp" }, `clamp (run ${held.json.runId}): src/math.mjs`],
      [{ files: ["src/other.mjs"] }, `clamp (run ${held.json.runId}): an open package of this label`],
    ]) {
      const args = f.args(overlap);
      const before = dryRunState(f);
      const dry = await f.flow(["--args", args, "--dry-run"]);
      t.eq(dryRunState(f), before, "a dry-run claim refusal writes no claim or journal and calls no model");
      t.ok(dry.code === 2 && dry.json?.refused?.includes(conflict), "the preview names the open claim and its conflict");
      const real = await f.flow(["--args", args]);
      t.eq([real.code, real.json?.refused, real.json?.conflicts, f.steps()],
        [dry.code, dry.json?.refused, dry.json?.conflicts, ["write"]], "preview and real start report the same conflict");
    }
  }

  async function checkAnalysisWriter(t) {
    const f = flowWorld(t, "flow-entry-analysis-writer");
    const hardWriter = { provider: "codex", model: "fixture-analysis-writer", effort: "high" };
    const models = { hardWriter: { candidates: [hardWriter] } };
    const invalid = await f.flow(["--args", f.args({ kind: "other", models }), "--dry-run"]);
    t.ok(invalid.code === 2 && invalid.json?.refused?.includes("args.kind"), "unknown task kinds are refused");
    const agent = await f.flow(["--args", f.args({ mode: "agent", kind: "analysis", models }), "--dry-run"]);
    t.eq([agent.code, agent.json?.models?.hardWriter?.model], [0, hardWriter.model], "agent preview selects the hardWriter role for analysis");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--args", f.args({ kind: "analysis", models })]);
    t.eq([result.code, result.json?.approved, result.json?.models?.hardWriter, f.steps()],
      [0, true, hardWriter, ["write", "review 1"]], "the analysis package runs with the hardWriter candidate");
    const intent = readJsonl(path.join(result.json.journal, "events.jsonl")).find(event => event.kind === "intent" && event.step === "write");
    t.eq(intent?.model, hardWriter.model, "the dispatched writer uses the selected candidate");
  }

  async function checkWave(t) {
    const f = flowWorld(t, "flow-entry-wave");
    const config = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ full: { run: "local", commands: ["node smoke.mjs --fail"] } }));
    gitOut(f.r, ["add", ".zodchi/verify.json"]);
    gitOut(f.r, ["commit", "-qm", "Declare full verification"]);
    const args = f.args({ wave: true, mode: "agent", verify: ["node smoke.mjs --fail"] });
    f.answer("write", { status: "done", summary: "Clamp is ready for integration.", criteria: [], questions: [],
      changedFiles: [], checks: [], flowWrites: { "src/math.mjs": FIXED } });
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", args]);
    t.eq([res.code, res.json?.approved, res.json?.verifiedBy, res.json?.rounds?.[0]?.verification?.verifiedBy],
      [0, true, "wave-integration", "wave-integration"], "wave integration owns verification of the approved package");
    t.eq(res.json?.verification?.evidence?.map(e => [e.source, e.exitCode]), [["checks", 0]],
      "wave still runs checks and skips the failing verify command");
    t.ok(!res.json?.fullVerification, "full verification also waits for wave integration");
    const [writer, reviewer] = readJsonl(path.join(f.w.codex, "fake-turns.jsonl"));
    t.ok(writer.prompt.includes("Do not build or run tests") && writer.prompt.includes("The lead builds")
      && !writer.prompt.includes("Run relevant checks from this workspace before handing off"),
      "the writer leaves builds and tests to the lead");
    t.ok(reviewer.prompt.includes("End-to-end verification runs at wave integration.")
      && reviewer.prompt.includes("Missing local end-to-end evidence alone is not an important finding."),
      "the review prompt explains the deferred evidence");
  }

  function expectEnvelope(t, result, kind, code) {
    t.eq(result.code, code, "the process returns the envelope's exit code");
    t.ok(/^[^\r\n]+\r?\n$/.test(result.err), "stderr contains exactly one envelope line");
    const { error } = JSON.parse(result.err);
    t.eq([error.kind, error.exitCode], [kind, code], "the error kind and exit code are machine-readable");
    t.ok(typeof error.message === "string" && error.message.length > 0
      && typeof error.hint === "string" && error.hint.length > 0, "the envelope has a message and a hint");
    return error;
  }

  async function checkCliContract(t, f) {
    const agent = { ...f.w.env, ZODCHI_AGENT: "1" };
    const plain = { ...f.w.env, ZODCHI_AGENT: "0" };
    const invoke = (args, env = plain) => zodchi(t, f.w, args, { cwd: f.r, env });
    const before = dryRunState(f);
    const usage = await invoke(["--usage"], agent);
    t.eq([usage.code, usage.err], [0, ""], "--usage writes one JSON document to stdout");
    const children = (name) => usage.json.commands.find((command) => command.name === name).subcommands;
    const workflow = children("flow").find((command) => command.name === "code-package");
    t.ok(workflow?.flags.some((flag) => flag.name === "--dry-run" && flag.valueKind === "boolean"),
      "the installed code-package command lists --dry-run as a switch");
    const verify = children("flow").find((command) => command.name === "verify");
    t.eq(verify?.flags.filter(flag => !["--help", "-h"].includes(flag.name)), [
      { name: "--args", valueKind: "json-file" },
      { name: "--detach", valueKind: "boolean" },
      { name: "--only", valueKind: "checks|verify" },
      { name: "--repo", valueKind: "directory" },
      { name: "--rerun", valueKind: "step" },
      { name: "--resume", valueKind: "run-id" },
    ], "usage describes the model-free verification flags");
    for (const control of ["close", "cancel"]) {
      t.ok(children("flow").find((command) => command.name === control)
        ?.flags.some((flag) => flag.name === "--reason" && flag.valueKind === "text"), `flow ${control} takes a reason`);
    }
    t.ok(children("flow").find((command) => command.name === "video")
      ?.subcommands.find((command) => command.name === "publish")
      ?.flags.some((flag) => flag.name === "--file" && flag.valueKind === "json-file"), "flow video publish takes a JSON file");
    const catalog = (await invoke(["flow", "list"])).json;
    t.ok(catalog.workflows.every(({ name }) => children("flow").some((command) => command.name === name)),
      "usage includes every installed workflow");
    t.ok(children("release").find((command) => command.name === "install")
      ?.flags.some((flag) => flag.name === "--archive" && flag.valueKind === "file"), "release install takes an archive file");
    t.ok(children("release").find((command) => command.name === "build")
      ?.flags.some((flag) => flag.name === "--archive" && flag.valueKind === "boolean"), "release build takes --archive as a switch");
    const buildOption = await invoke(["release", "build", "--archive"]);
    const installOption = await invoke(["release", "install", "--archive"]);
    t.eq([buildOption.err.split("\n")[0], installOption.err.split("\n")[0]],
      ["Missing --out.", "Missing value for --archive."], "the release parser uses the advertised flag kinds");
    t.ok(usage.json.configFiles.find(({ path }) => path === "~/.zodchi/flow.json")?.keys.includes("credits"),
      "usage lists flow.json credit configuration");
    t.ok(["ZODCHI_AGENT", "CODEX_HOME"].every((key) => usage.json.environment.includes(key)), "usage lists environment names");
    t.eq(Object.keys(usage.json.exitCodes), ["0", "1", "2", "3"], "usage lists the exit codes");
    t.eq(Object.keys(usage.json.exitCodes["3"]).sort(), ["pending", "sign-in"], "usage describes both meanings of code 3");

    const invalid = ["flow", "runs", "--args", "x"];
    const help = await invoke(["flow", "--help"]);
    const old = await invoke(invalid);
    t.eq([old.code, old.out, old.err], [1, "", help.json.usage + "\n"], "the legacy call prints its usage to stderr");
    const wrong = await invoke(invalid, agent);
    expectEnvelope(t, wrong, "wrong-call", 1);
    t.eq(wrong.out, "", "a malformed flow call has no result JSON");
    const privatePath = path.join(f.w.dir, "private-argument");
    const privateFailure = await invoke(["flow", "code-package", "--args", "x", privatePath], agent);
    expectEnvelope(t, privateFailure, "wrong-call", 1);
    t.ok(!privateFailure.err.includes("private-argument"), "invalid arguments are absent from the envelope");
    const status = await invoke(["status", "--json", "missing-first", "missing-second"]);
    expectEnvelope(t, status, "not-found", 2);
    t.eq(status.json, [], "redirected JSON status keeps its existing stdout even when both keys are missing");
    const missingKeys = await invoke(["status", "--json"]);
    expectEnvelope(t, missingKeys, "wrong-call", 2);
    t.eq(dryRunState(f), before, "usage and rejected calls leave source, home and model turns unchanged");

    // Package the already built fixture binary. A damaged recovery record traps an accidental update
    // before any request to GitHub, after it would already have created the release lock.
    const home = path.join(f.w.dir, "managed-home");
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const releaseDir = path.join(home, "releases", version);
    fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
    const built = await invoke(["release", "build", "--source", ROOT, "--out", releaseDir]);
    t.eq(built.code, 0, "the installed release fixture packages the local binary");
    const launcher = path.join(home, built.json.cli);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.copyFileSync(path.join(releaseDir, built.json.cli), launcher);
    fs.writeFileSync(path.join(home, "managed-release.json"), JSON.stringify({ active: version, clients: [] }));
    fs.writeFileSync(path.join(home, "release-activation.json"), "incomplete fixture record");
    const installed = directorySnapshot(home);
    const invalidWorkflow = ["flow", "code-package", "--args", "x", "--unexpected"];
    for (const args of [invalid, invalidWorkflow]) {
      const launched = await run(t, launcher, args, { cwd: f.r, env: agent });
      expectEnvelope(t, launched, "wrong-call", 1);
    }
    t.ok(!fs.existsSync(path.join(home, "release-install.lock")), "the malformed call never takes the release lock");
    t.eq(directorySnapshot(home), installed, "the launcher and release state are byte-identical");

    const future = await run(t, launcher, ["flow", "future-workflow", "--args", "x"], { cwd: f.r, env: agent });
    const lines = future.err.split(/\r?\n/);
    t.eq([lines.length, lines[2]], [3, ""], "the update warning and final error are separate JSON lines");
    t.eq(JSON.parse(lines[0]).warning.kind, "release-update", "the launcher checks for an update for a workflow outside its catalog");
    t.ok(fs.existsSync(path.join(home, "release-install.lock")), "the start form enters the release update path");
    expectEnvelope(t, { ...future, err: lines[1] + "\n" }, "wrong-call", 1);
  }

  async function checkCliDiagnostics(t, f) {
    const agent = { ...f.w.env, ZODCHI_AGENT: "1" };
    const plain = { ...f.w.env, ZODCHI_AGENT: "0" };
    const invoke = (args, env) => zodchi(t, f.w, args, { cwd: f.r, env });
    const config = path.join(f.w.zhome, "config.json");
    const warning = "Expected a JSON object in config.json. Using no limit on parallel jobs.";
    fs.writeFileSync(config, "[]");
    try {
      const human = await invoke(["roles"], plain);
      t.eq([human.code, human.err], [0, warning + "\n"], "the config warning remains text in plain mode");
      const machine = await invoke(["roles"], agent);
      t.eq([machine.code, JSON.parse(machine.err)], [0, { warning: { kind: "config", message: warning } }],
        "a successful command preserves its config warning as JSON in agent mode");
      const failed = await invoke(["status", "--json", "missing-after-warning"], plain);
      const lines = failed.err.split(/\r?\n/);
      t.eq([lines.length, lines[2]], [3, ""], "redirected --json status prints two complete JSON lines");
      t.eq(JSON.parse(lines[0]), { warning: { kind: "config", message: warning } }, "the warning precedes the error");
      expectEnvelope(t, { ...failed, err: lines[1] + "\n" }, "not-found", 2);
    } finally {
      fs.unlinkSync(config);
    }

    const args = path.join(f.w.dir, "youtube-consent.json");
    fs.writeFileSync(args, JSON.stringify({
      profile: "fixture",
      channelId: "UC" + "a".repeat(22),
      clientFile: path.join(f.w.dir, "unused-desktop-client.json"),
    }));
    // A detached process has no controlling terminal even if the runner itself has one.
    const consent = spawnSync(ZODCHI, ["flow", "youtube-publish", "connect", "--args", args], {
      cwd: f.r, env: agent, detached: true, windowsHide: true, encoding: "utf8", timeout: 10000,
    });
    if (consent.error) throw consent.error;
    const error = expectEnvelope(t, { code: consent.status, err: consent.stderr }, "sign-in", 3);
    t.eq(consent.stdout, "", "consent without a controlling terminal produces no stdout result");
    t.ok(error.hint.includes("terminal") && !consent.stderr.includes("unused-desktop-client"),
      "the consent hint points to a terminal and omits the local input path");
  }

  function checkSkillContract(t) {
    const codex = readSkill(SKILLS.codex);
    const claude = readSkill(SKILLS.claude);
    t.eq([codex.front.name, claude.front.name], ["zodchi-flow", "zodchi-flow"], "both skills are named zodchi-flow, as their folders");
    t.ok(codex.front.description && claude.front.description && codex.front.description !== claude.front.description, "each has its own description (a Codex session, a Claude Code session)");
    t.ok(codex.body === claude.body, "the two skills share one body");
    const detachedRule = (body) => body.match(/^After a detached start or resume .*\n\n(?:- .*\n)+/m)?.[0];
    const portable = fs.readFileSync(path.join(ROOT, "skills/zodchi-flow/SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const rule = detachedRule(codex.body);
    t.ok(rule?.includes("start waiting right away") && rule.includes("`--detach`"), "detached starts and resumes are followed by a wait");
    t.ok(rule.includes("In Claude Code, start `zodchi flow wait <run-id>` as a background command") && rule.includes("Claude Code notifies you")
      && rule.includes("Report the result to the person"), "Claude Code waits in the background and reports after notification");
    t.ok(rule.includes("In Codex, run `zodchi flow wait <run-id> --timeout-min N` in the foreground")
      && rule.includes("repeat while the command exits 3"), "Codex repeats the bounded foreground wait on timeout");
    t.ok(rule.includes("`zodchi flow runs --active`") && rule.includes("they never have to ask for status"),
      "the skill uses runs --active for discovery and keeps the person informed");
    t.ok(rule.includes("After the wait ends, use `zodchi flow status <run-id>`"),
      "the skill reads detailed status after the wait");
    t.eq([detachedRule(claude.body), detachedRule(portable)], [rule, rule], "all three skills give the same detached-run instructions");
    for (const s of [codex, claude]) {
      t.eq(s.lines, COMMANDS, `${s.rel}: the foreground examples are exactly the run, the resume and the rerun`);
      t.ok(s.lines[0].includes('--args "<args-file>"'), `${s.rel}: the args file placeholder of the run command is in quotes, so a path with a space stays one word`);
      t.ok(s.lines.every((l) => !/[&|;<>]\s*$|nohup|\bstart\b|\bdisown\b/.test(l.replace(/<[a-z-]+>/g, ""))), `${s.rel}: the examples stay in the foreground`);
      t.ok(/foreground/i.test(s.body) && /no `&`/.test(s.body) && /no `nohup`/.test(s.body), `${s.rel}: it says to run in the foreground, with no &, no nohup`);
      t.ok(/timeout/i.test(s.body), `${s.rel}: it says to set the longest timeout the shell tool allows`);
      t.ok(/Do not edit, delete or add files in the journal/.test(s.body), `${s.rel}: it forbids editing the journal`);
      t.ok(/Never resubmit a model step by hand/.test(s.body) && /Resume is the only way back/.test(s.body), `${s.rel}: it forbids resubmitting by hand and names resume`);
      t.ok(/Never switch branches/.test(s.body), `${s.rel}: it forbids switching branches during a run`);
      t.ok(/## Review boundary/.test(s.brief) && /Important:/.test(s.brief) && /Out of scope:/.test(s.brief), `${s.rel}: the brief template carries the Review boundary section`);
      t.ok(!/--no-verify|--force|git push|push -f/.test(s.lines.join("\n")), `${s.rel}: no command pushes or forces`);
      const hosts = [...s.body.matchAll(/https?:\/\/([^/\s"'`)]+)/g)].map((m) => m[1]);
      t.ok(hosts.every((x) => /(^|\.)example\.(org|com)$/.test(x)), `${s.rel}: no real host (${hosts.join(", ") || "none named"})`);
      for (const k of FIELDS) t.ok(s.body.includes(`\`${k}\``), `${s.rel}: it names the result field ${k}`);
      for (const k of STOP_FIELDS) t.ok(s.body.includes(`\`${k}\``), `${s.rel}: it names the result field ${k} for a run that did not end approved`);
      t.ok(/\.zodchi\/flows\//.test(s.body) && /`run\.json`/.test(s.body) && /`result\.json`/.test(s.body), `${s.rel}: it says where the run id of a cut run is found`);
    }
    t.eq(Object.keys(codex.argsExample).sort(), ["brief", "checks", "files", "label", "repo", "verify"], "the example holds the six fields of a package");
    return codex;
  }

  async function checkCommitVerification(t, f) {
    const cli = (args, { cwd = f.r, env = {} } = {}) =>
      zodchi(t, f.w, ["flow", ...args], { cwd, env: { ...f.w.env, ...env } });
    const config = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      setup: ["echo ready > .verify-ready"],
      checks: ['test -f .verify-ready && test "$VERIFY_FIXTURE" = committed && node test/math.test.mjs'],
      verify: ["node smoke.mjs"],
      full: { run: "local", commands: ["echo full verification"] },
      tools: ["node"],
      env: { VERIFY_FIXTURE: "committed" },
    }));
    gitOut(f.r, ["add", "--", ".zodchi/verify.json"]);
    gitOut(f.r, ["commit", "-qm", "declare verification"]);
    const commit = gitOut(f.r, ["rev-parse", "HEAD"]);
    const tree = gitOut(f.r, ["rev-parse", "HEAD^{tree}"]);
    fs.writeFileSync(config, JSON.stringify({ checks: ["exit 51"] }));
    fs.writeFileSync(path.join(f.r, "src", "math.mjs"), STUB);
    const before = dryRunState(f);

    const ok = await cli(["verify", "HEAD"]);
    t.eq([ok.code, ok.json?.verdict, ok.json?.commit, ok.json?.tree], [0, "passed", commit, tree],
      "verify HEAD uses the committed plan and tree even with local edits");
    t.eq(ok.json?.commands?.map(row => [row.source, row.exitCode]),
      [["setup", 0], ["checks", 0], ["verify", 0], ["verify", 0]], "setup, checks, verify and local full verification run in order");
    t.ok(ok.json.commands.every(row => Number.isSafeInteger(row.ms) && path.isAbsolute(row.log) && fs.existsSync(row.log)),
      "each command includes its duration and a full log path");
    t.eq(ok.json.receipt, { head: commit, tree, commands: ok.json.commands.map(({ command, exitCode, output }) => ({ command, exitCode, output })) },
      "the receipt contains the checked tree and screened command evidence in branch-review's file format");
    t.eq(path.basename(ok.json.journal), ok.json.runId, "the journal path names the verify run");

    const args = path.join(f.w.dir, "verify args.json");
    fs.writeFileSync(args, JSON.stringify({
      setup: ['test "$VERIFY_FIXTURE" = override'],
      checks: ["exit 52"],
      verify: ['test "$VERIFY_FIXTURE" = override || exit 53; echo "password=fixture-value"; echo "visible output"; exit 7'],
      env: { VERIFY_FIXTURE: "override" },
      tools: ["node"],
    }));
    const failed = await cli(["verify", commit, "--args", args, "--only", "verify"]);
    t.eq([failed.code, failed.json?.verdict, failed.json?.commands?.map(row => [row.source, row.exitCode])],
      [2, "failed", [["setup", 0], ["verify", 7]]], "only verify skips cheap checks and a failure prevents local full verification");
    const command = failed.json.commands[1];
    t.ok(command.output.includes("visible output") && !failed.out.includes("fixture-value")
      && fs.readFileSync(command.log, "utf8").includes("fixture-value"), "stdout is screened and the journal keeps the full log");

    const detached = await cli(["verify", commit, "--repo", f.r, "--only", "checks", "--detach"], { cwd: f.w.dir });
    t.eq([detached.code, detached.json?.status], [0, "submitted"], "verify can start a worker from outside the repo");
    const id = detached.json.runId;
    const wait = await cli(["wait", id, "--timeout-min", "0.5"]);
    t.eq([wait.code, wait.json?.workflow, wait.json?.status], [0, "verify", "finished"], "wait reports a passed verify worker as successful");
    const status = await cli(["status", id]);
    t.eq(status.json?.result?.commands?.map(row => [row.source, row.exitCode]), [["setup", 0], ["checks", 0]],
      "status returns the worker result for only checks");
    const runs = await cli(["runs"]);
    t.ok(runs.json?.some(row => row.runId === id && row.workflow === "verify" && row.status === "finished"),
      "runs lists the verification journal");

    const cut = await cli(["verify", commit, "--only", "checks"], { env: { ZODCHI_FLOW_CUT: "verify setup #1" } });
    t.eq(cut.code, 75, "the check runner can be cut after a recorded setup command");
    const opened = (await cli(["runs"])).json.filter(row => row.workflow === "verify" && row.status === "interrupted");
    t.eq(opened.length, 1, "the cut created an interrupted verify journal");
    const resumed = await cli(["verify", "--resume", opened[0].runId]);
    t.eq([resumed.code, resumed.json?.commit, resumed.json?.commands?.map(row => row.source)], [0, commit, ["setup", "checks"]],
      "resume continues on the pinned checkout and reuses the setup receipt");
    const events = readJsonl(path.join(resumed.json.journal, "events.jsonl"));
    t.eq(events.filter(event => event.kind === "check started").map(event => event.commandIndex), [1, 2],
      "resume starts only the remaining check");

    fs.writeFileSync(args, JSON.stringify({ tools: ["zodchi-missing-verify-tool"] }));
    const missingTool = await cli(["verify", commit, "--args", args]);
    t.eq([missingTool.code, missingTool.json?.verdict, missingTool.json?.commands], [2, "failed", []],
      "a required tool override is checked before launching any commands");
    t.ok(missingTool.json.infra.includes("zodchi-missing-verify-tool"), "the verification stop names the missing tool");
    const closed = await cli(["close", missingTool.json.runId, "--reason", "fixture complete"]);
    t.eq([closed.code, closed.json?.workflow, closed.json?.status], [0, "verify", "closed"],
      "close works for a stopped verification journal");

    const wrong = await cli(["verify", "missing-verify-ref"], { env: { ZODCHI_AGENT: "1" } });
    expectEnvelope(t, wrong, "wrong-call", 1);
    t.eq(wrong.out, "", "a wrong ref produces no result on stdout");
    const after = dryRunState(f);
    t.eq([after.packages, after.repo, after.status, after.turns], [before.packages, before.repo, before.status, before.turns],
      "commit verification takes no claim, leaves the source checkout intact, and makes no model call");

    const reviewArgs = path.join(f.w.dir, "review-args.json");
    const branchReview = (overrides) => {
      fs.writeFileSync(reviewArgs, JSON.stringify({
        repo: f.r, base: f.base, head: commit, label: "clamp-review", author: "codex/fake-writer", ...overrides,
      }));
      return cli(["branch-review", "--args", reviewArgs]);
    };
    fs.writeFileSync(args, JSON.stringify({ checks: ["node smoke.mjs"] }));
    const earlierRun = await cli(["verify", f.base, "--args", args, "--only", "checks"]);
    t.eq([earlierRun.code, earlierRun.json?.commit], [0, f.base], "the earlier tree has its own passing verification");
    const wrongRun = await branchReview({ verificationRun: earlierRun.json.runId });
    t.ok(wrongRun.code === 2 && wrongRun.json?.refused?.includes("no passing checks for tree"),
      "branch-review refuses a passing verify run for another tree");
    t.eq(failed.json?.tree, tree, "the failed verification checked the candidate tree");
    const failedRun = await branchReview({ verificationRun: failed.json.runId });
    t.ok(failedRun.code === 2 && failedRun.json?.refused?.includes("no passing checks for tree"),
      "branch-review refuses a failed verify run for the correct tree");
    t.eq(f.steps(), after.turns, "verification and refused evidence references call no model");

    const sameTreeHead = gitOut(f.r, ["commit-tree", tree, "-p", commit, "-m", "same candidate tree"]);
    f.answer("review", f.review("approved"));
    const linked = await branchReview({ head: sameTreeHead, verificationRun: ok.json.runId });
    t.eq([linked.code, linked.json?.head, linked.json?.verificationRun, linked.json?.tree],
      [0, sameTreeHead, ok.json.runId, tree], "branch-review links passing verify evidence for the same tree");
    const requestPath = path.join(linked.json.journal, "requests", `flow-${linked.json.runId}-review.json`);
    const { prompt } = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    const attachment = prompt.match(/<attachment path="verification\.json">\n([\s\S]*?)\n<\/attachment>/);
    t.ok(attachment, "the review request contains verification.json");
    const evidenceFromRun = JSON.parse(attachment[1]);
    t.eq([evidenceFromRun.runId, evidenceFromRun.tree, evidenceFromRun.commands],
      [ok.json.runId, tree, ok.json.receipt.commands], "the review receives screened evidence attributed to its verify run");

    const receipt = path.join(f.w.dir, "verification-receipt.json");
    fs.writeFileSync(receipt, JSON.stringify(ok.json.receipt));
    const fromFile = await branchReview({ verificationFile: receipt });
    t.eq([fromFile.code, fromFile.json?.verificationReceipt?.tree, f.steps()],
      [0, tree, [...after.turns, "review", "review"]], "the generated receipt also works as a coordinator verificationFile");
  }

  scenario("flow-entry-local", "the shared skills lead to local approval, with real check and commit evidence and a resumable result", async (t) => {
    const skill = checkSkillContract(t);
    const f = flowWorld(t, "flow-entry-local");
    await checkCliContract(t, f);
    await checkCliDiagnostics(t, f);
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const file = skillArgs(t, f, skill, {});
    const start = ["--args", file];
    const previewArgs = [...start, "--dry-run"];
    const source = path.join(f.r, "src", "math.mjs");
    const brief = JSON.parse(fs.readFileSync(file, "utf8")).brief;
    // A status probe using optional locks would refresh Git's index for this unchanged file.
    const past = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(source, past, past);
    const before = dryRunState(f);
    const dry = await f.flow(previewArgs);
    t.eq([dry.code, dry.json?.dryRun, dry.json?.label, dry.json?.branch, dry.json?.base],
      [0, true, "clamp", "refs/heads/main", f.base], "dry run prints a single JSON plan for the package");
    const plan = dry.json;
    t.ok(samePath(plan.repo, f.r), "the preview names the checkout");
    t.eq([plan.files, plan.protected, plan.allowCheckChanges], [["src/math.mjs"], [
      "test/", "tests/", "e2e/", ".claude/skills/verify/", ".agents/skills/verify/", "skills/verify/",
      ".zodchi/verify.json", "REVIEW.md", ".zodchi/workflows.json",
    ], []], "the preview describes the claim and its protected checks");
    t.eq(plan.models, {
      expertWriter: { provider: "codex", model: "fake-writer", effort: "medium", route: "local codex gateway" },
      reviewer: { provider: "codex", model: "fake-reviewer", effort: "high", route: "local codex gateway" },
    }, "the preview identifies both roles and their routes");
    t.eq(plan.prompt.attachments, [
      { path: "brief", bytes: fs.statSync(brief).size },
      { path: "src/math.mjs", bytes: Buffer.byteLength(STUB) },
    ], "attachments expose paths and byte counts");
    t.eq(plan.prompt.sections.map(section => section.name), ["instructions", "files", "rules", "checkRules"],
      "the preview lists the writer instructions, file manifest and rules");
    t.ok(plan.prompt.sections.every(section => Object.keys(section).length === 2 && Number.isSafeInteger(section.bytes) && section.bytes > 0),
      "the named sections expose byte counts only");
    t.ok(!dry.out.includes("a clamp that lets a value out of its range") && !dry.out.includes(STUB.trim()),
      "neither the brief nor the claimed file content appears in the preview");
    t.eq([plan.screening, plan.checks, plan.verify, plan.budget], [
      { brief: "screened", files: "screened", agentWorkspace: null },
      ["node test/math.test.mjs"], ["node smoke.mjs"], { rounds: 3, fixes: 1, continuations: 0 },
    ], "the preview reports screening, ordered verification commands and the package budget");
    t.eq(dryRunState(f), before, "the Zodchi home, claims, Git index and checkout are byte-identical and no model ran");
    t.eq(f.steps(), [], "the fake Codex received zero model calls");

    for (const flag of [["--detach"], ["--resume", "unused-run"]]) {
      const wrong = await f.flow([...previewArgs, ...flag]);
      t.ok(wrong.code === 1 && wrong.err.includes("--dry-run"), `dry run combined with ${flag[0]} is a wrong call`);
    }
    const unsupported = await zodchi(t, f.w, ["flow", "research", ...previewArgs], { cwd: f.r });
    t.ok(unsupported.code === 1 && unsupported.err.includes("code-package"), "research names code-package as the supported workflow");
    t.eq(dryRunState(f), before, "rejected command lines leave the same state");

    const denylist = path.join(f.w.dir, "preview-denylist.txt");
    fs.writeFileSync(denylist, "Make clamp\nexport const clamp\n");
    const screeningEnv = { ZODCHI_DENYLIST: denylist };
    const screened = await f.flow(previewArgs, screeningEnv);
    const screenedStart = await f.flow(start, screeningEnv);
    t.eq([screened.code, screened.json], [screenedStart.code, screenedStart.json], "dry run and start return the same privacy refusal");
    t.eq(screened.code, 2, "the input screening refusal exits 2");
    t.ok(/would be withheld: the brief:\d+ \(private-word\), src\/math\.mjs:\d+ \(private-word\)\./.test(screened.json?.refused),
      "the same input screening checks the brief and the claimed file");
    t.eq(dryRunState(f), before, "screening refuses before leaving any local effects");

    fs.writeFileSync(source, FIXED);
    const dirty = dryRunState(f);
    const dirtyPreview = await f.flow(previewArgs);
    t.eq(dryRunState(f), dirty, "a preview does not change a dirty checkout or Zodchi state");
    const dirtyStart = await f.flow(start);
    t.eq([dirtyPreview.code, dirtyPreview.json], [dirtyStart.code, dirtyStart.json], "preview and start refuse a dirty claimed file identically");
    t.ok(dirtyPreview.code === 2 && /Uncommitted changes in package files: src\/math\.mjs/.test(dirtyPreview.json?.refused),
      "the refusal names the dirty claimed file");
    fs.writeFileSync(source, STUB);

    const res = await startBySkill(t, f, skill);
    readLikeSkill(t, f, skill, res);
    t.eq([res.json.rounds.length, res.json.verifiedBy, res.json.openFindings], [1, "args.verify", []], "one round, verified by args.verify, nothing open");
    t.eq(res.json.models, { expertWriter: { provider: "codex", model: "fake-writer", effort: "medium" }, reviewer: { provider: "codex", model: "fake-reviewer", effort: "high" } }, "the pair: two distinct Codex models, pinned");
    t.ok(res.json.skipped.some((s) => /claude\/opus: Claude is not an executor/.test(s)) && res.json.skipped.some((s) => /fake-writer: the same model as the writer/.test(s)), "skipped candidates are recorded with their reasons");
    const evidence = res.json.verification.evidence;
    t.eq(evidence.map((e) => [e.source, e.exitCode]), [["checks", 0], ["args.verify", 0]], "the cheap check ran first, then verify, each with its real exit code");
    t.ok(evidence.every((e) => fs.existsSync(e.log) && fs.readFileSync(e.log, "utf8").trim()), "each command has a non-empty log");
    t.ok(evidence.every((e) => !samePath(path.dirname(e.log), f.r) && !e.log.toLowerCase().startsWith(path.resolve(f.r).toLowerCase())), "the logs are outside the checkout");
    const message = gitOut(f.r, ["log", "-1", "--format=%B"]);
    t.ok(message.startsWith("clamp: round 1") && message.includes("Verified: checks exit 0; args.verify exit 0"), "the commit message carries the stamp");
    t.ok(!/node |smoke|math\.test/.test(message), "the stamp names sources and exit codes, never a command");
    t.eq(gitOut(f.r, ["status", "--porcelain"]), "", "the work tree is clean after the commit");
    t.eq(f.steps(), ["write", "review 1"], "the writer and the reviewer each ran once");
    const [turn, review] = readJsonl(path.join(f.w.codex, "fake-turns.jsonl"));
    t.ok(turn.prompt.includes("## Review boundary") && turn.prompt.includes("a clamp that lets a value out of its range"), "the writer got the brief made from the template, with its review boundary");
    t.ok(review.prompt.includes("Out of scope: a second run started at the same instant"), "the reviewer got the review boundary");
    t.ok(review.prompt.includes("REVIEW-BASE-MARKER") && review.prompt.includes('<attachment path="REVIEW.base.md">'), "the review carries REVIEW.md of the base commit");
    t.ok(review.prompt.includes('<attachment path="change.diff">') && review.prompt.includes("Math.max(lo, x)"), "the review carries the diff");
    const again = await resumeBySkill(t, f, skill, res.json.runId);
    t.eq([again.code, again.json.verdict, again.json.rounds.length, f.steps()], [0, "approved", 1, ["write", "review 1"]], "the skill's resume of a finished run prints its result and runs nothing");
    // A run the engine refuses ends with exit 2 and `refused`, nothing claimed: what the skill says to read.
    const refused = await startBySkill(t, f, skill, { args: { branch: "elsewhere" } });
    t.ok(refused.code === 2 && /args\.branch is not supported/.test(refused.json.refused), "an option outside the engine's subset: exit 2, `refused` names it");
    const agentRefused = await startBySkill(t, f, skill, { env: { ZODCHI_AGENT: "1" }, args: { branch: "elsewhere" } });
    t.eq([agentRefused.code, agentRefused.json, agentRefused.err],
      [2, refused.json, ""], "a workflow refusal remains a structured stdout result in agent mode");
    await checkCommitVerification(t, f);
    await checkDryRunClaims(t);
    await checkAnalysisWriter(t);
    await checkWave(t);
  });

  scenario("flow-entry-cut", "the Claude Code skill resumes a run cut after writer submission and after commit, with one turn per step and one commit", async (t) => {
    const skill = readSkill(SKILLS.claude);
    const f = flowWorld(t, "flow-entry-cut");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const cut = await startBySkill(t, f, skill, { env: { ZODCHI_FLOW_CUT: "submit write" } });
    t.eq(cut.code, 75, "the process was cut right after the write step was submitted");
    t.eq(f.claim().status, "open", "the claim stays open across the cut");
    const id = runIdOf(f.w.zhome, f.r, "clamp");
    t.ok(id && /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(id), `the run id is found from the journal folder as the skill says (${id})`);
    const committed = await resumeBySkill(t, f, skill, id, { ZODCHI_FLOW_CUT: "commit 1" });
    t.eq(committed.code, 75, "cut after the commit of round 1");
    t.eq(f.commits().length, 1, "the commit exists at the cut");
    const res = await resumeBySkill(t, f, skill, id);
    readLikeSkill(t, f, skill, res);
    t.eq(res.json.runId, id, "the resume is the same run");
    t.eq(f.steps(), ["write", "review 1"], "each model step ran once");
    const events = readJsonl(path.join(res.json.journal, "events.jsonl"));
    for (const step of ["write", "commit 1"]) {
      t.eq(events.filter(e => e.kind === "intent" && e.step === step).length, 1, `one intent for ${step}`);
    }
    t.eq(fs.readdirSync(path.join(f.w.zhome, "flows")).length, 1, "no second run was started");
    t.eq(runIdOf(f.w.zhome, f.r, "clamp"), id, "a finished run is still the newest one of its repository and label: the skill resumes it and it prints its result");
  });

  scenario("flow-entry-cut-result", "from a Claude Code session: the run cut after its result was saved and before its claim was closed: the run id is found as the skill says although result.json is there, its resume closes the claim and asks no model", async (t) => {
    const skill = readSkill(SKILLS.claude);
    const f = flowWorld(t, "flow-entry-cut-result");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    t.ok(skill.body.includes("A saved `result.json` does not make it a finished run") && !skill.body.includes("which has no `result.json`"), "the skill does not leave out a run that has a result.json");
    const cut = await startBySkill(t, f, skill, { env: { ZODCHI_FLOW_CUT: "result" } });
    t.eq(cut.code, 75, "the process was cut after the result was saved");
    t.eq(f.claim().status, "open", "the claim is still open: nothing else could claim those files");
    const id = runIdOf(f.w.zhome, f.r, "clamp");
    t.ok(id && fs.existsSync(path.join(f.w.zhome, "flows", id, "result.json")), `the run id is found although the journal already holds result.json (${id})`);
    t.eq(f.steps(), ["write", "review 1"], "both model steps ran before the cut");
    const res = await resumeBySkill(t, f, skill, id);
    readLikeSkill(t, f, skill, res);
    t.eq([res.json.refused, res.json.conflicts], [undefined, undefined], "the saved approval returns without a claim refusal or conflict");
    t.eq([res.json.runId, f.steps()], [id, ["write", "review 1"]], "the resume is the same run and asked no model again");
  });

  scenario("flow-entry-failing-verify", "from a Codex session: a verify command that fails: verifiedBy is none while evidence holds the failed command's exit code, which is how the skill says to tell it from a run in which nothing ran", async (t) => {
    const skill = readSkill(SKILLS.codex);
    t.ok(/did not establish that the change is verified, not that nothing ran/.test(skill.body.replace(/\s+/g, " ")) && /`evidence`/.test(skill.body) && /exitCode/.test(skill.body), "the skill says none is not 'nothing ran' and points to the evidence");
    const f = flowWorld(t, "flow-entry-failing-verify");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    const verify = [
      "node smoke.mjs --fail",
      "node -e 'console.log(JSON.stringify({ok:true,exitCode:0})); process.exit(4)'",
    ];
    const res = await startBySkill(t, f, skill, { args: { verify, fixes: 0 } });
    t.eq([res.code, res.json.stoppedAt, res.json.verifiedBy], [2, "checks (args.verify exit 1)", "none"], "the run stops at the failed verification");
    t.eq(res.json.verification.stamp, "Verified: none", "the stamp records that verification failed");
    const evidence = res.json.verification.evidence;
    t.eq(evidence.map((e) => [e.source, e.exitCode]),
      [["checks", 0], ["args.verify", 1], ["args.verify", 4]], "checks run first, then both verifies record their real exit codes");
    t.ok(/smoke 4/.test(fs.readFileSync(evidence[1].log, "utf8")), "the verify log holds the program's output");
    t.ok(fs.readFileSync(evidence[2].log, "utf8").includes('{"ok":true,"exitCode":0}'), "the misleading output remains available for diagnosis");
    t.eq([f.commits().length, f.steps()], [0, ["write"]], "no commit, no review");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8"), FIXED, "the work stays in the work tree");
  });

  scenario("flow-entry-server", "from a Codex session for a colleague: the Codex skill's steps as written with flow.json naming a server: the model steps run on the server under the user's account, everything else stays local, same engine and result", async (t) => {
    const skill = readSkill(SKILLS.codex);
    const s = await serverWorld(t, "flow-entry-server");
    const { f } = s;
    s.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    s.answer("review 1", f.review("approved"));
    const file = skillArgs(t, f, skill, {});
    const before = dryRunState(f);
    const dry = await f.flow(["--args", file, "--dry-run"]);
    const route = `company server ${s.origin}`;
    t.eq([dry.code, dry.json?.models?.expertWriter?.route, dry.json?.models?.reviewer?.route, s.steps()],
      [0, route, route, []], "the dry run preflights the server route without asking a model");
    t.eq(dryRunState(f), before, "server preflight leaves the local state unchanged");
    t.ok(!dry.out.includes(s.u.token), "the preview prints the server origin without the token");
    const config = path.join(f.w.zhome, "flow.json");
    const settings = fs.readFileSync(config, "utf8");
    const address = new URL(s.origin);
    address.username = "preview-user";
    address.password = "preview-password";
    address.search = "fixture-query";
    address.hash = "fixture-fragment";
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(settings), server: address.href }));
    try {
      const configured = dryRunState(f);
      const sanitized = await f.flow(["--args", file, "--dry-run"]);
      t.eq([sanitized.code, sanitized.json?.models?.expertWriter?.route, sanitized.json?.models?.reviewer?.route, s.steps()],
        [0, route, route, []], "the preview with user info, query and fragment shows only the server origin");
      t.ok([address.username, address.password, address.search.slice(1), address.hash.slice(1), s.u.token]
        .every(secret => !sanitized.out.includes(secret) && !sanitized.err.includes(secret)), "the omitted URL parts reach neither output stream");
      t.eq(dryRunState(f), configured, "sanitizing the preview leaves the configured server intact");
    } finally {
      fs.writeFileSync(config, settings);
    }
    const res = await startBySkill(t, f, skill);
    readLikeSkill(t, f, skill, res);
    t.eq(s.steps(), ["write", "review 1"], "the writer and the reviewer ran on the server");
    t.eq(readJsonl(path.join(f.w.codex, "fake-turns.jsonl")).length, 0, "no model turn ran on this machine");
    const run = JSON.parse(fs.readFileSync(path.join(res.json.journal, "run.json"), "utf8"));
    t.eq(run.policy.executors, "codex via server", "the run records that its Codex steps went through the server");
    t.ok(!JSON.stringify(res.json).includes(s.u.token) && !gitOut(f.r, ["log", "-p", "--all"]).includes(s.u.token), "the token is in no result and no commit");
  });

  scenario("flow-entry-claude", "from a Codex session with Claude roles: the Codex skill's steps as written with \"claude\": true and a Claude writer first in the role table (the fake claude): a failed write stops the run, the skill's rerun of the step named in stoppedAt goes on to approval; same engine and result", async (t) => {
    const skill = readSkill(SKILLS.codex);
    const c = claudeWorld(t, "flow-entry-claude");
    const { f } = c;
    const auth = path.join(c.home, "fake-auth.json");
    const agent = { ZODCHI_AGENT: "1" };
    fs.unlinkSync(auth);
    try {
      const unsigned = await zodchi(t, f.w, ["run", "--provider", "claude", "--model", "opus",
        "--role", "text", "--key", "unsigned-claude", "--prompt", f.brief, "--wait-sec", "60"],
        { cwd: f.r, env: { ...f.w.env, ...agent } });
      expectEnvelope(t, unsigned, "sign-in", 3);
      t.eq(unsigned.json?.job?.status, "auth_required", "the unsigned Claude job's stdout is still the job record");
      const onlyClaude = { expertWriter: { candidates: [{ provider: "claude", model: "opus", effort: "high" }] } };
      const refused = await f.flow(["--args", f.args({ models: onlyClaude })], agent);
      expectEnvelope(t, refused, "sign-in", 3);
      t.ok(refused.json?.refused?.includes("Claude Code is not signed in"), "the flow refusal still names its cause");
      t.eq([c.calls(), f.claim()], [[], null], "no model was asked and nothing was claimed without sign-in");
    } finally {
      fs.writeFileSync(auth, "{}");
    }
    c.answer("write", "Here is the patch: clamp now uses Math.min and Math.max.");
    f.answer("review 1", f.review("approved"));
    const file = skillArgs(t, f, skill, {});
    // Keep previewing the same role pair while the main run holds its claim.
    const preview = { ...JSON.parse(fs.readFileSync(file, "utf8")), label: "clamp-preview", files: ["src/other.mjs"] };
    const previewArgs = ["--args", f.args(preview), "--dry-run"];
    const before = dryRunState(f);
    const dry = await f.flow(previewArgs);
    t.ok(dry.code === 1 && /Claude preflight receipt for opus with effort high.*new model call/.test(dry.json?.refused),
      "a missing receipt explains why the exact Claude candidate needs a model call");
    t.eq([dryRunState(f), c.calls()], [before, []], "a cold Claude preview uses no model and creates no local state");
    const codexOnly = f.args({ models: { expertWriter: { candidates: [{ provider: "codex", model: "fake-writer", effort: "medium" }] } } });
    const codexPreview = await f.flow(["--args", codexOnly, "--dry-run"]);
    t.eq([codexPreview.code, codexPreview.json?.models?.expertWriter?.route], [0, "local codex gateway"],
      "enabling Claude leaves a Codex-only pair previewable without a Claude receipt");
    t.eq([dryRunState(f), c.calls()], [before, []], "previewing the Codex pair also leaves local state unchanged");
    const stop = await startBySkill(t, f, skill);
    t.eq([stop.code, stop.json.stoppedAt], [2, "gateway failed at write"], "an answer outside the schema stops the run at the write step: exit 2");
    t.ok(stop.json.infra && stop.json.next && stop.json.runId, "the stop result carries infra, next and the run id the skill says to read");
    t.eq([f.commits().length, f.claim().status], [0, "open"], "nothing committed, the claim open (a plain resume would stop there again)");
    const warm = dryRunState(f);
    const calls = c.calls();
    const cachedPreview = await f.flow(previewArgs);
    t.eq([cachedPreview.code, cachedPreview.json?.models?.expertWriter, cachedPreview.json?.models?.reviewer], [0,
      { provider: "claude", model: "opus", effort: "high", route: "claude cli" },
      { provider: "codex", model: "fake-writer", effort: "medium", route: "local codex gateway" },
    ], "a fresh receipt resolves the Claude writer without exposing its account binding");
    t.eq([dryRunState(f), c.calls()], [warm, calls], "a warm preview leaves the journal, claim, receipt, checkout and model calls unchanged");
    const otherEffort = f.args({ ...preview, models: { expertWriter: { candidates: [
      { provider: "claude", model: "opus", effort: "medium" }, { provider: "codex", model: "fake-writer" },
    ] } } });
    const missing = await f.flow(["--args", otherEffort, "--dry-run"]);
    t.ok(missing.code === 1 && /Claude preflight receipt for opus with effort medium.*new model call/.test(missing.json?.refused),
      "the high-effort receipt leaves the medium-effort candidate unresolved even with a Codex fallback");
    t.eq([dryRunState(f), c.calls()], [warm, calls], "the unresolved candidate leaves local state and model calls unchanged");
    const step = (stop.json.stoppedAt.match(/ at (.+)$/) || [])[1];
    t.eq(step, "write", "the step is the one the stop names");
    c.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    const res = await rerunBySkill(t, f, skill, stop.json.runId, step);
    readLikeSkill(t, f, skill, res);
    t.eq([res.json.models.expertWriter.provider, res.json.models.expertWriter.model, res.json.models.reviewer.provider], ["claude", "opus", "codex"], "the writer is Claude and the reviewer is another model: the pair the skill reports");
    t.eq(res.json.runId, stop.json.runId, "the rerun is the same run");
    t.eq(f.steps(), ["review 1"], "Codex ran the review only");
    t.eq(c.calls().map((x) => x.step), ["preflight", "write", "write"], "Claude ran the preflight once and was asked the write step twice: the failed call and the rerun, under a new key");
    t.ok(c.calls().every((x) => x.apiKey === false), "no API key of the caller reached Claude");
  });
}
