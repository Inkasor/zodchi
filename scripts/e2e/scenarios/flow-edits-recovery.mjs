import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, blobOf, STUB, FIXED }) {
  const other = "export const other = 1;\n";
  const changedOther = "export const other = 2;\n";
  const edits = (f, path, original, replacements) => ({
    op: "modify", path, from: null, baseBlob: blobOf(f.r, original), content: null, edits: replacements,
  });
  const runId = (f) => fs.readdirSync(path.join(f.w.zhome, "flows"))[0];

  scenario("flow-edits-approve", "exact replacements preserve work-tree line endings and resume from the recorded apply", async (t) => {
    const f = flowWorld(t, "flow-edits-approve");
    const file = path.join(f.r, "src/math.mjs");
    const original = STUB.replaceAll("\n", "\r\n");
    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    fs.writeFileSync(file, original);
    gitOut(f.r, ["add", "--", "src/math.mjs"]);
    gitOut(f.r, ["commit", "-qm", "CRLF fixture"]);
    const base = gitOut(f.r, ["rev-parse", "HEAD"]);
    f.answer("write", f.patch([edits(f, "src/math.mjs", original, [
      { old: "=> x;\n", new: "=> Math.min(hi, Math.max(lo, x));\n" },
      { old: "export const clamp", new: "// Keep x inside the range.\nexport const clamp" },
    ])]));
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "apply write" });
    t.eq(cut.code, 75, "cut after applying both edits");
    const expected = ("// Keep x inside the range.\n" + FIXED).replaceAll("\n", "\r\n");
    t.eq(fs.readFileSync(file, "utf8"), expected, "only the addressed ranges change and new lines use CRLF");
    const result = await f.flow(["--resume", runId(f)]);
    t.eq([result.code, result.json.verdict, gitOut(f.r, ["rev-list", "--count", `${base}..HEAD`]), f.steps()], [0, "approved", "1", ["write", "review 1"]],
      "the recorded plan is reconciled, checked and committed once");
  });

  scenario("flow-edits-refused", "an incomplete, ambiguous, overlapping or stale edit cannot write any file in the patch", async (t) => {
    const cases = [
      { name: "absent", replacements: [{ old: "not in the file", new: "changed" }], reason: /no exact match/ },
      { name: "ambiguous", replacements: [{ old: "x", new: "value" }], reason: /matches more than once/ },
      { name: "overlap", replacements: [{ old: "export const", new: "const" }, { old: "const clamp", new: "const value" }], reason: /edits overlap/ },
      { name: "stale", replacements: [{ old: "=> x;", new: "=> lo;" }], reason: /stale patch/ },
    ];
    for (const item of cases) {
      const f = flowWorld(t, `flow-edits-${item.name}`);
      const edit = edits(f, "src/math.mjs", item.name === "stale" ? FIXED : STUB, item.replacements);
      f.answer("write", f.patch([f.modify("src/other.mjs", other, changedOther), edit]));
      const result = await f.flow(["--args", f.args({ files: ["src/math.mjs", "src/other.mjs"] })]);
      t.eq([result.code, f.commits().length, f.steps()], [2, 0, ["write"]], `${item.name}: refused before checks or review`);
      t.ok(item.reason.test(result.json.stoppedAt), `${item.name}: the result names the conflict`);
      t.eq(fs.readFileSync(path.join(f.r, "src/math.mjs"), "utf8"), STUB, "the conflicting file is untouched");
      t.eq(fs.readFileSync(path.join(f.r, "src/other.mjs"), "utf8"), other, "the earlier valid change was not applied");
    }
    const f = flowWorld(t, "flow-edits-protected");
    const check = "test/math.test.mjs";
    const original = fs.readFileSync(path.join(f.r, check), "utf8");
    f.answer("write", f.patch([edits(f, check, original, [{ old: "clamp ok", new: "verified clamp" }])]));
    const result = await f.flow(["--args", f.args({ files: [check] })]);
    t.eq([result.code, result.json.protectedChanged], [2, [check]], "existing protected checks keep their guard");
    t.eq(fs.readFileSync(path.join(f.r, check), "utf8"), original, "the check is untouched");
  });

  scenario("flow-index-reconcile-worktree", "resume restores a prepared index before refusing changes to the checked file", async (t) => {
    const f = flowWorld(t, "flow-index-reconcile-worktree");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    const cut = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "index 1" });
    t.eq(cut.code, 75, "cut after preparing the index");
    const file = path.join(f.r, "src/math.mjs");
    const userText = FIXED + "// Updated while the run was stopped.\n";
    fs.writeFileSync(file, userText);
    const result = await f.flow(["--resume", runId(f)]);
    t.eq([result.code, result.json.stoppedAt], [2, "commit (the work tree changed after the checks)"], "the checked tree is stale");
    t.eq(gitOut(f.r, ["diff", "--cached", "--name-only"]), "", "the unpublished entry is no longer staged");
    t.eq([fs.readFileSync(file, "utf8"), f.commits().length, f.steps()], [userText, 0, ["write"]], "the user's edit stays in the work tree");
  });

  scenario("flow-index-rollback", "a failed branch update after an index cut restores only the paths staged by the run", async (t) => {
    const f = flowWorld(t, "flow-index-rollback");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED), f.modify("src/other.mjs", other, changedOther)]));
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ files: ["src/math.mjs", "src/other.mjs"] })], { ZODCHI_FLOW_CUT: "apply write" });
    t.eq(cut.code, 75, "cut before starting the checks");
    fs.writeFileSync(path.join(f.r, "unrelated.mjs"), "export const unrelated = true;\n");
    gitOut(f.r, ["add", "--", "src/math.mjs", "unrelated.mjs"]);
    const id = runId(f);
    const indexCut = await f.flow(["--resume", id], { ZODCHI_FLOW_CUT: "index 1" });
    t.eq(indexCut.code, 75, "cut after adjusting the index and before moving the branch");
    const hook = path.join(f.r, ".git", "hooks", "reference-transaction");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nif [ "$1" = prepared ]; then exit 1; fi\n', { mode: 0o755 });
    const failed = await f.flow(["--resume", id]);
    t.eq([failed.code, failed.json.stoppedAt, gitOut(f.r, ["rev-parse", "HEAD"])],
      [2, "infrastructure at commit 1", f.base], "the reference transaction did not publish a commit");
    t.eq(gitOut(f.r, ["diff", "--cached", "--name-only"]).split("\n").sort(), ["src/math.mjs", "unrelated.mjs"],
      "the candidate version already staged by the user and the unrelated staging survive");
    t.eq(gitOut(f.r, ["show", ":src/other.mjs"]) + "\n", other, "the index entry changed by the engine returned to its original blob");
    fs.unlinkSync(hook);
    const resumed = await f.flow(["--resume", id]);
    t.eq([resumed.code, resumed.json.verdict, f.commits().length, f.steps()], [0, "approved", 1, ["write", "review 1"]],
      "after the error is cleared, the saved run finishes without a second writer turn");
  });

  scenario("flow-claim-close-error", "resume returns a closure error before returning saved approval and retries closure without a model turn", async (t) => {
    const f = flowWorld(t, "flow-claim-close-error");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "result" });
    t.eq(cut.code, 75, "cut after saving the result");
    const claims = path.join(f.w.home, ".zodchi", "packages");
    const claim = path.join(claims, fs.readdirSync(claims)[0], "clamp.json");
    const saved = fs.readFileSync(claim);
    fs.writeFileSync(claim, "{");
    const id = runId(f);
    const blocked = await f.flow(["--resume", id]);
    t.eq([blocked.code, blocked.json.approved, blocked.json.stoppedAt], [2, false, "infrastructure at close claim"],
      "an unreadable claim prevents approval");
    t.ok(blocked.json.infra.includes("cannot parse claim"), "the error includes the actual closure failure");
    fs.writeFileSync(claim, saved);
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json.verdict, f.claim().status, f.commits().length, f.steps()],
      [0, "approved", "done", 1, ["write", "review 1"]], "the retry closes the claim and returns the saved verdict");
  });
}
