// Review round 1 of the workflow gates: the plugin copy the session loaded is the only one tried; a claim that waits for a person is never
// closed by another gate; a failed `git status` is no clean tree; the asset ledger counts and accepts within the same rounds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const mail = ["tester", "example.test"].join("@");
  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-gate-r1-${name}-`));
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir.replace(/\\/g, "/");
  };
  const cleanPath = () => (process.env.PATH || "").split(path.delimiter).filter((d) => d && !["zodchi", "zodchi.exe"].some((n) => fs.existsSync(path.join(d, n)))).join(path.delimiter);
  const envFor = (home, extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, PATH: cleanPath(), CLAUDE_CONFIG_DIR: path.join(home, "claude-config"), ZODCHI_PLUGIN_ROOT: "", CLAUDE_PLUGIN_ROOT: "", ...extra });
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "user.name=tester", "-c", `user.email=${mail}`, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const helper = (cmd, spec, home) => {
    const r = spawnSync(process.execPath, [GATE, cmd, JSON.stringify(spec)], { encoding: "utf8", env: envFor(home) });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
    return { code: r.status, json };
  };
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
  /** Runs code-package once as the body of an async function, `agent` answered by `answers(label)`. */
  const runCodePackage = async (answers, args) => {
    const calls = [];
    const sandbox = { args, phase: () => {}, log: () => {}, parallel: (th) => Promise.all(th.map((f) => f())), agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt }); return answers(opts.label); } };
    const fn = vm.runInNewContext(`(async () => {\n${source("core/workflows/code-package.js").replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "code-package.js" });
    let out = null, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls };
  };
  const repoWithWork = (home) => {
    const repo = `${home}/repo`;
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(`${repo}/a.txt`, "base\n");
    fs.writeFileSync(`${repo}/.gitignore`, ".agent-tmp/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(`${repo}/a.txt`, "work\n");
    git(repo, "commit", "-q", "-am", "pkg: round 1");
    const dir = `${home}/.zodchi/packages/k`;
    fs.mkdirSync(dir, { recursive: true });
    const brief = `${home}/brief.md`;
    fs.writeFileSync(brief, "## Review boundary\nx\n");
    return { repo, base, dir, brief };
  };
  const claimWriter = (dir, base) => (label, extra = {}) => {
    const file = `${dir}/${label}.json`;
    const old = new Date(Date.now() - 20 * 3600 * 1000);
    fs.writeFileSync(file, JSON.stringify({ label, status: "open", files: ["a.txt"], branch: "main", base, ...extra }));
    fs.utimesSync(file, old, old);
  };

  scenario("workflow-gate-review-copy-the-session-loaded", "the bootstrap tries exactly one plugin copy, the one the session loaded, and every workflow passes the folder the session runs in; an identified copy without the helper is a stop", async (t) => {
    const home = scratch(t, "copy");
    const BOOT = vm.runInNewContext(source("core/workflows/code-package.js").match(/^const GATE_BOOT = (.*)$/m)[1]);
    const copy = (name, withHelper) => {
      const dir = `${home}/${name}`;
      fs.mkdirSync(`${dir}/.claude-plugin`, { recursive: true });
      fs.writeFileSync(`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name: "zodchi-core", version: "1.0.0-dev" }));
      if (withHelper) { fs.mkdirSync(`${dir}/scripts`); fs.copyFileSync(GATE, `${dir}/scripts/gate.mjs`); }
      return dir;
    };
    const user = copy("user-copy", true), projectOnly = copy("project-copy", false), projectOk = copy("project-ok", true);
    const projA = `${home}/proj-a`, sub = `${projA}/captures/deep`, other = `${home}/proj-b`;
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(other);
    const register = (entries) => {
      fs.mkdirSync(`${home}/claude-config/plugins`, { recursive: true });
      fs.writeFileSync(`${home}/claude-config/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: { "zodchi-core@zodchi": entries } }));
    };
    const spec = JSON.stringify({ api: 1 });
    const boot = (project, extra = {}) => {
      const r = spawnSync(process.execPath, ["-e", BOOT, "--", project, "plugin", spec], { encoding: "utf8", cwd: home, env: envFor(home, extra) });
      let json = null;
      try { json = JSON.parse(r.stdout); } catch { /* checked below */ }
      return { code: r.status, json };
    };
    // a project install that lacks the helper is the copy the session loaded: no fall-through to the user copy that has it
    register([{ scope: "user", installPath: user }, { scope: "local", projectPath: projA, installPath: projectOnly }]);
    let r = boot(projA);
    t.eq([r.code, r.json.ok, r.json.tried.length], [4, false, 1], "the project copy lacks the helper: exit 4, one place looked at");
    t.ok(r.json.tried[0].startsWith(projectOnly) && r.json.error.includes(projectOnly), "and it is named");
    t.eq([boot(sub).code, boot(`${projA}/`).code], [4, 4], "from a folder inside the project, or with a trailing slash, it is the same copy");
    r = boot(other);
    // macOS: the temp folder is a symlink (/var -> /private/var), so both sides are compared as real paths
    t.eq([r.code, fs.realpathSync(r.json.plugin.root)], [0, fs.realpathSync(user)], "another project gets the user copy, and the answer names it");
    // the most specific project install wins
    register([{ scope: "user", installPath: user }, { scope: "local", projectPath: projA, installPath: projectOk }, { scope: "local", projectPath: sub, installPath: projectOnly }]);
    t.eq([boot(sub).code, fs.realpathSync(boot(projA).json.plugin.root)], [4, fs.realpathSync(projectOk)], "the most specific project install is the one that counts");
    // an explicit folder without the helper is a stop as well, and the first explicit folder decides
    register([{ scope: "user", installPath: user }]);
    r = boot(other, { CLAUDE_PLUGIN_ROOT: projectOnly });
    t.eq([r.code, r.json.tried.length], [4, 1], "a folder Claude Code names that lacks the helper: exit 4, the registration is not consulted");
    t.eq(boot(other, { ZODCHI_PLUGIN_ROOT: projectOnly, CLAUDE_PLUGIN_ROOT: user }).code, 4, "the first explicit folder decides");
    t.eq(fs.realpathSync(boot(other, { ZODCHI_PLUGIN_ROOT: projectOk, CLAUDE_PLUGIN_ROOT: projectOnly }).json.plugin.root), fs.realpathSync(projectOk), "and is the one that runs");

    const SESSION = /^const SESSION_PROJECT = '"\$\(pwd -W 2>\/dev\/null \|\| pwd\)"'$/m;
    for (const rel of ["core/workflows/code-package.js", "core/workflows/incident-triage.js", "core/workflows/ops-script.js", "domains/gamedev-unity/workflows/asset-round.js",
      "domains/gamedev-unity/workflows/method-question.js", "domains/gamedev-unity/workflows/rubric-probe.js", "domains/gamedev-unity/workflows/unity-check.js", "domains/web-apps/workflows/branch-review.js"]) {
      const s = source(rel);
      t.ok(SESSION.test(s) && /-- \$\{SESSION_PROJECT\} \$\{command\}/.test(s), `${rel}: the command passes the folder the runner starts in, not the target of the work`);
    }
    for (const rel of ["core/workflows/code-package.js", "domains/web-apps/workflows/branch-review.js"]) {
      t.ok(!/From \$\{a\.repo\}, in the foreground/.test(source(rel)), `${rel}: the gate runner is not sent to another folder first`);
    }
  });

  scenario("workflow-gate-review-awaiting-claim", "a claim marked awaiting (a package stopped until a person decides) is never closed by another gate, however old; the workflow marks it on its unknown and infrastructure stops", async (t) => {
    const home = scratch(t, "await");
    const { repo, base, dir, brief } = repoWithWork(home);
    const claim = claimWriter(dir, base);
    claim("waiting", { awaiting: "unknown outcome at review 1" });
    const spec = { api: 1, repo, brief, label: "next", claimsKey: "k", want: [] };
    let r = helper("code-package", spec, home);
    t.eq(r.json.claims.closed, [], "its files are clean, its commit is on main and it is a day old, yet nothing was closed");
    t.ok(r.json.claims.kept.some((k) => k.startsWith("waiting: it awaits a decision") && k.includes("unknown outcome at review 1")), "it is kept, with the reason");
    t.eq(JSON.parse(fs.readFileSync(`${dir}/waiting.json`, "utf8")).status, "open", "and untouched");
    claim("finished");
    r = helper("code-package", spec, home);
    t.eq(r.json.claims.closed.map((c) => c.label), ["finished"], "a finished package's claim of the same age and shape is still closed");
    t.eq(r.json.claims.open.map((c) => c.label), ["waiting"], "the waiting one stays open");

    // the workflow side: both stops mark the claim in place with a runner step, and a clean run does not
    const facts = { ok: true, api: 1, plugin: PLUGIN, roles: {}, modelsErrors: [], account: { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null }, accountError: "", git: true, head: "abc1234", branch: "main", dirty: [], dirtyError: "",
      ignoreExit: 0, ignoreLine: ".gitignore:3:.agent-tmp/\t.agent-tmp/gateway/x", verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "Important: x.\n", claims: { dir: "d", open: [], closed: [], kept: [], skipped: [], notes: [] } };
    const args = { label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"],
      models: { writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] }, reviewer: { candidates: [{ provider: "codex", model: "gpt-x", effort: "medium" }] } } };
    const answers = (review) => (label) => {
      if (label === "gate pkg") return { exitCode: 0, stdout: JSON.stringify(facts) + "\n" };
      if (label === "claim pkg") return { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, conflicts: [], branchConflicts: [] }) + "\n" };
      if (label === "write pkg") return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
      if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
      if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "l" }] };
      if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: ["src/a.js"] };
      if (label.startsWith("review ")) return review;
      if (label.startsWith("close claim") || label.startsWith("await claim")) return { ok: true, summary: "done" };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    const unknown = await runCodePackage(answers({ verdict: "missing", findings: [], gateway: "unknown", unknownKey: "pkg-review-1", infra: "ended unknown" }), args);
    const awaiting = unknown.calls.filter((c) => /^await claim/.test(c.label));
    t.eq([unknown.out.stoppedAt, awaiting.length, unknown.calls.filter((c) => /^close claim/.test(c.label)).length], ["unknown outcome at review 1", 1, 0], "an unknown stop marks the claim and does not close it");
    t.ok(awaiting[0].prompt.includes('add the field "awaiting"') && awaiting[0].prompt.includes("unknown outcome at review 1") && awaiting[0].prompt.includes("make no backup"), "in place, with the reason, no backup");
    const infra = await runCodePackage(answers({ verdict: "missing", findings: [], gateway: "failed", infra: "no job was created" }), args);
    t.ok(infra.error && infra.calls.some((c) => /^await claim/.test(c.label)), "an infrastructure stop marks it too");
    const failedMark = await runCodePackage((label) => (label.startsWith("await claim") ? { ok: false, summary: "no" } : answers({ verdict: "missing", findings: [], gateway: "unknown", unknownKey: "k", infra: "x" })(label)), args);
    t.ok(/add "awaiting" by hand/.test(failedMark.out.claimNotMarked || ""), "when the marking fails the result says to do it by hand");
    const clean = await runCodePackage(answers({ verdict: "approved", findings: [], gateway: "final", infra: "" }), args);
    t.eq([clean.out.approved, clean.calls.filter((c) => /^await claim/.test(c.label)).length], [true, 0], "a finished run marks nothing awaiting");
  });

  scenario("workflow-gate-review-status-failure", "a failed git status is no clean work tree: the helper says so, the workflow stops, and no claim is closed from it", async (t) => {
    const home = scratch(t, "status");
    const { repo, base, dir, brief } = repoWithWork(home);
    claimWriter(dir, base)("finished");
    const spec = { api: 1, repo, brief, label: "next", claimsKey: "k", want: [] };
    // the index cannot be read: HEAD still resolves
    fs.writeFileSync(`${repo}/.git/index`, "this is not an index");
    t.eq(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).status, 0, "(HEAD resolves)");
    t.ok(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).status !== 0, "(and git status fails)");
    const r = helper("code-package", spec, home);
    t.eq([r.code, r.json.ok, r.json.git, r.json.dirty], [0, true, true, null], "the helper answers with no dirty list, not an empty one");
    t.ok(/^git status exited \d+/.test(r.json.dirtyError), `and says why (${r.json.dirtyError})`);
    t.eq(r.json.claims.closed, [], "the claim of the finished package was not closed");
    t.eq(r.json.claims.open.map((c) => c.label), ["finished"], "it is still listed open");
    t.ok(r.json.claims.notes.some((n) => /dirty list of the repository is unknown/.test(n)), "and the answer says that nothing was examined");
    t.eq(JSON.parse(fs.readFileSync(`${dir}/finished.json`, "utf8")).status, "open", "the file is untouched");
    // the workflow stops on it and names the cause
    const run = await runCodePackage(() => ({ exitCode: 0, stdout: JSON.stringify({ ...r.json, plugin: PLUGIN }) + "\n" }),
      { label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"], models: {} });
    t.ok(/^gate \(no dirty list: the Git state is unknown; git status exited/.test(run.out.stoppedAt), `the workflow stops at the gate (${run.out.stoppedAt})`);
    t.eq(run.calls.map((c) => c.label), ["gate pkg"], "before anything is claimed");
  });

  scenario("workflow-gate-review-ledger-same-rounds", "the asset ledger counts rounds and looks for acceptance in the same list: the rounds after the selected method", async (t) => {
    const home = scratch(t, "ledger");
    const file = `${home}/asset.ledger.json`;
    const run = (ledger, stage) => {
      fs.writeFileSync(file, JSON.stringify(ledger));
      return helper("ledger", { api: 1, file, stage }, home).json;
    };
    // a blockout was accepted in round 1; the look method was chosen after it and has played three rounds without acceptance
    const rounds = [{ n: 1, owner: "accepted" }, { n: 2, owner: "needs work" }, { n: 3, owner: "needs work" }, { n: 4, owner: "needs work" }];
    let l = run({ method: { name: "blockout", afterRound: 0 }, lookMethod: { name: "look", afterRound: 1 }, rounds }, 2);
    t.eq([l.roundsSinceMethod, l.accepted], [3, false], "stage 2: three rounds under the look method, and the blockout's acceptance does not count");
    l = run({ method: { name: "blockout", afterRound: 0 }, lookMethod: { name: "look", afterRound: 1 }, rounds: [{ n: 1, owner: "accepted" }, { n: 2, owner: "needs work" }, { n: 3, owner: "accepted with notes" }] }, 2);
    t.eq([l.roundsSinceMethod, l.accepted], [2, true], "an acceptance after the method was chosen does count");
    l = run({ method: { name: "blockout", afterRound: 0 }, lookMethod: { name: "look", afterRound: 1 }, rounds: [{ n: 1, owner: "accepted" }, { n: 2, owner: "needs work" }] }, 1);
    t.eq([l.roundsSinceMethod, l.accepted], [2, true], "stage 1 reads its own method: its acceptance in round 1 counts there");
    l = run({ method: "a method named as text", rounds: [{ n: 1, owner: "accepted" }] }, 1);
    t.eq([l.roundsSinceMethod, l.accepted], [1, true], "a method without afterRound counts every round");
  });
}
