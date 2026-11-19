// design-brief: from a goal to a brief that code-package can run.
//
// The workflow (core/workflows/design-brief.js) is run here the way Claude Code runs it: as the body of an async function with
// `args`, `agent`, `parallel`, `phase` and `log` in scope. `agent` is a script of answers keyed by the step's label, so every
// decision the workflow itself makes (which facts reach the writer and the review, which candidate reviews, what is reported as
// fixed, what is left, what is never answered) is tested on those answers. What a prompt asks of a runner (the gateway call) is
// checked as text of the prompt. The file steps are commands of the helper (core/scripts/gate.mjs brief-inspect, brief-material,
// brief-preflight, review-read): the inspection is scripted (its answer is wrapped as the helper's line); the material, the preflight and
// the reading of the review run the real helper with the command exactly as the workflow typed it, and the workflow gets the helper's
// line as printed. For that the run works on a scratch folder from the start: the paths of the args and of the scripted answers (/r, /g
// and a drive path) are mapped onto it before the workflow sees them, and the prompts and the result are mapped back for the checks. The
// brief, the cited lines and the review answer the scripted answers describe are written there before the helper runs.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MARK = "<!-- design-brief: db -->";
/** The brief the preflight reads; HEX_A is its hash, the one the draft inspection reports. */
const BRIEF = `${MARK}\n# Title\n\n## Goal\nMake the export resumable.\n\n## Review boundary\nImportant: a lost row.\n\n## Checks\nnode scripts/check.mjs\n`;
const HEX_A = sha(BRIEF);
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
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  // One scratch folder for the file steps of every run of this file, removed when the suite ends.
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "design-brief-")).replace(/\\/g, "/");
  process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });
  let runs = 0;

  const printed = (facts) => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, ...facts }) + "\n" });
  /** A helper line of a file command: the answer with api, plugin and its lineSha256, as gate.mjs prints it. */
  const ioLine = (facts) => { const body = { ok: true, ...facts, api: 1, plugin: PLUGIN }; return { exitCode: 0, stdout: JSON.stringify({ ...body, lineSha256: sha(JSON.stringify(body)) }) + "\n" }; };
  const gateFacts = (over = {}) => ({ roles: ROLES, modelsErrors: [], account: CONNECTED, accountError: "", ignoreExit: 0, ...over });
  const review = (doc, over = {}) => { const answer = JSON.stringify({ notVerified: [], summary: "s", ...doc }); return { ok: true, answer, answerSha256: sha(answer), gateway: "final", infra: "", ...over }; };
  const finding = (id, severity, problem = "p") => ({ id, severity, location: "section Goal", problem, fix: "change it" });

  const ARGS = { label: "db", goal: "Make the export resumable, because a cut run loses an hour.", repos: ["/r"], out: "/r/.agent-tmp/db/brief.md", tmp: "/r/.agent-tmp/db" };
  const ROOTS = [["C", ":"].join("") + "/work/r", "/r", "/g"];
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Runs the workflow once. `o.answers[label]` (a value or a function of the prompt and the calls) replaces a default answer. */
  async function run(o = {}) {
    const calls = [];
    const disk = `${SCRATCH}/run-${++runs}`;
    // The paths of the run on the scratch folder and back.
    const map = ROOTS.map((r, i) => [r, `${disk}/root${i}`]);
    const toDisk = (text) => map.reduce((t, [r, d]) => t.replace(new RegExp(`(?<![\\w.:/-])${escRe(r)}(?=[/"'\\s.,;:)]|$)`, "g"), d), String(text));
    const fromDisk = (text) => map.reduce((t, [r, d]) => t.split(d).join(r), String(text));
    // A drive path written with backslashes (as args may name it) goes to the scratch folder written the same way.
    const backDisk = (text) => map.filter(([r]) => /^[A-Za-z]:\//.test(r)).reduce((t, [r, d]) => t.split(r.replace(/\//g, "\\")).join(d.replace(/\//g, "\\")), String(text));
    const deep = (v, f) => (typeof v === "string" ? f(v) : Array.isArray(v) ? v.map((x) => deep(x, f)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)])) : v);
    const onDisk = (p) => toDisk(p);
    const args = deep({ ...ARGS, ...(o.args || {}) }, (x) => toDisk(backDisk(x)));
    let reviewGiven = null;
    const scripted = (label, prompt, opts) => {
      const given = o.answers && o.answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt, calls, opts) : given;
      if (label === "gate db") return printed(gateFacts(o.gate));
      if (label === "plan db") return { questions: [{ question: "How is the export written today?", repo: "/r", files: ["/r/src/export.js"] }, { question: "Where is the state kept?", repo: "/r", files: ["/r/src/state.js"] }] };
      if (label.startsWith("facts ")) return { facts: [{ claim: `The export writes rows one by one (${label})`, source: `/r/src/export.js:${12 + Number(label.slice(6))}` }], unknowns: [] };
      if (label === "draft db") return { done: true, summary: "wrote", ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }], leftForLater: ["the UI"], wrongFacts: [], unverified: [] };
      if (label === "inspect draft db") return { ok: true, exists: true, sha256: HEX_A, bytes: 100, firstLine: MARK, headings: HEADINGS };
      if (label.startsWith("material ")) return "real";
      if (label === "preflight db") return { ok: true, brief: BRIEF, excerpts: "default" };
      if (label === "review") return review({ verdict: "approved", findings: [] });
      if (label === "read review db") return "real";
      if (label === "fix db") return { done: true, summary: "fixed", fixed: [], left: [], ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }] };
      if (label === "inspect fix db") return { ok: true, exists: true, sha256: HEX_B, bytes: 120, firstLine: MARK, headings: HEADINGS };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    // The answers of the planner, the researchers and the writer name paths of the run (questions, sources): mapped onto the scratch folder.
    const answer = (label, prompt, opts) => {
      const given = scripted(label, prompt, opts);
      return /^(plan|facts|draft|fix) /.test(label) ? deep(given, toDisk) : given;
    };
    /** The real helper with the spec as the workflow typed it; the answer as gate.mjs printed it. */
    const helper = (command, spec) => {
      const r = spawnSync(process.execPath, [GATE, command, JSON.stringify(spec)], { encoding: "utf8", windowsHide: true });
      return { exitCode: r.status ?? -1, stdout: r.stdout || "", error: (r.stderr || "").slice(0, 300) };
    };
    // The file steps: the answer a test scripted describes what is on disk; the helper reads and writes it.
    const io = (command, spec, given) => {
      if (given === null || given === undefined) return given;
      if (typeof given === "object" && "exitCode" in given) return given;
      if (command === "brief-inspect") return ioLine({ exists: true, bytes: 0, firstLine: "", headings: [], ...given, ok: true });
      // A part of the material: the real helper writes it as given.
      if (command === "brief-material") return helper(command, spec);
      if (command === "brief-preflight") {
        fs.mkdirSync(path.dirname(spec.brief), { recursive: true });
        fs.writeFileSync(spec.brief, given.brief);
        // The cited lines, written where the facts of the material (as the runs of brief-material wrote it) point; the parts stay as they are.
        const n = spec.material && spec.material.parts;
        let mat = { facts: [] };
        try { mat = JSON.parse(Array.from({ length: n || 0 }, (_, i) => fs.readFileSync(`${spec.dir}/material/${i + 1}-of-${n}.part`, "utf8")).join("")); } catch { /* the helper says what is wrong */ }
        const lines = new Map();
        for (const f of mat.facts || []) {
          const m = String(f.source).match(/^(.+):(\d+)(?:-(\d+))?$/);
          if (!m) continue;
          const from = Math.max(1, Number(m[2]) - 3);
          const text = given.excerpts === "default" ? `${from}: the cited line of ${f.id}` : ((given.excerpts || []).find((e) => e.id === f.id) || {}).text || "";
          if (!text) continue;
          const have = lines.get(m[1]) || [];
          text.split("\n").forEach((l, k) => { have[from - 1 + k] = l.replace(/^\d+: /, ""); });
          lines.set(m[1], have);
        }
        for (const [file, have] of lines) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Array.from(have, (l) => l ?? "").join("\n") + "\n"); }
        // given.retype: a fault of the runner, which typed the command with a field changed.
        return helper(command, given.retype ? given.retype(spec) : spec);
      }
      if (command === "review-read") {
        if (reviewGiven && typeof reviewGiven.answer === "string") { fs.mkdirSync(path.dirname(spec.file), { recursive: true }); fs.writeFileSync(spec.file, reviewGiven.answer); }
        const r = helper(command, spec);
        // A runner that did not return the line as printed (the gateway step reported a hash that is not the answer's): a hash in it differs.
        if (reviewGiven && reviewGiven.answerSha256 && reviewGiven.answerSha256 !== sha(reviewGiven.answer || "")) return { ...r, stdout: r.stdout.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${reviewGiven.answerSha256}"`) };
        return r;
      }
      throw new Error(`no fake for the helper command ${command}`);
    };
    const sandbox = {
      args, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => {
        const shown = fromDisk(prompt);
        calls.push({ label: opts.label, prompt: shown, opts });
        const given = answer(opts.label, shown, opts);
        if (opts.label === "review") { reviewGiven = given; if (!given) return given; const { answer: _a, answerSha256: _s, ...gw } = given; return gw; }
        // The command as the workflow typed it (paths on the scratch folder), not the mapped text.
        const m = prompt.match(/ -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" (brief-inspect|brief-material|brief-preflight|review-read) '((?:[^']|'\\'')*)'\n/);
        return m ? io(m[1], JSON.parse(m[2].replace(/'\\''/g, "'")), given) : given;
      },
    };
    const fn = vm.runInNewContext(`(async () => {\n${SRC.replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "design-brief.js" });
    let out, error = null;
    try { out = deep(await fn(), fromDisk); } catch (e) { error = e; }
    /** A file the helper wrote for a path of the run, with the run's paths in it (""), and whether it exists. */
    const file = (p) => (fs.existsSync(onDisk(p)) ? fromDisk(fs.readFileSync(onDisk(p), "utf8")) : "");
    const exists = (p) => fs.existsSync(onDisk(p));
    return { out, error, calls, of: (re) => calls.filter((c) => re.test(c.label)), file, exists };
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
    const files = r.file("/r/.agent-tmp/db/review/facts.json");
    t.ok(files.includes('"/r/src/client.js:7"') && !files.includes(key) && !/\.env|server\.pem/.test(files), "nor does it reach the facts file of the review");
    const gw = r.of(/^review$/)[0].prompt;
    t.ok(!gw.includes("--attach '/r/src/client.js'") && !gw.includes("--attach '/r/src/z.js'"), "a cited source file is not attached whole");
    t.ok(gw.includes("--attach '/r/.agent-tmp/db/review/excerpts.md'"), "its cited lines are attached as one excerpts file");
    const pre = r.of(/^material /).map((c) => JSON.parse(c.prompt.match(/ brief-material '(.*)'$/m)[1].replace(/'\\''/g, "'")).text).join("");
    t.ok(pre.includes('"source":"/r/src/client.js:7"') && !/\.env|server\.pem/.test(pre), "the helper is asked for the lines of the good facts only");
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
    const files = r.of(/^preflight /)[0];
    t.ok(files.opts.agentType === "zodchi-core:runner" && files.prompt.includes(' brief-preflight \'') && files.prompt.includes('"dir":"/r/.agent-tmp/db/review"'), "the files of the request are written by the helper a runner runs");
    for (const f of ["facts.json", "excerpts.md", "prompt.md", "design-review.md", "design-review.schema.json", "design-review.json"]) t.ok(r.exists(`/r/.agent-tmp/db/review/${f}`), `the request has ${f}`);
    const rv = r.of(/^review$/)[0];
    t.ok(rv.opts.agentType === "zodchi-core:runner" && rv.opts.model === undefined, "the review is a runner step that calls the gateway");
    t.ok(/zodchi run --role '\/r\/\.agent-tmp\/db\/review\/design-review\.json' --key db-design-review --model gpt-x --effort high --prompt '\/r\/\.agent-tmp\/db\/review\/prompt\.md' --attach '\/r\/\.agent-tmp\/db\/brief\.md' --attach '\/r\/\.agent-tmp\/db\/review\/facts\.json' --attach '\/r\/\.agent-tmp\/db\/review\/excerpts\.md' --wait-sec 540/.test(rv.prompt), "the command names the role, the key, the model, the prompt and the attachments");
    t.ok(/foreground/.test(rv.prompt) && /Never in the background/.test(rv.prompt), "it waits in the foreground");
    t.ok(/is final with status "unknown" never gets a new key/.test(rv.prompt), "a job that ended unknown is never submitted again");
    const body = JSON.parse(r.file("/r/.agent-tmp/db/review/design-review.json"));
    t.eq([body.mode, body.model, body.effort], ["expert", "gpt-x", "high"], "the role file carries the chosen candidate");
    const reviewPrompt = r.file("/r/.agent-tmp/db/review/prompt.md");
    for (const s of ["Facts.", "Guessing.", "Scope.", "Review boundary.", "Checks.", "Secrets and names.", "Owner decisions."]) t.ok(reviewPrompt.includes(s), `the review asks about: ${s}`);
    t.ok(!/no company, product or person name/.test(reviewPrompt), "a repository not marked public is not asked about private names");
    const pub = await run({ args: { publicRepo: true } });
    t.ok(/no company, product or person name and no machine path/.test(pub.file("/r/.agent-tmp/db/review/prompt.md")), "a public repository is also checked for names and machine paths");

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

    const odd = await run({ answers: { review: review({ verdict: "changes_requested", findings: [{ ...finding("F1", "critical") }] }) } });
    t.eq(odd.of(/^fix /).length, 1, "a finding of an unknown severity goes to the fix: the workflow, not the reviewer's spelling, decides");
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

  // ------------------------------------------------------------------ review-1 findings (F1 to F6)
  const KEY = ["sk", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
  const driveRoot = ["C", ":"].join("") + "/work/ann";
  /** What the preflight finds on disk: the brief and, by default, one cited line per fact (written where the fact points). */
  const preAnswer = (brief, over = {}) => () => ({ ok: true, brief, briefSha256: sha(brief), excerpts: "default", ...over });
  const inspected = (brief) => ({ ok: true, exists: true, sha256: sha(brief), firstLine: MARK, headings: HEADINGS });

  scenario("design-brief-research-writes-nothing", "F1: no research prompt allows a plain git command (git status writes the index), and the planner is not told to keep a progress file", async (t) => {
    const r = await run();
    const plan = r.of(/^plan /)[0];
    t.ok(plan.opts.agentType === undefined && !/Resume rule|progress file of|Shell rule/.test(plan.prompt), "the planner is a plain agent: no wrapper that tells it to create, append to or rename a progress file");
    t.ok(/write nothing \(no progress file, no note\)/.test(plan.prompt), "and it is told to write nothing, not even a note");
    for (const c of [plan, ...r.of(/^facts /)]) {
      t.ok(/git --no-optional-locks log\|show\|diff\|grep/.test(c.prompt), `${c.label}: git only with --no-optional-locks, and only log, show, diff or grep`);
      t.ok(!/git log, git show, git diff, git status|\bgit status\b[^.]*(allowed|read-only shell)/.test(c.prompt), `${c.label}: git status is not offered as a read-only command`);
    }
  });

  scenario("design-brief-no-secret-or-path-to-reviewer", "F2: a secret in a question never leaves the workflow; in a public repository the reviewer gets repository aliases and relative paths", async (t) => {
    const q = `Why does the client send password: hunter2xyz and ${KEY}?`;
    const r = await run({ args: { questions: [q] }, answers: { "facts 1": null } });
    t.ok(!r.calls.some((c) => c.prompt.includes("hunter2xyz") || c.prompt.includes(KEY)), "no prompt holds the secret of the question");
    t.ok(r.out.notes.some((n) => n.includes("The researcher of question 1 returned no result")) && !JSON.stringify(r.out).includes("hunter2xyz") && !JSON.stringify(r.out).includes(KEY), "nor the notes or the result when the researcher fails");
    const ok = await run({ args: { questions: [q] } });
    const factsFile = ok.file("/r/.agent-tmp/db/review/facts.json");
    t.ok(!factsFile.includes("hunter2xyz") && !factsFile.includes(KEY) && factsFile.includes("[REDACTED"), "the facts file of the review carries the redacted question");
    const pub = await run({ args: { publicRepo: true, goal: `Resume the export in ${driveRoot}/app and /r/src.` }, answers: { "facts 1": { facts: [{ claim: `Rows are written by /r/src/export.js; see ${driveRoot}/x`, source: "/r/src/export.js:13" }], unknowns: [`Not found under ${driveRoot}/y`] } } });
    const body = (name) => pub.file(`/r/.agent-tmp/db/review/${name}`);
    const material = body("facts.json") + body("prompt.md") + body("excerpts.md");
    t.ok(material.length > 0 && pub.out.stoppedAt === undefined, "the request was written and sent");
    t.ok(!material.includes("/r/") && !material.includes(driveRoot) && !/[A-Za-z]:\//.test(material), "the facts, the excerpts and the prompt of the review hold no machine path");
    t.ok(material.includes("<repo1>/src/export.js:13") && material.includes("<path>"), "the repository is an alias and a relative path, and a foreign path is <path>");
    const local = await run({ args: { goal: "Resume the export in /r/src." } });
    t.ok(local.file("/r/.agent-tmp/db/review/facts.json").includes("/r/src/export.js:13"), "a repository not marked public keeps its paths");
  });

  scenario("design-brief-preflight", "F3: the brief is screened and the cited lines redacted before anything goes to the gateway; no whole source file is attached", async (t) => {
    const dirty = `${BRIEF}\nThe client sends ${KEY} to the queue.\n`;
    const r = await run({ answers: { "preflight db": preAnswer(dirty), "inspect draft db": inspected(dirty) } });
    t.ok(/^review \(the brief holds material that is not sent to a reviewer: line \d+: a secret-shaped value/.test(r.out.stoppedAt), "a brief with a secret-shaped value stops before the review");
    t.eq([r.exists("/r/.agent-tmp/db/review/facts.json"), r.exists("/r/.agent-tmp/db/review/prompt.md"), r.of(/^review$/).length, r.of(/^fix /).length], [false, false, 0, 0], "nothing was written for the gateway, sent, or fixed");
    t.ok(!JSON.stringify(r.out).includes(KEY) && r.out.path === ARGS.out && /was not sent to the review/.test(r.out.next), "the value is not repeated; the brief is named");
    const pathy = `${BRIEF}\nRun it in ${driveRoot}/app.\n`;
    const publicRun = await run({ args: { publicRepo: true }, answers: { "preflight db": preAnswer(pathy), "inspect draft db": inspected(pathy) } });
    t.ok(/a machine path/.test(publicRun.out.stoppedAt) && publicRun.of(/^review$/).length === 0, "in a public repository a machine path stops it too");
    const quiet = await run({ answers: { "preflight db": preAnswer(pathy), "inspect draft db": inspected(pathy) } });
    t.ok(quiet.out.stoppedAt === undefined && quiet.of(/^review$/).length === 1, "a repository not marked public may name a path");
    const other = await run({ answers: { "preflight db": preAnswer(`${BRIEF}\nchanged\n`, { briefSha256: HEX_A }) } });
    t.ok(/is not the brief that was inspected/.test(other.out.stoppedAt) && other.of(/^review$/).length === 0, "a brief that is not the inspected one (hash) is not sent");
    const none = await run({ answers: { "preflight db": null } });
    t.ok(/the preflight read no brief/.test(none.out.stoppedAt) && none.of(/^review$/).length === 0, "no preflight answer: not sent");

    // T2 cites a file that cannot be read (here: none is there)
    const leak = await run({ answers: { "facts 2": { facts: [{ claim: "The state is kept in one file (facts 2)", source: "/r/src/state.js:14" }], unknowns: [] }, "preflight db": (prompt) => ({ ...preAnswer(BRIEF)(prompt), excerpts: [{ id: "T1", text: `3: const token = "abcd1234efgh5678"\n4: key ${KEY}` }, { id: "T2", text: "" }] }) } });
    const ex = leak.file("/r/.agent-tmp/db/review/excerpts.md");
    t.ok(!ex.includes("abcd1234efgh5678") && !ex.includes(KEY) && ex.includes("[REDACTED"), "a secret in a cited line is redacted in the excerpts");
    t.ok(/## T2 .*\n\(not available\)/.test(ex) && leak.out.notes.some((n) => n.includes("1 cited excerpt(s) could not be read")), "an excerpt that could not be read is said, not invented");
    const ask = leak.of(/^preflight /)[0];
    t.ok(ask.opts.agentType === "zodchi-core:runner" && /change nothing/.test(ask.prompt) && !/Resume rule/.test(ask.prompt), "the preflight is a runner that only runs the helper (it changes nothing itself) and keeps no progress file");
    t.ok(!/exactly as read|every character|<<<FILE/.test(ask.prompt) && (ask.prompt.match(/node -e /g) || []).length === 1, "and is never asked to return or write a file's content: one helper command");
  });

  scenario("design-brief-gateway-attachments", "F4: every attachment is required and its list is recorded per key; a missing one is reported, never answered by another submission", async (t) => {
    const rv = (await run()).of(/^review$/)[0].prompt;
    t.ok(!/Not attached for size|optional file|drop the largest/.test(rv), "no file is dropped for size: nothing is optional");
    t.ok(/Every attachment is required/.test(rv) && /exact list of the --attach paths submitted under it/.test(rv), "the exact list is recorded with each key and checked against");
    t.ok(/must contain \`<attachment path="\.\.\.">\` .* for every path of the list recorded for the active key/.test(rv), "request.json is checked against that list");
    t.ok(/do not submit again for it, because the model turn may have run/.test(rv) && !/run the full command again with the next key \(counted with the retries\), every attachment included/.test(rv), "a missing attachment is a failure, not a new submission");
    t.ok(/over 500 KB do not submit/.test(rv), "a request over the size limit is not sent");
    t.ok(/no attachment is missing/.test(rv), "ok means that no attachment is missing");
  });

  scenario("design-brief-fix-claims", "F5: a changed hash only shows the file changed; an unfinished fix is an attempt; without an edit the owner decisions of the draft stay", async (t) => {
    const two = { verdict: "changes_requested", findings: [finding("F1", "blocker"), finding("F2", "important")] };
    const half = await run({ answers: { review: review(two), "fix db": { done: false, summary: "half", fixed: [{ id: "F1", what: "did it" }], left: [], ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }] } } });
    t.eq(half.out.fixed, [], "the writer says done false: nothing is reported as fixed even though the file changed");
    t.ok(half.out.left.some((x) => x.startsWith("F1") && x.includes("an attempt, not confirmed")), "the claim is an attempt in left");
    t.ok(/edited once/.test(half.out.next) && /0 finding\(s\) fixed/.test(half.out.next), "and the next step does not say the brief was fixed");
    const noop = await run({ answers: { review: review(two), "fix db": { done: true, summary: "x", fixed: [{ id: "F1", what: "did it" }], left: [], ownerDecisions: [{ question: "Keep a copy of the old export?", default: "No" }, { question: "A new question?", default: "Yes" }] }, "inspect fix db": { ok: true, exists: true, sha256: HEX_A, firstLine: MARK, headings: HEADINGS } } });
    t.eq(noop.out.ownerDecisions, ["Keep a copy of the old export? (default: No)"], "no edit: the owner decisions are those of the draft, not the writer's new list");
    t.ok(noop.out.notes.some((n) => n.includes("the brief did not change")), "the difference is noted");
    t.ok(/did not change the brief/.test(noop.out.next) && !/fixed once|was fixed/.test(noop.out.next) && /nothing is fixed/.test(noop.out.next), "the lead is told nothing was fixed");
    const real = await run({ answers: { review: review(two), "fix db": { done: true, summary: "x", fixed: [{ id: "F1", what: "did it" }, { id: "F2", what: "and it" }], left: [], ownerDecisions: [] } } });
    t.eq(real.out.fixed.length, 2, "a changed file and a finished fix are reported, as what the writer says");
    t.ok(/the writer reports 2 finding\(s\) fixed \(not checked finding by finding\)/.test(real.out.next), "and the next step says so");
  });

  scenario("design-brief-verdict-agrees", "F6: a verdict that contradicts its findings stops the run: it is never reported as an approval", async (t) => {
    const a1 = await run({ answers: { review: review({ verdict: "approved", findings: [finding("F1", "important")] }) } });
    t.ok(/^review \(the verdict approved does not match its findings/.test(a1.out.stoppedAt) && a1.of(/^fix /).length === 0, "approved with an important finding stops and fixes nothing");
    t.ok(!/approved the brief\b(?! but)/.test(a1.out.next) && /not approved/.test(a1.out.next), "and the lead is told the brief is not approved");
    t.eq(a1.out.review.verdict, "approved", "the reviewer's own word is kept in review.verdict");
    const c1 = await run({ answers: { review: review({ verdict: "changes_requested", findings: [finding("F1", "minor")] }) } });
    t.ok(/^review \(the verdict changes_requested does not match its findings/.test(c1.out.stoppedAt) && c1.of(/^fix /).length === 0, "changes_requested with only minor findings stops too");
    t.ok(!/The review approved/.test(c1.out.next || ""), "and is never described as an approval");
    const ok = await run({ answers: { review: review({ verdict: "approved", findings: [finding("F1", "minor")] }) } });
    t.ok(ok.out.stoppedAt === undefined && /The review approved the brief/.test(ok.out.next), "approved with only a minor finding is an approval");
  });

  scenario("design-brief-material-parts", "the workflow's material for the review (goal, questions, facts, unknowns) reaches the helper in parts of at most 3000 characters, one command each, so no command a runner types grows with the research; a part that did not arrive exactly stops the run before the preflight", async (t) => {
    const many = { facts: Array.from({ length: 60 }, (_, i) => ({ claim: `The export writes row group ${i} with its own checkpoint and a long explanation of why it matters here (fact ${i}).`, source: `/r/src/export.js:${i + 1}` })), unknowns: [] };
    const r = await run({ answers: { "facts 1": many } });
    const parts = r.of(/^material /);
    const texts = parts.map((c) => JSON.parse(c.prompt.match(/ brief-material '(.*)'$/m)[1].replace(/'\\''/g, "'")));
    t.ok(parts.length > 1 && texts.every((x) => x.text.length <= 3000 && x.of === parts.length), "the material is cut into several parts of at most 3000 characters");
    t.ok(parts.every((c) => c.opts.agentType === "zodchi-core:runner" && (c.prompt.match(/node -e /g) || []).length === 1), "each part is one helper command a runner runs");
    t.ok(!/"facts":/.test(r.of(/^preflight /)[0].prompt) && r.out.stoppedAt === undefined && r.of(/^review$/).length === 1, "the preflight command carries no facts, only the parts' count and hash; the review was sent");
    const doc = JSON.parse(r.file("/r/.agent-tmp/db/review/facts.json"));
    t.eq(doc.facts.length, 61, "every fact reached the facts file of the review");
    const bad = await run({ answers: { "material 1/1 db": ioLine({ part: 1, of: 1, sha256: "0".repeat(64), chars: 1 }) } });
    t.ok(/^review \(part 1 of the material did not reach the helper exactly/.test(bad.out.stoppedAt) && bad.of(/^preflight /).length === 0 && bad.of(/^review$/).length === 0, "a part whose hash differs stops the run: no preflight, nothing sent");
    const cmd = JSON.parse(r.of(/^preflight /)[0].prompt.match(/ brief-preflight '(.*)'$/m)[1].replace(/'\\''/g, "'"));
    t.eq(cmd.material.parts, parts.length, "the preflight is given the workflow's own part count, and the real helper joined those parts");
  });

  scenario("design-brief-screen-mode", "the screening mode is the workflow's: a preflight command whose publicRepo a runner dropped is refused by the helper, and one whose mode a runner changed is refused by the workflow; nothing goes to the gateway", async (t) => {
    const pathy = `${BRIEF}\nRun it in ${driveRoot}/app.\n`;
    const drop = (spec) => { const { publicRepo: _p, ...rest } = spec; return rest; };
    const dropped = await run({ args: { publicRepo: true }, answers: { "preflight db": preAnswer(pathy, { retype: drop }), "inspect draft db": inspected(pathy) } });
    t.ok(/^review \(the preflight read no brief: .*publicRepo must be true or false/.test(dropped.out.stoppedAt) && dropped.of(/^review$/).length === 0, `an omitted mode is refused, not screened as not public (${dropped.out.stoppedAt})`);
    const flipped = await run({ args: { publicRepo: true }, answers: { "preflight db": preAnswer(pathy, { retype: (spec) => ({ ...spec, publicRepo: false }) }), "inspect draft db": inspected(pathy) } });
    t.ok(/^review \(the preflight screened the brief as not public, but the repository is public/.test(flipped.out.stoppedAt) && flipped.of(/^review$/).length === 0, `a changed mode stops the run before the gateway (${flipped.out.stoppedAt})`);
    const right = await run({ args: { publicRepo: true } });
    t.ok(right.out.stoppedAt === undefined && right.of(/^review$/).length === 1 && /"publicRepo":true/.test(right.of(/^preflight /)[0].prompt), "the command carries the mode, and a matching answer goes on");
  });

  scenario("design-brief-review-beyond-40", "the verdict and the shape of the review are judged over every finding, not only the 40 the helper lists: a blocker after the first 40 contradicts an approval, a malformed finding after them makes it no review, and a fix is still asked for one", async (t) => {
    const minors = Array.from({ length: 40 }, (_, i) => finding(`M${i}`, "minor"));
    const hidden = await run({ answers: { review: review({ verdict: "approved", findings: [...minors, finding("F41", "important")] }) } });
    t.ok(/^review \(the verdict approved does not match its findings: 1 blocker or important, 40 minor\)/.test(hidden.out.stoppedAt) && hidden.of(/^fix /).length === 0, `an approval with an important finding at 41 stops (${hidden.out.stoppedAt})`);
    const bad = await run({ answers: { review: review({ verdict: "approved", findings: [...minors, "not an object"] }) } });
    t.ok(/not a review/.test(bad.out.stoppedAt) && bad.out.reviewFindings === null, `a malformed finding at 41 is no review (${bad.out.stoppedAt})`);
    const asked = await run({ answers: { review: review({ verdict: "changes_requested", findings: [...minors, finding("F41", "blocker")] }) } });
    t.eq(asked.of(/^fix /).length, 1, "changes requested for a blocker at 41: the fix runs");
    t.ok(/1 more blocker or important finding\(s\) after the first 40/.test(asked.of(/^fix /)[0].prompt), "and the writer is told to read it in the answer file");
  });
}
