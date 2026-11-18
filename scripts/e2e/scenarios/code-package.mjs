// code-package: the review boundary and packages that share one checkout.
//
// The workflow (core/workflows/code-package.js) is run here the way Claude Code runs it: as the body of an async
// function with `args`, `agent`, `phase` and `log` in scope. `agent` is a script of answers keyed by the step's label,
// so every decision the workflow itself makes (the boundary stop, the review ledger, the refusal on another branch, the
// files it leaves out of its commit, the line it hands every agent) is tested on its own answers. What the prompts ask
// of a runner (the lock, the claims, Git) is checked as text of the prompt; it is carried out by the runner agent.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const LINE = "work in the checkout you were given; do not create clones or worktrees and do not switch branches";
const BOUNDARY = "Important: a normal run loses work between packages.\nOut of scope: two leads starting at the same instant.";

export default function register({ scenario, ROOT }) {
  const SRC = fs.readFileSync(path.join(ROOT, "core", "workflows", "code-package.js"), "utf8").replace(/^export const meta/, "const meta");

  /** The gate runner's answer: the exit code and the one JSON line the helper prints (core/scripts/gate.mjs). */
  const gateAnswer = (over = {}) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true, api: 1, plugin: { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" },
      roles: {}, modelsErrors: [], account: null, accountError: "none", git: true, head: "abc1234", branch: "main", dirty: [], ignoreExit: 0, ignoreLine: "",
      verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "", claims: { dir: "claims-dir/r", open: [], closed: [], kept: [], skipped: [], notes: [] },
      ...over,
    }),
  });

  /** Runs the workflow once. `o.reviews[i]` answers review round i+1; `o.answers` replaces the answer of a step label. */
  async function run(o = {}) {
    const calls = [];
    const reviews = [...(o.reviews || [{ verdict: "approved", findings: [] }])];
    const args = {
      label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"],
      models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } },
      ...(o.args || {}),
    };
    const answer = (label, prompt) => {
      const given = o.answers && o.answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt, calls) : given;
      if (label === "gate pkg") return gateAnswer({ config: o.config ? JSON.parse(o.config) : {}, branch: o.branch ?? "main", boundary: o.boundary ?? BOUNDARY });
      if (label === "claim pkg") return { ok: true, conflicts: [], branchConflicts: [] };
      if (label === "write pkg") return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
      if (label === "base pkg") return { ok: true, head: "abc1234", branch: args.branch || "main", verifySkill: false, reviewMd: false };
      if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
      if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "/r/.agent-tmp/pkg/logs/1.log" }] };
      if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: ["src/a.js"] };
      if (label.startsWith("review ")) return reviews.shift() || { verdict: "approved", findings: [] };
      if (label.startsWith("close ") && label.includes("claim")) return { ok: true, summary: "closed" };
      if (label.startsWith("close ")) return { done: true, summary: "fixed", changed: o.closeChanged === false ? [] : ["/r/src/a.js"], unverified: [] };
      if (label.startsWith("claim more")) return { ok: true, conflicts: [], others: [] };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    const sandbox = {
      args,
      phase: () => {},
      log: () => {},
      agent: async (prompt, opts) => {
        calls.push({ label: opts.label, prompt, opts });
        return answer(opts.label, prompt);
      },
    };
    const fn = vm.runInNewContext(`(async () => {\n${SRC}\n})`, sandbox, { filename: "code-package.js" });
    const out = await fn();
    return { out, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }

  const imp = (id, loc, problem) => `${id} important ${loc}: ${problem}`;
  const bad = (...f) => ({ verdict: "changes_requested", summary: "s", findings: f });

  scenario("code-package-boundary-quoted", "the review prompt quotes the brief's Review boundary section; a brief without it gets a note, not a refusal", async (t) => {
    const withIt = await run();
    t.eq(withIt.out.approved, true, "a brief with a boundary runs to approval");
    t.ok(withIt.out.notes === undefined, "no note when the boundary is there");
    const gate = withIt.of(/^gate /)[0].prompt;
    t.ok(gate.includes('"brief":"/r/brief.md"'), "the gate helper is given the brief, and reads its Review boundary section itself");
    const review = withIt.of(/^review 1$/)[0].prompt;
    t.ok(review.includes(JSON.stringify(BOUNDARY)), "the review prompt quotes the section exactly");
    t.ok(review.includes('"nit" or "pre-existing" finding, never "important"'), "a point outside the boundary is never important");

    const without = await run({ boundary: "" });
    t.eq(without.out.approved, true, "a brief without a boundary is not refused");
    t.ok(Array.isArray(without.out.notes) && without.out.notes.length === 1 && without.out.notes[0].includes('no "## Review boundary" section'), "the result carries a one-line note");
    t.ok(without.of(/^review 1$/)[0].prompt.includes('no "Review boundary" section'), "the review prompt says there is none");
  });

  scenario("code-package-review-deeper", "a round whose important findings are all new, with every earlier one closed, stops the run: boundary, proposed REVIEW.md lines, ledger", async (t) => {
    const r = await run({
      reviews: [bad(imp("F1", "src/a.js:10", "off by one")), bad(imp("F2", "src/a.js:55", "double fault in cleanup"), imp("F3", "src/b.js", "hostile file system"), "F4 nit src/a.js:3: naming")],
    });
    t.eq(r.out.stoppedAt, "review went deeper", "the run stops at round 2");
    t.eq(r.of(/^review /).length, 2, "no third review was spent");
    t.eq(r.of(/^close \d+$/).length, 1, "the writer closed round 1 only; round 2's findings were not given to it");
    t.eq(r.out.verdict, "changes_requested", "the verdict stays what the review said");
    t.eq(r.out.boundary.map((b) => b.id), ["F2", "F3"], "boundary lists the new important findings only");
    const today = new Date().toISOString().slice(0, 10);
    t.ok(r.out.boundary.every((b) => b.decide === "fix | out of scope" && b.ifOutOfScope.startsWith("- Do not flag: ") && b.ifOutOfScope.includes("Why:") && b.ifOutOfScope.includes(today)), "each has a proposed REVIEW.md line: what not to flag, why, date");
    t.ok(r.out.boundary[0].ifOutOfScope.includes("double fault in cleanup"), "the line names the problem");
    const ledger = Object.fromEntries(r.out.reviewLedger.map((e) => [e.id, e]));
    t.eq([ledger.F1.status, ledger.F1.closedBy, ledger.F1.closedInRound], ["closed", "code change", 2], "F1 was closed by a code change in round 2");
    t.eq([ledger.F2.status, ledger.F3.status, ledger.F4.status], ["to sort", "to sort", "open"], "the new important ones wait for the lead; the nit stays open");
    t.ok(String(r.out.next).includes("REVIEW.md"), "next tells the lead what to do with REVIEW.md");
    t.ok(r.of(/claim/).every((c) => !/REVIEW\.md.*(append|write|edit)/i.test(c.prompt.replace(/REVIEW\.md as of the base commit/g, ""))), "no step is asked to write REVIEW.md");
    t.ok(r.out.claimLeftOpen === undefined && r.of(/^close claim/).length === 1, "the claim is closed");
  });

  scenario("code-package-review-repeat-continues", "a finding that comes back keeps the run going; the ledger tells closed from open", async (t) => {
    const r = await run({
      reviews: [bad(imp("F1", "src/a.js:10", "off by one")), bad(imp("F1", "src/a.js:12", "off by one still"), imp("F2", "src/b.js", "new")), { verdict: "approved", findings: [] }],
    });
    t.eq([r.out.approved, r.out.stoppedAt], [true, undefined], "the repeated finding is not deeper: the run goes to round 3 and is approved");
    t.eq(r.of(/^review /).length, 3, "three reviews");
    const ledger = Object.fromEntries(r.out.reviewLedger.map((e) => [e.id, e]));
    t.eq([ledger.F1.firstRound, ledger.F1.lastRound, ledger.F1.status, ledger.F1.closedInRound], [1, 2, "closed", 3], "F1: seen in rounds 1 and 2 (the line moved), closed in round 3");
    t.eq([ledger.F2.status, ledger.F2.closedBy], ["closed", "code change"], "F2 closed by a code change");
    t.eq(r.out.reviewLedger.length, 2, "two findings in all");
  });

  scenario("code-package-review-deeper-last-round", "the boundary stop wins over the round limit; a close answered without a code change is told apart", async (t) => {
    const r = await run({
      closeChanged: false,
      reviews: [bad(imp("F1", "src/a.js", "one")), bad(imp("F1", "src/a.js", "one"), imp("F2", "src/a.js", "two")), bad(imp("F9", "src/z.js", "deep"))],
    });
    t.eq(r.out.stoppedAt, "review went deeper", "round 3 of 3 stops as deeper, not by the stop rule");
    const ledger = Object.fromEntries(r.out.reviewLedger.map((e) => [e.id, e]));
    t.eq([ledger.F1.status, ledger.F1.closedBy], ["closed", "answered without a code change"], "F1 was answered without a change");
    t.eq(ledger.F2.status, "closed", "F2 closed");
    t.eq(r.out.boundary.map((b) => b.id), ["F9"], "only F9 is for the lead");
  });

  scenario("code-package-stop-rule-still-holds", "important findings that keep coming back stop at the round limit, not as deeper", async (t) => {
    const r = await run({ reviews: [bad(imp("F1", "src/a.js", "x")), bad(imp("F1", "src/a.js", "x")), bad(imp("F1", "src/a.js", "x"))] });
    t.ok(String(r.out.stoppedAt).startsWith("stop rule: 3 review rounds"), `stoppedAt is the stop rule (${r.out.stoppedAt})`);
    t.ok(r.out.boundary === undefined, "no boundary list");
    t.eq(r.out.reviewLedger[0].status, "open", "the ledger keeps F1 open");
  });

  scenario("code-package-shared-branch-note", "the owner setting parallel shared-branch hands every agent of the run the line; without it no agent gets it", async (t) => {
    const on = await run({ config: JSON.stringify({ parallel: "shared-branch" }) });
    const after = on.calls.slice(1);
    t.ok(after.length >= 5, `steps after the gate ran (${after.length})`);
    t.ok(after.every((c) => c.prompt.includes(LINE)), `every step after the gate carries the line (${after.filter((c) => !c.prompt.includes(LINE)).map((c) => c.label)} lack it)`);
    t.ok(on.of(/^write /)[0].prompt.includes(LINE), "the writer's task carries it");
    t.ok(!on.calls[0].prompt.includes(LINE), "the gate only reads: it has not read the setting yet");

    const off = await run({});
    t.ok(off.calls.every((c) => !c.prompt.includes("clones or worktrees")), "unset: no agent is told anything about clones or worktrees");
    const other = await run({ config: JSON.stringify({ parallel: "worktrees" }) });
    t.ok(other.calls.every((c) => !c.prompt.includes("clones or worktrees")), "an unknown value is ignored");

    const sw = await run({ config: JSON.stringify({ parallel: "shared-branch" }), branch: "main", args: { branch: "feat" } });
    t.ok(String(sw.out.refused).includes("shared-branch"), "args.branch other than the checked-out branch is refused: the setting forbids switching");
    t.eq(sw.calls.length, 1, "nothing was claimed");
    const same = await run({ config: JSON.stringify({ parallel: "shared-branch" }), branch: "feat", args: { branch: "feat" } });
    t.eq(same.out.approved, true, "args.branch equal to the checked-out branch runs");
    t.ok(!same.of(/^claim pkg$/)[0].prompt.includes("git switch"), "and the claim step does not switch");
  });

  scenario("code-package-branch-refusal", "a package refuses to start while another open package of the repository is on a different branch; the claim records the branch", async (t) => {
    const r = await run({ answers: { "claim pkg": { ok: false, conflicts: [], branchConflicts: ["other: feat"] } } });
    t.ok(String(r.out.refused).includes("different branch") && r.out.refused.includes("other: feat") && r.out.refused.includes("main"), `refused with the reason (${r.out.refused})`);
    t.eq(r.calls.map((c) => c.label), ["gate pkg", "claim pkg"], "nothing ran after the claim step, and no claim was left to close");
    const claim = r.of(/^claim pkg$/)[0].prompt;
    t.ok(claim.includes('"branch":"main"'), "the claim file it would write names the branch");
    t.ok(claim.includes("branchConflicts") && claim.includes("A claim without a \"branch\" field is not a branch conflict"), "the comparison is in the prompt");

    const same = await run({});
    t.eq(same.out.approved, true, "with the same branch (no branch conflicts) the package runs");
    const named = await run({ args: { branch: "feat" } });
    t.ok(named.of(/^claim pkg$/)[0].prompt.includes('"branch":"feat"'), "args.branch is the branch the claim records");
    const detached = await run({ branch: "" });
    t.ok(detached.of(/^claim pkg$/)[0].prompt.includes('"branch":"(detached)"'), "a detached HEAD is recorded as such");
  });

  scenario("code-package-shared-checkout-files", "a file another open package claims, changed in the shared checkout, stays out of this package's claim and commit; a reported one is a conflict", async (t) => {
    let moreCalls = 0;
    const withOther = {
      "status write pkg": { ok: true, paths: ["src/a.js", "src/other.js"] },
      "status close 1": { ok: true, paths: ["src/a.js", "src/other.js"] },
      "claim more write pkg": () => { moreCalls++; return { ok: true, conflicts: [], others: ["src/other.js"] }; },
      "claim more close 1": () => { moreCalls++; return { ok: true, conflicts: [], others: ["src/other.js"] }; },
    };
    const r = await run({ answers: withOther, reviews: [bad(imp("F1", "src/a.js", "x")), { verdict: "approved", findings: [] }] });
    t.eq(r.out.approved, true, "the run goes on");
    t.eq(moreCalls, 1, "the other package's file is asked about once, then remembered");
    const more = r.of(/^claim more write pkg$/)[0].prompt;
    t.ok(more.includes('hard: []') && more.includes('soft: ["src/other.js"]'), "it is asked as a soft file");
    t.ok(more.includes("never a conflict"), "a soft file claimed by another package is not a conflict");
    for (const c of r.of(/^commit /)) {
      t.ok(c.prompt.includes('["src/a.js"]') && !c.prompt.includes("other.js"), `${c.label}: only the package's own path is committed`);
      t.ok(c.prompt.includes("never commit with -a"), `${c.label}: told not to take other files`);
    }
    t.ok(r.out.claimAdded === undefined, "the claim did not grow by the other package's file");

    const reported = await run({
      answers: {
        "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js", "/r/src/other.js"], unverified: [] },
        "claim more write pkg": { ok: false, conflicts: ["other: src/other.js"], others: [] },
      },
    });
    t.eq(reported.out.stoppedAt, "claim conflict", "a file the writer itself reports, which another package claims, stops the run");
    t.eq(reported.of(/^commit /).length, 0, "and nothing was committed");
    t.ok(reported.of(/^claim more/)[0].prompt.includes('hard: ["src/other.js"]'), "it was asked as a hard file");
  });

  scenario("code-package-commit-lock", "the commit step waits for index.lock a bounded number of times and never deletes it; a lock that stays held ends the run with that reason", async (t) => {
    const r = await run();
    const c = r.of(/^commit 1$/)[0].prompt;
    t.ok(c.includes("index.lock") && c.includes("wait 3 seconds") && c.includes("at most 10 times"), "the commit step retries a held lock, bounded");
    t.ok(c.includes("never delete, move or overwrite the lock file"), "and never removes it");
    t.ok(c.includes("git commit -m") && c.includes("-- <those paths>") && c.includes('["src/a.js"]'), "the commit stays limited to the package's paths");
    const held = await run({ answers: { "commit 1": { ok: false, summary: "index.lock held" } } });
    t.eq(held.out.stoppedAt, "commit (index.lock held)", "a lock held to the end stops the run with the reason");
    t.eq(held.of(/^review /).length, 0, "before review");
  });
  scenario("code-package-claim-more-needs-others", "a claim-extension answer without the others list stops the run before anything is recorded or committed", async (t) => {
    const own = { "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js", "/r/src/n.js"], unverified: [] }, "status write pkg": { ok: true, paths: ["src/a.js", "src/n.js"] } };
    const r = await run({ answers: { ...own, "claim more write pkg": { ok: true, conflicts: [] } } });
    t.eq(r.out.stoppedAt, "claim more (the answer has no others list)", "the missing list stops the run");
    t.eq(r.of(/^commit /).length, 0, "nothing was committed");
    t.ok(r.out.claimAdded === undefined, "the claim record did not grow");
    const ok = await run({ answers: { ...own, "claim more write pkg": { ok: true, conflicts: [], others: [] } } });
    t.eq(ok.out.approved, true, "an empty list is a valid answer");
  });

  scenario("code-package-review-ids-never-reused", "a new finding gets an id above every id of every round, so it never merges into a closed finding", async (t) => {
    const r = await run({
      reviews: [
        bad(imp("F1", "src/a.js", "one"), imp("F2", "src/a.js", "two")),
        bad(imp("F1", "src/a.js", "one")),
        bad(imp("F3", "src/a.js", "a different defect")),
      ],
    });
    const p3 = r.of(/^review 3$/)[0].prompt;
    t.ok(p3.includes("number it on after F2"), "round 3 is told to number above F2, the highest id of round 1");
    t.ok(p3.includes('"F2 src/a.js"'), "round 3 gets the ids used so far with their locations");
    t.eq(r.out.stoppedAt, "review went deeper", "the new defect in the same file is deeper, not a repeat");
    t.eq(r.out.boundary.map((b) => b.id), ["F3"], "it is listed for the lead");
  });

  scenario("code-package-focused-review-goes-deeper", "a focused nit-fix review that reports a new important finding, with no earlier important one open, stops as deeper", async (t) => {
    const r = await run({
      args: { closeShouldFix: true },
      reviews: [{ verdict: "approved", summary: "s", findings: ["F1 nit src/a.js: naming"] }, bad(imp("F2", "src/b.js", "regression"))],
    });
    t.eq(r.out.stoppedAt, "review went deeper", "the boundary rule applies to the focused round");
    t.eq(r.of(/^review /).length, 2, "no third review");
    t.eq(r.out.boundary.map((b) => b.id), ["F2"], "the new important finding is for the lead");
    t.eq(r.of(/^close \d+$/).length, 1, "the writer closed only the nit");
  });
}
