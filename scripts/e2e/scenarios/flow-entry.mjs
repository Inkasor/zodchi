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
  const { scenario, flowWorld, serve, user, run, ZODCHI, gitOut, samePath, STUB, ROOT } = h;
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

  /** The steps of a skill, as an agent does them in a flow world: the brief from the template, the args from the
   *  example, the run command from any other folder. `env` is added to the run's environment (for a simulated cut).
   *  The files are in a folder with a space in its name, as an agent's may be, and the command is run by bash. */
  async function startBySkill(t, f, skill, { env = {}, args = {} } = {}) {
    const dir = path.join(f.r, ".agent-tmp", "flow", "two words");
    fs.mkdirSync(dir, { recursive: true });
    const brief = path.join(dir, "clamp-brief.md");
    fs.writeFileSync(brief, briefFrom(t, skill));
    const given = { ...skill.argsExample, label: "clamp", brief, repo: f.r, files: ["src/math.mjs"], checks: ["node test/math.test.mjs"], verify: ["node smoke.mjs"], ...args };
    const file = path.join(dir, "clamp-args.json");
    fs.writeFileSync(file, JSON.stringify(given, null, 2));
    t.eq(gitOut(f.r, ["status", "--porcelain"]), "", "the brief and the args are in the ignored .agent-tmp/: the work tree is clean");
    t.ok(/ /.test(file), "the args file is at a path with a space in it");
    return byShell(t, f, skill, COMMANDS[0], { "<args-file>": file }, { env });
  }

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
    return { f, answer, calls };
  }

  /** A flow world whose model steps go to a real zodchi-server on 127.0.0.1: the user's token in a token file, the
   *  server named in flow.json, no local Codex sign-in (a person who has none). */
  async function serverWorld(t, name) {
    const f = flowWorld(t, name);
    const data = path.join(f.w.dir, "server-data");
    const u = await user(t, f.w, data, "Flow user");
    const server = await serve(t, f.w, data);
    const tokenFile = path.join(f.w.dir, "flow-token");
    fs.writeFileSync(tokenFile, `${u.token}\n`);
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ server: `http://${server.address}`, tokenFile }));
    fs.rmSync(path.join(f.w.codex, "fake-auth.json"), { force: true });
    const answer = (step, value) => {
      fs.mkdirSync(path.join(u.home, "fake-flow"), { recursive: true });
      fs.writeFileSync(path.join(u.home, "fake-flow", `${step.replace(/ /g, "-")}.json`), JSON.stringify(value));
    };
    const steps = () => readJsonl(path.join(u.home, "fake-turns.jsonl")).map((x) => x.step);
    return { f, u, answer, steps };
  }

  // ------------------------------------------------------------------------------------------------ scenarios

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

  scenario("flow-entry-local", "the shared skills lead to local approval, with real check and commit evidence and a resumable result", async (t) => {
    const skill = checkSkillContract(t);
    const f = flowWorld(t, "flow-entry-local");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
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
    c.answer("write", "Here is the patch: clamp now uses Math.min and Math.max.");
    f.answer("review 1", f.review("approved"));
    const stop = await startBySkill(t, f, skill);
    t.eq([stop.code, stop.json.stoppedAt], [2, "gateway failed at write"], "an answer outside the schema stops the run at the write step: exit 2");
    t.ok(stop.json.infra && stop.json.next && stop.json.runId, "the stop result carries infra, next and the run id the skill says to read");
    t.eq([f.commits().length, f.claim().status], [0, "open"], "nothing committed, the claim open (a plain resume would stop there again)");
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
