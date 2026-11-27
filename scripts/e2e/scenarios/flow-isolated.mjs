import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, FIXED }) {
  const math = "src/math.mjs";
  const other = "src/other.mjs";
  const get = (f, p) => fs.readFileSync(path.join(f.r, p), "utf8");
  const put = (f, p, text) => fs.writeFileSync(path.join(f.r, p), text);
  const cli = (t, f, args, env = {}) => zodchi(t, f.w, ["flow", ...args], { cwd: f.r, env: { ...f.w.env, ...env } });

  scenario("flow-isolated-apply", "a candidate keeps the live checkout unchanged and the approved commit is applied once after cuts", async (t) => {
    const f = flowWorld(t, "flow-isolated-apply");
    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    const original = get(f, math);
    put(f, other, "// staged user work\n");
    gitOut(f.r, ["add", "--", other]);
    put(f, other, "// unstaged user work\n");
    const closed = `// final round\n${FIXED}`;
    f.answer("write", f.patch([f.modify(math, original, FIXED)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    f.answer("close 1", f.patch([f.modify(math, FIXED, closed)]));
    f.answer("review 2", f.review("approved"));
    const approved = await f.flow(["--args", f.args({ isolated: true })]);
    t.eq([approved.code, approved.json?.application?.status], [0, "pending"], "review and application are separate");
    const { runId, candidate } = approved.json;
    const handoff = await cli(t, f, ["status", runId, "--handoff"]);
    t.eq([handoff.code, handoff.json?.candidate?.commit, handoff.json?.review?.verdict, handoff.json?.application?.status],
      [0, candidate.commit, "approved", "pending"], "another chat can read exact application receipts");
    t.ok(!JSON.stringify(handoff.json).includes("rounds"), "the handoff excludes historical conversation and review prose");
    t.eq([gitOut(f.r, ["rev-parse", "HEAD"]), get(f, math), gitOut(f.r, ["show", `:${math}`])],
      [f.base, original, original.trim()], "approval does not advance the branch or modify project files/index");
    t.eq(gitOut(f.r, ["rev-parse", `${candidate.commit}^`]), f.base, "the cumulative candidate is a single commit on the target base");
    const modelSteps = f.steps();
    put(f, math, "// user's overlapping edit\n");
    const conflict = await cli(t, f, ["apply", runId]);
    t.eq([conflict.code, get(f, math)], [2, "// user's overlapping edit\n"], "application preserves a user's edit in a claimed file");
    put(f, math, original);
    for (const cut of ["candidate files", "candidate index", "candidate branch"]) {
      const interrupted = await cli(t, f, ["apply", runId], { ZODCHI_FLOW_CUT: cut });
      t.eq(interrupted.code, 75, `application interrupted at ${cut}`);
    }
    const applied = await cli(t, f, ["apply", runId]);
    t.eq([applied.code, applied.json?.status, gitOut(f.r, ["rev-parse", "HEAD"]), get(f, math)],
      [0, "applied", candidate.commit, closed], "the exact approved SHA is the only commit to reach the branch");
    t.eq([gitOut(f.r, ["show", `:${other}`]), get(f, other), f.steps()],
      ["// staged user work", "// unstaged user work\n", modelSteps], "application recovery preserves other staging, files and model receipts");
    t.eq((await cli(t, f, ["status", runId])).json?.result?.application?.status ?? null, "applied", "status records completion of application");

    const moved = flowWorld(t, "flow-isolated-apply-moved");
    gitOut(moved.r, ["config", "core.autocrlf", "false"]);
    moved.answer("write", moved.patch([moved.modify(math, get(moved, math), FIXED)]));
    moved.answer("review 1", moved.review("approved"));
    const ready = await moved.flow(["--args", moved.args({ isolated: true })]);
    t.eq(ready.code, 0, "a candidate is approved before the target moves");
    const old = ready.json.candidate.commit;
    gitOut(moved.r, ["commit", "-qm", "empty target commit", "--allow-empty"]);
    const movingFile = "new-on-target.txt";
    put(moved, movingFile, "Commit on the target.\n");
    gitOut(moved.r, ["add", "--", movingFile]);
    gitOut(moved.r, ["commit", "-qm", "unrelated target change"]);
    const tip = gitOut(moved.r, ["rev-parse", "HEAD"]);
    put(moved, other, "Staged work.\n");
    gitOut(moved.r, ["add", "--", other]);
    put(moved, other, "Unstaged work.\n");
    const interrupted = await cli(t, moved, ["apply", ready.json.runId], { ZODCHI_FLOW_CUT: "candidate branch" });
    t.eq(interrupted.code, 75, "the moved application can be interrupted after advancing the branch");
    const landed = await cli(t, moved, ["apply", ready.json.runId]);
    const head = gitOut(moved.r, ["rev-parse", "HEAD"]);
    const parent = gitOut(moved.r, ["rev-parse", "HEAD^"]);
    const tree = gitOut(moved.r, ["rev-parse", "HEAD^{tree}"]);
    t.ok(head !== old, "the candidate is a new commit on the moved target");
    t.eq([landed.code, landed.json?.commit, landed.json?.candidateCommit, landed.json?.tree, parent],
      [0, head, old, tree, tip], "the result records both commits and the recovered tree");
    t.eq(gitOut(moved.r, ["diff-tree", "--no-commit-id", "--name-only", "-r", tip, head]), math,
      "the applied tree changes only the candidate path relative to the new parent");
    t.eq(gitOut(moved.r, ["rev-parse", `HEAD:${math}`]), gitOut(moved.r, ["rev-parse", `${old}:${math}`]),
      "the path uses the exact reviewed blob");
    t.eq(gitOut(moved.r, ["show", "-s", "--format=%an%n%ae%n%aI%n%B", head]), gitOut(moved.r, ["show", "-s", "--format=%an%n%ae%n%aI%n%B", old]),
      "the new commit preserves the author and message");
    t.eq([get(moved, math), get(moved, movingFile), gitOut(moved.r, ["show", `:${other}`]), get(moved, other), moved.steps()],
      [FIXED, "Commit on the target.\n", "Staged work.", "Unstaged work.\n", ["write", "review 1"]], "recovery preserves the target's files and local staging without a new review");
  });

  scenario("flow-isolated-stops", "failed checks, a refusal and target drift leave the live checkout alone", async (t) => {
    const f = flowWorld(t, "flow-isolated-stops");
    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    const original = get(f, math);
    const sameCheckout = () => [gitOut(f.r, ["rev-parse", "HEAD"]), get(f, math), gitOut(f.r, ["status", "--porcelain"])];
    const before = sameCheckout();
    f.answer("write", f.patch([f.modify(math, original, "export const clamp = () => 9;\n")]));
    const failed = await f.flow(["--args", f.args({ isolated: true, fixes: 0 })]);
    t.eq([failed.code, sameCheckout()], [2, before], "failed checks never publish the candidate");
    f.answer("write", f.patch([f.modify(math, original, FIXED)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    const rejected = await f.flow(["--args", f.args({ isolated: true, rounds: 1 })]);
    t.eq([rejected.code, rejected.json?.verdict, sameCheckout()], [2, "changes_requested", before], "rejected candidate stays private");
    t.eq((await cli(t, f, ["apply", rejected.json.runId])).code, 2, "application requires approval");
    f.answer("review 1", f.review("approved"));
    const ready = await f.flow(["--args", f.args({ isolated: true })]);
    t.eq(ready.code, 0, "another candidate is approved on the same base");
    put(f, math, `// Committed on the target after review.\n${original}`);
    gitOut(f.r, ["add", "--", math]);
    gitOut(f.r, ["commit", "-qm", "move the target after review"]);
    const moved = sameCheckout();
    const drift = await cli(t, f, ["apply", ready.json.runId]);
    t.ok(drift.json?.reason?.includes("target branch moved"), "application identifies the changed target");
    t.ok(drift.code === 2 && drift.json?.reason?.includes(math), "application refuses and names the overlapping file");
    t.eq(sameCheckout(), moved, "application after branch drift changes neither files nor the index");
  });

  scenario("flow-isolated-successor", "a correction begins at the retained candidate and reviews its entire inherited change", async (t) => {
    const f = flowWorld(t, "flow-isolated-successor");
    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    const original = get(f, math);
    const otherOriginal = get(f, other);
    f.answer("write", f.patch([f.modify(math, original, FIXED), f.modify(other, otherOriginal, "// inherited change\n")]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F17")]));
    const first = await f.flow(["--args", f.args({ isolated: true, rounds: 1, files: [math, other] })]);
    t.eq(first.json?.verdict ?? null, "changes_requested", "the original findings and candidate are retained");
    const sourceRun = first.json.runId;
    const correction = `// clarify the clamping contract\n${FIXED}`;
    f.answer("write", { status: "done", flowWrites: { [math]: correction }, summary: "close the prior finding", criteria: [], questions: [], changedFiles: [], checks: [] });
    f.answer("review 1", f.review("approved"));
    const refused = await f.flow(["--args", f.args({ label: "correction", isolated: true, sourceRun, files: [other] })]);
    t.ok(refused.json?.refused?.includes(`Claim ${math}`), "the next package claims all inherited edits");
    const fixed = await f.flow(["--args", f.args({ label: "correction", mode: "agent", isolated: true, sourceRun, files: [math, other] })]);
    t.eq([fixed.code, fixed.json?.sourceRun, fixed.json?.seed, get(f, math)], [0, sourceRun, first.json.candidate.commit, original], "the correction uses the retained commit and preserves the live checkout");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const review = turns.at(-1).prompt;
    t.ok(review.includes("F17 important") && review.includes("previous-package.json") && review.includes(original.trim()) && review.includes("clarify the clamping contract"), "the reviewer sees the earlier finding and cumulative diff");
    const delta = JSON.parse(review.match(/<attachment path="source-delta.json">\n(.*?)\n<\/attachment>/s)[1]);
    t.eq([delta.seed, delta.changedSinceSeed.map(entry => entry.path), delta.inheritedUnchanged],
      [first.json.candidate.commit, [math], [other]], "the reviewer can distinguish exact inherited paths from the correction");
    t.eq((await cli(t, f, ["apply", fixed.json.runId])).code, 0, "the cumulative correction can be applied");
  });

  scenario("flow-provider-safety-block", "record a provider refusal and stop the frozen run without a second model dispatch", async (t) => {
    const f = flowWorld(t, "flow-provider-safety-block");
    f.answer("write", { flowError: {
      message: "This content was flagged for possible cybersecurity risk. Fixture provider reply."
    } });
    const end = await f.flow(["--args", f.args({ isolated: true })]);
    t.eq(end.code, 2, "a provider refusal stops the flow");
    const id = end.json?.runId;
    t.ok(id, "the stopped run has a journal ID");
    const status = await cli(t, f, ["status", id]);
    t.eq(status.json?.safetyBlock?.step ?? null, "write", "the transport refusal has distinct evidence");
    t.eq([status.json?.status, status.json?.result?.verdict], ["finished", "blocked"], "the code package settles and releases its claim");
    const handoff = await cli(t, f, ["status", id, "--handoff"]);
    t.eq([handoff.code, handoff.json?.safetyBlock?.step, handoff.json?.safetyBlock?.provider],
      [0, "write", "codex"], "surface the precise provider refusal in the handoff");
    t.ok(!JSON.stringify(handoff.json).includes("Fixture provider reply"), "handoff has no raw provider prose");
    const resume = await cli(t, f, ["code-package", "--resume", id, "--rerun", "write", "--detach"]);
    t.eq([resume.code, resume.json?.safetyBlock?.step, f.steps()], [2, "write", ["write"]],
      "the same pinned request is never reissued through a workflow rerun");
  });
}
