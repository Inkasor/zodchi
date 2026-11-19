// incident-triage: the synthetic cases of scripts/e2e/fixtures/incident-triage/cases, run through the real workflow.
//
// The body of core/workflows/incident-triage.js runs the way Claude Code runs it (an async function of args, agent, phase, log, ...)
// with a fake agent. The fake does what each runner step's prompt asks, for real, in a temporary incident folder: it takes the lock,
// writes the exact files the workflow hands over (checking their SHA-256, which also checks the workflow's own SHA-256), runs the
// generated collector with node (so the evidence is collected for real from the synthetic product of fixtures/incident-triage/product.mjs)
// and publishes the draft. Only the model and the gate helper are scripted: the classifier's answer is the case's classification.json,
// returned as the gateway would (a Codex candidate) or as a Claude subagent would (when the case's role table has only Claude), and the
// gate step prints the line core/scripts/gate.mjs would print (its own checks are in workflow-gate.mjs).
// Each case folder holds case.json: { about, report, params, models?, adapterFrom?, twinReport?, expect }; the keys of expect are read
// by verify() below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export default function register({ scenario, ROOT }) {
  const WORKFLOW = path.join(ROOT, "core", "workflows", "incident-triage.js");
  const FIXTURES = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
  const CASES = path.join(FIXTURES, "cases");
  const slash = (p) => p.replace(/\\/g, "/");
  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  const readIf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]));

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runWorkflow = new AsyncFunction("args", "agent", "phase", "log", "parallel", "pipeline", "budget", fs.readFileSync(WORKFLOW, "utf8").replace(/^export const meta/m, "const meta"));

  const CODEX_TABLE = { architect: { candidates: [{ provider: "codex", model: "mock-architect", effort: "high" }, { provider: "claude", model: "fable", effort: "high" }] } };
  const ACCOUNT = { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } };
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };

  /** The exact-file blocks of a prompt, in order. */
  function blocks(prompt) {
    const re = /<<<FILE path=("(?:[^"\\]|\\.)*") sha256=([0-9a-f]{64})>>>\n([\s\S]*?)<<<END FILE>>>/g;
    return [...prompt.matchAll(re)].map((m) => ({ path: JSON.parse(m[1]), sha: m[2], text: m[3] }));
  }
  function writeBlocks(prompt) {
    const wrote = [];
    const replace = new Set();
    // "(replace)" follows the quoted path in the list of files of each group.
    for (const m of prompt.matchAll(/("(?:[^"\\]|\\.)*") \(replace\)/g)) replace.add(JSON.parse(m[1]));
    for (const b of blocks(prompt)) {
      const got = sha(Buffer.from(b.text, "utf8"));
      if (got !== b.sha) throw new Error(`the workflow's sha256 of ${b.path} is ${b.sha}, node says ${got}`);
      fs.mkdirSync(path.dirname(b.path), { recursive: true });
      if (!replace.has(b.path) && fs.existsSync(b.path)) throw new Error(`${b.path} exists and is not marked replace: a revision is never overwritten`);
      fs.writeFileSync(b.path + ".tmp", b.text);
      fs.renameSync(b.path + ".tmp", b.path);
      wrote.push({ path: b.path, sha256: got });
    }
    return wrote;
  }

  function fakeAgent(ctx) {
    return async (prompt, opts = {}) => {
      const label = opts.label || "";
      ctx.prompts.push({ label, prompt, opts });
      const { tmp } = ctx;
      if (label.startsWith("gate ")) {
        // The helper's one line, as the runner would return it (what the helper prints is checked in workflow-gate.mjs).
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, roles: CODEX_TABLE, modelsErrors: [], account: ACCOUNT, accountError: "", ignoreExit: 0 }) + "\n", error: "" };
      }
      if (label.startsWith("open ")) {
        let locked = true;
        try { fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(`${tmp}/.lock`); } catch { locked = false; }
        if (!locked) return { ok: false, locked: false, incident: "", revs: [], adapter: "", adapterSha256: "" };
        const adapter = fs.readFileSync(ctx.adapter);
        return {
          ok: true, locked: true,
          incident: readIf(`${tmp}/incident.json`),
          revs: fs.readdirSync(tmp).filter((n) => /^rev-\d+$/.test(n)),
          adapter: adapter.toString("utf8"), adapterSha256: `${sha(adapter)}  ${ctx.adapter}`,
        };
      }
      if (label.startsWith("collect ")) {
        const collector = blocks(prompt).find((b) => b.path.endsWith("/collect.cjs"));
        const revDir = path.dirname(collector.path);
        fs.mkdirSync(revDir); // not recursive: the revision folder must be new
        const wrote = writeBlocks(prompt);
        ctx.collector = collector.text;
        let summary = "", exitCode = 0, error = "";
        try { summary = execFileSync(process.execPath, [collector.path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { exitCode = e.status ?? 1; error = String(e.stderr || e.message).slice(-2000); }
        const ev = `${revDir}/evidence.json`;
        // The runner keeps the collector's stdout in collect.out and returns it in the field the step's schema names (collectOut, or summary in
        // an older step); the collector's exit code and the hash of evidence.json are what the runner measured.
        fs.writeFileSync(`${revDir}/collect.out`, summary);
        const field = opts.schema && opts.schema.properties && opts.schema.properties.collectOut ? "collectOut" : "summary";
        return { ok: exitCode === 0, [field]: summary, evidenceSha256: fs.existsSync(ev) ? sha(fs.readFileSync(ev)) : "", exitCode, error, wrote };
      }
      if (label.startsWith("classify ")) {
        if (ctx.failClassify) return { ok: false, answer: "", answerSha256: "", infra: "the gateway created no job (mock)" };
        const text = fs.readFileSync(path.join(ctx.caseDir, "classification.json"), "utf8");
        if (opts.schema && opts.schema.properties && opts.schema.properties.answer) {
          // The gateway path: the runner returns the file the gateway wrote with --out.
          const outFile = prompt.match(/--out '([^']+)'/)[1];
          fs.writeFileSync(outFile, text);
          ctx.classifier = "codex/" + (prompt.match(/--model (\S+)/) || [])[1];
          return { ok: true, answer: text, answerSha256: sha(Buffer.from(text, "utf8")), infra: "", unknownKey: "" };
        }
        ctx.classifier = `claude/${opts.model}`;
        return JSON.parse(text);
      }
      if (label.startsWith("mark failed ")) {
        // Fault injection: a runner that says ok but left the file out, or reports a hash that is not the file's.
        if (ctx.faultCleanup === "omit") return { ok: true, summary: "written", wrote: [] };
        const wrote = writeBlocks(prompt);
        if (ctx.faultCleanup === "badhash") return { ok: true, summary: "written", wrote: wrote.map((w) => ({ ...w, sha256: "0".repeat(64) })) };
        return { ok: true, summary: "written", wrote };
      }
      if (label.startsWith("publish ") || label.startsWith("unlock ")) {
        const wrote = writeBlocks(prompt);
        if (label.startsWith("unlock ")) { try { fs.rmdirSync(`${tmp}/.lock`); } catch { return { ok: false, summary: "no lock", wrote }; } }
        return { ok: true, summary: "written", wrote };
      }
      throw new Error(`the fake agent has no answer for the step "${label}"`);
    };
  }

  /** One run of the workflow over a case, in a scratch incident folder that the scenario's cleanups remove. */
  async function runCase(t, name, overrides = {}) {
    const caseDir = path.join(CASES, name);
    const c = JSON.parse(fs.readFileSync(path.join(caseDir, "case.json"), "utf8"));
    const adapter = slash(path.join(CASES, c.adapterFrom || name, "adapter.json"));
    const tmp = overrides.tmp || slash(fs.mkdtempSync(path.join(os.tmpdir(), `incident-triage-${name}-`)));
    if (!overrides.tmp) t.cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const ctx = { tmp, adapter, caseDir, prompts: [], failClassify: Boolean(overrides.failClassify), faultCleanup: overrides.faultCleanup || "" };
    const args = { incident: `case-${name}`, tmp, adapter, report: overrides.report ?? c.report, params: c.params, repo: tmp, ...(c.models ? { models: c.models } : {}) };
    const logs = [];
    const result = await runWorkflow(args, fakeAgent(ctx), () => {}, (m) => logs.push(m), null, null, { total: null });
    return { c, ctx, result, tmp, logs };
  }

  /** The expectations of one case; returns the list of problems. */
  function verify(run) {
    const { c, ctx, result: r, tmp } = run;
    const e = c.expect || {};
    const bad = [];
    const rev = `${tmp}/rev-${r.revision}`;
    const draft = readIf(`${rev}/draft.md`);
    const evidenceText = readIf(`${rev}/evidence.json`);
    const evidence = evidenceText ? JSON.parse(evidenceText) : { items: [] };
    const cls = readIf(`${rev}/classification.json`) ? JSON.parse(readIf(`${rev}/classification.json`)) : null;
    const item = (id) => evidence.items.find((i) => i.id === id) || {};
    if (fs.existsSync(`${tmp}/.lock`)) bad.push("the lock was left behind");
    // The gate step ran first and asked the helper for the classifier role; nothing was locked before it answered.
    if (!ctx.prompts.length || !/^gate /.test(ctx.prompts[0].label) || !/ roles '\{"api":1,"want":\["architect"\]/.test(ctx.prompts[0].prompt)) bad.push("the first step is not the gate helper's roles command");
    if (e.noRevision) {
      if (fs.readdirSync(tmp).some((n) => /^rev-/.test(n))) bad.push("a revision folder was made although the adapter was refused");
      if (ctx.prompts.some((p) => /^collect /.test(p.label))) bad.push("the collector ran although the adapter was refused");
    }
    if (e.state && r.state !== e.state) bad.push(`state ${r.state}, expected ${e.state}`);
    if (e.route && r.route !== e.route) bad.push(`route ${r.route}, expected ${e.route}`);
    if (e.kinds && JSON.stringify(r.kinds) !== JSON.stringify(e.kinds)) bad.push(`kinds ${JSON.stringify(r.kinds)}, expected ${JSON.stringify(e.kinds)}`);
    if (e.classifier && ctx.classifier !== e.classifier) bad.push(`classifier ${ctx.classifier}, expected ${e.classifier}`);
    for (const [id, want] of Object.entries(e.outcomes || {})) if (item(id).outcome !== want) bad.push(`${id} (${item(id).source}) ended ${item(id).outcome}, expected ${want}`);
    for (const [id, want] of Object.entries(e.reasonIncludes || {})) if (!String(item(id).reason || "").includes(want)) bad.push(`${id}: reason ${JSON.stringify(item(id).reason)} lacks ${JSON.stringify(want)}`);
    for (const s of e.refusedIncludes || []) if (!(r.refused || []).some((x) => x.includes(s))) bad.push(`refused lacks ${JSON.stringify(s)}: ${JSON.stringify(r.refused)}`);
    for (const s of e.refusedExcludes || []) if ((r.refused || []).some((x) => x.includes(s))) bad.push(`refused holds ${JSON.stringify(s)}: ${JSON.stringify(r.refused)}`);
    for (const s of e.notesInclude || []) if (!(r.notes || []).some((x) => x.includes(s))) bad.push(`notes lack ${JSON.stringify(s)}: ${JSON.stringify(r.notes)}`);
    for (const s of e.draftIncludes || []) if (!draft.includes(s)) bad.push(`the draft lacks ${JSON.stringify(s)}`);
    for (const s of e.evidenceExcludes || []) if (evidenceText.includes(s)) bad.push(`the evidence bundle holds ${JSON.stringify(s)} (not redacted)`);
    // A secret reaches no generated file (collector, prompt, classification, draft, progress) and no step's prompt.
    for (const s of e.secretsExclude || []) {
      for (const f of filesUnder(tmp)) if (fs.readFileSync(f, "utf8").includes(s)) bad.push(`${slash(path.relative(tmp, f))} holds ${JSON.stringify(s)}`);
      for (const p of ctx.prompts) if (p.prompt.includes(s)) bad.push(`the prompt of the step "${p.label}" holds ${JSON.stringify(s)}`);
      if (JSON.stringify(r).includes(s)) bad.push(`the workflow's result holds ${JSON.stringify(s)}`);
    }
    for (const s of e.classificationExcludes || []) if (cls && JSON.stringify(cls).includes(s)) bad.push(`classification.json holds ${JSON.stringify(s)}`);
    // Findings in classification.json hold no model text (its summaries are kept apart, under modelWording).
    for (const s of e.findingsExclude || []) if (cls && JSON.stringify(cls.findings || []).includes(s)) bad.push(`classification.json findings hold ${JSON.stringify(s)}`);
    for (const s of e.draftExcludes || []) if (draft.toLowerCase().includes(s.toLowerCase())) bad.push(`the draft holds ${JSON.stringify(s)}`);
    // The reply the workflow assembled for the reporter (classification.json and the draft's reply section).
    const reply = cls && typeof cls.reporterReply === "string" ? cls.reporterReply : null;
    if ((e.replyIncludes || e.replyExcludes) && reply === null) bad.push("classification.json has no reporterReply");
    for (const s of e.replyIncludes || []) if (reply !== null && !reply.includes(s)) bad.push(`the reply to the reporter lacks ${JSON.stringify(s)}: ${JSON.stringify(reply)}`);
    for (const s of e.replyExcludes || []) if (reply !== null && reply.toLowerCase().includes(s.toLowerCase())) bad.push(`the reply to the reporter holds ${JSON.stringify(s)}: ${JSON.stringify(reply)}`);
    // Model text that may appear only under the heading of unchecked wording, nowhere the lead forwards from.
    const wordingAt = draft.indexOf("## Model's wording (not checked, do not forward as is)");
    for (const s of e.wordingOnly || []) {
      if (wordingAt < 0) { bad.push("the draft has no section of the model's wording"); break; }
      if (draft.slice(0, wordingAt).includes(s)) bad.push(`${JSON.stringify(s)} appears before the model's wording section`);
      if (!draft.slice(wordingAt).includes(s)) bad.push(`${JSON.stringify(s)} is not in the model's wording section`);
    }
    for (const id of e.gapFor || []) if (!cls || !(cls.gaps || []).some((g) => g.evidence.includes(id))) bad.push(`no gap covers the item ${id}`);
    if (e.draftExcludesAccess && /\b(grant|give|request|ask for)\b[^.\n]{0,40}\baccess\b|\bno access\b/i.test(draft)) bad.push("the draft asks for access");
    if (e.citesBothSources) {
      const f = cls && cls.findings && cls.findings[0];
      const src = f ? f.evidence.map((id) => item(id).source) : [];
      if (!src.includes("agentSkill") || !src.some((s) => String(s).startsWith("allowList:"))) bad.push(`the main finding does not cite both the agent skill and an allow-list: ${JSON.stringify(src)}`);
    }
    // Every case that classified: the report reached the classifier only as untrusted evidence, never in the prompt.
    const promptText = readIf(`${rev}/classify-prompt.md`) + readIf(`${rev}/classifier/incident-classify.md`);
    if (promptText) {
      if (promptText.includes(c.report)) bad.push("the report text is in the classifier prompt");
      if (!evidence.items.some((i) => i.source === "report" && i.untrusted === true)) bad.push("the report is not an untrusted evidence item");
      if (!evidence.items.every((i) => i.untrusted === true)) bad.push("an evidence item is not marked untrusted");
    }
    for (const s of e.promptExcludes || []) if (promptText.includes(s)) bad.push(`the classifier prompt holds ${JSON.stringify(s)}`);
    if (r.state && r.state !== "failed" && !r.refused) {
      const inc = JSON.parse(readIf(`${tmp}/incident.json`) || "{}");
      if (inc.revision !== r.revision || inc.state !== r.state) bad.push(`incident.json says revision ${inc.revision} ${inc.state}, the run ${r.revision} ${r.state}`);
      if (readIf(`${rev}/adapterHash`).trim() !== sha(fs.readFileSync(run.ctx.adapter))) bad.push("rev adapterHash differs from the adapter file");
    }
    return bad;
  }

  /** The injection case is run a second time with a plain report: the prompt, the plan and the verdict must not differ. */
  async function twin(t, name, run) {
    const bad = [];
    const plain = await runCase(t, name, { report: run.c.twinReport });
    const plan = (text) => { const p = JSON.parse(text.match(/const PLAN = ([\s\S]*?)\n\n/)[1]); delete p.revDir; p.items[0].text = "<report>"; return JSON.stringify(p); };
    const prompt = (x) => readIf(`${x.tmp}/rev-${x.result.revision}/classify-prompt.md`);
    if (prompt(run) !== prompt(plain)) bad.push("the classifier prompt differs between the injected and the plain report");
    if (plan(run.ctx.collector) !== plan(plain.ctx.collector)) bad.push("the collector plan differs between the injected and the plain report");
    for (const k of ["state", "route"]) if (run.result[k] !== plain.result[k]) bad.push(`${k} differs: ${run.result[k]} with the injection, ${plain.result[k]} without`);
    if (JSON.stringify(run.result.kinds) !== JSON.stringify(plain.result.kinds)) bad.push("the kinds differ");
    return bad;
  }

  /** Runs each named case, checks its expectations and records one assertion per case. */
  async function runCases(t, names) {
    for (const name of names) {
      const run = await runCase(t, name);
      const bad = verify(run);
      if (run.c.twinReport) bad.push(...(await twin(t, name, run)));
      const r = run.result;
      t.log(`${name}: ${r.refused && !r.route ? `refused (${r.refused.length})` : `state=${r.state} route=${r.route || "-"} kinds=${(r.kinds || []).join(",") || "-"}`}`);
      t.ok(!bad.length, `case ${name} meets its expectations${bad.length ? `:\n  - ${bad.join("\n  - ")}` : ""}`);
    }
  }

  // Every case folder belongs to one group below; the last scenario checks that none is left out.
  const GROUPS = {
    kinds: ["stale", "skill-allowlist", "blocked-release", "agent-capability"],
    adapterRefused: ["bad-adapter", "interpreter-flags", "remote-launcher"],
    answerRefused: ["access-in-brief", "access-in-gap", "access-in-summary", "blank-brief", "unknown-evidence-id", "security-prohibitions"],
    reply: ["plain-wait", "no-retry-lead", "repeat-in-facts", "retry-in-facts", "retry-text-unflagged"],
    staleUnknown: ["stale-no-deploy", "stale-assertive", "stale-owner-mixed"],
    untrustedInput: ["injection", "loose-pattern", "secret-param"],
  };

  // The four kinds the plan names, each as one case: an error older than the release, a skill that tells the agent to do
  // something the allow-list refuses, a question about access instead of a fix of the tool, a product fix without a skill change.
  scenario("incident-triage-kinds", "incident-triage over the four synthetic kinds: an error older than the release (stale), a skill the allow-list contradicts (product-bug citing both), a blocked release that needs a better product report and no access request (missing-tool), and a product fix with a second package for the agent skill (agent-capability, Claude classifier)", async (t) => {
    await runCases(t, GROUPS.kinds);
  });

  scenario("incident-triage-adapter-refused", "incident-triage refuses an unsafe adapter before anything runs: no revision, no collector (shell -c with a placeholder, a placeholder inside other text, a skill without an allow-list, combined or abbreviated code flags, launchers, code subcommands)", async (t) => {
    await runCases(t, GROUPS.adapterRefused);
  });

  scenario("incident-triage-answer-refused", "incident-triage refuses a classifier answer that asks for access, has a blank fix brief or cites an unknown evidence id, keeps access wording in the model's wording section only, and accepts prohibitions", async (t) => {
    await runCases(t, GROUPS.answerRefused);
  });

  scenario("incident-triage-reply", "the reply to the reporter and the line for the lead are the workflow's own: a retry appears only when the adapter documents one and the answer recommends it, model text stays under the wording heading", async (t) => {
    await runCases(t, GROUPS.reply);
  });

  scenario("incident-triage-stale-unknown", "stale without evidence that the environment runs the fixing release becomes unknown, with the whole assertive answer dropped, also next to an owner decision; failed, skipped, timed-out and refused reads are recorded", async (t) => {
    await runCases(t, GROUPS.staleUnknown);
  });

  scenario("incident-triage-untrusted-input", "a report that instructs the classifier changes nothing (same prompt, plan and verdict as a plain one), and an operation argument that passes a loose pattern still never reaches a shell, a prompt or a file when it holds shell characters or a secret", async (t) => {
    await runCases(t, GROUPS.untrustedInput);
  });

  scenario("incident-triage-runs", "incident-triage keeps revisions and the lock: a second run makes rev-2 and leaves rev-1 as it was, a held lock refuses a run, a gateway failure marks the revision failed and releases the lock, and a failed pointer that is not verified keeps the lock", async (t) => {
    // revisions
    const first = await runCase(t, "stale");
    const before = Object.fromEntries(["evidence.json", "classification.json", "draft.md", "adapterHash"].map((f) => [f, sha(fs.readFileSync(`${first.tmp}/rev-1/${f}`))]));
    const second = await runCase(t, "stale", { tmp: first.tmp });
    t.eq(second.result.revision, 2, "the second run in the same folder gets revision 2");
    t.eq(Object.entries(before).filter(([f, h]) => sha(fs.readFileSync(`${first.tmp}/rev-1/${f}`)) !== h).map(([f]) => f), [], "rev-1 is left as it was");
    const inc = JSON.parse(fs.readFileSync(`${first.tmp}/incident.json`, "utf8"));
    t.ok(inc.revision === 2 && inc.revisions.length === 2 && inc.revisions.every((x) => x.state === "drafted"), `incident.json lists both revisions as drafted: ${JSON.stringify(inc)}`);
    fs.mkdirSync(`${first.tmp}/.lock`);
    const third = await runCase(t, "stale", { tmp: first.tmp });
    t.ok(third.result.refused && /locked/.test(third.result.refused[0]), `a held lock refuses the run: ${JSON.stringify(third.result.refused)}`);
    t.ok(!fs.existsSync(`${first.tmp}/rev-3`), "a locked run makes no rev-3");

    // an infrastructure failure at Classify: the revision is marked failed, nothing is drafted, the lock is released
    const down = await runCase(t, "stale", { failClassify: true });
    t.ok(down.result.state === "failed" && /^classify/.test(down.result.stoppedAt || ""), `state ${down.result.state}, stoppedAt ${down.result.stoppedAt}`);
    const downInc = JSON.parse(readIf(`${down.tmp}/incident.json`) || "{}");
    t.ok(downInc.state === "failed" && downInc.revision === 1, `incident.json says failed: ${JSON.stringify(downInc)}`);
    t.ok(!fs.existsSync(`${down.tmp}/rev-1/draft.md`), "no draft was written");
    t.ok(!fs.existsSync(`${down.tmp}/.lock`), "the lock was released");

    // a failed revision whose failed pointer is not verified (the runner left the file out, or reported another hash):
    // the lock stays, the result says so, and no unlock step runs
    for (const fault of ["omit", "badhash"]) {
      const run = await runCase(t, "stale", { failClassify: true, faultCleanup: fault });
      const r = run.result;
      t.ok(fs.existsSync(`${run.tmp}/.lock`), `${fault}: the lock stays because incident.json was not verified as failed`);
      t.ok(!run.ctx.prompts.some((p) => p.label.startsWith("unlock ")), `${fault}: no unlock step ran`);
      t.ok(/not verified as failed/.test(r.persistError || ""), `${fault}: persistError ${JSON.stringify(r.persistError)}`);
      t.ok(/kept/.test(r.lockLeft || ""), `${fault}: lockLeft ${JSON.stringify(r.lockLeft)}`);
      t.eq(r.state, "failed", `${fault}: state failed`);
    }
  });

  scenario("incident-triage-cases-covered", "every case folder of scripts/e2e/fixtures/incident-triage/cases is run by one of the incident-triage scenarios, and every name a scenario runs is a case folder", async (t) => {
    const folders = fs.readdirSync(CASES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    t.eq(folders.filter((n) => !fs.existsSync(path.join(CASES, n, "case.json")) && !fs.existsSync(path.join(CASES, n, "adapter.json"))), [], "no folder is empty of a case and an adapter");
    const withCase = folders.filter((n) => fs.existsSync(path.join(CASES, n, "case.json")));
    const used = Object.values(GROUPS).flat().sort();
    t.eq(withCase.filter((n) => !used.includes(n)), [], "no case with a case.json is left out of the scenarios");
    t.eq(used.filter((n) => !withCase.includes(n)), [], "no scenario names a case that does not exist");
    t.eq(new Set(used).size, used.length, "no case is listed twice");
    t.ok(used.length >= 20, `${used.length} cases`);
  });
}
