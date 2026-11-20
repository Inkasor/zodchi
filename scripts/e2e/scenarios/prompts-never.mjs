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
      agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt, opts }); return answer(opts.label); },
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
    const iLook = first.prompt.indexOf("First look in the progress file for a submission of this call");
    const iSubmit = first.prompt.indexOf(`With none, submit under ${key}`);
    t.ok(iLook >= 0 && iSubmit > iLook, "attempt 1: the check of the progress file comes before the order to submit");
    t.ok(first.prompt.includes(`if it records ${key}, ${key}-r2 or ${key}-r3, the latest of them is the active key, and a resumed run waits on it as below instead of submitting again`), "and a recorded submission is waited on, not submitted again");
    t.ok(/Keys of this run all start with \S+-; count only those/.test(first.prompt), "the run's key prefix is named");

    const second = (await runCodePackage({ ...ARGS, rerun: { "review 1": 2 } }, answers)).calls.find((c) => /^review /.test(c.label));
    const key2 = /Gateway call, base key (\S+)\./.exec(second.prompt)[1];
    t.eq(key2, `${key}-a2`, "attempt 2 has a base key of its own");
    const look = second.prompt.indexOf(`First look in the progress file for a submission of this attempt: a key that starts with ${key2}`);
    const wait = second.prompt.indexOf("the latest of them is the active key: wait on it as below instead of submitting");
    const none = second.prompt.indexOf("If there is none, take the latest key");
    const submit = second.prompt.indexOf(`submit under ${key2}`);
    t.ok(look >= 0 && wait > look && none > wait && submit > none, "attempt 2: look for a submission of this attempt first, wait on the latest one, only then (with none) fall back to the older keys and the base key");
    t.ok(second.prompt.includes(`(${key2}, ${key2}-r2, ${key2}-r3)`), "the keys named are the base key and its retries");
  });

  scenario("prompts-never-one-exit-rule-for-a-gateway-wait", "every workflow that waits on a gateway job words the exit rule the same way: wait until the job is final (exit 0 or 2) or the time is up; on timeout report failure and say the job still runs", async (t) => {
    const lines = (rel, re) => source(rel).split("\n").filter((l) => re.test(l)).map((l) => l.trim().replace(/\$\{q\(\w+\)\}/, "${q()}"));
    const wait = new Set(), background = new Set();
    for (const rel of GATEWAY_WORKFLOWS) {
      const w = lines(rel, /Wait in the foreground with/), o = lines(rel, /If the time runs out, report failure/), b = lines(rel, /Never start it in the background/);
      t.ok(w.length === 1 && o.length === 1 && b.length === 1, `${rel}: one wait rule, one timeout rule, one background rule`);
      wait.add(w[0]);
      background.add(b[0]);
      t.ok(/until the job is final \(exit 0 or 2\) or \$\{totalMin\} minutes have passed/.test(w[0]) && /still runs under its active key/.test(o[0]) && /Do not return earlier/.test(o[0]), `${rel}: the exit rule`);
      t.ok(!/never return before|Never in the background|never through Monitor/.test(source(rel)), `${rel}: the old negative wordings are gone`);
    }
    t.eq([wait.size, background.size], [1, 1], "the wait rule and the background rule read the same in all six workflows");
    t.ok(/a dead worker can leave a paid job with an unknown outcome/.test([...background][0]), "the background rule gives its reason");
  });
}
