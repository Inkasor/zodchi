#!/usr/bin/env node
// A stand-in for `codex` in the end-to-end suite (scripts/e2e.mjs, scripts/e2e-release.mjs): `features list` and an
// `app-server` that speaks enough JSON-RPC for a sign-in, an account read and one turn. No model, no network.
// It answers with the CODEX_HOME it was started with, so a scenario can prove which Codex home ran a job.
//
// Files in CODEX_HOME steer it:
//   fake-auth.json        present = signed in to a ChatGPT subscription
//   fake-login-mode       "early" (completion before the answer to account/login/start), "never", "held" (the
//                         answer waits until the file fake-login-release exists and no completion follows), else the
//                         completion after the answer
//   fake-slow-cancel      present = account/login/cancel is answered after 1 s
//   fake-slow-exit        present = when its stdin closes, it writes fake-closing and exits only 1.5 s later
//   fake-account-error    present = account/read fails with an error that names a file in CODEX_HOME
//   fake-answer.json      present = the answer of a turn with an output schema (a scripted review), as written
// What it writes into CODEX_HOME:
//   fake-turns.jsonl      one line per turn/start: {pid, at, prompt, schema, image}; the invocation log a scenario
//                         counts executions with
//   fake-login-started    the loginId, when account/login/start arrives; fake-login-cancelled (the loginId) on a cancel
//   fake-exited           its pid, appended when it exits after its stdin closed
//   fake-entered-<name>   its pid, when a turn whose prompt holds HOLD:<name> has entered; that turn then waits until
//                         the file fake-release-<name> exists (the ready/release signal of a scenario)
// A prompt with FAIL ends the turn as failed. The markers a scenario waits for (fake-entered-<name>,
// fake-login-started, fake-login-cancelled) are published whole: written to a temporary file and renamed, so a file
// that exists holds its complete value.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const home = process.env.CODEX_HOME || "";
const args = process.argv.slice(2);
if (args[0] === "features") {
  process.stdout.write("image_generation\ncode_mode_host\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const file = (name) => path.join(home, name);
const authFile = file("fake-auth.json");
const mode = () => { try { return fs.readFileSync(file("fake-login-mode"), "utf8").trim(); } catch { return "late"; } };
// A tiny valid-looking PNG: the signature and an IHDR header are all the gateway checks.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
let imageThread = false;

/// Writes `name` in CODEX_HOME whole: a reader that sees the file sees all of `value`.
function publish(name, value) {
  const tmp = file(`.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, file(name));
}

function complete(loginId) {
  fs.writeFileSync(authFile, "{}");
  send({ method: "account/login/completed", params: { loginId, success: true, error: null } });
}

/// Calls `then` once `name` exists in CODEX_HOME. The fake polls the file system; a scenario never sleeps.
function whenExists(name, then) {
  if (fs.existsSync(file(name))) return then();
  setTimeout(() => whenExists(name, then), 25);
}

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
      if (fs.existsSync(file("fake-account-error"))) {
        return send({ id: msg.id, error: { code: -32000, message: "cannot read " + file("auth.json") + ": permission denied" } });
      }
      return reply({ account: fs.existsSync(authFile) ? { type: "chatgpt", email: "tester" + "@" + "example.org", planType: "plus" } : null });
    case "account/rateLimits/read":
      return reply({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: false, balance: "0" } } });
    case "account/login/start": {
      const loginId = "login-" + process.pid;
      const answer = { type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.invalid/device", userCode: "ABCD-1234" };
      const m = mode();
      publish("fake-login-started", loginId);
      if (m === "held") { whenExists("fake-login-release", () => reply(answer)); return; }
      if (m === "early") { complete(loginId); return reply(answer); }
      reply(answer);
      if (m !== "never") setTimeout(() => complete(loginId), 300);
      return;
    }
    case "account/login/cancel":
      publish("fake-login-cancelled", String(p.loginId || ""));
      if (fs.existsSync(file("fake-slow-cancel"))) { setTimeout(() => reply({}), 1000); return; }
      return reply({});
    case "account/logout":
      try { fs.unlinkSync(authFile); } catch { /* not signed in */ }
      return reply({});
    case "config/read": return reply({ config: {} });
    case "thread/start":
      imageThread = String(p.developerInstructions || "").includes("image job");
      return reply({ thread: { id: "thread-1" }, sandbox: "read-only", approvalPolicy: "never", instructionSources: [] });
    case "mcpServerStatus/list": return reply({ data: [], nextCursor: null });
    case "turn/start": {
      reply({ turn: { id: "turn-1" } });
      const prompt = (p.input || []).map((i) => i.text || "").join("\n");
      fs.appendFileSync(file("fake-turns.jsonl"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), prompt,
        schema: Boolean(p.outputSchema), image: imageThread }) + "\n");
      const finish = () => {
        if (prompt.includes("FAIL")) {
          send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "failed", error: { message: "boom" } } } });
          return;
        }
        if (imageThread) {
          send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "img-1", type: "imageGeneration", status: "completed",
            result: PNG.toString("base64"), revisedPrompt: "a dot", generationId: "gen-1" } } });
        } else {
          let text = "CODEX_HOME=" + home;
          if (p.outputSchema) {
            text = fs.existsSync(file("fake-answer.json")) ? fs.readFileSync(file("fake-answer.json"), "utf8").trim() : JSON.stringify({ codexHome: home });
          }
          send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "msg-1", type: "agentMessage", text } } });
        }
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "completed", durationMs: 5 } } });
      };
      const hold = prompt.match(/HOLD:([A-Za-z0-9_-]+)/);
      if (hold) {
        publish(`fake-entered-${hold[1]}`, String(process.pid));
        whenExists(`fake-release-${hold[1]}`, finish);
        return;
      }
      setTimeout(finish, 10);
      return;
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: "fake codex: no " + msg.method } });
  }
});
lines.on("close", () => {
  const exit = () => { fs.appendFileSync(file("fake-exited"), `${process.pid}\n`); process.exit(0); };
  if (!fs.existsSync(file("fake-slow-exit"))) return exit();
  fs.appendFileSync(file("fake-closing"), `${process.pid}\n`);
  setTimeout(exit, 1500);
});
