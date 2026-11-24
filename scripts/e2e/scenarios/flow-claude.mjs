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
    const models = { expertWriter: { candidates: [{ provider: "claude", model: "haiku" }] } };
    c.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args({ models })]);
    t.eq([res.code, res.json && res.json.verdict], [0, "approved"], "the run ends approved, exit 0");
    const bound = res.json.models.expertWriter.account;
    t.ok(/^claude-[0-9a-f]{16}$/.test(bound || ""), "the Claude writer is bound to the account of its sign-in at the gate, as a digest");
    t.eq(res.json.models, { expertWriter: { provider: "claude", model: "haiku", effort: "high", account: bound }, reviewer: { provider: "codex", model: "fake-writer", effort: "medium" } }, "the pair uses the default Haiku effort and a distinct Codex reviewer");
    t.eq(c.calls().map((x) => x.step), ["preflight", "write"], "Claude ran the preflight at the gate and the write step once");
    t.eq([c.calls("version").length, c.calls("auth").length], [1, 2], "the program was checked once; its sign-in at the gate and again right before the call");
    const write = c.calls()[1];
    t.eq([write.model, write.effort, write.apiKey], ["haiku", "high", false], "the call has the pinned model and effort, and no ANTHROPIC_ variable");
    t.eq(JSON.parse(fs.readFileSync(write.args[write.args.indexOf("--settings") + 1], "utf8")), { disableAllHooks: true },
      "the tool-free Haiku call lets Claude Code choose its default auto-compaction window");
    t.ok(write.args[write.args.indexOf("--tools") + 1] === "" && write.args.includes("--safe-mode") && write.args.includes("--strict-mcp-config"), "the call has no tools, no MCP servers, no hooks or plugins");
    t.ok(write.prompt.includes("Make clamp(x, lo, hi) keep x") && write.prompt.includes("A structured patch of one code package"), "the message carries the brief and the step's schema");
    t.eq(f.steps(), ["review 1"], "Codex ran the review only");
    t.eq([f.commits().length, fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8")], [1, FIXED], "the patch of the Claude writer is committed");
    const intent = c.events(res).find((e) => e.kind === "intent" && e.step === "write");
    t.eq([intent.executor, intent.model], ["claude", "haiku"], "the intent names the Claude executor before the call");
    const done = c.events(res).find((e) => e.kind === "done" && e.step === "write");
    t.ok(done && JSON.stringify(done).includes("Math.max(lo, x)"), "the validated answer is journaled as done");
    const job = path.join(res.json.journal, "claude", intent.key);
    const fin = JSON.parse(fs.readFileSync(path.join(job, "final.json"), "utf8"));
    t.ok(fin.status === "succeeded" && fin.turnStartedAt && JSON.parse(fs.readFileSync(path.join(job, "raw.json"), "utf8")).type === "result", "the raw final message and the final state are in the journal");
    t.ok(!allText(res.json.journal).includes(KEY), "the API key of the caller reaches no file of the journal");
    t.ok(!allText(res.json.journal).includes("org-fake-one") && fin.account === bound, "the job names the bound account by its digest, never by its name");
    const cache = JSON.parse(fs.readFileSync(path.join(f.w.zhome, "claude-preflight.json"), "utf8"));
    t.ok(Object.keys(cache).some((k) => k.endsWith("|haiku|high")), "the passed preflight is cached for this CLI version, model and effort");
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

    const r = claudeWorld(t, "flow-claude-reserved");
    r.answer("write", r.f.patch([r.f.modify("src/math.mjs", STUB, FIXED)]));
    r.f.answer("review 1", r.f.review("approved"));
    const reserved = await r.f.flow(["--args", r.f.args()], { ZODCHI_FLOW_CUT: "claude reserved" });
    t.eq(reserved.code, 75, "a cut after the key of the Claude call was reserved and before its job record");
    const [rid] = fs.readdirSync(path.join(r.f.w.zhome, "flows"));
    const back = await r.f.flow(["--resume", rid]);
    t.eq([back.code, back.json && back.json.verdict], [0, "approved"], "resume reads the reserved key as a call that never started and goes on to approval");
    t.eq(r.calls().map((x) => x.step), ["preflight", "write"], "Claude was asked the write step once");
    const keys = r.events(back).filter((e) => e.kind === "intent" && e.step === "write").map((e) => e.key);
    t.ok(keys.length === 2 && keys[1] === `${keys[0]}-r2`, "the reserved key is not reused: the step went on under the next key");
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
    const exit = path.join(c.home, "answers", "write.exit");
    fs.writeFileSync(exit, "3");
    const crashed = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.ok(crashed.code === 2 && crashed.json.stoppedAt === "gateway failed at write" && /claude exited 3 after an answer in the schema/.test(crashed.json.infra), "a valid answer followed by exit 3 is a recorded failure, not a success");
    t.eq([f.commits().length, fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8")], [0, STUB], "nothing of the answer of a failed call was applied");
    fs.rmSync(exit);
    const third = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.eq([third.code, third.json.verdict, c.calls().filter((x) => x.step === "write").length], [0, "approved", 4], "a rerun with a valid answer and a clean exit goes on to approval");
    t.eq(gitOut(f.r, ["show", "--name-only", "--format=", "HEAD"]), "src/math.mjs", "one commit of the claimed file");
  });

  scenario("flow-claude-account", "the sign-in changes between the gate and the call, or Claude is disabled before a rerun: the call is refused with nothing sent and the run stops; enabled and signed in with the bound account again, a rerun goes on", async (t) => {
    const c = claudeWorld(t, "flow-claude-account");
    const { f } = c;
    fs.writeFileSync(path.join(c.home, "fake-auth.json"), JSON.stringify({ orgs: ["org-fake-one", "org-fake-two"] }));
    c.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args()]);
    t.eq([res.code, res.json.stoppedAt], [2, "gateway refused at write"], "the run stops at the write step");
    t.ok(/signed in with another account .* than the one this run was bound to at the gate .*nothing was sent/.test(res.json.infra), "the refusal says the account changed and nothing was sent");
    t.eq([c.calls().map((x) => x.step), f.steps(), f.commits().length, f.claim().status], [["preflight"], [], 0, "open"], "the other account never got the step, no other model was asked, nothing committed, the claim open");
    t.ok(!allText(res.json.journal).includes("org-fake-"), "neither account reaches the journal by its name");

    fs.writeFileSync(path.join(c.home, "fake-auth.json"), JSON.stringify({ orgs: ["org-fake-one"] }));
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: false }));
    const off = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.ok(off.code === 2 && /Claude is no longer enabled as an executor/.test(off.json.infra), "Claude disabled before the rerun: refused");
    t.eq(c.calls().length, 1, "still only the preflight reached Claude");

    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: true }));
    const back = await f.flow(["--resume", res.json.runId, "--rerun", "write"]);
    t.eq([back.code, back.json.verdict, c.calls().map((x) => x.step)], [0, "approved", ["preflight", "write"]], "enabled and signed in with the bound account again: the rerun goes on to approval");
  });
}
