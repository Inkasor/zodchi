#!/usr/bin/env node
// A stand-in for the Claude Code CLI (`claude`) for the `install-plugins-*` scenarios: the plugin commands the installer
// calls, modelled on how Claude Code keeps its plugin cache. No model, no network, nothing outside the scratch home.
//
//   claude --version
//   claude plugin marketplace list --json | add <dir> | update <name> | remove <name>
//   claude plugin install | uninstall | update <plugin>@<marketplace> [--scope user|local|project]
//
// The cache is keyed by name and version, like Claude Code's: <config>/plugins/cache/<marketplace>/<plugin>/<version>/,
// filled from the marketplace's plugin folder only when that folder does not exist yet. So `install` at a version whose
// cache is there reuses what is there, and `update` at the version already installed is a no-op that prints "already at
// the latest version" (that is the behaviour the installer must not rely on). The registration is
// <config>/plugins/installed_plugins.json: { version: 2, plugins: { "<plugin>@<marketplace>": [{ scope, projectPath?,
// installPath, version }] } } with projectPath (the folder the command runs in) for a local scope.
//
// Environment: CLAUDE_CONFIG_DIR (where the cache and the registration live) and FAKE_CLAUDE_PLUGIN_HOME (the fake's
// own state, marketplaces.json, and calls.jsonl: one line {args, cwd} per call). Switches, by a file in that folder:
//   fail-reinstall    an install of a plugin this fake uninstalled earlier fails (as a failed download would)
//   keep-cache        uninstall leaves the cache folder behind (as when another scope still uses it)
import fs from "node:fs";
import path from "node:path";

const home = process.env.FAKE_CLAUDE_PLUGIN_HOME || "";
const config = path.resolve(process.env.CLAUDE_CONFIG_DIR || "");
const args = process.argv.slice(2);
const file = (name) => path.join(home, name);
const registration = path.join(config, "plugins", "installed_plugins.json");
const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback);
const writeJson = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value, null, 2) + "\n"); };

fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(file("calls.jsonl"), JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const say = (text, code = 0) => { (code ? process.stderr : process.stdout).write(text + "\n"); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };

if (args[0] === "--version") say("9.9.9 (Claude Code, fake plugin cache)");
if (args[0] !== "plugin") say("fake claude: only --version and plugin commands", 2);

const markets = readJson(file("marketplaces.json"), []);
const saveMarkets = () => writeJson(file("marketplaces.json"), markets);
const registry = readJson(registration, { version: 2, plugins: {} });
const saveRegistry = () => writeJson(registration, registry);
const cacheOf = (market, plugin, version) => path.join(config, "plugins", "cache", market, plugin, version);
const dropCache = (installPath) => {
  const used = Object.values(registry.plugins).flat().some((e) => e.installPath === installPath);
  if (!used && !fs.existsSync(file("keep-cache"))) fs.rmSync(installPath, { recursive: true, force: true });
};

if (args[1] === "marketplace") {
  if (args[2] === "list") say(JSON.stringify(markets));
  if (args[2] === "add") {
    const dir = path.resolve(args[3]);
    const name = readJson(path.join(dir, ".claude-plugin", "marketplace.json"), {}).name;
    if (!name) say(`no marketplace.json in ${dir}`, 1);
    markets.splice(0, markets.length, ...markets.filter((m) => m.name !== name), { name, source: "directory", path: dir });
    saveMarkets();
    say(`marketplace ${name} added from ${dir}`);
  }
  if (args[2] === "update") say(`marketplace ${args[3]} refreshed`);
  if (args[2] === "remove") {
    markets.splice(0, markets.length, ...markets.filter((m) => m.name !== args[3]));
    saveMarkets();
    // The plugins installed from a marketplace go with it, and their cache with them.
    for (const id of Object.keys(registry.plugins).filter((k) => k.endsWith(`@${args[3]}`))) {
      const gone = registry.plugins[id];
      delete registry.plugins[id];
      for (const e of gone) dropCache(e.installPath);
    }
    saveRegistry();
    say(`marketplace ${args[3]} removed`);
  }
  say("fake claude: unsupported marketplace command", 2);
}

if (["install", "uninstall", "update"].includes(args[1])) {
  const id = args[2] || "";
  const [plugin, market] = id.split("@");
  const scope = flag("--scope") || "user";
  const entry = markets.find((m) => m.name === market);
  if (!entry) say(`marketplace ${market} not found`, 1);
  const listed = readJson(path.join(entry.path, ".claude-plugin", "marketplace.json"), { plugins: [] }).plugins.find((p) => p.name === plugin);
  const projectPath = scope === "user" ? undefined : process.cwd();
  const list = registry.plugins[id] || [];
  const same = (e) => e.scope === scope && e.projectPath === projectPath;
  const mine = list.find(same);
  const state = readJson(file("state.json"), { uninstalled: [] });

  if (args[1] === "uninstall") {
    if (!mine) say(`Plugin "${id}" not found in installed plugins (${scope} scope)`, 1);
    registry.plugins[id] = list.filter((e) => !same(e));
    if (!registry.plugins[id].length) delete registry.plugins[id];
    dropCache(mine.installPath);
    saveRegistry();
    state.uninstalled.push(id);
    writeJson(file("state.json"), state);
    say(`uninstalled ${id} (${scope} scope)`);
  }
  if (!listed) say(`plugin ${plugin} not found in marketplace ${market}`, 1);
  const source = path.resolve(entry.path, listed.source);
  const version = readJson(path.join(source, ".claude-plugin", "plugin.json"), {}).version || "0.0.0";
  const installPath = cacheOf(market, plugin, version);
  const fill = () => { if (!fs.existsSync(installPath)) fs.cpSync(source, installPath, { recursive: true }); };

  if (args[1] === "install") {
    if (mine) say(`Plugin "${id}" is already installed in ${scope} scope`, 1);
    if (fs.existsSync(file("fail-reinstall")) && state.uninstalled.includes(id)) say(`could not fetch ${id}: connection reset`, 1);
    fill();
    registry.plugins[id] = [...list, { scope, ...(projectPath ? { projectPath } : {}), installPath, version }];
    saveRegistry();
    say(`installed ${id} (${scope} scope) at ${version}`);
  }
  // update
  if (!mine) say(`Plugin "${id}" not found in installed plugins (${scope} scope)`, 1);
  if (mine.version === version) say(`${plugin} is already at the latest version (${version})`);
  fill();
  Object.assign(mine, { installPath, version });
  saveRegistry();
  say(`updated ${id} to ${version}`);
}
say("fake claude: unsupported plugin command", 2);
