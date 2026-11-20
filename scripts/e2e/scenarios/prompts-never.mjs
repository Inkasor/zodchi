// The wording the models read: the gateway half of the resume rule belongs to the steps that make a gateway call (S3/S4), the wait ends by one
// exit rule in every workflow that has the block (G8), and a resumed runner that finds a submission of this run waits on it and does not submit
// under the base key (next-fixes 26).
//
// The workflows are run the way Claude Code runs them: as the body of an async function with `agent` scripted by step label.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export default function register({ scenario, ROOT }) {
  const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const GATEWAY_WORKFLOWS = [
    "core/workflows/code-package.js", "core/workflows/design-brief.js", "core/workflows/incident-triage.js", "domains/web-apps/workflows/branch-review.js",
    "domains/gamedev-unity/workflows/rubric-probe.js", "domains/gamedev-unity/workflows/asset-round.js",
  ];

  async function runCodePackage(args, answer) {
    const calls = [];
    const sandbox = {
      args, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map(async (th) => { try { const v = await th(); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } })),
      agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt, opts }); return answer(opts.label, prompt); },
    };
    const fn = vm.runInNewContext(`(async () => {\n${source("core/workflows/code-package.js").replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "code-package.js" });
    let out, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls };
  }

  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
  const printed = (facts) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, ...facts }) + "\n" });
  const FACTS = {
    workflow: { name: "code-package", build: "b", copyBuild: "b", match: true }, roles: {}, modelsErrors: [], account: null, accountError: "none", git: true, head: "abc1234", runId: "a1b2c3d4", branch: "main", dirty: [], ignoreExit: 0, ignoreLine: ".gitignore:3:.agent-tmp/\t.agent-tmp/gateway/x",
    verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "Important: x.\n",
    claims: { dir: "claims-dir/r", open: [], closed: [], kept: [], skipped: [], notes: [] },
  };
  const ARGS = {
    label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"],
    models: { writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] }, reviewer: { candidates: [{ provider: "codex", model: "gpt-x", effort: "medium" }] } },
  };
  const answers = (label) => {
    if (label === "gate pkg") return printed({ ...FACTS, account: { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null } });
    if (label === "claim pkg") return printed({ conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: "/h/.zodchi/packages/-r/pkg.json" });
    if (label === "write pkg") return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
    if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
    if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "l" }] };
    if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: ["src/a.js"] };
    if (label.startsWith("review ")) return { verdict: "approved", findings: [], gateway: "final", infra: "" };
    if (label.startsWith("await claim")) return { ok: true, summary: "awaiting" };
    if (label.startsWith("close claim")) return { ok: true, summary: "closed" };
    if (label.startsWith("claim more")) return printed({ conflicts: [], others: [], added: [] });
    throw new Error(`no scripted answer for the step "${label}"`);
  };

  scenario("prompts-never-gateway-text-only-in-gateway-steps", "the gateway half of the resume rule (zodchi wait, UNKNOWN line, key rule) is in the steps that make a gateway call and not in the steps that do not; every step keeps the shell and resume rules", async (t) => {
    const r = await runCodePackage(ARGS, answers);
    t.eq([r.error, r.out && r.out.approved], [null, true], "the run approves");
    const GATEWAY_TEXT = /zodchi wait|UNKNOWN:|turnRequestedAt|Gateway call/;
    const gateway = r.calls.filter((c) => /^review /.test(c.label));
    const plain = r.calls.filter((c) => !/^review /.test(c.label));
    t.ok(gateway.length === 1 && plain.length >= 5, "one gateway step (the review) and several steps without a gateway call");
    for (const c of gateway) {
      t.ok(GATEWAY_TEXT.test(c.prompt) && /the latest of them is the active key/.test(c.prompt), `the gateway step "${c.label}" carries the gateway call, with the wait on the latest recorded key`);
      t.ok(/exit 0 or 2/.test(c.prompt) && /still runs under its active key/.test(c.prompt), "and the one exit rule of the wait");
      t.ok(/Keys of this run all start with \S+; count only those\./.test(c.prompt) && /belong to an earlier run/.test(c.prompt), "and the key rule: keys of this run carry its prefix, others belong to an earlier run");
    }
    for (const c of plain) {
      t.ok(!GATEWAY_TEXT.test(c.prompt) && !/never submit again/.test(c.prompt), `the step "${c.label}" does not read the gateway text`);
      t.ok(/Shell rule: run every command with bash \(Git Bash on Windows\)/.test(c.prompt) && /Resume rule: this run may have been cut off/.test(c.prompt) && /last line DONE/.test(c.prompt), `and keeps the shell rule and the resume rule: "${c.label}"`);
    }
    // an attempt after an infrastructure failure: a step without a gateway call does not read the gateway text either
    const again = await runCodePackage({ ...ARGS, rerun: { "write pkg": 2 } }, answers);
    const w = again.calls.find((c) => c.label === "write pkg");
    t.ok(w && /attempt 2/.test(w.prompt) && !/zodchi wait|UNKNOWN:|gateway call/i.test(w.prompt), "a writer rerun reads that it is attempt 2 and no gateway text");
  });

  scenario("prompts-never-resumed-runner-waits-on-its-submission", "a resumed gateway step first checks the progress file for a submission of this run and waits on it; it is told to submit under the base key only when there is none (next-fixes 26)", async (t) => {
    const first = (await runCodePackage(ARGS, answers)).calls.find((c) => /^review /.test(c.label));
    const key = /Gateway call, base key (\S+)\./.exec(first.prompt)[1];
    const p = first.prompt;
    const iLook = p.indexOf("First look in the progress file for a submission of this call");
    const iWait = p.indexOf("the latest of them is the active key: wait on it as below and do not run the submit command.");
    const iNone = p.indexOf(`Only with none, submit under ${key}`);
    const iCommand = p.indexOf("The submit command (run it in the foreground from");
    t.ok(iLook >= 0 && iWait > iLook && iNone > iWait && iCommand > iNone, "attempt 1: the check of the progress file, then the wait for a recorded submission, then (only with none) the submit command");
    t.ok(p.includes(`if it records ${key}, ${key}-r2 or ${key}-r3, the latest of them is the active key`), "a recorded submission is the active key");
    t.ok(p.slice(iCommand).includes("only when the rule above calls for a submission"), "the submit command is conditional on the progress check");
    t.eq(p.split("zodchi run --role").length - 1, 1, "the submit command stands once in the prompt, with no unconditional order to run it");
    t.ok(!/Run it in the foreground from/.test(p), "no sentence that orders the command regardless of the check");
    t.ok(/Keys of this run all start with \S+-; count only those/.test(p), "the run's key prefix is named");

    const second = (await runCodePackage({ ...ARGS, rerun: { "review 1": 2 } }, answers)).calls.find((c) => /^review /.test(c.label));
    const key2 = /Gateway call, base key (\S+)\./.exec(second.prompt)[1];
    t.eq(key2, `${key}-a2`, "attempt 2 has a base key of its own");
    const look = second.prompt.indexOf(`First look in the progress file for a submission of this attempt: a key that starts with ${key2}`);
    const wait = second.prompt.indexOf("the latest of them is the active key: wait on it as below and do not run the submit command.");
    const none = second.prompt.indexOf("If there is none, take the latest key");
    const running = second.prompt.indexOf("shows the job not final yet, it is the active key: wait on it as below and do not run the submit command");
    const submit = second.prompt.indexOf(`run the submit command under ${key2}`);
    const command = second.prompt.indexOf("The submit command (run it in the foreground from");
    t.ok(look >= 0 && wait > look && none > wait && running > none && submit > running && command > submit, "attempt 2 checks its own keys first and waits on an earlier job if it is still running");
    t.ok(second.prompt.includes(`(${key2}, ${key2}-r2, ${key2}-r3)`), "the keys named are the base key and its retries");
    t.eq(second.prompt.split("zodchi run --role").length - 1, 1, "the submit command stands once in the prompt of attempt 2 as well");
  });

  scenario("prompts-never-rerun-after-a-final-review", "an explicit rerun authorizes attempt 2 after an unknown review or a successful job with no verdict, while a plain resume keeps the unknown key", async (t) => {
    for (const status of ["unknown", "succeeded"]) {
      const priorReview = (label, prompt) => {
        if (label !== "review 1") return answers(label);
        if (status === "unknown") {
          const key = /Gateway call, base key (\S+)\./.exec(prompt)[1];
          return { gateway: "unknown", unknownKey: key, infra: "outcome unknown", verdict: "missing", findings: [] };
        }
        return { gateway: "final", infra: "", verdict: "missing", summary: "job succeeded without a verdict", findings: [] };
      };
      const first = await runCodePackage(ARGS, priorReview);
      let stop;
      if (status === "unknown") {
        stop = first.out;
        t.eq(stop.stoppedAt, "unknown outcome at review 1", "the unknown review stops at the owner's decision");
        const resume = await runCodePackage(ARGS, priorReview);
        t.eq(resume.out.unknown, stop.unknown, "a plain resume stops again at the same unknown job");
        const prompt = resume.calls.find((c) => c.label === "review 1").prompt;
        t.ok(prompt.includes(`if it records ${stop.unknown.key}, ${stop.unknown.key}-r2 or ${stop.unknown.key}-r3, the latest of them is the active key: wait on it as below and do not run the submit command.`), "a plain resume reuses the recorded key");
        t.ok(prompt.includes('A job that is final with status "unknown" never gets a new key and is never waited on again') && prompt.includes('return gateway "unknown" with unknownKey set to the active key'), "it reports unknown without another submission");
      } else {
        t.ok(first.error && first.error.message.includes("the review has no verdict"), "the job succeeded but the missing verdict stops the step");
        stop = JSON.parse(first.error.message.split("Run result so far: ")[1]);
      }
      const rerun = JSON.parse(/args\.rerun (\{[^}]+\})/.exec(stop.next)[1]);
      t.eq(rerun, { "review 1": 2 }, `the ${status} stop offers attempt 2`);
      const second = await runCodePackage({ ...ARGS, rerun }, answers);
      const prompt = second.calls.find((c) => c.label === "review 1").prompt;
      const firstPrompt = first.calls.find((c) => c.label === "review 1").prompt;
      const key = /Gateway call, base key (\S+)\./.exec(firstPrompt)[1];
      t.ok(prompt.includes(`If the earlier job is already final (any status, including failed, succeeded, timeout or unknown), or there is no earlier job, run the submit command under ${key}-a2.`), `the authorized rerun submits after the final ${status} job`);
      t.ok(prompt.includes(`zodchi run --role code-review --key ${key}-a2 `), `the ${status} rerun's submit command uses its own key`);
    }
  });

  // The shared sentences of the block are one text in all six workflows, compared whole. Result fields of one workflow follow in a sentence of their own.
  scenario("prompts-never-one-exit-rule-for-a-gateway-wait", "every workflow that waits on a gateway job words the shared rules the same way, byte for byte: the wait, the timeout, the background rule, the new-key and the unknown rules; the result fields of a workflow are a separate sentence", async (t) => {
    const lines = (rel, re) => source(rel).split("\n").filter((l) => re.test(l)).map((l) => l.trim().replace(/\$\{q\(\w+\)\}/, "${q()}"));
    const SHARED = [
      ["the conditional submit command", /The submit command \(run it in the foreground from/],
      ["the wait", /Wait in the foreground with/], ["the timeout", /If the time runs out, report failure/], ["the background rule", /Never start it in the background/],
      ["the active key", /The active key is the key of the latest submission/], ["the new-key rule", /A job gets a new key only with evidence/], ["the new-key command", /Then run the same full command again with --key set to the next key/],
      ["the unknown rule", /A job that is final with status "unknown" never gets a new key/], ["the UNKNOWN line", /write the line "UNKNOWN: key <active key>/], ["the other statuses", /Any other final status, a "failed" job/],
    ];
    for (const [what, re] of SHARED) {
      const seen = new Set();
      for (const rel of GATEWAY_WORKFLOWS) {
        const found = lines(rel, re);
        t.ok(found.length === 1, `${rel}: ${what} is one line`);
        seen.add(found[0]);
      }
      t.eq(seen.size, 1, `${what} reads the same in all six workflows`);
    }
    const attemptRule = /If the earlier job is already final/;
    const codePackageRule = lines("core/workflows/code-package.js", attemptRule);
    t.eq(codePackageRule.length, 1, "code-package has one rule for a final job from an earlier attempt");
    t.eq(lines("core/workflows/design-brief.js", attemptRule), codePackageRule, "design-brief gives the same instruction after a final earlier job");
    const timeout = lines(GATEWAY_WORKFLOWS[0], /If the time runs out, report failure/)[0];
    t.ok(timeout.startsWith("`If the time runs out, report failure and say the job still runs under its active key. Do not return earlier: nobody else waits on the job. `") && !/ok false|verdict|gateway/.test(timeout), "the shared timeout text is the sentence itself, with no result field of one workflow in it");
    for (const rel of GATEWAY_WORKFLOWS) {
      const src = source(rel);
      t.ok(/until the job is final \(exit 0 or 2\) or \$\{totalMin\} minutes have passed/.test(lines(rel, /Wait in the foreground with/)[0]), `${rel}: the exit rule`);
      t.ok(/In this workflow's result that failure is /.test(src), `${rel}: its own result fields follow in a sentence of their own`);
      t.ok(!/never return before|Never in the background|never through Monitor/.test(src), `${rel}: the old negative wordings are gone`);
      t.ok(!/Run it in the foreground from/.test(src) && !/instead of submitting again/.test(src), `${rel}: no unconditional order to run the submit command`);
    }
    t.ok(/a dead worker can leave a paid job with an unknown outcome/.test(lines(GATEWAY_WORKFLOWS[0], /Never start it in the background/)[0]), "the background rule gives its reason");
  });
}
