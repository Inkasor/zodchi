// Claude as an executor of a model step of `zodchi flow` (docs/flow-claude.md), against scripts/e2e/fake-claude.mjs.
// On POSIX the fake is a `claude` program on PATH; on Windows, where only a native claude.exe is looked up on PATH,
// it is named by ZODCHI_CLAUDE_BIN. The real Claude CLI never runs here: an enabled scenario always has the fake
// first, and the "missing" one takes every folder holding a claude program off PATH.
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const FIXED = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const KEY = "not-a-real-key-for-the-flow-claude-scenarios";
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

export default function register({ scenario, flowWorld, gitOut, ROOT, STUB }) {
  const FAKE_CLAUDE = path.join(ROOT, "scripts", "e2e", "fake-claude.mjs");

  /** A flow world (writer candidates claude/opus then codex/fake-writer) with a fake Claude home, an API key in the
   *  caller's environment that must not reach the call, and Claude enabled or not, on PATH or missing. */
  function claudeWorld(t, name, { enabled = true, present = true, signedIn = true } = {}) {
    const f = flowWorld(t, name);
    const env = f.w.env;
    const home = path.join(f.w.dir, "claude-home");
    fs.mkdirSync(path.join(home, "answers"), { recursive: true });
    if (signedIn) fs.writeFileSync(path.join(home, "fake-auth.json"), "{}");
    env.FAKE_CLAUDE_HOME = home;
    env.ANTHROPIC_API_KEY = KEY;
    delete env.ZODCHI_CLAUDE_BIN;
    if (enabled) fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: true }));
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    const dirs = (env[pathKey] || "").split(path.delimiter).filter(Boolean);
    if (present && WIN) env.ZODCHI_CLAUDE_BIN = FAKE_CLAUDE;
    else if (present) {
      const bin = path.join(f.w.dir, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node '${FAKE_CLAUDE.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
      env[pathKey] = [bin, ...dirs].join(path.delimiter);
    } else {
      const holds = (d) => ["claude", "claude.exe", "claude.cmd"].some((n) => fs.existsSync(path.join(d, n)));
      const kept = dirs.filter((d) => !holds(d));
      // Node must stay reachable for the checks even when it shares a folder with a claude program.
      const nodeDir = path.dirname(process.execPath);
      if (holds(nodeDir)) {
        const own = path.join(f.w.dir, "node-bin");
        fs.mkdirSync(own, { recursive: true });
        const exe = path.join(own, path.basename(process.execPath));
        if (WIN) fs.copyFileSync(process.execPath, exe); else fs.symlinkSync(process.execPath, exe);
        kept.unshift(own);
      }
      env[pathKey] = kept.join(path.delimiter);
    }
    const answer = (step, value) => fs.writeFileSync(path.join(home, "answers", `${step.replace(/ /g, "-")}.json`), typeof value === "string" ? value : JSON.stringify(value));
    const calls = (kind = "call") => readJsonl(path.join(home, "calls.jsonl")).filter((c) => c.kind === kind);
    const events = (res) => readJsonl(path.join(res.json.journal, "events.jsonl"));
    return { f, home, answer, calls, events };
  }

  /** Every file under a folder, read as text. */
  const allText = (dir) => fs.readdirSync(dir, { recursive: true }).map((rel) => path.join(dir, String(rel)))
    .filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p, "utf8")).join("\n");

  scenario("flow-claude-writer", "Claude enabled: a Claude writer (preflight at the gate, one tool-free call without the API key) with the fake-Codex reviewer to approval; the call is journaled with its raw message", async (t) => {
    const c = claudeWorld(t, "flow-claude-writer");
    const { f } = c;
    c.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args()]);
    t.eq([res.code, res.json && res.json.verdict], [0, "approved"], "the run ends approved, exit 0");
    t.eq(res.json.models, { expertWriter: { provider: "claude", model: "opus", effort: "high" }, reviewer: { provider: "codex", model: "fake-writer", effort: "medium" } }, "the pair: the Claude writer and a distinct Codex reviewer, pinned");
    t.eq(c.calls().map((x) => x.step), ["preflight", "write"], "Claude ran the preflight at the gate and the write step once");
    t.eq([c.calls("version").length, c.calls("auth").length], [1, 1], "the program and its sign-in were checked once");
    const write = c.calls()[1];
    t.eq([write.model, write.effort, write.apiKey], ["opus", "high", false], "the call has the pinned model and effort, and no ANTHROPIC_ variable");
    t.ok(write.args[write.args.indexOf("--tools") + 1] === "" && write.args.includes("--safe-mode") && write.args.includes("--strict-mcp-config"), "the call has no tools, no MCP servers, no hooks or plugins");
    t.ok(write.prompt.includes("Make clamp(x, lo, hi) keep x") && write.prompt.includes("A structured patch of one code package"), "the message carries the brief and the step's schema");
    t.eq(f.steps(), ["review 1"], "Codex ran the review only");
    t.eq([f.commits().length, fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8")], [1, FIXED], "the patch of the Claude writer is committed");
    const intent = c.events(res).find((e) => e.kind === "intent" && e.step === "write");
    t.eq([intent.executor, intent.model], ["claude", "opus"], "the intent names the Claude executor before the call");
    const done = c.events(res).find((e) => e.kind === "done" && e.step === "write");
    t.ok(done && JSON.stringify(done).includes("Math.max(lo, x)"), "the validated answer is journaled as done");
    const job = path.join(res.json.journal, "claude", intent.key);
    const fin = JSON.parse(fs.readFileSync(path.join(job, "final.json"), "utf8"));
    t.ok(fin.status === "succeeded" && fin.turnStartedAt && JSON.parse(fs.readFileSync(path.join(job, "raw.json"), "utf8")).type === "result", "the raw final message and the final state are in the journal");
    t.ok(!allText(res.json.journal).includes(KEY), "the API key of the caller reaches no file of the journal");
    const cache = JSON.parse(fs.readFileSync(path.join(f.w.zhome, "claude-preflight.json"), "utf8"));
    t.ok(Object.keys(cache).some((k) => k.endsWith("|opus|high")), "the passed preflight is cached for this CLI version, model and effort");
    t.eq(f.claim().status, "done", "the claim is closed as done");
    const again = await f.flow(["--resume", res.json.runId]);
    t.eq([again.code, c.calls().length, f.steps().length], [0, 2, 1], "resuming the finished run calls nothing");
  });

  scenario("flow-claude-cut", "a cut right after the Claude call: resume reads the saved answer and never asks Claude again", async (t) => {
    const c = claudeWorld(t, "flow-claude-cut");
    const { f } = c;
    c.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "submit write" });
    t.eq(cut.code, 75, "the process ends right after the call, before its receipt");
    const flows = path.join(f.w.zhome, "flows");
    const [id] = fs.readdirSync(flows);
    const res = await f.flow(["--resume", id]);
    t.eq([res.code, res.json.verdict], [0, "approved"], "the resumed run goes on to approval");
    t.eq(c.calls().map((x) => x.step), ["preflight", "write"], "Claude was asked the write step once");
    t.eq(c.events(res).filter((e) => e.kind === "intent" && e.step === "write").length, 1, "one intent for the write step");
  });

  scenario("flow-claude-disabled", "Claude not enabled: the Claude candidate is skipped with its reason and the pair is Codex-only; the Claude program is never run", async (t) => {
    const c = claudeWorld(t, "flow-claude-disabled", { enabled: false });
    const { f } = c;
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args()]);
    t.eq([res.code, res.json.models.expertWriter.model, res.json.models.reviewer.model], [0, "fake-writer", "fake-reviewer"], "approved by the Codex-only pair");
    t.ok(res.json.skipped.some((s) => /claude\/opus: Claude is not an executor of this run: not enabled/.test(s)), "the skipped Claude candidate names why");
    t.eq(readJsonl(path.join(c.home, "calls.jsonl")).length, 0, "the Claude program never ran");
  });

  scenario("flow-claude-missing", "Claude enabled without a claude program, or not signed in: skipped at the gate with the reason, the Codex pair runs; with no other writer the gate refuses before any claim", async (t) => {
    const c = claudeWorld(t, "flow-claude-missing", { present: false });
    const { f } = c;
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args()]);
    t.eq([res.code, res.json.models.expertWriter.provider], [0, "codex"], "approved by the Codex pair");
    t.ok(res.json.skipped.some((s) => /claude\/opus: Claude preflight: the claude program is missing/.test(s)), "the skipped Claude candidate says the program is missing");
    const only = { expertWriter: { candidates: [{ provider: "claude", model: "opus", effort: "high" }] } };
    const refused = await f.flow(["--args", f.args({ models: only })]);
    t.ok(refused.code === 2 && /No writer\/reviewer pair of distinct models: .*claude program is missing/.test(refused.json.refused), "no valid pair left: refused with the reason");
    t.eq(f.commits().length, 1, "the refused run changed nothing");

    const s = claudeWorld(t, "flow-claude-signed-out", { signedIn: false });
    s.f.answer("write", s.f.patch([s.f.modify("src/math.mjs", STUB, FIXED)]));
    s.f.answer("review 1", s.f.review("approved"));
    const out = await s.f.flow(["--args", s.f.args()]);
    t.eq([out.code, out.json.models.expertWriter.provider], [0, "codex"], "signed out: the Codex pair runs");
    t.ok(out.json.skipped.some((x) => /claude\/opus: Claude preflight: Claude Code is not signed in with a Claude subscription/.test(x)), "the reason names the missing subscription sign-in");
    t.eq(s.calls().length, 0, "no model call was sent to Claude");
  });

  scenario("flow-claude-invalid", "the Claude writer answers outside its schema: a recorded failure, the run stops with the claim open and never switches to another model; a rerun with a valid answer goes on", async (t) => {
    const c = claudeWorld(t, "flow-claude-invalid");
    const { f } = c;
    c.answer("write", "Here is the patch: clamp now uses Math.min and Math.max.");
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args()]);
    t.eq([res.code, res.json.stoppedAt], [2, "gateway failed at write"], "the run stops at the write step");
    t.ok(/not one JSON object/.test(res.json.infra), "the failure says why");
    t.eq([c.calls().map((x) => x.step), f.steps(), f.commits().length], [["preflight", "write"], [], 0], "one Claude call, no Codex writer instead, nothing committed");
    t.eq([fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8"), f.claim().status], [STUB, "open"], "nothing applied, the claim stays open");
    const job = path.join(res.json.journal, "claude", c.events(res).find((e) => e.kind === "intent" && e.step === "write").key);
    t.ok(fs.readFileSync(path.join(job, "raw.json"), "utf8").includes("Here is the patch"), "the raw message is in the journal");

    const extra = f.patch([f.modify("src/math.mjs", STUB, FIXED)]);
    c.answer("write", { ...extra, note: "an extra field" });
    const second = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.ok(second.code === 2 && /does not follow the step's schema: answer has note/.test(second.json.infra), "an answer with a field outside the schema stops too");
    c.answer("write", extra);
    const third = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.eq([third.code, third.json.verdict, c.calls().filter((x) => x.step === "write").length], [0, "approved", 3], "a rerun with a valid answer goes on to approval");
    t.eq(gitOut(f.r, ["show", "--name-only", "--format=", "HEAD"]), "src/math.mjs", "one commit of the claimed file");
  });
}
