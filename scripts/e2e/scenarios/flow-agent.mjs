import fs from "node:fs";
import path from "node:path";

const report = (status, flowWrites, questions = []) => ({
  status, flowWrites, summary: status, criteria: [], questions, changedFiles: [], checks: [],
});
const turns = (f) => fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED, samePath }) {
  scenario("flow-agent-continue", "a cut during the next ephemeral writer turn preserves the working copy and handoff summary", async (t) => {
    const f = flowWorld(t, "flow-agent-continue");
    const binary = [8, 0, 255];
    const fromOtherPackage = path.join(f.r, "src", "other.mjs");
    fs.writeFileSync(fromOtherPackage, "local work outside this package\n");
    const limits = {
      model_context_window: 272000,
      model_auto_compact_token_limit: 244800,
      model_auto_compact_token_limit_scope: "total",
    };
    const role = path.join(f.r, ".zodchi", "roles", "flow-work.json");
    fs.mkdirSync(path.dirname(role), { recursive: true });
    fs.writeFileSync(role, JSON.stringify({ extends: "flow-work", sandbox: "read-only" }));
    const noTools = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.ok(noTools.code === 2 && /work role with workspace-write/.test(noTools.json?.refused ?? "") && !noTools.json?.runId,
      "an incompatible role fails the gate before a run can ask the writer");
    fs.writeFileSync(role, JSON.stringify({ extends: "flow-work", config: limits }));
    const badPermission = await f.flow(["--args", f.args({ mode: "agent", allowCheckChanges: true })]);
    t.ok(badPermission.code === 2 && /exact paths.*tests\/math\.mjs/.test(badPermission.json?.refused ?? ""),
      "the gate explains the protected path array");
    const summary = "The math change and binary output are in the private workspace.";
    f.answer("write", { ...report("more", { "src/math.mjs": FIXED, "output.bin": { bytes: binary } }), summary });
    f.answer("write continue 1", report("more", {}));
    f.answer("write continue 2", report("more", {}));
    f.answer("write continue 3", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const badContext = await f.flow(["--args", f.args({ mode: "agent", reviewContext: ["src/missing.mjs"] })]);
    t.ok(badContext.code === 2 && /review context file src\/missing\.mjs/.test(badContext.json?.refused ?? "") && !badContext.json?.runId,
      "an absent review context file is refused before a model turn");
    const first = await f.flow(["--args", f.args({
      mode: "agent", continuations: 12, files: ["src/math.mjs", "output.bin"], reviewContext: ["src/other.mjs"],
    })], {
      ZODCHI_FLOW_CUT: "submit write continue 1",
    });
    t.eq(first.code, 75, "the engine cut after submitting the continuation");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8").replaceAll("\r\n", "\n"), STUB, "the live checkout has yet to be written");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json?.approved, f.claim()?.status, f.commits().length], [0, true, "done", 1], "the original run applies and reviews once");
    const observed = turns(f);
    t.eq(observed.map(turn => turn.step), ["write", "write continue 1", "write continue 2", "write continue 3", "review 1"],
      "a declared limit beyond the default continues without another owner answer");
    t.ok(observed[0].prompt.includes("Use local tools and the shell") && !observed[0].prompt.includes("no tools and no shell"),
      "the writer receives the workspace contract rather than expert patch instructions");
    const journal = path.join(result.json.journal, "requests");
    const requestFor = step => JSON.parse(fs.readFileSync(path.join(journal, `flow-${id}-${step}.json`), "utf8"));
    t.eq(requestFor("write").role.config, limits, "the writer receives the live project's role even though it is untracked");
    t.eq(requestFor("write-continue-1").role.config, limits, "the resumed writer keeps the project window");
    t.ok(requestFor("review-1").role.config === undefined, "the expert review uses its model window");
    const reviewPrompt = requestFor("review-1").prompt;
    t.ok(reviewPrompt.includes('<attachment path="src/other.mjs">')
      && reviewPrompt.includes("export const other = 1;") && !reviewPrompt.includes("local work outside this package"),
    "the reviewer sees pinned read-only context without the adjacent local edits");
    const receivedLimits = observed.map(turn => Object.fromEntries(Object.entries(turn.config).filter(([key]) => key in limits)));
    t.eq(receivedLimits, [limits, limits, limits, limits, {}], "Codex receives context overrides only for the worker turns");
    t.eq(observed.map(turn => [turn.ephemeral, turn.resumed ?? null]),
      Array.from({ length: 5 }, () => [true, null]), "each writer and review turn starts an ephemeral Codex thread");
    t.ok(observed[1].prompt.includes(summary), "the continuation sees the recorded writer summary");
    t.ok(samePath(observed[0].cwd, observed[1].cwd) && !samePath(f.r, observed[0].cwd), "the writer turns use the same isolated copy");
    t.eq([...fs.readFileSync(path.join(f.r, "output.bin"))], binary, "the engine copies binary output without a text round trip");
    t.eq(fs.readFileSync(fromOtherPackage, "utf8"), "local work outside this package\n", "the other work in the checkout is preserved");
    const files = gitOut(f.r, ["diff", "--name-only", f.base, "HEAD"]).split("\n");
    t.eq(files, ["output.bin", "src/math.mjs"], "only the scope is committed");
  });

  scenario("flow-agent-scope", "outside changes pause before application, and a reply continues in the same private workspace", async (t) => {
    const f = flowWorld(t, "flow-agent-scope");
    const summary = "The math change is ready and outside.txt was added in the private workspace.";
    f.answer("write", { ...report("done", { "src/math.mjs": FIXED, "outside.txt": "out\n" }), summary });
    const first = await f.flow(["--args", f.args({ mode: "agent" })]);
    const id = first.json?.runId;
    t.eq([first.code, first.json?.status, first.json?.outsideClaim, f.commits().length],
      [2, "waiting", ["outside.txt"], 0], "the owner has a decision before the claim publishes any file");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8").replaceAll("\r\n", "\n"), STUB, "the claimed original stays intact");
    const inspected = await zodchi(t, f.w, ["flow", "status", id], { cwd: f.w.dir, env: f.w.env });
    t.ok(inspected.json?.question?.includes("outside.txt"), "status exposes the pending decision");
    const input = path.join(f.w.dir, "reply.txt");
    fs.writeFileSync(input, "Drop the extra file and continue with the original scope.");
    const reply = await zodchi(t, f.w, ["flow", "reply", id, "--file", input], { cwd: f.w.dir, env: f.w.env });
    t.eq(reply.code, 0, "the owner can resume the existing code package");
    f.answer("write", report("done", { "outside.txt": null }));
    f.answer("review 1", f.review("approved"));
    const resumed = await f.flow(["--resume", id]);
    t.eq([resumed.code, resumed.json?.runId, resumed.json?.approved, fs.existsSync(path.join(f.r, "outside.txt"))],
      [0, id, true, false], "the package approves only its declared change");
    const observed = turns(f);
    t.eq([observed[1].ephemeral, observed[1].resumed ?? null], [true, null], "the owner reply opens a new ephemeral thread");
    t.ok(samePath(observed[0].cwd, observed[1].cwd), "the owner reply preserves the private workspace");
    t.ok(observed[1].prompt.includes(summary) && observed[1].prompt.includes("Drop the extra file"),
      "the new thread receives the prior summary and the owner's reply");
  });

  scenario("flow-agent-timeout", "a timed-out ephemeral writer leaves its completed edits for the next turn", async (t) => {
    const f = flowWorld(t, "flow-agent-timeout");
    const roles = path.join(f.w.dir, "roles");
    fs.cpSync(f.w.env.ZODCHI_ROLES, roles, { recursive: true });
    const role = path.join(roles, "flow-work.json");
    const settings = JSON.parse(fs.readFileSync(role, "utf8"));
    fs.writeFileSync(role, JSON.stringify({ ...settings, timeoutMin: 0.025, keepThread: true }));
    f.w.env.ZODCHI_ROLES = roles;

    f.answer("write", { ...report("more", { "src/math.mjs": FIXED }), flowHang: true });
    f.answer("write continue 1", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq([result.code, result.json?.approved, f.commits().length], [0, true, 1], "the saved edit is applied once");
    const observed = turns(f);
    t.eq(observed.map(turn => [turn.step, turn.ephemeral, turn.resumed ?? null]),
      [["write", true, null], ["write continue 1", true, null], ["review 1", true, null]],
      "the Flow overrides a role requesting a kept thread and opens ephemeral threads throughout");
    t.ok(samePath(observed[0].cwd, observed[1].cwd) && observed[1].prompt.includes("writer's turn timed out"),
      "the continuation gets the timeout handoff and reuses the original writable copy");
  });

  scenario("flow-agent-scope-approved", "the proposed paths can be approved without starting another writer turn", async (t) => {
    const f = flowWorld(t, "flow-agent-scope-approved");
    f.answer("write", report("done", { "src/math.mjs": FIXED, "src/other.mjs": "export const other = 2;\n" }));
    f.answer("review 1", f.review("approved"));
    const initial = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq(initial.json?.outsideClaim, ["src/other.mjs"], "the detected scope change is named");
    const allowed = path.join(f.w.dir, "approved.json");
    fs.writeFileSync(allowed, JSON.stringify(["src/other.mjs"]));
    const reply = await zodchi(t, f.w, ["flow", "reply", initial.json.runId, "--allow-files", allowed], { cwd: f.w.dir, env: f.w.env });
    t.eq(reply.code, 0, "the owner approves the exact extra path");
    const result = await f.flow(["--resume", initial.json.runId]);
    t.eq([result.code, result.json?.claimAdded, f.steps()], [0, ["src/other.mjs"], ["write", "review 1"]],
      "the engine applies the recorded workspace changes and reviews them in the original run");
  });
}
