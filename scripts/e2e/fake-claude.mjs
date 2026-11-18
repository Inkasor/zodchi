#!/usr/bin/env node
// A stand-in for the Claude Code CLI (`claude`) in the `flow-claude-*` scenarios: the three forms `zodchi flow`
// uses, no model and no network.
//
//   claude --version                 prints a version line
//   claude auth status --json        signed in with a subscription when FAKE_CLAUDE_HOME holds fake-auth.json; its
//                                    "orgs" list names the organization of each status asked in turn (the last one
//                                    repeats; "org-fake-one" without it), so a sign-in can change between the gate
//                                    and a call
//   claude -p ... --output-format json
//                                    reads the message on stdin and answers like `claude -p --output-format json`:
//                                    one result object whose `result` is the text of the answer
//
// The messages of `zodchi flow` carry "Step: <step> (" on a line of their own. A call of step "write" answers with
// the text of answers/write.json in FAKE_CLAUDE_HOME, as written (so an invalid answer can be scripted); the
// preflight answers {"ok": true} unless answers/preflight.json says otherwise; a step without a file ends with an
// error result. answers/<step>.exit holds an exit code the program ends with after printing its answer. Every
// invocation is logged to calls.jsonl in FAKE_CLAUDE_HOME: {pid, at, args, kind} with kind "version", "auth" (with
// the orgId answered) or "call"; a call adds step, model, effort, apiKey (whether an ANTHROPIC_ variable reached
// it), cwd and prompt.
import fs from "node:fs";
import path from "node:path";

const home = process.env.FAKE_CLAUDE_HOME || "";
const file = (name) => path.join(home, name);
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };

const log = (entry) => fs.appendFileSync(file("calls.jsonl"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), args, ...entry }) + "\n");
if (args[0] === "--version") {
  log({ kind: "version" });
  process.stdout.write("9.9.9 (Claude Code, fake)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  const signed = fs.existsSync(file("fake-auth.json"));
  const orgs = (signed && JSON.parse(fs.readFileSync(file("fake-auth.json"), "utf8") || "{}").orgs) || ["org-fake-one"];
  const asked = fs.existsSync(file("calls.jsonl")) ? fs.readFileSync(file("calls.jsonl"), "utf8").split("\n").filter((l) => l.includes('"kind":"auth"')).length : 0;
  const orgId = orgs[Math.min(asked, orgs.length - 1)];
  log({ kind: "auth", orgId: signed ? orgId : null });
  process.stdout.write(JSON.stringify(signed ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", orgId, subscriptionType: "pro" } : { loggedIn: false, authMethod: "none" }) + "\n");
  process.exit(signed ? 0 : 1);
}
if (!args.includes("-p")) {
  process.stderr.write("fake claude: only --version, auth status and -p\n");
  process.exit(2);
}

const result = (text, isError = false, code = isError ? 1 : 0) => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: isError, result: text, session_id: "fake-session", num_turns: 1 }) + "\n");
  process.exit(code);
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const step = (input.match(/^Step: (.+?) \(/m) || [])[1] || "";
  log({ kind: "call", step, model: after("--model"), effort: after("--effort"),
    apiKey: Object.keys(process.env).some((k) => k.toUpperCase().startsWith("ANTHROPIC_")), cwd: process.cwd(), prompt: input });
  // The flags of a call without tools, MCP servers, hooks or a kept session, and a JSON result.
  const tools = after("--tools");
  const required = ["--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--disable-slash-commands"];
  if (tools !== "" || after("--output-format") !== "json" || !required.every((f) => args.includes(f)) || !after("--model")) {
    return result(`fake claude: a call needs --tools "", ${required.join(", ")}, --model and --output-format json`, true);
  }
  const answer = file(path.join("answers", `${step.replace(/ /g, "-")}.json`));
  const exit = file(path.join("answers", `${step.replace(/ /g, "-")}.exit`));
  const code = fs.existsSync(exit) ? Number(fs.readFileSync(exit, "utf8").trim()) : 0;
  if (fs.existsSync(answer)) return result(fs.readFileSync(answer, "utf8").trim(), false, code);
  if (step === "preflight") return result('{"ok": true}');
  return result(`fake claude: no scripted answer for step "${step}"`, true);
});
