#!/usr/bin/env node
// A stand-in for `codex` in the server tests: `features list` and an `app-server` that speaks enough JSON-RPC for
// a sign-in, an account read and one turn. It answers with the CODEX_HOME it was started with, so a test can prove
// which Codex home ran a job. Files in CODEX_HOME steer it:
//   fake-auth.json        present = signed in to a ChatGPT subscription
//   fake-login-mode       "early" (completion before the answer to account/login/start), "never", "slow" (the
//                         answer comes after 1.5 s and no completion follows), else the completion after the answer
// It writes fake-login-started when account/login/start arrives and fake-login-cancelled (the loginId) on a cancel.
// A prompt with SLOW takes four seconds; one with FAIL ends the turn as failed.
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
const authFile = path.join(home, "fake-auth.json");
const mode = () => { try { return fs.readFileSync(path.join(home, "fake-login-mode"), "utf8").trim(); } catch { return "late"; } };
// A tiny valid-looking PNG: the signature and an IHDR header are all the gateway checks.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
let imageThread = false;

function complete(loginId) {
  fs.writeFileSync(authFile, "{}");
  send({ method: "account/login/completed", params: { loginId, success: true, error: null } });
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
      return reply({ account: fs.existsSync(authFile) ? { type: "chatgpt", email: "tester" + "@" + "example.org", planType: "plus" } : null });
    case "account/rateLimits/read":
      return reply({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: false, balance: "0" } } });
    case "account/login/start": {
      const loginId = "login-" + process.pid;
      const answer = { type: "chatgptDeviceCode", loginId, verificationUrl: "https://example.invalid/device", userCode: "ABCD-1234" };
      const m = mode();
      fs.writeFileSync(path.join(home, "fake-login-started"), loginId);
      if (m === "slow") { setTimeout(() => reply(answer), 1500); return; }
      if (m === "early") { complete(loginId); return reply(answer); }
      reply(answer);
      if (m !== "never") setTimeout(() => complete(loginId), 300);
      return;
    }
    case "account/login/cancel":
      fs.writeFileSync(path.join(home, "fake-login-cancelled"), String(p.loginId || ""));
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
      const finish = () => {
        if (prompt.includes("FAIL")) {
          send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "failed", error: { message: "boom" } } } });
          return;
        }
        if (imageThread) {
          send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "img-1", type: "imageGeneration", status: "completed",
            result: PNG.toString("base64"), revisedPrompt: "a dot", generationId: "gen-1" } } });
        } else {
          const text = p.outputSchema ? JSON.stringify({ codexHome: home }) : "CODEX_HOME=" + home;
          send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "msg-1", type: "agentMessage", text } } });
        }
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", status: "completed", durationMs: 5 } } });
      };
      setTimeout(finish, prompt.includes("SLOW") ? 4000 : 10);
      return;
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: "fake codex: no " + msg.method } });
  }
});
lines.on("close", () => process.exit(0));
