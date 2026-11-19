// design-brief: from a goal to a brief that code-package can run.
//
// The workflow (core/workflows/design-brief.js) is run here the way Claude Code runs it: as the body of an async function with
// `args`, `agent`, `parallel`, `phase` and `log` in scope. `agent` is a script of answers keyed by the step's label, so every
// decision the workflow itself makes (which facts reach the writer and the review, which candidate reviews, what is reported as
// fixed, what is left, what is never answered) is tested on those answers. What a prompt asks of a runner (the gateway call, the
// files) is checked as text of the prompt; it is carried out by the runner agent.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MARK = "<!-- design-brief: db -->";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
const CONNECTED = { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null };
const ROLES = {
  writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] },
  architect: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }, { provider: "claude", model: "fable", effort: "high" }] },
};
const HEADINGS = ["# Title", "## Goal", "## What to build", "## Owner decisions", "## Review boundary", "## Checks"];

export default function register({ scenario, ROOT }) {
  const source = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const SRC = source("core/workflows/design-brief.js");

  const printed = (facts) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, ...facts }) + "\n" });
  const gateFacts = (over = {}) => ({ roles: ROLES, modelsErrors: [], account: CONNECTED, accountError: "", ignoreExit: 0, ...over });
  /** What a runner answers to a "write these files" prompt: each file with the hash the prompt states. */
  const wrote = (prompt) => ({ ok: true, summary: "written", wrote: [...prompt.matchAll(/<<<FILE path=("(?:[^"\\]|\\.)*") sha256=([0-9a-f]{64})>>>/g)].map((m) => ({ path: JSON.parse(m[1]), sha256: m[2] })) });
  const review = (doc, over = {}) => { const answer = JSON.stringify({ notVerified: [], summary: "s", ...doc }); return { ok: true, answer, answerSha256: sha(answer), gateway: "final", infra: "", ...over }; };
  const finding = (id, severity, problem = "p") => ({ id, severity, location: "section Goal", problem, fix: "change it" });

  const ARGS = { label: "db", goal: "Make the export resumable, because a cut run loses an hour.", repos: ["/r"], out: "/r/.agent-tmp/db/brief.md", tmp: "/r/.agent-tmp/db" };

  /** Runs the workflow once. `o.answers[label]` (a value or a function of the prompt and the calls) replaces a default answer. */
  async function run(o = {}) {
    const calls = [];
    const args = { ...ARGS, ...(o.args || {}) };
    const answer = (label, prompt, opts) => {
      const given = o.answers && o.answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt, calls, opts) : given;
      if (label === "gate db") return printed(gateFacts(o.gate));
      if (label === "plan db") return { questions: [{ question: "How is the export written today?", repo: "/r", files: ["/r/src/export.js"] }, { question: "Where is the state kept?", repo: "/r", files: ["/r/src/state.js"] }] };
      if (label.startsWith("facts ")) return { facts: [{ claim: `The export writes rows one by one (${label})`, source: `/r/src/export.js:${12 + Number(label.slice(6))}` }], unknowns: [] };
      if (label === "draft db") return { done: true, summary: "wrote", ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }], leftForLater: ["the UI"], wrongFacts: [], unverified: [] };
      if (label === "inspect draft db") return { ok: true, exists: true, sha256: HEX_A, bytes: 100, firstLine: MARK, headings: HEADINGS };
      if (label === "review files db") return wrote(prompt);
      if (label === "review") return review({ verdict: "approved", findings: [] });
      if (label === "fix db") return { done: true, summary: "fixed", fixed: [], left: [], ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }] };
      if (label === "inspect fix db") return { ok: true, exists: true, sha256: HEX_B, bytes: 120, firstLine: MARK, headings: HEADINGS };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    const sandbox = {
      args, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt, opts }); return answer(opts.label, prompt, opts); },
    };
    const fn = vm.runInNewContext(`(async () => {\n${SRC.replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "design-brief.js" });
    let out, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }

  scenario("design-brief-happy-path", "facts, a draft, a review through the gateway and one fix: the result says what was found, fixed and left, and lists the owner decisions with their default", async (t) => {
    const r = await run({
      answers: {
        review: review({ verdict: "changes_requested", findings: [finding("F1", "blocker", "A fact is wrong"), finding("F2", "important", "The writer would guess a name"), finding("F3", "minor", "Order of sections")] }),
        "fix db": { done: true, summary: "fixed", fixed: [{ id: "F1", what: "corrected the fact" }], left: [{ id: "F2", reason: "the name is in the file the brief points to" }], ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }, { question: "Name of the new flag?", default: "--resume" }] },
      },
    });
    t.eq(r.error, null, "the run does not throw");
    const o = r.out;
    t.eq(o.path, ARGS.out, "the result names the brief");
    t.eq(o.facts, 2, "two facts passed the checks (one per researcher)");
    t.eq(o.reviewFindings.length, 3, "every finding of the review is in the result");
    t.ok(o.reviewFindings[0].startsWith("F1 blocker section Goal: A fact is wrong"), "each as '<id> <severity> <location>: <problem>'");
    t.eq(o.fixed, ["F1 blocker: corrected the fact"], "what the writer fixed, with what it did");
    t.eq(o.left.length, 2, "the finding the writer left and the minor one are left");
    t.ok(o.left.some((x) => x.startsWith("F2 important") && x.includes("the name is in the file")), "a finding the writer left carries its reason");
    t.ok(o.left.some((x) => x.startsWith("F3 minor") && x.includes("minor: not fixed")), "a minor finding is left, and says so");
    t.eq(o.ownerDecisions, ["Keep a copy of the old export? (default: No)", "Name of the new flag? (default: --resume)"], "owner decisions are listed with the default, not answered");
    t.eq([o.writtenBy, o.reviewedBy], ["claude/sonnet (effort high)", "codex/gpt-x (effort high)"], "the writer is a Claude agent, the reviewer a Codex candidate");
    t.eq(o.pluginCopy.path, "/plugin/core", "the result names the plugin copy");
    t.ok(o.stoppedAt === undefined && /code-package on it yourself/.test(o.next), "the lead is told to read the brief and start code-package itself");
    t.eq(r.of(/^review$/).length, 1, "one review");
    t.eq(r.of(/^fix /).length, 1, "one fix");
    t.ok(r.calls.every((c) => !/code-package/.test(c.label)), "no package was started");
    t.ok(!r.calls.some((c) => /^review \d|^review 2|^review again/.test(c.label)), "there is no second review round");
  });

  scenario("design-brief-researchers-read-only", "researchers run on the cheap model, are told to change nothing, call no API and print no secret, and get no agent type", async (t) => {
    const r = await run({ args: { questions: ["How is the export written?", { question: "Where is the state?", repo: "/r", files: ["/r/src/state.js"] }] } });
    const facts = r.of(/^facts /);
    t.eq(facts.length, 2, "one researcher per question");
    t.ok(r.of(/^plan /).length === 0, "given questions, no planner runs");
    for (const c of facts) {
      t.eq(c.opts.model, "haiku", "a researcher runs on the cheap model");
      t.ok(c.opts.agentType === undefined, "a general agent, not the gateway researcher");
      t.ok(/You change no file/.test(c.prompt) && /call no product API/.test(c.prompt) && /contact no server/.test(c.prompt), "it is told to change nothing, call no API and contact no server");
      t.ok(/never print a secret value/.test(c.prompt) && /name the variable or the file/.test(c.prompt), "it names a variable or a file, never the value");
      t.ok(!/progress/.test(c.prompt), "it keeps no progress file: it writes nothing");
    }
    t.ok(facts[1].prompt.includes('"/r/src/state.js"'), "the files a question names are in its prompt");
    const planned = await run();
    t.eq(planned.of(/^plan /).length, 1, "without questions a planner proposes them");
    t.eq(planned.of(/^facts /).length, 2, "and one researcher runs for each");
    t.ok(/3 to 5 research questions/.test(planned.of(/^plan /)[0].prompt) && /read-only|Read only/i.test(planned.of(/^plan /)[0].prompt), "the planner asks for 3-5 questions and only reads");
  });

  scenario("design-brief-facts-are-checked", "a fact whose source is outside the repositories, not a path:line, or a secret file never reaches the writer or the review; a secret in a claim is redacted", async (t) => {
    const key = ["sk", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
    const r = await run({
      args: { questions: ["q1"] },
      answers: {
        "facts 1": {
          facts: [
            { claim: `The client uses the key ${key} here`, source: "/r/src/client.js:7" },
            { claim: "outside", source: "/other/x.js:1" },
            { claim: "no line", source: "/r/src/y.js" },
            { claim: "relative", source: "src/y.js:3" },
            { claim: "dotdot", source: "/r/../etc/x:3" },
            { claim: "a secret file", source: "/r/.env:1" },
            { claim: "a key file", source: "/r/deploy/server.pem:1" },
            { claim: "same twice", source: "/r/src/z.js:2-4" },
            { claim: "same twice", source: "/r/src/z.js:2-4" },
          ],
          unknowns: ["Which queue is used?"],
        },
      },
    });
    t.eq(r.out.facts, 2, "only the two good facts count (the repeated one once)");
    const draft = r.of(/^draft /)[0].prompt;
    t.ok(!draft.includes(key) && draft.includes("[REDACTED key]"), "the secret in a claim is redacted before it reaches the writer");
    t.ok(!/\/other\/x\.js|\.env|server\.pem|src\/y\.js/.test(draft), "no dropped fact is in the draft prompt");
    t.ok(draft.includes("Which queue is used?"), "what the researchers could not settle is handed to the writer");
    t.ok(r.out.notes.some((n) => n.includes("6 fact(s) were dropped")), "the drop is said in the notes");
    const files = r.of(/^review files /)[0].prompt;
    t.ok(!files.includes(key) && !/\.env|server\.pem/.test(files), "nor does it reach the facts file of the review");
    const gw = r.of(/^review$/)[0].prompt;
    t.ok(gw.includes("--attach '/r/src/client.js'") && gw.includes("--attach '/r/src/z.js'"), "the cited files are attached to the review");
    t.ok(!/--attach '\/r\/\.env'|server\.pem/.test(gw), "a secret file is never attached");
    const none = await run({ args: { questions: ["q1"] }, answers: { "facts 1": { facts: [{ claim: "x", source: "/other/x.js:1" }], unknowns: [] } } });
    t.ok(/^facts /.test(none.out.stoppedAt) && none.of(/^draft /).length === 0, "no usable fact stops the run before the draft");
  });

  scenario("design-brief-draft-prompt", "the writer is told to verify each fact, cut to one package, list owner decisions with a default, never overwrite a foreign file, and to read and write only the brief", async (t) => {
    const r = await run({ args: { context: ["/r/docs/plan.md"], template: "/r/docs/old-brief.md" } });
    const p = r.of(/^draft /)[0].prompt;
    t.ok(p.includes("/r/.agent-tmp/db/brief.md"), "it writes to args.out");
    t.ok(/Verify each fact you rely on by reading the cited file/.test(p), "it verifies each fact");
    t.ok(/Cut the scope to ONE package/.test(p) && /Left for later/.test(p), "one package, with the rest said as left for later");
    t.ok(/Never answer it yourself/.test(p) && /marked default/.test(p), "owner decisions are listed with a marked default, never answered");
    t.ok(p.includes(MARK) && /do not overwrite it/.test(p), "a file that is not this workflow's is never overwritten");
    t.ok(/call no product API, contact no server, and never print a secret value/.test(p), "no API, no server, no secret");
    t.ok(p.includes('"/r/docs/plan.md"') && p.includes("/r/docs/old-brief.md"), "the context and the template are named");
    const plain = (await run()).of(/^draft /)[0].prompt;
    for (const s of ["## Review boundary", "## Checks", "## What to build", "## Owner decisions", "## Left for later"]) t.ok(plain.includes(s), `the default template names ${s}`);
    const pub = (await run({ args: { publicRepo: true } })).of(/^draft /)[0].prompt;
    t.ok(/no company, product or person name/.test(pub), "for a public repository the writer is told to name no company, product or person");
    t.eq(r.of(/^draft /)[0].opts.model, "sonnet", "the writer is the model of the role writer");
  });

  scenario("design-brief-review-gateway", "the review goes through the gateway to a Codex candidate of the role architect, with the brief, the facts and the cited files attached; the run never falls back to a Claude reviewer", async (t) => {
    const r = await run();
    const files = r.of(/^review files /)[0];
    t.ok(files.opts.agentType === "zodchi-core:runner", "the files of the request are written by a runner");
    for (const f of ["facts.json", "prompt.md", "design-review.md", "design-review.schema.json", "design-review.json"]) t.ok(files.prompt.includes(`/r/.agent-tmp/db/review/${f}`), `the request has ${f}`);
    const rv = r.of(/^review$/)[0];
    t.ok(rv.opts.agentType === "zodchi-core:runner" && rv.opts.model === undefined, "the review is a runner step that calls the gateway");
    t.ok(/zodchi run --role '\/r\/\.agent-tmp\/db\/review\/design-review\.json' --key db-design-review --model gpt-x --effort high --prompt '\/r\/\.agent-tmp\/db\/review\/prompt\.md' --attach '\/r\/\.agent-tmp\/db\/brief\.md' --attach '\/r\/\.agent-tmp\/db\/review\/facts\.json' --attach '\/r\/src\/export\.js'/.test(rv.prompt), "the command names the role, the key, the model, the prompt and the attachments");
    t.ok(/foreground/.test(rv.prompt) && /Never in the background/.test(rv.prompt), "it waits in the foreground");
    t.ok(/is final with status "unknown" never gets a new key/.test(rv.prompt), "a job that ended unknown is never submitted again");
    const body = JSON.parse(files.prompt.match(/design-review\.json" sha256=[0-9a-f]{64}>>>\n([\s\S]*?)<<<END FILE>>>/)[1]);
    t.eq([body.mode, body.model, body.effort], ["expert", "gpt-x", "high"], "the role file carries the chosen candidate");
    const reviewPrompt = files.prompt.match(/prompt\.md" sha256=[0-9a-f]{64}>>>\n([\s\S]*?)<<<END FILE>>>/)[1];
    for (const s of ["Facts.", "Guessing.", "Scope.", "Review boundary.", "Checks.", "Secrets and names.", "Owner decisions."]) t.ok(reviewPrompt.includes(s), `the review asks about: ${s}`);
    t.ok(!/no company, product or person name/.test(reviewPrompt), "a repository not marked public is not asked about private names");
    const pub = await run({ args: { publicRepo: true } });
    t.ok(/no company, product or person name and no machine path/.test(pub.of(/^review files /)[0].prompt), "a public repository is also checked for names and machine paths");

    // the role table leaves no Codex reviewer: the run is refused before any agent but the gate was spent
    for (const [name, over] of [
      ["no limit left", { account: { ...CONNECTED, primary: { usedPercent: 100 } } }],
      ["not connected", { account: { connected: false } }],
      ["no account answer", { account: null, accountError: "zodchi was not found" }],
      ["only a Claude reviewer", { roles: { ...ROLES, architect: { candidates: [{ provider: "claude", model: "fable", effort: "high" }] } } }],
    ]) {
      const x = await run({ gate: over });
      t.ok(/^gate \(no gateway reviewer\)/.test(x.out.stoppedAt) && /not independent/.test(x.out.next) && x.out.refused, `${name}: refused`);
      t.eq(x.calls.map((c) => c.label), ["gate db"], `${name}: nothing but the gate ran`);
    }
    const noIgnore = await run({ gate: { ignoreExit: 1 } });
    t.ok(/does not ignore \.agent-tmp/.test(noIgnore.out.stoppedAt) && noIgnore.calls.length === 1, "a gateway repository that does not ignore .agent-tmp/ is refused at the gate");
    const writerless = await run({ gate: { roles: { ...ROLES, writer: { candidates: [{ provider: "codex", model: "gpt-y", effort: "high" }] } } } });
    t.ok(/^gate \(no writer\)/.test(writerless.out.stoppedAt) && writerless.calls.length === 1, "a writer role without a Claude candidate is refused");
    const other = await run({ args: { gatewayRepo: "/g" } });
    t.ok(other.of(/^gate /)[0].prompt.includes('"repo":"/g"') && other.of(/^review$/)[0].prompt.includes(["Run it in the foreground from /g", ":"].join("")), "args.gatewayRepo moves the gateway to another repository");
    const dflt = r.of(/^gate /)[0].prompt;
    t.ok(/ roles '\{"api":1,"want":\["writer","architect"\],"repo":"\/r"\}'/.test(dflt), "by default the gateway runs from the first repository");
  });

  scenario("design-brief-no-review-no-claim", "a review that did not answer, answered unreadably or ended unknown is never reported as a review and is never asked again by itself", async (t) => {
    const unknown = await run({ answers: { review: { ok: false, answer: "", answerSha256: "", gateway: "unknown", unknownKey: "db-design-review", infra: "ended unknown" } } });
    t.eq(unknown.out.stoppedAt, "unknown outcome at review", "an unknown job stops the run");
    t.eq(unknown.out.unknown, { step: "review", key: "db-design-review", reason: "ended unknown" }, "with its key and reason");
    t.ok(/was not asked again/.test(unknown.out.next) && /args\.rerun/.test(unknown.out.next), "and the person decides whether to pay once more");
    t.eq([unknown.out.reviewFindings, unknown.out.review], [null, undefined], "no review is reported");
    t.eq(unknown.of(/^review$/).length, 1, "no second submission");
    t.eq(unknown.of(/^fix /).length, 0, "and no fix");
    t.ok(unknown.out.path === ARGS.out, "the brief that was written is still named");

    const failed = await run({ answers: { review: { ok: false, answer: "", answerSha256: "", gateway: "failed", infra: "the gateway created no job" } } });
    t.ok(/^infrastructure at review \(the gateway created no job\)/.test(failed.out.stoppedAt) && /"review":2/.test(failed.out.next), "a failed gateway is an infrastructure stop that names the rerun");
    t.eq(failed.out.reviewFindings, null, "no review is reported");
    const none = await run({ answers: { review: null } });
    t.ok(/^infrastructure at review/.test(none.out.stoppedAt), "no result from the review step is an infrastructure stop");

    const wrongHash = await run({ answers: { review: { ...review({ verdict: "approved", findings: [] }), answerSha256: HEX_A } } });
    t.ok(/does not match the sha256/.test(wrongHash.out.stoppedAt), "an answer that does not match its file hash is refused");
    const notReview = await run({ answers: { review: review({ verdict: "fine", findings: [] }) } });
    t.ok(/not a review/.test(notReview.out.stoppedAt) && notReview.out.reviewFindings === null, "an answer without a valid verdict is not a review");
    const notJson = await run({ answers: { review: { ok: true, answer: "no json", answerSha256: sha("no json"), gateway: "final", infra: "" } } });
    t.ok(/not a review/.test(notJson.out.stoppedAt), "an answer that is not JSON is not a review");
    const noFinding = await run({ answers: { review: review({ verdict: "changes_requested", findings: [] }) } });
    t.ok(/without a finding/.test(noFinding.out.stoppedAt) && noFinding.of(/^fix /).length === 0, "changes requested without a finding stops and fixes nothing");

    const rerun = await run({ args: { rerun: { review: 2 } } });
    const rv = rerun.of(/^review$/)[0].prompt;
    t.ok(/base key db-design-review-a2/.test(rv) && /attempt 2/.test(rv), "an attempt after an infrastructure failure submits under a key of its own");
    t.eq(rerun.out.review.key, "db-design-review-a2", "and the result names that key");
  });

  scenario("design-brief-blocked-and-approved", "a blocked review fixes nothing; an approved one needs no fix; a minor finding alone is left, not fixed", async (t) => {
    const blocked = await run({ answers: { review: review({ verdict: "blocked", findings: [finding("F1", "important")], notVerified: ["the schema of the table"] }) } });
    t.eq(blocked.out.stoppedAt, "review verdict blocked", "a blocked review stops the run");
    t.eq(blocked.of(/^fix /).length, 0, "no fix");
    t.eq(blocked.out.left.length, 1, "its findings are left");
    t.ok(blocked.out.notes.some((n) => n.includes("the schema of the table")), "what the reviewer could not judge is in the notes");

    const approved = await run();
    t.eq([approved.out.reviewFindings, approved.out.fixed, approved.out.left, approved.out.stoppedAt], [[], [], [], undefined], "an approved review with nothing found: nothing to fix");
    t.eq(approved.of(/^fix /).length, 0, "no fix step");

    const minor = await run({ answers: { review: review({ verdict: "approved", findings: [finding("F1", "minor", "wording")] }) } });
    t.eq(minor.of(/^fix /).length, 0, "a minor finding does not start a fix");
    t.ok(minor.out.left.length === 1 && minor.out.left[0].includes("minor: not fixed"), "it is left, and says so");

    const odd = await run({ answers: { review: review({ verdict: "approved", findings: [{ ...finding("F1", "critical") }] }) } });
    t.eq(odd.of(/^fix /).length, 1, "an approved verdict with a finding of an unknown severity still goes to the fix: the workflow, not the reviewer's word, decides");
    t.ok(odd.out.reviewFindings[0].startsWith("F1 important"), "an unknown severity word is read as important");
  });

  scenario("design-brief-fix-is-real", "a fix is reported only when the file changed; a finding the writer did not answer is left; a fix that loses a required section is not reported", async (t) => {
    const two = { verdict: "changes_requested", findings: [finding("F1", "blocker"), finding("F2", "important")] };
    const same = await run({ answers: { review: review(two), "fix db": { done: true, summary: "x", fixed: [{ id: "F1", what: "did it" }], left: [{ id: "F2", reason: "wrong finding" }], ownerDecisions: [] }, "inspect fix db": { ok: true, exists: true, sha256: HEX_A, firstLine: MARK, headings: HEADINGS } } });
    t.eq(same.out.fixed, [], "the writer says fixed but the file is the reviewed one: nothing is reported as fixed");
    t.ok(same.out.left.some((x) => x.startsWith("F1") && x.includes("the file did not change")), "the claim is in left with that reason");
    const silent = await run({ answers: { review: review(two), "fix db": { done: true, summary: "x", fixed: [{ id: "F1", what: "did it" }], left: [], ownerDecisions: [] } } });
    t.eq(silent.out.fixed, ["F1 blocker: did it"], "a changed file makes the fix real");
    t.ok(silent.out.left.some((x) => x.startsWith("F2") && x.includes("the writer did not answer this finding")), "a finding the writer did not answer is left");
    const unknownId = await run({ answers: { review: review(two), "fix db": { done: true, summary: "x", fixed: [{ id: "F9", what: "invented" }], left: [], ownerDecisions: [] } } });
    t.eq(unknownId.out.fixed, [], "a fix of a finding that does not exist is not reported");
    const lost = await run({ answers: { review: review(two), "inspect fix db": { ok: true, exists: true, sha256: HEX_B, firstLine: MARK, headings: ["# T", "## Goal"] } } });
    t.ok(/^fix \(the brief lost its first line or a required section\)/.test(lost.out.stoppedAt) && lost.out.fixed.length === 0 && lost.out.left.length === 2, "a fix that loses a required section is not reported; the brief is to be read first");
    const none = await run({ answers: { review: review(two), "fix db": null } });
    t.ok(/^fix \(the writer returned no result\)/.test(none.out.stoppedAt) && none.out.fixed.length === 0, "no result from the writer: nothing is reported as fixed");
    const p = same.of(/^fix /)[0].prompt;
    t.ok(/Fix the brief ONCE: there is no second review/.test(p) && /first verify it/.test(p) && /say why/.test(p), "the fix prompt: once, verify each finding first, a wrong one is left with the reason");
    t.ok(!p.includes("F3") && p.includes("F1") && p.includes("F2"), "only the blocker and important findings go to the writer");
  });

  scenario("design-brief-owner-decisions", "owner decisions are listed from the draft and the fix, never answered by the workflow; a decision dropped by the fix stays in the list with a note", async (t) => {
    const draftOnly = await run({ answers: { "draft db": { done: true, summary: "w", ownerDecisions: [{ question: "Which limit?", default: "100" }, { question: "Name?", default: "" }] } } });
    t.eq(draftOnly.out.ownerDecisions, ["Which limit? (default: 100)", "Name? (default: none given)"], "each decision with its default; a missing default is said");
    t.ok(draftOnly.out.notes.some((n) => n.includes("no marked default")), "a decision without a default is noted");
    const dropped = await run({
      answers: {
        review: review({ verdict: "changes_requested", findings: [finding("F1", "important")] }),
        "draft db": { done: true, summary: "w", ownerDecisions: [{ question: "Which limit?", default: "100" }, { question: "Name?", default: "x" }] },
        "fix db": { done: true, summary: "f", fixed: [{ id: "F1", what: "ok" }], left: [], ownerDecisions: [{ question: "Which limit?", default: "50" }] },
      },
    });
    t.ok(dropped.out.ownerDecisions.includes("Which limit? (default: 50)") && !dropped.out.ownerDecisions.includes("Which limit? (default: 100)"), "a reworded decision takes its new default");
    t.ok(dropped.out.ownerDecisions.some((d) => d.startsWith("Name?")), "a decision the fix dropped stays in the list");
    t.ok(dropped.out.notes.some((n) => n.includes("removed or reworded")), "and the removal is noted");
    const p = (await run()).of(/^draft /)[0].prompt;
    t.ok(!/decide it yourself|settle it yourself/.test(p), "no prompt asks the writer or a researcher to decide for the owner");
  });

  scenario("design-brief-brief-checks", "the brief must exist, start with the workflow's line and carry a title, a Review boundary and Checks before it is reviewed; an existing foreign file is not overwritten", async (t) => {
    const notDone = await run({ answers: { "draft db": { done: false, summary: "out already exists and is not mine", ownerDecisions: [] } } });
    t.ok(/^draft \(out already exists/.test(notDone.out.stoppedAt) && notDone.of(/^review/).length === 0, "a writer that refuses stops the run before the review");
    const foreign = await run({ answers: { "inspect draft db": { ok: true, exists: true, sha256: HEX_A, firstLine: "# Somebody's brief", headings: HEADINGS } } });
    t.ok(/does not start with/.test(foreign.out.stoppedAt) && foreign.out.path === "" && foreign.of(/^review/).length === 0, "a file without the workflow's first line is not reviewed and not reported as the result");
    const missing = await run({ answers: { "inspect draft db": { ok: true, exists: false, sha256: "", firstLine: "", headings: [] } } });
    t.ok(/was not found after the writer finished/.test(missing.out.stoppedAt) && missing.out.path === "", "a brief that is not there is no result");
    const noBoundary = await run({ answers: { "inspect draft db": { ok: true, exists: true, sha256: HEX_A, firstLine: MARK, headings: ["# T", "## Goal", "## Checks"] } } });
    t.ok(/lacks a "## Review boundary" section/.test(noBoundary.out.stoppedAt) && noBoundary.out.path === ARGS.out && noBoundary.of(/^review/).length === 0, "a brief without a Review boundary is not sent to a review");
    const noChecks = await run({ answers: { "inspect draft db": { ok: true, exists: true, sha256: HEX_A, firstLine: MARK, headings: ["# T", "## Review boundary"] } } });
    t.ok(/lacks a "## Checks" section/.test(noChecks.out.stoppedAt), "nor one without Checks");
    const p = (await run()).of(/^inspect draft /)[0];
    t.ok(p.opts.agentType === "zodchi-core:runner" && /change nothing/.test(p.prompt), "the file is looked at by a runner that changes nothing");
  });

  scenario("design-brief-args-and-gate", "bad args throw before any agent runs; a missing or stale helper stops at the gate; the bootstrap is the same text as in code-package", async (t) => {
    for (const [name, args] of [["goal", { goal: "" }], ["repos", { repos: undefined }], ["out", { out: undefined }], ["label", { label: "bad label" }], ["a relative repo", { repos: ["src"] }], ["a dotdot path", { out: "/r/../x/brief.md" }], ["a relative tmp", { tmp: "tmp" }]]) {
      const x = await run({ args });
      t.ok(x.error && x.calls.length === 0, `${name}: throws before any agent runs (${x.error && x.error.message})`);
    }
    const q = await run({ args: { questions: [{ question: "q", repo: "/elsewhere" }] } });
    t.ok(q.error && /not inside args\.repos/.test(q.error.message), "a question about a repository outside args.repos throws");
    const drive = ["C", ":"].join(""), back = (p) => drive + p.split("/").join("\\");
    const win = await run({ args: { repos: [back("/work/r")], out: back("/work/r/b.md"), tmp: back("/work/r/t") } });
    t.ok(win.error === null && win.of(/^gate /)[0].prompt.includes(`"repo":"${drive}/work/r"`), "backslash paths are taken as slash paths");

    const stale = await run({ answers: { "gate db": { exitCode: 4, stdout: JSON.stringify({ ok: false, api: 0, error: "no helper", tried: ["/cache"] }) + "\n" } } });
    t.ok(/^gate \(.*no helper.*looked in \["\/cache"\]/.test(stale.out.stoppedAt) && /Update the zodchi-core plugin/.test(stale.out.next) && stale.calls.length === 1, "a missing helper stops at the gate and says what to do");
    const wrongApi = await run({ answers: { "gate db": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 2, plugin: PLUGIN }) } } });
    t.ok(/api 2/.test(wrongApi.out.stoppedAt), "another api is a stop");
    const g = (await run()).of(/^gate /)[0];
    t.eq(g.opts.schema.required, ["exitCode", "stdout"], "the gate answer is the exit code and the one string the command printed");
    t.eq((g.prompt.match(/node -e /g) || []).length, 1, "one command");
    t.ok(/do not parse, summarize, reorder or shorten it/.test(g.prompt), "returned as it is");
    const named = await run({ args: { pluginRoot: "/my/copy/core" } });
    t.ok(named.of(/^gate /)[0].prompt.includes("ZODCHI_PLUGIN_ROOT='/my/copy/core' node -e"), "args.pluginRoot is handed to the command");

    const cp = source("core/workflows/code-package.js");
    const boot = (s) => s.match(/^const GATE_BOOT = (.*)$/m)[1];
    t.eq(boot(SRC), boot(cp), "the gate bootstrap is the same text as code-package's");
    t.ok(/^const SESSION_PROJECT = '"\$\(pwd -W 2>\/dev\/null \|\| pwd\)"'$/m.test(SRC) && /-- \$\{SESSION_PROJECT\} \$\{command\}/.test(SRC), "the command passes the folder the runner starts in");
  });

  scenario("design-brief-no-writes-outside", "the workflow script itself writes nothing but through runner and writer steps: it has no file access, and every non-runner step is a researcher, the planner or the writer", async (t) => {
    t.ok(!/require\(|import\(|\bfs\./.test(SRC.replace(/^const GATE_BOOT = .*$/m, "")), "the script body uses no Node module");
    const r = await run({ args: { questions: ["q"] }, answers: { review: review({ verdict: "changes_requested", findings: [finding("F1", "important")] }) } });
    const kinds = new Set(r.calls.map((c) => (c.opts.agentType === "zodchi-core:runner" ? "runner" : c.opts.model === "haiku" ? "researcher" : "writer")));
    t.eq([...kinds].sort(), ["researcher", "runner", "writer"], "runner, researcher and writer steps only");
    t.ok(r.calls.filter((c) => c.opts.agentType === undefined && c.opts.model === "haiku").every((c) => /^facts /.test(c.label)), "only the researchers run on the cheap model without an agent type");
    t.ok(r.calls.filter((c) => c.opts.model === "sonnet").every((c) => /^(draft|fix|plan) /.test(c.label)), "only the writer steps use the writer model");
    const prompts = r.calls.map((c) => c.prompt).join("\n");
    t.ok(!/codex exec/.test(prompts), "no step runs codex directly: the gateway is the only way");
  });
}
