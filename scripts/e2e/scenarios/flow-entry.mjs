// The three entry points of `zodchi flow code-package` (docs/flow.md, "Three ways to start it"): the Codex skill
// (codex/skills/zodchi-flow), the Claude Code skill of the zodchi-core plugin (core/skills/zodchi-flow) and the installer
// that puts them where the two programs read them.
//
// The skills are followed as written, not paraphrased: the brief is made from the skill's own brief template, the args
// file from its own JSON example, and every command line of its `sh` blocks is run, with its placeholders filled, against
// the real `zodchi` and the fakes of the other scenarios (fake Codex, a real zodchi-server, fake Claude). A real run
// with real Codex and Claude sessions belongs to the before-release run, not to CI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WIN = process.platform === "win32";
const FIXED = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const KEY = "not-a-real-key-for-the-flow-entry-scenarios";
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const SKILLS = { codex: "codex/skills/zodchi-flow/SKILL.md", claude: "core/skills/zodchi-flow/SKILL.md" };
// The only commands a skill tells an agent to run, in the order of its steps.
const COMMANDS = [
  "zodchi flow code-package --args <args-file>",
  "zodchi flow code-package --resume <run-id>",
  'zodchi flow code-package --resume <run-id> --rerun "<step>"',
];
// The fields the skill tells the agent to read in the result of an approved run.
const FIELDS = ["verdict", "approved", "openFindings", "verifiedBy", "verification", "rounds", "models", "runId", "journal"];
// The fields it names for a run that did not end approved.
const STOP_FIELDS = ["refused", "stoppedAt", "next", "question", "questions", "infra"];

