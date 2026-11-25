#!/usr/bin/env node
// A stand-in for `codex` in the `flow-*` scenarios of scripts/e2e.mjs: the same app-server protocol as
// fake-codex.mjs (enough for an account read and one turn per process), but each turn answers by its step. No model,
// no network.
//
// The prompts of `zodchi flow` start with "Step: <step> (code-package v1, run <id>)". A turn of step "review 1"
// answers with the file fake-flow/review-1.json in CODEX_HOME, as written (spaces in the step become "-"); a step
// without a file ends the turn as failed. CODEX_HOME holds fake-auth.json (signed in) and gets fake-turns.jsonl, one
// line per turn/start: {pid, at, step, prompt}, the invocation log the scenarios count executions with.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const home = process.env.CODEX_HOME || "";
const args = process.argv.slice(2);
if (args[0] === "features") {
  process.stdout.write("image_generation\ncode_mode_host\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const file = (name) => path.join(home, name);
let threadRequest;

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  const reply = (result) => send({ id: msg.id, result });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": return reply({});
    case "account/read":
      return reply({ account: fs.existsSync(file("fake-auth.json")) ? { type: "chatgpt", email: "tester" + "@" + "example.org", planType: "plus" } : null });
    case "account/rateLimits/read":
      return reply({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: false, balance: "0" } } });
    case "config/read": return reply({ config: {} });
    case "thread/start":
    case "thread/resume":
      threadRequest = p;
      return reply({ thread: { id: p.threadId || "thread-1" }, sandbox: p.sandbox, approvalPolicy: "never", instructionSources: [] });
    case "mcpServerStatus/list": return reply({ data: [], nextCursor: null });
    case "turn/start": {
      reply({ turn: { id: "turn-1" } });
      const prompt = (p.input || []).map((i) => i.text || "").join("\n");
      const step = (prompt.match(/^Step: (.+?) \([a-z][a-z0-9-]* v/m) || [])[1] || "";
      fs.appendFileSync(file("fake-turns.jsonl"), JSON.stringify({
        pid: process.pid, at: new Date().toISOString(), step, prompt,
        cwd: threadRequest?.cwd, resumed: threadRequest?.threadId, ephemeral: threadRequest?.ephemeral,
        config: threadRequest?.config,
      }) + "\n");
      const answer = file(path.join("fake-flow", `${step.replace(/ /g, "-")}.json`));
      setTimeout(() => {
        if (!step || !fs.existsSync(answer)) {
          send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "failed", error: { message: `fake codex: no scripted answer for step "${step}"` } } } });
          return;
        }
        const result = JSON.parse(fs.readFileSync(answer, "utf8"));
        if (result.flowError) {
          send({ method: "turn/completed", params: { threadId: p.threadId, turn: {
            id: "turn-1", status: "failed", error: result.flowError
          } } });
          return;
        }
        if (result.flowWrites) {
          if (threadRequest?.sandbox !== "workspace-write") throw new Error("Expected a writable writer fixture workspace");
          for (const [relative, data] of Object.entries(result.flowWrites)) {
            const target = path.resolve(threadRequest.cwd, relative);
            if (!target.startsWith(threadRequest.cwd + path.sep)) throw new Error("Fixture path lies outside its workspace");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (data === null) fs.rmSync(target, { force: true });
            else fs.writeFileSync(target, typeof data === "string" ? data : Buffer.from(data.bytes));
          }
          delete result.flowWrites;
        }
        if (result.flowNodeTest) {
          if (threadRequest?.sandbox !== "workspace-write") throw new Error("Expected a writable writer fixture workspace");
          const argv = ["--test", result.flowNodeTest];
          const test = spawnSync(process.execPath, argv, {
            cwd: threadRequest.cwd, encoding: "utf8", timeout: 15000, windowsHide: true,
          });
          result.checks.push({ command: `node ${argv.join(" ")}`, exitCode: test.status,
            result: (test.stdout + test.stderr).trim() });
          delete result.flowNodeTest;
        }
        if (result.flowHang) return;
        const text = JSON.stringify(result);
        send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "msg-1", type: "agentMessage", text } } });
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "completed", durationMs: 5 } } });
      }, 10);
      return;
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: "fake codex: no " + msg.method } });
  }
});
lines.on("close", () => process.exit(0));
