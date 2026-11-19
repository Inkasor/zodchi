// The installer and Claude Code's plugin cache. Claude Code keeps a cache of an installed plugin by name and version
// (<config>/plugins/cache/<marketplace>/<plugin>/<version>/), and `plugin update` at an unchanged version leaves it as it
// was, so a rerun of the installer after `git pull` used to leave sessions on the workflows of the first install. These
// scenarios run the real installer, from a scratch clone, against scripts/e2e/fake-claude-plugin.mjs, which models that
// cache, in a scratch home: no real Claude Code, no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WIN = process.platform === "win32";
const VERSION = "1.0.0-dev";
const MARKET = "zodchi";

export default function register(h) {
  const { scenario, ROOT, samePath } = h;
  const FAKE = path.join(ROOT, "scripts", "e2e", "fake-claude-plugin.mjs");

  const world = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-${name}-`));
    t.cleanups.push(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left in the temp folder */ } });
    const w = { dir, clone: path.join(dir, "clone"), config: path.join(dir, "claude-config"), fake: path.join(dir, "fake-state"), project: path.join(dir, "project") };
    const bin = path.join(dir, "bin");
    // The fake is a `claude` first on PATH. On Windows only a claude.exe is found by name, so a real one must not answer
    // first and the installer runs the npm-style cli.js behind claude.cmd, as it does for an npm install of Claude Code.
    const cli = WIN ? path.join(bin, "node_modules", "@anthropic-ai", "claude-code", "cli.js") : path.join(bin, "claude");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    if (WIN) {
      fs.writeFileSync(cli, `import(${JSON.stringify(new URL(`file:///${FAKE.replace(/\\/g, "/")}`).href)});\n`);
      fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\n");
    } else fs.writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: path.join(dir, "home"), USERPROFILE: path.join(dir, "home"), ZODCHI_HOME: path.join(dir, "zodchi-home"), CODEX_HOME: path.join(dir, "codex-home"),
      CLAUDE_CONFIG_DIR: w.config, FAKE_CLAUDE_PLUGIN_HOME: w.fake };
    delete env.ZODCHI_DENYLIST;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const holds = (d) => ["claude", "claude.exe", "claude.cmd"].some((n) => fs.existsSync(path.join(d, n)));
    env[pathKey] = [bin, ...(env[pathKey] || "").split(path.delimiter).filter((x) => x && !(WIN && holds(x)))].join(path.delimiter);
    fs.mkdirSync(env.HOME, { recursive: true });
    fs.mkdirSync(w.project, { recursive: true });
    w.env = env;
    return w;
  };

  const git = (w, args) => {
    const r = spawnSync("git", ["-C", w.clone, "-c", "user.name=zodchi e2e", "-c", "user.email=zodchi-e2e", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return (r.stdout || "").trim();
  };
  const write = (w, rel, text) => {
    const f = path.join(w.clone, ...rel.split("/"));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  // The workflows of a commit: their text tells the commit apart in the cache.
  const workflows = (w, n) => {
    write(w, "core/workflows/code-package.js", `// code-package, commit ${n}\n`);
    write(w, "domains/web-apps/workflows/branch-review.js", `// branch-review, commit ${n}\n`);
  };

  /** A clone of the installer with two plugins (zodchi-core and zodchi-web-apps), one commit on main, the default branch
   *  as `origin` would name it. The real install.mjs, zodchi.mjs, roles and model table are copied in. */
  const clone = (t, name) => {
    const w = world(t, name);
    fs.mkdirSync(w.clone, { recursive: true });
    git(w, ["init", "-q", "-b", "main"]);
    for (const f of ["install/install.mjs", "install/zodchi.mjs", "package.json", "models.json"]) {
      fs.mkdirSync(path.dirname(path.join(w.clone, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(w.clone, f));
    }
    fs.cpSync(path.join(ROOT, "roles"), path.join(w.clone, "roles"), { recursive: true });
    write(w, ".claude-plugin/marketplace.json", JSON.stringify({ name: MARKET, owner: { name: "test" }, plugins: [
      { name: "zodchi-core", source: "./core" }, { name: "zodchi-web-apps", source: "./domains/web-apps" }] }, null, 2) + "\n");
    for (const [dir, name] of [["core", "zodchi-core"], ["domains/web-apps", "zodchi-web-apps"]]) write(w, `${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name, version: VERSION }) + "\n");
    workflows(w, 1);
    git(w, ["add", "-A"]);
    git(w, ["commit", "-q", "-m", "first"]);
    git(w, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(w, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    return w;
  };
  const commit = (w, n) => { workflows(w, n); git(w, ["add", "-A"]); git(w, ["commit", "-q", "-m", `commit ${n}`]); return git(w, ["rev-parse", "HEAD"]); };

  const install = (t, w, args) => {
    const r = spawnSync(process.execPath, [path.join(w.clone, "install", "install.mjs"), "--no-build", "--no-codex-skill", ...args], { env: w.env, encoding: "utf8", windowsHide: true, cwd: w.dir });
    t.log(`$ node install/install.mjs ${args.join(" ")}\n  exit ${r.status}\n  stdout: ${(r.stdout || "").trim().replace(/\n/g, "\n          ")}${r.stderr ? `\n  stderr: ${r.stderr.trim().replace(/\n/g, "\n          ")}` : ""}`);
    return { code: r.status, out: r.stdout || "", err: r.stderr || "", lines: (r.stdout || "").trim().split("\n") };
  };
  const fakeCalls = (w) => (fs.existsSync(path.join(w.fake, "calls.jsonl")) ? fs.readFileSync(path.join(w.fake, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const registry = (w) => JSON.parse(fs.readFileSync(path.join(w.config, "plugins", "installed_plugins.json"), "utf8")).plugins;
  const cacheOf = (w, plugin) => path.join(w.config, "plugins", "cache", MARKET, plugin, VERSION);
  const read = (f) => fs.readFileSync(f, "utf8");
  const SESSIONS = "Open Claude Code sessions keep the plugins they started with: run /reload-plugins in each, or start a new session.";

  scenario("install-plugins-first", "a first install fills Claude Code's cache from the copy of HEAD's commit for zodchi-core and a domain, registers both, and ends by telling that open sessions keep their plugins", async (t) => {
    const w = clone(t, "install-first");
    const head = git(w, ["rev-parse", "HEAD"]);
    const r = install(t, w, ["--domains", "web-apps"]);
    t.eq(r.code, 0, "the installer succeeds");
    const copy = path.join(w.env.ZODCHI_HOME, "plugins", head);
    t.ok(fs.existsSync(path.join(copy, ".complete")), "the plugins were copied from the commit to ~/.zodchi/plugins/<hash>");
    const reg = registry(w);
    t.ok(samePath(reg["zodchi-core@zodchi"][0].installPath, cacheOf(w, "zodchi-core")) && samePath(reg["zodchi-web-apps@zodchi"][0].installPath, cacheOf(w, "zodchi-web-apps")), "both plugins are registered with a cache folder keyed by name and version");
    t.eq(read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")), "// code-package, commit 1\n", "the cached code-package.js is the copy's");
    t.eq(read(path.join(cacheOf(w, "zodchi-web-apps"), "workflows", "branch-review.js")), "// branch-review, commit 1\n", "the cached domain workflow is the copy's");
    t.ok(r.out.includes("code-package.js in Claude Code's cache") && r.out.includes("is the copy's"), "the installer says it compared the cache with the copy");
    t.eq(r.lines[r.lines.length - 1], SESSIONS, "the last line says that open sessions keep the plugins they started with");
    t.ok(!fakeCalls(w).some((c) => c.args[1] === "uninstall" || c.args[1] === "update"), "a first install neither uninstalls nor updates anything");
    // The model itself: an update at an unchanged version is a no-op, which is why the installer does not use it.
    const next = path.join(w.dir, "next-marketplace");
    fs.mkdirSync(path.join(next, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(next, "core", ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(next, "core", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(next, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: MARKET, plugins: [{ name: "zodchi-core", source: "./core" }] }));
    fs.writeFileSync(path.join(next, "core", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "zodchi-core", version: VERSION }));
    fs.writeFileSync(path.join(next, "core", "workflows", "code-package.js"), "// code-package, commit 9\n");
    const fake = (...a) => spawnSync(process.execPath, [FAKE, ...a], { env: w.env, encoding: "utf8", windowsHide: true });
    t.eq(fake("plugin", "marketplace", "add", next).status, 0, "the fake registers a marketplace with a newer zodchi-core at the same version");
    const upd = fake("plugin", "update", "zodchi-core@zodchi", "--scope", "user");
    t.log(`fake update -> ${upd.status} ${upd.stdout}${upd.stderr}`);
    t.ok(/already at the latest version/.test(upd.stdout) && read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")) === "// code-package, commit 1\n", "the fake models the bug: `plugin update` at the same version prints \"already at the latest version\" and keeps the old cache");
  });

  scenario("install-plugins-refresh", "a second install after a new commit refreshes Claude Code's cache (zodchi-core and a domain) although the version is unchanged: uninstall and install again, never update", async (t) => {
    const w = clone(t, "install-refresh");
    t.eq(install(t, w, ["--domains", "web-apps"]).code, 0, "the first install succeeds");
    const before = fakeCalls(w).length;
    const second = commit(w, 2);
    const r = install(t, w, ["--domains", "web-apps"]);
    t.eq(r.code, 0, "the second install succeeds");
    t.ok(fs.existsSync(path.join(w.env.ZODCHI_HOME, "plugins", second, ".complete")), "the new commit has its own copy");
    const calls = fakeCalls(w).slice(before).map((c) => c.args.slice(0, 3).join(" "));
    t.ok(!calls.some((c) => c.startsWith("plugin update")), "`claude plugin update` is not called for a plugin");
    for (const id of ["zodchi-core@zodchi", "zodchi-web-apps@zodchi"]) {
      const at = (verb) => calls.findIndex((c) => c === `plugin ${verb} ${id}`);
      t.ok(at("install") >= 0 && at("uninstall") > at("install") && calls.lastIndexOf(`plugin install ${id}`) > at("uninstall"), `${id}: install says it is there, then uninstall, then install again`);
    }
    t.eq(read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")), "// code-package, commit 2\n", "the cached code-package.js is the new copy's although plugin.json still says " + VERSION);
    t.eq(read(path.join(cacheOf(w, "zodchi-web-apps"), "workflows", "branch-review.js")), "// branch-review, commit 2\n", "the cached domain workflow is the new copy's");
    t.eq(registry(w)["zodchi-core@zodchi"].length, 1, "zodchi-core is registered once");
    t.eq(r.lines[r.lines.length - 1], SESSIONS, "the last line is the note about open sessions");
    // A third run on the same commit stays consistent.
    const again = install(t, w, ["--domains", "web-apps"]);
    t.ok(again.code === 0 && read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")) === "// code-package, commit 2\n", "a rerun on the same commit succeeds and keeps the cache as it is");
  });

  scenario("install-plugins-local", "a domain in one project (local scope) is uninstalled and installed again in that scope and that folder; the user scope zodchi-core is refreshed beside it", async (t) => {
    const w = clone(t, "install-local");
    const args = ["--domains", "web-apps", "--project", w.project];
    t.eq(install(t, w, args).code, 0, "the first install succeeds");
    t.eq(registry(w)["zodchi-web-apps@zodchi"].map((e) => [e.scope, samePath(e.projectPath, w.project)]), [["local", true]], "the domain is registered for the project only");
    const before = fakeCalls(w).length;
    commit(w, 2);
    const r = install(t, w, args);
    t.eq(r.code, 0, "the second install succeeds");
    const mine = fakeCalls(w).slice(before).filter((c) => c.args[2] === "zodchi-web-apps@zodchi");
    t.eq(mine.map((c) => [c.args[1], c.args[3], c.args[4]]), [["install", "--scope", "local"], ["uninstall", "--scope", "local"], ["install", "--scope", "local"]], "install, uninstall, install, all in local scope");
    t.ok(mine.every((c) => samePath(c.cwd, w.project)), "each of them ran in the project folder");
    t.eq(read(path.join(cacheOf(w, "zodchi-web-apps"), "workflows", "branch-review.js")), "// branch-review, commit 2\n", "the domain's cache is the new copy's");
    t.eq(read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")), "// code-package, commit 2\n", "and so is zodchi-core's");
  });

  scenario("install-plugins-reinstall-fails", "an install whose reinstall fails says that the plugin is now not installed and gives the command to install it", async (t) => {
    const w = clone(t, "install-reinstall-fails");
    t.eq(install(t, w, []).code, 0, "the first install succeeds");
    commit(w, 2);
    fs.writeFileSync(path.join(w.fake, "fail-reinstall"), "");
    const r = install(t, w, []);
    t.ok(r.code !== 0, "the installer fails");
    t.ok(/zodchi-core@zodchi was uninstalled to refresh it and is now NOT installed/.test(r.err), "the error says the plugin is now NOT installed");
    t.ok(r.err.includes("claude plugin install zodchi-core@zodchi --scope user"), "and gives the exact command to install it");
    t.ok(r.err.includes("connection reset"), "and carries what Claude Code said");
    t.ok(!registry(w)["zodchi-core@zodchi"], "it really is not registered");
    t.ok(!r.out.includes("Open Claude Code sessions keep"), "a failed install does not end with the note of a successful one");
    // The way out the message gives works.
    fs.rmSync(path.join(w.fake, "fail-reinstall"));
    const fixed = install(t, w, []);
    t.ok(fixed.code === 0 && read(path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js")) === "// code-package, commit 2\n", "a rerun when the download works installs it again with the new copy's files");
  });

  scenario("install-plugins-stale-cache", "the installer does not report success when Claude Code's cache still differs from the copy: it names both paths", async (t) => {
    const w = clone(t, "install-stale");
    t.eq(install(t, w, []).code, 0, "the first install succeeds");
    commit(w, 2);
    // Another scope still uses the cache folder, so uninstalling does not remove it and the install reuses it.
    fs.writeFileSync(path.join(w.fake, "keep-cache"), "");
    const r = install(t, w, []);
    t.ok(r.code !== 0, "the installer fails");
    const cached = path.join(cacheOf(w, "zodchi-core"), "workflows", "code-package.js");
    t.ok(r.err.includes(cached) && /differs from/.test(r.err), "the error names the cached file");
    t.ok(r.err.includes(path.join(w.env.ZODCHI_HOME, "plugins")) && r.err.includes(path.join("core", "workflows", "code-package.js")), "and the copy's file");
    t.ok(r.err.includes("claude plugin uninstall zodchi-core@zodchi --scope user"), "and how to refresh it by hand");
    t.ok(!r.out.includes("Open Claude Code sessions keep"), "no success note");
  });

  scenario("install-plugins-uninstall", "--uninstall takes the plugins and the marketplace out of Claude Code, and the copies of the plugins with them, and touches no other marketplace", async (t) => {
    const w = clone(t, "install-uninstall");
    t.eq(install(t, w, ["--domains", "web-apps"]).code, 0, "the install succeeds");
    // Another marketplace's plugin, registered in the same registration, must stay as it is.
    const other = path.join(w.config, "plugins", "cache", "other", "their-plugin", "1.0.0");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "file.txt"), "theirs\n");
    const regFile = path.join(w.config, "plugins", "installed_plugins.json");
    const reg = JSON.parse(read(regFile));
    reg.plugins["their-plugin@other"] = [{ scope: "user", installPath: other, version: "1.0.0" }];
    fs.writeFileSync(regFile, JSON.stringify(reg));
    const r = install(t, w, ["--uninstall"]);
    t.eq(r.code, 0, "the uninstall succeeds");
    t.eq(Object.keys(registry(w)), ["their-plugin@other"], "no zodchi plugin is registered any more, the other marketplace's one still is");
    t.ok(!fs.existsSync(cacheOf(w, "zodchi-core")) && !fs.existsSync(cacheOf(w, "zodchi-web-apps")), "their cache folders are gone");
    t.eq(read(path.join(other, "file.txt")), "theirs\n", "the other marketplace's files are untouched");
    t.ok(!fs.existsSync(path.join(w.env.ZODCHI_HOME, "plugins")), "the plugin copies are removed");
    t.ok(!r.out.includes("Open Claude Code sessions keep"), "an uninstall does not print the note of an install");
  });
}
