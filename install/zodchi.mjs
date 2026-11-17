#!/usr/bin/env node
// Interim `zodchi` command: forwards every call to a Node gateway CLI (the reference gateway this project grew
// from) until the Rust gateway replaces it. The commands and options are the same: run, submit, wait, job, roles,
// check, account. What it adds is role lookup by name across zodchi's folders:
//   <repo>/.zodchi/roles/<name>.json   the repository's own role
//   <repo>/.codex/gateway/<name>.json  a role the reference gateway finds itself (name passed through)
//   ~/.zodchi/roles/<name>.json        the roles zodchi installed
// otherwise the name is passed through unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const home = process.env.ZODCHI_HOME || path.join(os.homedir(), ".zodchi");
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); } catch { /* checked below */ }
const cli = process.env.ZODCHI_GATEWAY_CLI || config.gatewayCli;
if (!cli || !fs.existsSync(cli)) {
  console.error(`zodchi: no gateway configured. Set "gatewayCli" in ${path.join(home, "config.json")} (or ZODCHI_GATEWAY_CLI) to the cli.mjs of the Node gateway, or rerun the installer with --gateway-cli.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const rootAt = argv.indexOf("--root");
let root = rootAt >= 0 ? argv[rootAt + 1] : null;
if (!root) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  root = git.status === 0 ? git.stdout.trim() : null;
}
const roleAt = argv.indexOf("--role");
if (roleAt >= 0 && argv[roleAt + 1] && /^[a-z0-9][a-z0-9-]{0,47}$/.test(argv[roleAt + 1])) {
  const name = argv[roleAt + 1];
  const own = root && path.join(root, ".zodchi", "roles", `${name}.json`);
  const legacy = root && path.join(root, ".codex", "gateway", `${name}.json`);
  const installed = path.join(home, "roles", `${name}.json`);
  if (own && fs.existsSync(own)) argv[roleAt + 1] = own;
  else if (legacy && fs.existsSync(legacy)) { /* the reference gateway resolves it */ }
  else if (fs.existsSync(installed)) argv[roleAt + 1] = installed;
}

const result = spawnSync(process.execPath, [cli, ...argv], { stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
