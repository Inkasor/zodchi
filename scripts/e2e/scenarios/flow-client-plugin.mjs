import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";

export default function register({ scenario, scratch, ROOT, ZODCHI, flowWorld, run, FIXED, STUB }) {
  const release = (args) => JSON.parse(execFileSync(ZODCHI, ["release", ...args], {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
  }));

  scenario("flow-workflow-help", "catalog help is read-only and exposes every installed workflow", async (t) => {
    const env = { ...process.env, ZODCHI_HOME: path.join(scratch, "help-empty-home") };
    const call = (args) => spawnSync(ZODCHI, ["flow", ...args], { cwd: ROOT, env, encoding: "utf8", windowsHide: true });
    const list = call(["list"]);
    t.eq(list.status, 0, "catalog succeeds without an account");
    const catalog = JSON.parse(list.stdout);
    t.eq(catalog.workflows.length, 14, "all workflows remain available");
    const help = call(["--help"]);
    t.eq(help.status, 0, "general help succeeds");
    t.eq(JSON.parse(help.stdout).catalog, catalog, "general help uses the shared catalog");
    for (const entry of catalog.workflows) {
      const result = call([entry.name, "--help"]);
      t.eq(result.status, 0, `${entry.name} help succeeds`);
      t.eq(JSON.parse(result.stdout), entry, `${entry.name} help is the catalog entry`);
      t.ok(entry.purpose && entry.limits && entry.required.length && entry.docs, `${entry.name} describes its contract`);
    }
    for (const name of ["candidate-acceptance", "release-acceptance", "player-acceptance"]) {
      const example = catalog.workflows.find(entry => entry.name === name).example;
      t.ok(example.repo && example.label && example.scenarios[0].steps[0].expect, `${name} has a structural check example`);
      if (name !== "player-acceptance") t.ok(example.browser.executable, `${name} pins Chromium explicitly`);
    }
    const candidate = catalog.workflows.find(entry => entry.name === "candidate-acceptance");
    t.eq(candidate.required, ["repo", "head", "label", "browser.executable", "scenarios"], "candidate unconditional fields exclude fixture");
    t.eq(candidate.conditional, [
      { when: { fixture: "absent" }, required: ["scenarios[].test"] },
      { when: { fixture: "present" }, required: ["fixture.script", "scenarios[].steps"] },
    ], "candidate describes committed tests and fixture steps separately");
    for (const [name, alternatives] of Object.entries({
      "branch-review": [["base", "author"], ["sourceRun", "head"]],
      "method-question": [["realLife"], ["games"]],
      "asset-round": [["package"], ["check"], ["export"], ["unity"], ["rubric"]],
      "video": [["brief", "variants"], ["adopt"]],
    })) t.eq(catalog.workflows.find(entry => entry.name === name).anyOf, alternatives, `${name} describes input alternatives`);
    const branch = JSON.parse(call(["branch-review", "--help"]).stdout);
    t.eq(branch.required, ["repo", "label"], "branch review requires only common fields unconditionally");
    t.eq(branch.anyOf, [["base", "author"], ["sourceRun", "head"]], "branch review help describes initial and repeat forms");
    t.ok(branch.limits.includes("author may name additional authors"), "repeat review help makes additional authors optional");
    t.eq(call(["not-a-workflow", "--help"]).status, 1, "unknown workflow is rejected");
    t.ok(!fs.existsSync(env.ZODCHI_HOME), "help does not create a journal or check an account");
    const repo = path.join(scratch, "help-domain-repo");
    fs.mkdirSync(path.join(repo, ".zodchi"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".zodchi", "workflows.json"), JSON.stringify({ domains: ["video"] }));
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    git("add", ".zodchi/workflows.json");
    git("-c", "user.name=Flow Test", "-c", "user.email=flow-test", "commit", "-qm", "configure domains");
    const project = call(["list", "--repo", repo]);
    t.eq(project.status, 0, "repository catalog succeeds");
    t.eq(JSON.parse(project.stdout).workflows, catalog.workflows.filter(entry => ["core", "video"].includes(entry.domain)), "repository catalog contains exactly core and configured video entries");
  });

  scenario("flow-startup-release-note", "startup hook exposes only short public build notes", async (t) => {
    const home = path.join(scratch, "notes-empty-home");
    const env = { ...process.env, ZODCHI_HOME: home };
    const invoke = (args) => spawnSync(ZODCHI, ["release", "notes", ...args], {
      cwd: ROOT, env, input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: "private-marker" }),
      encoding: "utf8", windowsHide: true,
    });
    const direct = invoke([]);
    t.eq(direct.status, 0, "notes command succeeds");
    const facts = JSON.parse(direct.stdout);
    t.eq(facts.channel, "direct", "unmanaged binary reports direct");
    t.ok(facts.highlights.length > 0, "public highlights are present");
    const hook = invoke(["--hook"]);
    t.eq(hook.status, 0, "hook command succeeds");
    const output = JSON.parse(hook.stdout).hookSpecificOutput;
    t.eq(output.hookEventName, "SessionStart", "hook event shape");
    for (const hint of ["zodchi flow list", "zodchi flow <workflow> --help", "candidate-acceptance", "candidate build", "release-acceptance", "deployed release"]) {
      t.ok(output.additionalContext.includes(hint), `startup note includes ${hint}`);
    }
    t.ok(output.additionalContext.length < 500 && !hook.stdout.includes("private-marker") && !hook.stdout.includes(home), "context is short and private input stays private");
    t.ok(!fs.existsSync(home), "notes do not create a home");
  });

  scenario("flow-client-plugin", "both client manifests share the same portable skills and release version", async (t) => {
    const output = path.join(scratch, "shared-client-plugin");
    const built = release(["marketplace", "--out", output]);
    const read = (file) => fs.readFileSync(path.join(built.root, file), "utf8");
    const hookBytes = read("hooks/hooks.json");
    t.eq(hookBytes, fs.readFileSync(path.join(ROOT, "install/session-start-hooks.json"), "utf8"), "both registrations share the source hook bytes");
    const hook = JSON.parse(hookBytes).hooks.SessionStart[0];
    t.eq([hook.matcher, hook.hooks[0].command, hook.hooks[0].timeout], ["startup", "zodchi release notes --hook", 5], "startup hook invokes the installed CLI");
    const portable = JSON.parse(read("plugin.json"));
    const codex = JSON.parse(read(".codex-plugin/plugin.json"));
    const claude = JSON.parse(read(".claude-plugin/plugin.json"));
    t.eq([portable.name, codex.name, claude.name], ["zodchi", "zodchi", "zodchi"], "the package has one identity");
    t.eq([portable.version, codex.version, claude.version], [built.version, built.version, built.version], "claims the same version");
    t.eq(codex.skills, "./skills/", "Codex reads the bundled skills");
    t.eq(read("assets/workflows/catalog.json"), fs.readFileSync(path.join(ROOT, "workflows/catalog.json"), "utf8"), "the build pins the shared catalog");
    for (const entry of JSON.parse(read("assets/workflows/catalog.json")).workflows) {
      const doc = entry.docs.split("#")[0];
      t.eq(read(doc), fs.readFileSync(path.join(ROOT, doc), "utf8"), `${doc} is installed`);
    }
    t.eq(read("docs/flow.md"), fs.readFileSync(path.join(ROOT, "docs/flow.md"), "utf8"), "the installed skill can reach the shared branch-review contract");
    t.eq(fs.readdirSync(path.join(built.root, "assets/workflows")), ["catalog.json"], "the catalog is data for the native workflows");
    t.ok(!fs.existsSync(path.join(built.root, "workflows")), "the clients use the engine instead of auto-loading its workflow source");
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
    const commit = git("status", "--porcelain", "--untracked-files=normal") ? null : git("rev-parse", "HEAD");
    t.eq(JSON.parse(read("zodchi-build.json")).sourceCommit, commit, "both clients receive the checked source revision when the tree is clean");
    const market = (file) => JSON.parse(fs.readFileSync(path.join(output, file), "utf8")).plugins[0];
    t.eq(market(".agents/plugins/marketplace.json").source.path, market(".claude-plugin/marketplace.json").source,
      "both local marketplaces point to the same installation payload");
    // The fake clients implement marketplace add and plugin install in isolated directories.
    // Each reads its own registration, so a missing or incorrect source cannot pass by
    // inspecting only the builder's returned root.
    const fixture = path.join(scratch, "plugin-client-fixture");
    const bin = path.join(fixture, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const clientScript = path.join(fixture, "client.cjs");
    fs.writeFileSync(clientScript, `
      const fs = require('node:fs'), path = require('node:path');
      const client = path.basename(process.execPath).toLowerCase().startsWith('codex') ? 'codex' : 'claude';
      const args = process.argv.slice(1), dir = path.join(process.env.FAKE_CLIENT_HOME, client);
      args[0] = path.basename(args[0]); // Node resolves its would-be script argument to an absolute path.
      fs.mkdirSync(dir, { recursive: true });
      if (args[0] !== 'plugin') process.exit(2);
      if (args[1] === 'marketplace' && args[2] === 'add') fs.writeFileSync(path.join(dir, 'market'), args[3]);
      else if (args[1] === 'marketplace' && args[2] === 'remove') { /* no previous registration */ }
      else if ((client === 'codex' && args[1] === 'add') || (client === 'claude' && args[1] === 'install')) {
        if (args[2] !== 'zodchi@zodchi-local') process.exit(3);
        const market = fs.readFileSync(path.join(dir, 'market'), 'utf8');
        const manifest = client === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json';
        const entry = JSON.parse(fs.readFileSync(path.join(market, manifest), 'utf8')).plugins.find(p => p.name === 'zodchi');
        const source = client === 'codex' ? entry.source.path : entry.source;
        fs.cpSync(path.resolve(market, source), path.join(dir, 'installed'), { recursive: true });
      } else process.exit(4);
      process.exit(0);
    `);
    const ext = process.platform === "win32" ? ".exe" : "";
    for (const client of ["codex", "claude"]) fs.copyFileSync(process.execPath, path.join(bin, client + ext));
    const bundle = release(["build", "--out", path.join(fixture, "bundle"), "--archive"]);
    const env = { ...process.env, ZODCHI_HOME: path.join(fixture, "home"), FAKE_CLIENT_HOME: fixture,
      CODEX_HOME: path.join(fixture, "codex-config"), CLAUDE_CONFIG_DIR: path.join(fixture, "claude-config"),
      ZODCHI_CODEX_BIN: path.join(bin, "codex" + ext), NODE_OPTIONS: `--require "${clientScript.replace(/\\/g, "/")}"` };
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") || "PATH";
    env[pathKey] = bin + path.delimiter + env[pathKey];
    const installed = spawnSync(ZODCHI, ["release", "install", "--archive", bundle.archive, "--sha256", bundle.sha256, "--clients", "codex,claude"],
      { cwd: fixture, env, encoding: "utf8", windowsHide: true });
    t.log(installed.stderr);
    t.eq(installed.status, 0, "installation registers both isolated clients");
    for (const client of ["codex", "claude"]) {
      t.eq(fs.readFileSync(path.join(fixture, client, "installed", "hooks", "hooks.json")).toString("hex"),
        fs.readFileSync(path.join(ROOT, "install/session-start-hooks.json")).toString("hex"), `${client} installs the source hook bytes`);
    }
    for (const name of built.skills) {
      const file = `skills/${name}/SKILL.md`;
      t.eq(read(file), fs.readFileSync(path.join(ROOT, file), "utf8"), `${name} is packaged from the common source`);
    }
  });
  scenario("flow-release-bundle", "the binary, catalog and both native manifests travel together in a versioned bundle", async (t) => {
    const output = path.join(scratch, "flow-release");
    const built = release(["build", "--out", output, "--archive"]);
    const receipt = JSON.parse(fs.readFileSync(path.join(output, "release.json"), "utf8"));
    const read = (file) => JSON.parse(fs.readFileSync(path.join(output, "marketplace", "plugins", "zodchi", file), "utf8"));
    t.eq([read(".codex-plugin/plugin.json").version, read(".claude-plugin/plugin.json").version, receipt.version],
      Array(3).fill(built.version), "the CLI builder required the same version used by both client manifests");
    const check = (file, digest) => crypto.createHash("sha256").update(fs.readFileSync(path.join(output, file))).digest("hex") === digest;
    t.ok(receipt.sha256[built.cli] && Object.entries(receipt.sha256).every(([file, digest]) => check(file, digest)),
      "the bundle records the digest of its CLI and each bundled file");
    const env = { ...process.env, ZODCHI_HOME: path.join(scratch, "empty-bundle-home") };
    delete env.ZODCHI_ROLES;
    const roles = execFileSync(path.join(output, built.cli), ["roles"], { env, cwd: scratch, encoding: "utf8", windowsHide: true });
    t.ok(roles.includes("flow-work") && roles.includes("code-review"), "the bundled executable finds its own roles using an empty home");

    const install = (digest, env) => spawnSync(ZODCHI, ["release", "install", "--archive", built.archive, "--sha256", digest], {
      cwd: scratch, env, encoding: "utf8", windowsHide: true,
    });
    const rejected = install("0".repeat(64), env);
    t.eq(rejected.status, 1, "a rejected archive returns an error");
    t.ok(rejected.stderr.includes("digest") && !fs.existsSync(env.ZODCHI_HOME), "a bad digest leaves the install home untouched");
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") || "PATH";
    env[pathKey] = scratch;
    const installed = install(built.sha256, env);
    t.log(installed.stderr);
    t.eq(installed.status, 0, "the archive installs without Node or Cargo on PATH");
    const { launcher, version, root } = JSON.parse(installed.stdout);
    t.eq([version, path.basename(root)], [built.version, built.version], "the installed release has an immutable version directory");
    const call = (args) => execFileSync(launcher, args, { env, cwd: scratch, encoding: "utf8", windowsHide: true });
    const otherNotes = JSON.parse(execFileSync(ZODCHI, ["release", "notes"], { env, cwd: scratch, encoding: "utf8", windowsHide: true }));
    t.eq(otherNotes.channel, "direct", "another executable does not claim the selected stable build");
    const stableNotes = JSON.parse(call(["release", "notes"]));
    t.eq([stableNotes.channel, stableNotes.version], ["stable", version], "selected stable child identifies itself");
    t.eq(call(["--version"]).trim(), "zodchi " + version, "the launcher starts the verified native binary");
    t.eq(JSON.parse(call(["flow", "list"])), JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/catalog.json"), "utf8")), "the installed CLI uses the packaged catalog");
    t.ok(call(["roles"]).includes("code-review"), "installed roles travel with the executable");
  });

  scenario("flow-dev-revision", "the local launcher selects the newest DEV archive and an existing run keeps its build", async (t) => {
    const f = flowWorld(t, "dev-revision");
    const location = path.join(scratch, "dev-package");
    fs.mkdirSync(location);
    const packed = release(["build", "--out", path.join(location, "bundle"), "--archive"]);
    const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    const invoke = (program, args) => run(t, program, args, { cwd: f.r, env: f.w.env });
    const activate = async (commit) => {
      const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(packed.archive)));
      const metadata = "marketplace/plugins/zodchi/zodchi-build.json";
      const record = JSON.stringify({ sourceCommit: commit });
      payload.files[metadata] = Buffer.from(record).toString("base64");
      payload.manifest.sha256[metadata] = sha256(record);
      const archive = path.join(location, commit + ".json.gz");
      const bytes = zlib.gzipSync(JSON.stringify(payload));
      fs.writeFileSync(archive, bytes);
      const result = await invoke(ZODCHI, ["release", "dev", "--archive", archive, "--sha256", sha256(bytes)]);
      t.eq(result.code, 0, "activate DEV build " + commit.slice(0, 7));
      return result.json;
    };
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    const bin = path.join(f.w.zhome, "bin");
    const launcherName = process.platform === "win32" ? "zodchi.exe" : "zodchi";
    const backupName = process.platform === "win32" ? "zodchi-before-dev.exe" : "zodchi-before-dev";
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, launcherName), "previous local executable");
    const first = await activate(firstCommit);
    t.eq(fs.readFileSync(path.join(bin, backupName), "utf8"), "previous local executable", "the previous launcher is saved");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const runStart = await invoke(first.launcher, ["flow", "code-package", "--args", f.args()]);
    t.eq(runStart.code, 0, "a new run starts through the local DEV launcher");
    const id = runStart.json.runId;
    const journal = JSON.parse(fs.readFileSync(path.join(f.w.zhome, "flows", id, "run.json"), "utf8"));
    t.eq(journal.buildCommit, firstCommit, "the run records the source revision of its own binary");

    const second = await activate(secondCommit);
    t.eq(second.launcher, first.launcher, "switching the DEV selection keeps the same launcher");
    const notes = await invoke(second.launcher, ["release", "notes"]);
    t.eq([notes.json.channel, notes.json.sourceCommit], ["dev", secondCommit], "notes identify the selected DEV child");
    const current = await invoke(second.launcher, ["release", "current"]);
    t.eq([current.json.channel, current.json.sourceCommit], ["dev", secondCommit], "new calls select the second build");
    const unavailable = first.cli + ".unavailable";
    fs.renameSync(first.cli, unavailable);
    try {
      const missing = await invoke(second.launcher, ["flow", "code-package", "--resume", id]);
      t.eq(missing.code, 1, "resume requires the original binary");
      t.ok(missing.err.includes(firstCommit), "the error identifies the missing pinned build");
    } finally {
      fs.renameSync(unavailable, first.cli);
    }
    const resumed = await invoke(second.launcher, ["flow", "code-package", "--resume", id]);
    t.eq([resumed.code, resumed.json.runId, resumed.json.verdict], [0, id, "approved"], "resume uses the original run after switching");
    t.eq(f.steps(), ["write", "review 1"], "resume submitted no new model calls");
  });
}
