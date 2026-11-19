// The gates of the workflows: facts from one command of the loaded plugin copy, claims, and the rule for a job that ended unknown.
//
// Two layers. The helper (core/scripts/gate.mjs) is run for real, on repositories and a home folder made here: it prints the facts a
// gate decides from, closes the stale claim of a finished package and nothing else, and is found by the bootstrap in the plugin copy
// the registration names, never in a checkout. The workflows (code-package, branch-review, asset-round, and the text of the others)
// are run the way Claude Code runs them, as the body of an async function with `agent` scripted by step label: what the workflow
// decides from the helper's printed line, from an exit code and from the answer of a gateway step is tested on those answers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { specIn } from "../spec-arg.mjs";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const WORKFLOWS = [
    "core/workflows/code-package.js", "core/workflows/incident-triage.js", "core/workflows/ops-script.js",
    "domains/gamedev-unity/workflows/asset-round.js", "domains/gamedev-unity/workflows/method-question.js",
    "domains/gamedev-unity/workflows/rubric-probe.js", "domains/gamedev-unity/workflows/unity-check.js", "domains/web-apps/workflows/branch-review.js",
  ];
  const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const mail = ["tester", "example.test"].join("@");

  // ---------------------------------------------------------------------------------------------------------------
  // The helper, run for real

  /** A scratch folder, removed when the scenario ends. */
  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-gate-${name}-`));
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir.replace(/\\/g, "/");
  };
  // PATH without any folder that holds a zodchi program: the account of the real machine is never asked.
  const cleanPath = () => (process.env.PATH || "").split(path.delimiter).filter((d) => d && !["zodchi", "zodchi.exe"].some((n) => fs.existsSync(path.join(d, n)))).join(path.delimiter);
  const envFor = (home, extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, PATH: cleanPath(), CLAUDE_CONFIG_DIR: path.join(home, "claude-config"), ZODCHI_PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "", ...extra });
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "user.name=tester", "-c", `user.email=${mail}`, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitFile = (repo, file, text, message) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, "add", "--", file);
    git(repo, "commit", "-m", message, "--", file);
    return git(repo, "rev-parse", "HEAD");
  };
  /** The helper's one line, parsed, with its exit code and the raw stdout. */
  const helper = (cmd, spec, home, { script = GATE, cwd } = {}) => {
    const r = spawnSync(process.execPath, [script, cmd, JSON.stringify(spec)], { encoding: "utf8", env: envFor(home), cwd });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
    return { code: r.status, out: r.stdout, err: r.stderr, json };
  };

  scenario("workflow-gate-helper-facts", "the helper prints one line with the role table, Git state, dirty list, ignore rule, verify skill, REVIEW.md, config and the brief's Review boundary, and says which plugin copy it is", async (t) => {
    const home = scratch(t, "facts"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(`${repo}/.gitignore`, ".agent-tmp/\n.zodchi/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "base");
    commitFile(repo, "REVIEW.md", "x\n", "review");
    commitFile(repo, ".claude/skills/verify/SKILL.md", "x\n", "skill");
    fs.writeFileSync(`${repo}/new.txt`, "dirty\n");
    fs.mkdirSync(`${home}/.zodchi`, { recursive: true });
    fs.writeFileSync(`${home}/.zodchi/models.json`, JSON.stringify({ roles: { writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] }, other: { candidates: [] } } }));
    fs.mkdirSync(`${repo}/.zodchi`);
    fs.writeFileSync(`${repo}/.zodchi/models.json`, JSON.stringify({ roles: { writer: { candidates: [{ provider: "claude", model: "haiku" }] } } }));
    fs.writeFileSync(`${home}/.zodchi/config.json`, JSON.stringify({ parallel: "shared-branch" }));
    const brief = `${home}/brief.md`;
    fs.writeFileSync(brief, "# Brief\n\n## Goal\nx\n\n## review boundary (what matters)\r\nImportant: a.\r\nOut of scope: b.\n\n## Checks\n- c\n");
    const r = helper("code-package", { api: 1, repo, brief, label: "mine", claimsKey: "k", want: ["writer", "reviewer"] }, home);
    t.eq(r.code, 0, "exit code 0");
    t.ok(r.out.endsWith("\n") && r.out.trim().split("\n").length === 1 && r.json, "stdout is one line of JSON and nothing else");
    t.ok(r.out.length < 4000, `compact (${r.out.length} bytes)`);
    const f = r.json;
    t.eq([f.ok, f.api, f.git, f.branch, /^[0-9a-f]{40}$/.test(f.head)], [true, 1, true, "main", true], "git facts");
    t.eq(f.dirty, ["new.txt"], "the dirty list");
    t.eq([f.verifySkill, f.reviewMd], [true, true], "verify skill and REVIEW.md are read from HEAD");
    t.eq(f.ignoreExit, 0, "the ignore rule is checked");
    t.ok(/^\S+:\d+:\S.*\t\.agent-tmp\/gateway\/x$/.test(f.ignoreLine), `and its printed rule is given (${JSON.stringify(f.ignoreLine)})`);
    t.eq(Object.keys(f.roles).sort(), ["reviewer", "writer"], "only the wanted roles are printed");
    t.eq(f.roles.writer.candidates[0].model, "haiku", "the repository's table replaces the home table's role");
    t.eq(f.config, { parallel: "shared-branch" }, "the owner config");
    t.eq(f.boundary, "Important: a.\nOut of scope: b.\n", "the Review boundary section, up to the next ## heading");
    t.eq([f.account, typeof f.accountError], [null, "string"], "no zodchi: the account is null and says why");
    t.eq(f.plugin.root, path.join(ROOT, "core").replace(/\\/g, "/"), "the plugin copy it runs from is named");
    t.ok(f.plugin.name === "zodchi-core" && f.plugin.commit, "with its name and commit");
    // a repository outside Git: facts, not a crash
    const plain = `${home}/plain`;
    fs.mkdirSync(plain);
    const p = helper("code-package", { api: 1, repo: plain, brief, label: "mine", claimsKey: "k", want: [] }, home);
    t.eq([p.code, p.json.ok, p.json.git, p.json.head, p.json.dirty], [0, true, false, "", []], "outside a Git work tree it says so");
  });

  scenario("workflow-gate-helper-claims", "the gate closes an open claim of another package only when its files are clean, all its commits are on the default branch and nothing was written to it for hours; strays in the folder are never read or made", async (t) => {
    const home = scratch(t, "claims"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    for (const f of ["f1.txt", "f2.txt", "g.txt", "b.txt", "h.txt"]) fs.writeFileSync(`${repo}/${f}`, "base\n");
    fs.writeFileSync(`${repo}/.gitignore`, ".agent-tmp/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    commitFile(repo, "f1.txt", "done work\n", "done: round 1");
    git(repo, "switch", "-q", "-c", "feature");
    commitFile(repo, "b.txt", "unmerged\n", "branchy: round 1");
    git(repo, "switch", "-q", "main");
    fs.writeFileSync(`${repo}/f2.txt`, "uncommitted\n");
    const dir = `${home}/.zodchi/packages/k`;
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 10 * 3600 * 1000);
    const claim = (label, files, extra = {}, age = old) => {
      const file = `${dir}/${label}.json`;
      fs.writeFileSync(file, JSON.stringify({ label, status: "open", files, branch: "main", base, ...extra }));
      if (age) fs.utimesSync(file, age, age);
    };
    claim("mine", ["g.txt"]);
    claim("done", ["f1.txt"]);
    claim("dirty", ["f2.txt"]);
    claim("fresh", ["f1.txt"], {}, null);
    claim("nocommit", ["h.txt"]);
    claim("branchy", ["b.txt"]);
    claim("closed-already", ["f1.txt"], { status: "closed" });
    fs.writeFileSync(`${dir}/done.json.bak-1`, fs.readFileSync(`${dir}/done.json`));
    fs.writeFileSync(`${dir}/x.bak.json`, JSON.stringify({ label: "x", status: "open", files: ["f1.txt"], base }));
    fs.writeFileSync(`${dir}/liar.json`, JSON.stringify({ label: "someone-else", status: "open", files: ["f1.txt"], base }));
    const before = fs.readdirSync(dir).sort();
    const brief = `${home}/brief.md`;
    fs.writeFileSync(brief, "## Review boundary\nx\n");
    const r = helper("code-package", { api: 1, repo, brief, label: "mine", claimsKey: "k", want: [] }, home);
    t.eq(r.code, 0, "exit code 0");
    const c = r.json.claims;
    t.eq(c.closed.map((x) => x.label), ["done"], "only the finished package's claim was closed");
    t.ok(/no uncommitted changes/.test(c.closed[0].reason) && /on main/.test(c.closed[0].reason), `with the reason (${c.closed[0].reason})`);
    const kept = Object.fromEntries(c.kept.map((k) => k.split(": ")).map(([l, ...w]) => [l, w.join(": ")]));
    t.ok(/uncommitted changes in its files: f2\.txt/.test(kept.dirty), "a claim whose files have uncommitted changes is kept");
    t.ok(/minute/.test(kept.fresh), "a claim written to a moment ago may be running: kept");
    t.ok(/no commit after its base/.test(kept.nocommit), "a claim with no commit shows no finished work: kept");
    t.ok(/commits not on main/.test(kept.branchy), "a claim with a commit that is not on the default branch is kept");
    t.eq(Object.keys(kept).sort(), ["branchy", "dirty", "fresh", "nocommit"], "nothing else was weighed: not our own claim, not a closed one, not a stray");
    t.eq(c.open.map((x) => x.label).sort(), ["branchy", "dirty", "fresh", "mine", "nocommit"], "the open list is what is left, our own claim included");
    t.ok(c.skipped.includes("done.json.bak-1") && c.skipped.includes("x.bak.json") && c.skipped.includes("liar.json"), `strays are named as skipped (${c.skipped})`);
    const done = JSON.parse(fs.readFileSync(`${dir}/done.json`, "utf8"));
    t.eq([done.status, done.closedBy, done.files, done.base], ["closed", "the gate of mine", ["f1.txt"], base], "the closed claim keeps its fields and says who closed it");
    t.ok(!!done.closedAt && !!done.closedReason, "with the time and the reason");
    t.eq(fs.readdirSync(dir).sort(), before, "no file was added to or removed from the claims folder: no backup, no temp file, no lock left");
    t.eq(JSON.parse(fs.readFileSync(`${dir}/dirty.json`, "utf8")).status, "open", "a claim that was kept is untouched");
    const again = helper("code-package", { api: 1, repo, brief, label: "mine", claimsKey: "k", want: [] }, home);
    t.eq([again.json.claims.closed, again.json.claims.open.map((x) => x.label).includes("done")], [[], false], "a second gate closes nothing more and no longer lists it");
    const strict = helper("code-package", { api: 1, repo, brief, label: "mine", claimsKey: "k", want: [], staleHours: 0 }, home);
    t.ok(strict.json.claims.closed.map((x) => x.label).includes("fresh"), "staleHours 0 lets a recently written claim of a finished package go too (the owner's choice)");
  });

  scenario("workflow-gate-helper-bootstrap", "the helper is found in the plugin copy the registration names, never in a checkout; a copy without it stops with the places looked at; the api of the copy must match", async (t) => {
    const home = scratch(t, "boot");
    const BOOT = vm.runInNewContext(source("core/workflows/code-package.js").match(/^const GATE_BOOT = (.*)$/m)[1]);
    const copy = (name, withHelper) => {
      const dir = `${home}/${name}`;
      fs.mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
      fs.writeFileSync(`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name: "zodchi-core", version: "1.0.0-dev" }));
      if (withHelper) { fs.mkdirSync(`${dir}/scripts`); fs.copyFileSync(GATE, `${dir}/scripts/gate.mjs`); }
      return dir;
    };
    const ok = copy("copy-ok", true), stale = copy("copy-stale", false);
    // a checkout of this repository lies in the folder the command runs from: it must never be used
    const checkout = `${home}/checkout`;
    fs.mkdirSync(`${checkout}/core/scripts`, { recursive: true });
    fs.copyFileSync(GATE, `${checkout}/core/scripts/gate.mjs`);
    const register = (entries) => {
      fs.mkdirSync(`${home}/claude-config/plugins`, { recursive: true });
      fs.writeFileSync(`${home}/claude-config/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: { "zodchi-core@zodchi": entries } }));
    };
    const spec = JSON.stringify({ api: 1, file: `${home}/none.json` });
    const boot = (repo, extra = {}, specText = spec) => {
      const r = spawnSync(process.execPath, ["-e", BOOT, "--", repo, "ledger", specText], { encoding: "utf8", cwd: checkout, env: envFor(home, extra) });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* checked below */ }
      return { code: r.status, json, out: r.stdout };
    };
    register([{ scope: "user", installPath: stale }]);
    let r = boot("/some/repo");
    t.eq([r.code, r.json.ok], [4, false], "a registered copy without scripts/gate.mjs: exit 4");
    t.ok(r.json.tried.length === 1 && r.json.tried[0].startsWith(stale) && /no scripts\/gate\.mjs/.test(r.json.tried[0]), `it names the place it looked at (${JSON.stringify(r.json.tried)})`);
    t.ok(!r.json.tried.some((p) => p.includes(checkout)), "the checkout it runs from is not a place it looks at");
    register([{ scope: "user", installPath: ok }]);
    r = boot("/some/repo");
    // macOS: the temp folder is a symlink (/var -> /private/var), so both sides are compared as real paths
    t.eq([r.code, fs.realpathSync(r.json.plugin.root), r.json.plugin.via], [0, fs.realpathSync(ok), "installed_plugins.json, scope user"], "the registered copy with the helper runs it, and the answer names the copy and how it was found");
    register([{ scope: "user", installPath: stale }, { scope: "local", projectPath: "/project/a", installPath: ok }]);
    t.eq(fs.realpathSync(boot("/project/a").json.plugin.root), fs.realpathSync(ok), "an install made for this project is preferred");
    t.eq(boot("/project/b").code, 4, "an install made for another project is not used");
    register([{ scope: "user", installPath: stale }]);
    r = boot("/some/repo", { ZODCHI_PLUGIN_ROOT: ok });
    t.eq([r.code, r.json.plugin.via], [0, "ZODCHI_PLUGIN_ROOT"], "the explicit folder wins over the registration");
    r = boot("/some/repo", { CLAUDE_PLUGIN_ROOT: ok });
    t.eq([r.code, r.json.plugin.via], [0, "CLAUDE_PLUGIN_ROOT"], "so does the folder Claude Code names");
    r = boot("/some/repo", { ZODCHI_PLUGIN_ROOT: checkout });
    t.eq(r.code, 4, "a folder that is no zodchi-core plugin (no manifest) is not taken");
    register([{ scope: "user", installPath: ok }]);
    r = boot("/some/repo", {}, JSON.stringify({ api: 2, file: "x" }));
    t.eq([r.code, r.json.ok], [3, false], "a copy that speaks another api than the workflow: exit 3");
    t.ok(/does not match the workflow/.test(r.json.error), "with the reason");
    fs.rmSync(`${home}/claude-config`, { recursive: true });
    t.eq(boot("/some/repo").code, 4, "no registration at all: exit 4");
  });

  scenario("workflow-gate-helper-ledger-and-errors", "the ledger gate reads the asset ledger itself; a bad call is exit 2 with a line, never a crash", async (t) => {
    const home = scratch(t, "ledger");
    const file = `${home}/asset.ledger.json`;
    fs.writeFileSync(file, JSON.stringify({
      method: { name: "m", afterRound: 1 }, lookMethod: "",
      rounds: [{ n: 1, owner: "needs work" }, { n: 2, owner: "accepted with notes" }, { n: 3, owner: null }],
    }));
    let r = helper("ledger", { api: 1, file, stage: 1 }, home);
    t.eq([r.code, r.json.hasMethod, r.json.lastRound, r.json.lastVerdict, r.json.roundsSinceMethod, r.json.accepted], [0, true, 3, "", 2, true], "stage 1: method, last round, its (empty) verdict, rounds since the method, acceptance");
    t.ok(/^\d{4}(-\d\d){2}T\d\d(:\d\d){2}Z$/.test(r.json.startedAt), "startedAt is the time now");
    r = helper("ledger", { api: 1, file, stage: 2 }, home);
    t.eq(r.json.hasMethod, false, "stage 2 reads lookMethod, which is empty here");
    r = helper("ledger", { api: 1, file, stage: 1, accepted: "approved" }, home);
    t.eq(r.json.accepted, false, "the acceptance word is the caller's");
    r = helper("ledger", { api: 1, file: `${home}/none.json` }, home);
    t.eq([r.code, r.json.ok, /does not exist/.test(r.json.error)], [0, false, true], "a missing ledger is a fact in the line, not a crash");
    r = helper("nothing", { api: 1 }, home);
    t.eq([r.code, r.json.ok], [2, false], "an unknown command: exit 2");
    const bad = spawnSync(process.execPath, [GATE, "ledger", "{not json"], { encoding: "utf8", env: envFor(home) });
    t.eq([bad.status, JSON.parse(bad.stdout).ok], [2, false], "a spec that is not JSON: exit 2");
    r = helper("code-package", { api: 1, repo: home }, home);
    t.eq([r.code, r.json.ok], [2, false], "a missing field of the spec: exit 2");
    const b = helper("branch-review", { api: 1, repo: ROOT, base: "HEAD" }, home);
    t.eq([b.code, b.json.ok, b.json.files, b.json.baseSha === b.json.head], [0, true, [], true], "branch-review: the range from a base that is HEAD is empty");
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The workflows, on scripted answers

  /** Runs a workflow body once. `answer(label, prompt, calls)` gives each step's result. */
  async function runWorkflow(rel, args, answer) {
    const calls = [];
    const sandbox = {
      args,
      phase: () => {},
      log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt, opts }); return answer(opts.label, prompt, calls); },
    };
    const fn = vm.runInNewContext(`(async () => {\n${source(rel).replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: rel });
    let out, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
  const printed = (facts, over = {}) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, ...facts }) + "\n", ...over });
  const CONNECTED = { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null };
  const CP_FACTS = {
    roles: {}, modelsErrors: [], account: null, accountError: "none", git: true, head: "abc1234", branch: "main", dirty: [], ignoreExit: 0, ignoreLine: ".gitignore:3:.agent-tmp/\t.agent-tmp/gateway/x",
    verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "Important: x.\n",
    claims: { dir: "claims-dir/r", open: [], closed: [], kept: [], skipped: [], notes: [] },
  };
  const CP_ARGS = {
    label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"],
    models: { writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus", effort: "medium" }] } },
  };
  /** The default answers of a code-package run that approves at once. */
  const cpAnswers = (over = {}) => (label) => {
    if (over[label] !== undefined) return typeof over[label] === "function" ? over[label]() : over[label];
    if (label === "gate pkg") return printed(CP_FACTS);
    if (label === "claim pkg") return printed({ conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: "/h/.zodchi/packages/-r/pkg.json" });
    if (label === "write pkg") return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
    if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
    if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "l" }] };
    if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: ["src/a.js"] };
    if (label.startsWith("review ")) return { verdict: "approved", findings: [], gateway: "final", infra: "" };
    if (label.startsWith("close claim")) return { ok: true, summary: "closed" };
    if (label.startsWith("claim more")) return printed({ conflicts: [], others: [], added: [] });
    throw new Error(`no scripted answer for the step "${label}"`);
  };
  const CODEX_REVIEWER = { reviewer: { candidates: [{ provider: "codex", model: "gpt-x", effort: "medium" }] } };

  scenario("workflow-gate-code-package-decides-from-the-line", "code-package runs one command at the gate and decides from the printed line and the exit code; a missing or stale helper stops the run before anything is claimed", async (t) => {
    const r = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers());
    t.eq(r.out.approved, true, "a run on a normal gate answer approves");
    const gate = r.of(/^gate /);
    t.eq(gate.length, 1, "one gate step");
    t.eq(gate[0].opts.schema.required, ["exitCode", "stdout"], "its answer is the exit code and the one string the command printed");
    t.eq((gate[0].prompt.match(/node -e /g) || []).length, 1, "its prompt holds one command");
    t.ok(gate[0].prompt.includes("do not parse, summarize, reorder or shorten it"), "and tells the runner to return the output as it is");
    const gateSpec = specIn(gate[0].prompt, "code-package") || {};
    t.ok(Object.keys(gateSpec).join() === "api,repo,brief,label,claimsKey,want" && gateSpec.api === 1 && gateSpec.repo === "/r" && gateSpec.brief === "/r/brief.md" && gateSpec.label === "pkg" && /^.+$/.test(gateSpec.claimsKey) && JSON.stringify(gateSpec.want) === '["writer","reviewer"]', "the command carries the spec: repo, brief, label, claims key, wanted roles");
    t.ok(!/ZODCHI_PLUGIN_ROOT=/.test(gate[0].prompt), "without args.pluginRoot it does not set the folder");
    t.eq(r.out.pluginCopy, { path: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" }, "the result names the plugin copy: path and commit");
    const named = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, pluginRoot: "/my/copy/core" }, cpAnswers());
    t.ok(named.of(/^gate /)[0].prompt.includes("ZODCHI_PLUGIN_ROOT='/my/copy/core' node -e"), "args.pluginRoot is handed to the command");

    // the helper could not be found: exit 4 and the places it looked at
    const missing = { exitCode: 4, stdout: JSON.stringify({ ok: false, api: 0, error: "the registered zodchi-core plugin copy has no scripts/gate.mjs", tried: ["/cache/zodchi-core (no scripts/gate.mjs)"] }) + "\n" };
    const m = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": missing }));
    t.ok(/^gate \(.*no scripts\/gate\.mjs.*looked in \["\/cache\/zodchi-core/.test(m.out.stoppedAt), `a missing helper stops at the gate with the places (${m.out.stoppedAt})`);
    t.ok(/Update the zodchi-core plugin/.test(m.out.next), "and says what to do");
    t.eq(m.calls.map((c) => c.label), ["gate pkg"], "nothing was claimed");
    // an exit code that disagrees with the line, a line that is not JSON, a stale api, no answer
    const mismatches = {
      "exit 1 with ok true": printed(CP_FACTS, { exitCode: 1 }),
      "no JSON": { exitCode: 0, stdout: "retold: the gate looks fine" },
      "api 2": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 2, plugin: PLUGIN }) },
      "no plugin copy named": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1 }) },
      "no result": null,
    };
    for (const [what, answer] of Object.entries(mismatches)) {
      const x = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": answer }));
      t.ok(String(x.out.stoppedAt).startsWith("gate (") && x.calls.length === 1, `${what}: the gate stops, nothing claimed (${x.out.stoppedAt})`);
    }
    // the line may come wrapped in other text from the runner: the JSON line is taken
    const wrapped = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": printed(CP_FACTS, { stdout: `output follows\n${JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, ...CP_FACTS })}\n` }) }));
    t.eq(wrapped.out.approved, true, "the JSON line is found among other lines");
    // decisions come from the facts
    const overlap = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, dirty: ["src/a.js"] }) }));
    t.ok(String(overlap.out.refused).includes("Uncommitted changes in package files: src/a.js"), "a dirty package file in the printed list refuses the package");
    const noGit = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, git: false, head: "" }) }));
    t.ok(String(noGit.out.refused).includes("not a Git work tree"), "no Git work tree refuses");
    const noIgnore = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: { ...CP_ARGS.models, ...CODEX_REVIEWER } }, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, account: CONNECTED, ignoreExit: 1, ignoreLine: "" }) }));
    t.ok(String(noIgnore.out.refused).includes("does not ignore .agent-tmp/"), "a gateway package in a repository that does not ignore .agent-tmp/ is refused");
    const liar = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: { ...CP_ARGS.models, ...CODEX_REVIEWER } }, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, account: CONNECTED, ignoreExit: 0, ignoreLine: "" }) }));
    t.ok(String(liar.out.refused).includes("does not ignore .agent-tmp/"), "an exit 0 without the printed rule is not believed");
    const roles = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: undefined }, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, roles: CP_ARGS.models }) }));
    t.eq(roles.out.approved, true, "the role table is the one the helper printed");
    // claims the gate closed are said in the result
    const closed = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({ "gate pkg": printed({ ...CP_FACTS, claims: { ...CP_FACTS.claims, closed: [{ label: "old", reason: "its files have no uncommitted changes, its commits are all on main, and nothing was written to it for 3 hour(s)" }] } }) }));
    t.eq(closed.out.closedClaims.map((c) => c.label), ["old"], "a stale claim the gate closed is in the result");
    t.ok(closed.out.notes.some((n) => n.startsWith("The gate closed the open claim of old")), "and in the notes");
    t.ok(r.out.notes === undefined, "no note when nothing was closed");
  });

  scenario("workflow-gate-code-package-claims-and-choice", "claims are read as <label>.json only and never backed up; the claim records its tmp folder; the result says which candidate each role took and the effort handed to Claude steps", async (t) => {
    const r = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers());
    const claimStep = r.of(/^claim pkg$/)[0], claimPrompt = claimStep.prompt, closePrompt = r.of(/^close claim/)[0].prompt;
    t.ok((claimPrompt.match(/node -e /g) || []).length === 1 && specIn(claimPrompt, "claim") && specIn(claimPrompt, "claim").api === 1 && specIn(claimPrompt, "claim").dir.startsWith("~/.zodchi/packages/"), "the claim step runs the claim helper's one command (which reads only <label>.json whose label is its name)");
    t.eq(claimStep.opts.schema.required, ["exitCode", "stdout"], "and returns its exit code and printed line, nothing it read itself");
    t.ok(claimPrompt.includes("never touch the claims folder or its lock yourself"), "the runner never writes a claim itself");
    t.ok(closePrompt.includes("make no backup"), "the close step changes the file in place and makes no backup either");
    for (const p of [claimPrompt, closePrompt]) t.ok(!p.includes("every *.json file"), "never the glob that reads a .bak");
    t.eq(specIn(r.of(/^claim pkg$/)[0].prompt, "claim").tmp, "/r/.agent-tmp/pkg", "the claim records the package's tmp folder (the gate uses it to tell a running package from a finished one)");
    const more = await runWorkflow("core/workflows/code-package.js", CP_ARGS, cpAnswers({
      "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js", "/r/src/n.js"], unverified: [] }, "status write pkg": { ok: true, paths: ["src/a.js", "src/n.js"] },
    }));
    const moreSpec = specIn(more.of(/^claim more write pkg$/)[0].prompt, "claim-more");
    t.ok(moreSpec && moreSpec.api === 1 && moreSpec.dir.startsWith("~/.zodchi/packages/"), "the extension step runs the claim-more helper the same way");
    t.eq(r.out.choice, ["writer: claude/sonnet (effort high), the first candidate", "reviewer: claude/opus (effort medium), the first candidate"], "the choice of each role is in the result");
    t.eq(r.out.effort, { writer: "high", reviewer: "medium" }, "the effort handed to the Claude steps is in the result");
    t.eq([r.of(/^write pkg$/)[0].opts.effort, r.of(/^review 1$/)[0].opts.effort], ["high", "medium"], "and was passed to agent() as its effort");
    const odd = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: { writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "turbo" }] }, reviewer: CP_ARGS.models.reviewer } }, cpAnswers());
    t.ok(odd.of(/^write pkg$/)[0].opts.effort === undefined && odd.out.effort.writer === "the agent default", "an effort agent() does not know is not passed, and the result says the agent's own default applied");
    const skipped = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: { writer: { candidates: [{ provider: "codex", model: "gpt-1", effort: "high" }, { provider: "claude", model: "sonnet", effort: "high" }] }, reviewer: CP_ARGS.models.reviewer } }, cpAnswers());
    t.ok(skipped.out.choice[0].includes("after skipping codex/gpt-1 (effort high): the quota is unknown"), `a skipped candidate is named with the reason (${skipped.out.choice[0]})`);
  });

  scenario("workflow-gate-unknown-keeps-its-key", "a gateway job that ended unknown is never submitted again by a workflow: the run stops with the key, the reason and the decision for the person; failed is resubmitted only on evidence the request was never sent", async (t) => {
    const args = { ...CP_ARGS, models: { ...CP_ARGS.models, ...CODEX_REVIEWER } };
    const gate = printed({ ...CP_FACTS, account: CONNECTED });
    const u = await runWorkflow("core/workflows/code-package.js", args, cpAnswers({
      "gate pkg": gate, "review 1": { verdict: "missing", findings: [], gateway: "unknown", unknownKey: "pkg-review-1", infra: "The worker stopped after it set out to ask for the model turn" },
    }));
    t.eq(u.error, null, "the run ends with a result, not a crash");
    t.eq(u.out.stoppedAt, "unknown outcome at review 1", "it stopped at the review");
    t.eq(u.out.unknown, { step: "review 1", key: "pkg-review-1", reason: "The worker stopped after it set out to ask for the model turn" }, "naming the key and the reason");
    t.ok(u.out.next.includes("zodchi job --key pkg-review-1") && u.out.next.includes("may already have run") && u.out.next.includes("args.rerun") && u.out.next.includes("it was not asked again"), "and the decision for the person");
    t.eq(u.of(/^review /).length, 1, "no second review was submitted");
    t.eq(u.of(/^close /).length, 0, "the writer was not sent on, and the claim was not closed (it stays open for the resume)");
    // the same stop at the other gateway steps
    const w = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, models: { writer: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }] }, reviewer: CP_ARGS.models.reviewer } }, cpAnswers({
      "gate pkg": gate, "write pkg": { done: false, summary: "", changed: [], gateway: "unknown", unknownKey: "pkg-work-1", infra: "ended unknown" },
    }));
    t.eq([w.out.stoppedAt, w.out.unknown.key], ["unknown outcome at write pkg", "pkg-work-1"], "a Codex writer's job that ended unknown stops the same way");
    const x = await runWorkflow("core/workflows/code-package.js", { ...CP_ARGS, mode: "expert", models: { expertWriter: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }] }, reviewer: CP_ARGS.models.reviewer } }, cpAnswers({
      "gate pkg": gate, "write pkg ask": { ok: false, summary: "", gateway: "unknown", unknownKey: "pkg-expert-1", infra: "ended unknown" },
    }));
    t.eq([x.out.stoppedAt, x.out.unknown.key], ["unknown outcome at write pkg ask", "pkg-expert-1"], "and an expert's");
    // failed with no evidence is still an infrastructure failure, resumable with rerun
    const f = await runWorkflow("core/workflows/code-package.js", args, cpAnswers({ "gate pkg": gate, "review 1": { verdict: "missing", findings: [], gateway: "failed", infra: "no job was created" } }));
    t.ok(f.error && /Infrastructure failure at step "review 1"/.test(f.error.message), "failed stays an infrastructure failure (the resume rule is args.rerun)");
    // the wording every step carries
    const review = u.of(/^review 1$/)[0].prompt;
    t.ok(review.includes('shows turnRequestedAt and turnStartedAt both null or missing (the gateway never asked for the model turn)'), "a new key needs that evidence");
    t.ok(review.includes('A job that is final with status "unknown" never gets a new key and is never waited on again'), "unknown never gets a new key");
    t.ok(review.includes('return gateway "unknown" with unknownKey set to the active key'), "and is reported with its key");
    t.ok(review.includes("a \"failed\" job whose turnRequestedAt is set included, is not retried"), "a failed job that asked for the turn is not retried either");
    const step = u.of(/^write pkg$/)[0].prompt;
    t.ok(step.includes('if it is final with status "unknown", never submit again and never wait on it'), "the resume rule of every step says the same");
    for (const rel of WORKFLOWS) {
      const s = source(rel);
      t.ok(!/or "failed" with no turnStartedAt/.test(s) && !/final with status "unknown", or/.test(s), `${rel}: no rule is left that resubmits an unknown job`);
    }
  });

  scenario("workflow-gate-other-workflows", "branch-review and asset-round take their gate from the helper, name the plugin copy and stop on an unknown job; the rule is the same in method-question, rubric-probe and incident-triage", async (t) => {
    const sha = (c) => c.repeat(40);
    const brArgs = { label: "br", repo: "/r", base: "main", tmp: "/r/.agent-tmp/br", author: ["claude/sonnet"], models: { reviewer: { candidates: [{ provider: "codex", model: "gpt-x", effort: "medium" }] } } };
    const brGate = printed({ roles: {}, modelsErrors: [], account: CONNECTED, accountError: "", head: sha("a"), baseSha: sha("b"), files: ["x.js"], dirty: false });
    const approved = { verdict: "approved", findings: [], gateway: "final", infra: "" };
    const br = await runWorkflow("domains/web-apps/workflows/branch-review.js", brArgs, (l) => (l.startsWith("gate ") ? brGate : approved));
    t.eq([br.out.approved, br.out.pluginCopy.path, br.out.pluginCopy.commit], [true, "/plugin/core", "c0ffee"], "branch-review approves on an approved review and names the plugin copy");
    const brGatePrompt = br.of(/^gate /)[0].prompt;
    t.ok(JSON.stringify(specIn(brGatePrompt, "branch-review")) === '{"api":1,"repo":"/r","base":"main","want":["reviewer","architect"]}' && (brGatePrompt.match(/node -e /g) || []).length === 1, "its gate is one command with a spec");
    const review = br.of(/^review$/)[0].prompt;
    t.ok(review.includes(`the commits ${sha("b")}..${sha("a")}`) && review.includes("review.diff is that change and nothing else") && review.includes("never from the working tree"), "the review is of the recorded range, given as a diff, not of the working tree");
    t.ok(review.includes(`git diff ${sha("b")} ${sha("a")} -- <the files above>`) && review.includes("--attach '/r/.agent-tmp/br/review.diff'"), "the diff is made from the range and attached");
    const brStale = await runWorkflow("domains/web-apps/workflows/branch-review.js", brArgs, (l) => ({ exitCode: 4, stdout: JSON.stringify({ ok: false, api: 0, error: "no helper", tried: ["/c"] }) }));
    t.ok(String(brStale.out.stoppedAt).startsWith("gate (the gate helper: no helper") && brStale.calls.length === 1, "a missing helper stops branch-review at the gate");
    const brUnknown = await runWorkflow("domains/web-apps/workflows/branch-review.js", brArgs, (l) => (l.startsWith("gate ") ? brGate : { verdict: "missing", findings: [], gateway: "unknown", unknownKey: "br-review", infra: "ended unknown" }));
    t.eq([brUnknown.out.approved, brUnknown.out.stoppedAt, brUnknown.out.unknown[0].key], [false, "unknown outcome at review", "br-review"], "branch-review stops on an unknown review with its key");
    const brFailed = await runWorkflow("domains/web-apps/workflows/branch-review.js", brArgs, (l) => (l.startsWith("gate ") ? brGate : { verdict: "missing", findings: [], gateway: "failed", infra: "no job" }));
    t.ok(brFailed.out.approved === false && /^infrastructure at review/.test(brFailed.out.stoppedAt), "a review with no job is an infrastructure stop, never an approval");

    const arArgs = { ledger: "/l.json", label: "r1", stage: 1, tmp: "/t", summary: "s", unity: { project: "/p", menus: [], cameras: [{ menu: "m", file: "f.png" }] }, rubric: { role: "rubric", repo: "/r" } };
    const ledger = { hasMethod: true, lastRound: 0, lastVerdict: "", roundsSinceMethod: 0, accepted: false, startedAt: "2026-11-18T00:00:00Z" };
    const arAnswer = (over = {}) => (l) => {
      if (over[l] !== undefined) return over[l];
      if (l.startsWith("gate ")) return printed(ledger);
      if (l.startsWith("engine ")) return { ok: true, summary: "", paths: ["f.png"] };
      if (l.startsWith("record ")) return { ok: true, summary: "" };
      throw new Error(`no answer for ${l}`);
    };
    const ar = await runWorkflow("domains/gamedev-unity/workflows/asset-round.js", arArgs, arAnswer({ "rubric r1": { ok: true, summary: "pass" } }));
    t.eq([ar.out.stoppedAt, ar.out.pluginCopy.path, ar.out.gate.hasMethod, "plugin" in ar.out.gate], [null, "/plugin/core", true, false], "asset-round reads the ledger gate from the helper and names the plugin copy");
    t.ok(JSON.stringify(specIn(ar.of(/^gate /)[0].prompt, "ledger")) === '{"api":1,"file":"/l.json","stage":1,"accepted":"accepted"}', "its gate command carries the ledger, the stage and the acceptance word");
    const refused = await runWorkflow("domains/gamedev-unity/workflows/asset-round.js", arArgs, arAnswer({ "gate r1": printed({ ...ledger, hasMethod: false }) }));
    t.ok(String(refused.out.refused).includes("No method in the ledger"), "the gate rules are applied to the helper's facts");
    const arUnknown = await runWorkflow("domains/gamedev-unity/workflows/asset-round.js", arArgs, arAnswer({ "rubric r1": { ok: false, summary: "UNKNOWN: key r1-rubric-1: ended unknown", unknownKey: "r1-rubric-1" } }));
    t.eq([arUnknown.out.stoppedAt, arUnknown.out.unknown.key], ["unknown outcome at rubric (key r1-rubric-1)", "r1-rubric-1"], "a rubric call that ended unknown stops the round with its key");
    t.eq(arUnknown.of(/^record /).length, 1, "and the round is still recorded, as stopped");
    const apply = await runWorkflow("domains/gamedev-unity/workflows/asset-round.js", { ...arArgs, answer: { file: "/a.md", targets: ["/x.py"], backup: "/b" } }, arAnswer({ "apply r1": { ok: true, summary: "" }, "rubric r1": { ok: true, summary: "" } }));
    t.ok(apply.of(/^apply /)[0].prompt.includes('The success flag of this step is "ok"'), "the applier is told which flag is the success flag");

    const rp = await runWorkflow("domains/gamedev-unity/workflows/rubric-probe.js", { role: "rubric", repo: "/r", label: "p", tmp: "/t", frames: [{ file: "/f.png", note: "n", sound: true }] }, (l) => (l === "plugin copy" ? printed({}) : { ok: false, rows: [], inputTokens: 0, summary: "UNKNOWN: key p-probe-1", unknownKey: "p-probe-1" }));
    t.eq([rp.out.stoppedAt, rp.out.unknown.key, rp.out.pluginCopy.commit], ["ask (unknown outcome)", "p-probe-1", "c0ffee"], "rubric-probe stops on an unknown call with its key");
    const mq = await runWorkflow("domains/gamedev-unity/workflows/method-question.js", { label: "m", context: "c", tmp: "/t", realLife: ["q"], games: [] }, (l) => (l === "plugin copy" ? printed({}) : { ok: false, answerFile: "", unknownKey: "m-real-0" }));
    t.eq([mq.out.stoppedAt, mq.out.unknown[0].key], ["research (unknown outcome)", "m-real-0"], "method-question stops on an unknown call with its key");
  });

  scenario("workflow-gate-names-the-copy", "ops-script, unity-check, method-question, rubric-probe and incident-triage name the plugin copy that ran, and stop before any work when the helper cannot be found; incident-triage takes its role table and account from the helper", async (t) => {
    const stale = { exitCode: 4, stdout: JSON.stringify({ ok: false, api: 0, error: "no helper", tried: ["/c (no scripts/gate.mjs)"] }) + "\n" };
    const COPY = { path: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
    const cases = [
      ["core/workflows/ops-script.js", { script: "/s/run.sh", tmp: "/t/ops", sudo: "sudo {script}", check: "{copy} --check" }],
      ["domains/gamedev-unity/workflows/unity-check.js", { steps: "/s.md", tmp: "/t" }],
      ["domains/gamedev-unity/workflows/method-question.js", { label: "m", context: "c", tmp: "/t", realLife: ["q"], games: ["q"] }],
      ["domains/gamedev-unity/workflows/rubric-probe.js", { role: "rubric", repo: "/r", label: "p", tmp: "/t", frames: [{ file: "/f.png", note: "n", sound: true }] }],
    ];
    for (const [rel, args] of cases) {
      const stopped = await runWorkflow(rel, args, () => stale);
      t.ok(String(stopped.out.stoppedAt).startsWith("plugin copy (the plugin copy helper: no helper") && /Update the zodchi-core plugin/.test(stopped.out.next), `${rel}: a missing helper stops the run first`);
      t.eq(stopped.calls.map((c) => c.label), ["plugin copy"], `${rel}: and nothing else was started`);
      const first = stopped.calls[0].prompt;
      t.ok((first.match(/node -e /g) || []).length === 1 && JSON.stringify(specIn(first, "plugin")) === '{"api":1}', `${rel}: the copy step is one command of the helper`);
    }
    const uc = await runWorkflow("domains/gamedev-unity/workflows/unity-check.js", cases[1][1], (l) => (l === "plugin copy" ? printed({}) : { ok: true, steps: [], editor: "e" }));
    t.eq([uc.out.ok, uc.out.pluginCopy], [true, COPY], "unity-check names the copy next to the runner's result");
    const mq = await runWorkflow("domains/gamedev-unity/workflows/method-question.js", cases[2][1], (l) => (l === "plugin copy" ? printed({}) : l === "fold" ? { file: "o.md", realFacts: [], constructions: [], follows: [], unsettled: [] } : { ok: true, answerFile: "a.json" }));
    t.eq(mq.out.pluginCopy, COPY, "method-question names it");
    const os_ = await runWorkflow("core/workflows/ops-script.js", cases[0][1], (l) => (l === "plugin copy" ? printed({}) : null));
    t.eq([os_.out.stoppedAt, os_.out.pluginCopy], ["no result from the runner", COPY], "ops-script names it in its result");

    // incident-triage: facts of the role table come from the helper, before anything is locked
    const itArgs = { incident: "i1", tmp: "/t/i1", adapter: "/t/adapter.json", report: "r", repo: "/r" };
    const itStale = await runWorkflow("core/workflows/incident-triage.js", itArgs, () => stale);
    t.ok(String(itStale.out.stoppedAt).startsWith("gate (the gate helper: no helper") && itStale.calls.length === 1, "incident-triage: a missing helper stops it before the lock is taken");
    const roles = { classifier: 1 };
    const itOpen = await runWorkflow("core/workflows/incident-triage.js", itArgs, (l) => (l.startsWith("gate ") ? printed({ roles: { architect: { candidates: [{ provider: "claude", model: "opus", effort: "high" }] } }, modelsErrors: ["~/.zodchi/models.json: not JSON: x"], account: null, accountError: "none", ignoreExit: 0 }) : { ok: false, locked: false, incident: "", revs: [], adapter: "", adapterSha256: "", summary: "stop here" }));
    t.ok(JSON.stringify(specIn(itOpen.of(/^gate /)[0].prompt, "roles")) === '{"api":1,"want":["architect"],"repo":"/r"}', "incident-triage: the gate command asks for the classifier role and the repository");
    t.eq(itOpen.out.pluginCopy, COPY, "and its result names the plugin copy");
    t.ok(itOpen.out.notes.some((n) => n.includes("not JSON")), "an unreadable role table is a note, apart from a missing one");
    t.ok(!itOpen.of(/^open /)[0].prompt.includes("homeModels") && !itOpen.of(/^open /)[0].prompt.includes("zodchi account"), "the Open step no longer asks a runner to retell the role table or the account");
    void roles;
  });

  scenario("workflow-gate-one-bootstrap", "every workflow that runs the gate helper carries the same bootstrap, and it can only look in plugin copies", async (t) => {
    const files = ["core/workflows/code-package.js", "domains/web-apps/workflows/branch-review.js", "domains/gamedev-unity/workflows/asset-round.js", "core/workflows/incident-triage.js",
      "core/workflows/ops-script.js", "domains/gamedev-unity/workflows/method-question.js", "domains/gamedev-unity/workflows/rubric-probe.js", "domains/gamedev-unity/workflows/unity-check.js"];
    const boots = files.map((f) => source(f).match(/^const GATE_BOOT = (.*)$/m)[1]);
    t.ok(boots.every((b) => b === boots[0]), "the bootstraps of all eight workflows are the same text");
    const code = vm.runInNewContext(boots[0]);
    t.ok(!/\bgit\b/.test(code) && !code.includes("process.cwd"), "it never looks at Git, a checkout or the current folder");
    t.ok(code.includes("installed_plugins.json") && code.includes("ZODCHI_PLUGIN_ROOT") && code.includes("CLAUDE_PLUGIN_ROOT"), "it looks at the explicit folder, the folder Claude Code names and the registration");
    for (const f of files) t.ok(/^const GATE_API = 1$/m.test(source(f)), `${f}: GATE_API is the helper's api`);
    t.ok(/^const API = 1;$/m.test(fs.readFileSync(GATE, "utf8")), "and the helper speaks api 1");
  });
}