export default function register(h) {
  const { scenario, flowWorld, serve, user, zodchi, gitOut, samePath, STUB, ROOT } = h;
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

  /** `zodchi flow ...` as the skill writes it, split like a shell does and with its placeholders filled; the program
   *  name is checked and dropped (the scenario runs the release binary it just built). */
  function command(skill, shape, fill) {
    const line = skill.lines.find((l) => l === shape);
    if (!line) throw new Error(`${skill.rel} has no command line "${shape}"`);
    const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((x) => (x[1] !== undefined ? x[1] : x[2]));
    if (words[0] !== "zodchi") throw new Error(`${skill.rel}: "${line}" does not start with zodchi`);
    return words.slice(1).map((w) => fill[w] !== undefined ? fill[w] : w);
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

  /** The newest run folder of the zodchi home whose run.json names the repository and the label and that has no
   *  result.json: how the skill says to find the id of a cut run. */
  function runIdOfCut(zhome, repo, label) {
    const flows = path.join(zhome, "flows");
    for (const id of fs.readdirSync(flows).sort().reverse()) {
      const file = path.join(flows, id, "run.json");
      if (!fs.existsSync(file) || fs.existsSync(path.join(flows, id, "result.json"))) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      if (samePath(run.repo, repo) && run.inputs.args.label === label) return id;
    }
    return null;
  }

  /** The steps of a skill, as an agent does them in a flow world: the brief from the template, the args from the
   *  example, the run command from any other folder. `env` is added to the run's environment (for a simulated cut). */
  async function startBySkill(t, f, skill, { env = {}, args = {} } = {}) {
    const dir = path.join(f.r, ".agent-tmp", "flow");
    fs.mkdirSync(dir, { recursive: true });
    const brief = path.join(dir, "clamp-brief.md");
    fs.writeFileSync(brief, briefFrom(t, skill));
    const given = { ...skill.argsExample, label: "clamp", brief, repo: f.r, files: ["src/math.mjs"], checks: ["node test/math.test.mjs"], verify: ["node smoke.mjs"], ...args };
    const file = path.join(dir, "clamp-args.json");
    fs.writeFileSync(file, JSON.stringify(given, null, 2));
    t.eq(gitOut(f.r, ["status", "--porcelain"]), "", "the brief and the args are in the ignored .agent-tmp/: the work tree is clean");
    const argv = command(skill, COMMANDS[0], { "<args-file>": file });
    t.eq(argv.slice(0, 2), ["flow", "code-package"], `the skill's run command: zodchi ${argv.join(" ")}`);
    return zodchi(t, f.w, argv, { cwd: f.w.dir, env: { ...f.w.env, ...env } });
  }

  /** The resume command of the skill. */
  const resumeBySkill = (t, f, skill, id, extra = {}) => zodchi(t, f.w, command(skill, COMMANDS[1], { "<run-id>": id }), { cwd: f.w.dir, env: { ...f.w.env, ...extra } });
  /** The rerun command of the skill, `<step>` filled from the step the stop names. */
  const rerunBySkill = (t, f, skill, id, step) => zodchi(t, f.w, command(skill, COMMANDS[2], { "<run-id>": id, "<step>": step }), { cwd: f.w.dir, env: f.w.env });

  /** What the skill says about an approved result: every field it names is there, the journal holds the same result,
   *  and the engine is the same one in every way of starting it. */
  function readLikeSkill(t, f, skill, res) {
    t.eq([res.code, res.json && res.json.verdict, res.json && res.json.approved], [0, "approved", true], "the run ends approved, exit 0");
    for (const k of FIELDS) t.ok(res.json && k in res.json && skill.body.includes(`\`${k}\``), `the skill names \`${k}\` and the result has it`);
    t.eq([res.json.workflow, res.json.mode], ["code-package", "expert"], "the result is the engine's code-package result");
    t.eq(JSON.parse(fs.readFileSync(path.join(res.json.journal, "result.json"), "utf8")).runId, res.json.runId, "result.json in the journal folder is this run's result (the skill's fallback read)");
    t.eq([f.commits().length, gitOut(f.r, ["show", "--name-only", "--format=", "HEAD"])], [1, "src/math.mjs"], "one commit on top of the base, the claimed file only (git log <base>..HEAD, as the skill reports)");
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

  scenario("flow-entry-skills", "the Codex skill and the Claude Code skill: one shared body, front matter, exactly the three commands the doc names, a brief template with the review boundary, an args example the engine takes, no foreground-breaking or journal-editing advice, no real host", async (t) => {
    const codex = readSkill(SKILLS.codex);
    const claude = readSkill(SKILLS.claude);
    t.eq([codex.front.name, claude.front.name], ["zodchi-flow", "zodchi-flow"], "both skills are named zodchi-flow, as their folders");
    t.ok(codex.front.description && claude.front.description && codex.front.description !== claude.front.description, "each has its own description (a Codex session, a Claude Code session)");
    t.ok(codex.body === claude.body, "the two skills share one body");
    for (const s of [codex, claude]) {
      t.eq(s.lines, COMMANDS, `${s.rel}: the commands the skill tells an agent to run are exactly the run, the resume and the rerun`);
      t.ok(s.lines.every((l) => !/[&|;<>]\s*$|nohup|\bstart\b|\bdisown\b/.test(l.replace(/<[a-z-]+>/g, ""))), `${s.rel}: no command is backgrounded or detached`);
      t.ok(/foreground/i.test(s.body) && /no `&`/.test(s.body) && /no `nohup`/.test(s.body), `${s.rel}: it says to run in the foreground, with no &, no nohup`);
      t.ok(/timeout/i.test(s.body), `${s.rel}: it says to set the longest timeout the shell tool allows`);
      t.ok(/Never edit, delete or copy files in the journal/.test(s.body), `${s.rel}: it forbids editing the journal`);
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
    // The engine takes the args example as written (anything outside its subset is refused before a claim).
    const f = flowWorld(t, "flow-entry-skills");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await startBySkill(t, f, codex);
    t.eq([res.code, res.json && res.json.verdict], [0, "approved"], "the example's keys are all ones the engine accepts");
    t.eq(Object.keys(codex.argsExample).sort(), ["brief", "checks", "files", "label", "repo", "verify"], "the example holds the six fields of a package");
  });

  scenario("flow-entry-install", "the installer puts the Codex skill where Codex reads skills and the Claude Code skill in the zodchi-core plugin it installs, never over a file it did not write, and removes both on uninstall", async (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-entry-"));
    t.cleanups.push(() => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left in the temp folder */ } });
    const env = (name) => {
      const dir = path.join(scratch, name);
      const e = { ...process.env, ZODCHI_HOME: path.join(dir, "zodchi-home"), CODEX_HOME: path.join(dir, "codex-home"), HOME: path.join(dir, "home"), USERPROFILE: path.join(dir, "home"), CLAUDE_CONFIG_DIR: path.join(dir, "claude-config") };
      delete e.ZODCHI_DENYLIST;
      fs.mkdirSync(e.HOME, { recursive: true });
      return e;
    };
    const install = (e, args) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, "install", "install.mjs"), ...args], { env: e, encoding: "utf8", windowsHide: true, cwd: scratch });
      t.log(`$ node install/install.mjs ${args.join(" ")}\n  exit ${r.status}\n  stdout: ${(r.stdout || "").trim().replace(/\n/g, "\n          ")}${r.stderr ? `\n  stderr: ${r.stderr.trim()}` : ""}`);
      return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
    };
    const skillSource = fs.readFileSync(path.join(ROOT, SKILLS.codex), "utf8");
    const base = ["--no-plugins", "--no-build"];

    // Codex skill: dry run, install, rerun, a change of yours, --force, uninstall.
    const a = env("codex-skill");
    const skillFile = path.join(a.CODEX_HOME, "skills", "zodchi-flow", "SKILL.md");
    const dry = install(a, [...base, "--dry-run"]);
    t.ok(dry.code === 0 && dry.out.includes(skillFile) && !fs.existsSync(path.join(a.CODEX_HOME)), "a dry run names the skill file and writes nothing");
    const first = install(a, base);
    t.eq([first.code, fs.existsSync(skillFile) && fs.readFileSync(skillFile, "utf8") === skillSource], [0, true], "the Codex skill is installed in $CODEX_HOME/skills/zodchi-flow, as the repository has it");
    t.ok(JSON.parse(fs.readFileSync(path.join(a.ZODCHI_HOME, "installed.json"), "utf8")).files[skillFile], "it is recorded as installed by zodchi");
    const again = install(a, base);
    t.ok(again.code === 0 && !again.out.includes("update ") && fs.readFileSync(skillFile, "utf8") === skillSource, "a rerun changes nothing");
    fs.writeFileSync(skillFile, `${skillSource}\nMy own line.\n`);
    const mine = install(a, base);
    t.ok(mine.code === 0 && mine.out.includes(`skip (not installed by zodchi or changed by you): ${skillFile}`) && fs.readFileSync(skillFile, "utf8").endsWith("My own line.\n"), "a skill changed by you is not overwritten");
    t.ok(mine.out.includes("left as they are") && !mine.out.includes(`Codex skill zodchi-flow: ${skillFile}`), "and the summary does not claim it installed it");
    const kept = install(a, ["--no-plugins", "--uninstall"]);
    t.ok(kept.code === 0 && fs.existsSync(skillFile) && kept.out.includes(`keep (changed by you): ${skillFile}`), "uninstall leaves a skill you changed");
    const forced = install(a, [...base, "--force"]);
    t.eq([forced.code, fs.readFileSync(skillFile, "utf8") === skillSource], [0, true], "--force puts the repository's skill back");
    const other = path.join(a.CODEX_HOME, "skills", "my-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "---\nname: my-skill\n---\n");
    const gone = install(a, ["--no-plugins", "--uninstall"]);
    t.ok(gone.code === 0 && !fs.existsSync(skillFile) && !fs.existsSync(path.dirname(skillFile)), "uninstall removes the skill and its folder");
    t.ok(fs.existsSync(other), "and nothing else in the skills folder of Codex");

    // A file of the same path that zodchi did not write is never overwritten, and never removed.
    const b = env("foreign-skill");
    const foreign = path.join(b.CODEX_HOME, "skills", "zodchi-flow", "SKILL.md");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, "a skill of my own with this name\n");
    const skipped = install(b, base);
    t.ok(skipped.code === 0 && fs.readFileSync(foreign, "utf8") === "a skill of my own with this name\n" && skipped.out.includes("skip (not installed by zodchi"), "a skill of that name that zodchi did not write is left alone");
    install(b, ["--no-plugins", "--uninstall"]);
    t.eq(fs.readFileSync(foreign, "utf8"), "a skill of my own with this name\n", "and uninstall does not remove it");

    // The default folder when CODEX_HOME is not set.
    const d = env("default-home");
    delete d.CODEX_HOME;
    install(d, base);
    t.ok(fs.existsSync(path.join(d.HOME, ".codex", "skills", "zodchi-flow", "SKILL.md")), "without $CODEX_HOME the skill goes to ~/.codex/skills");
    install(d, ["--no-plugins", "--uninstall"]);
    t.ok(!fs.existsSync(path.join(d.HOME, ".codex", "skills", "zodchi-flow")), "and comes out again");

    // --no-codex-skill: nothing written; an earlier copy is left alone by install and by uninstall.
    const c = env("no-codex-skill");
    const skip = install(c, [...base, "--no-codex-skill"]);
    t.ok(skip.code === 0 && !fs.existsSync(c.CODEX_HOME) && /Codex skill: skipped/.test(skip.out), "--no-codex-skill writes no skill");
    install(c, base);
    const cFile = path.join(c.CODEX_HOME, "skills", "zodchi-flow", "SKILL.md");
    install(c, ["--no-plugins", "--uninstall", "--no-codex-skill"]);
    t.ok(fs.existsSync(cFile), "--no-codex-skill on uninstall leaves the installed skill");
    install(c, ["--no-plugins", "--uninstall"]);
    t.ok(!fs.existsSync(cFile), "a plain uninstall afterwards removes it: it is still recorded");

    // The Claude Code skill rides in the zodchi-core plugin. The installer runs against a fake `claude` that keeps the
    // marketplaces and plugins it is told about, so what Claude Code would read is the folder the plugin is installed from.
    const p = env("plugin");
    const bin = path.join(scratch, "plugin", "bin");
    const stateFile = path.join(scratch, "plugin", "plugin-state.json");
    const cli = WIN ? path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "cli.js") : path.join(bin, "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const file = process.env.FAKE_PLUGIN_STATE;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: [], installed: [], calls: [] };
s.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const done = (text, code = 0) => { save(); if (text) console.log(text); process.exit(code); };
if (args[0] === "--version") done("9.9.9 (fake)");
if (args[0] === "plugin" && args[1] === "marketplace") {
  if (args[2] === "list") done(JSON.stringify(s.marketplaces));
  if (args[2] === "add") {
    const dir = path.resolve(args[3]);
    const name = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "utf8")).name;
    s.marketplaces = s.marketplaces.filter((m) => m.name !== name).concat({ name, source: "directory", path: dir });
  }
  if (args[2] === "remove") s.marketplaces = s.marketplaces.filter((m) => m.name !== args[3]);
  done("");
}
if (args[0] === "plugin" && ["install", "update", "uninstall"].includes(args[1])) {
  const [plugin, market] = args[2].split("@");
  const entry = s.marketplaces.find((m) => m.name === market);
  if (!entry) done("no such marketplace", 1);
  const source = JSON.parse(fs.readFileSync(path.join(entry.path, ".claude-plugin", "marketplace.json"), "utf8")).plugins.find((x) => x.name === plugin).source;
  s.installed = s.installed.filter((x) => x.plugin !== plugin);
  if (args[1] !== "uninstall") s.installed.push({ plugin, from: path.join(entry.path, source) });
  done("");
}
done("fake claude: not supported", 2);
`);
    if (WIN) fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\n");
    else fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
    const pathKey = Object.keys(p).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const holds = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => fs.existsSync(path.join(dir, n)));
    // On Windows only a claude.exe is found by name, so a real one on PATH must not answer first; elsewhere the fake is first.
    p[pathKey] = [bin, ...(p[pathKey] || "").split(path.delimiter).filter((x) => x && !(WIN && holds(x)))].join(path.delimiter);
    p.FAKE_PLUGIN_STATE = stateFile;
    const plug = install(p, ["--dev", "--no-build"]);
    t.eq(plug.code, 0, "the installer runs against the fake Claude Code");
    const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const core = state().installed.find((x) => x.plugin === "zodchi-core");
    t.ok(core, "zodchi-core is installed from the marketplace");
    const inPlugin = path.join(core.from, "skills", "zodchi-flow", "SKILL.md");
    t.ok(fs.existsSync(path.join(core.from, ".claude-plugin", "plugin.json")) && fs.existsSync(inPlugin), "the folder it is installed from is a plugin and holds skills/zodchi-flow/SKILL.md");
    t.eq(fs.readFileSync(inPlugin, "utf8"), fs.readFileSync(path.join(ROOT, SKILLS.claude), "utf8"), "the Claude Code skill is the repository's");
    t.ok(fs.existsSync(path.join(p.CODEX_HOME, "skills", "zodchi-flow", "SKILL.md")), "the same run put the Codex skill in place");
    const out = install(p, ["--uninstall"]);
    t.ok(out.code === 0 && state().calls.some((c) => c[0] === "plugin" && c[1] === "uninstall" && c[2] === "zodchi-core@zodchi"), "uninstall takes zodchi-core, and with it the Claude Code skill, out of Claude Code");
    t.ok(!state().installed.some((x) => x.plugin === "zodchi-core") && !fs.existsSync(path.join(p.CODEX_HOME, "skills", "zodchi-flow")), "and removes the Codex skill");
  });

  scenario("flow-entry-local", "from a Codex session on the local gateway: the Codex skill's steps as written (brief from its template, args from its example, the run command from another folder, the result read, the finished run resumed) reach the engine and end approved", async (t) => {
    const skill = readSkill(SKILLS.codex);
    const f = flowWorld(t, "flow-entry-local");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await startBySkill(t, f, skill);
    readLikeSkill(t, f, skill, res);
    t.eq(res.json.models, { expertWriter: { provider: "codex", model: "fake-writer", effort: "medium" }, reviewer: { provider: "codex", model: "fake-reviewer", effort: "high" } }, "the pair: two distinct Codex models, pinned");
    const turn = readJsonl(path.join(f.w.codex, "fake-turns.jsonl")).find((x) => x.step === "write");
    t.ok(turn.prompt.includes("## Review boundary") && turn.prompt.includes("a clamp that lets a value out of its range"), "the writer got the brief made from the template, with its review boundary");
    const review = readJsonl(path.join(f.w.codex, "fake-turns.jsonl")).find((x) => x.step === "review 1");
    t.ok(review.prompt.includes("Out of scope: a second run started at the same instant"), "the reviewer got the review boundary");
    const again = await resumeBySkill(t, f, skill, res.json.runId);
    t.eq([again.code, again.json.verdict, f.steps()], [0, "approved", ["write", "review 1"]], "the skill's resume of a finished run prints its result and runs nothing");
    // A run the engine refuses ends with exit 2 and `refused`, nothing claimed: what the skill says to read.
    const refused = await startBySkill(t, f, skill, { args: { branch: "elsewhere" } });
    t.ok(refused.code === 2 && /args\.branch is not supported/.test(refused.json.refused), "an option outside the engine's subset: exit 2, `refused` names it");
  });

  scenario("flow-entry-cut", "from a Claude Code session: the Claude Code skill's steps as written, with the run cut after its write step was submitted: the run id is found as the skill says and its resume goes on, one model turn per step, never a new run", async (t) => {
    const skill = readSkill(SKILLS.claude);
    const f = flowWorld(t, "flow-entry-cut");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const cut = await startBySkill(t, f, skill, { env: { ZODCHI_FLOW_CUT: "submit write" } });
    t.eq(cut.code, 75, "the process was cut right after the write step was submitted");
    t.eq(f.claim().status, "open", "the claim stays open across the cut");
    const id = runIdOfCut(f.w.zhome, f.r, "clamp");
    t.ok(id && /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(id), `the run id is found from the journal folder as the skill says (${id})`);
    const res = await resumeBySkill(t, f, skill, id);
    readLikeSkill(t, f, skill, res);
    t.eq(res.json.runId, id, "the resume is the same run");
    t.eq(f.steps(), ["write", "review 1"], "each model step ran once");
    t.eq(fs.readdirSync(path.join(f.w.zhome, "flows")).length, 1, "no second run was started");
    t.eq(runIdOfCut(f.w.zhome, f.r, "clamp"), null, "a finished run is not taken for a cut one");
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
