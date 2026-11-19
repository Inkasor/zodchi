// incident-triage: the synthetic cases of scripts/e2e/fixtures/incident-triage/cases, run through the real workflow.
//
// The body of core/workflows/incident-triage.js runs the way Claude Code runs it (an async function of args, agent, phase, log, ...)
// with a fake agent. The fake does what each runner step's prompt asks, for real, in a temporary incident folder: every file step is one
// command of the helper (core/scripts/gate.mjs incident-open, incident-collect, incident-publish, incident-fail, incident-unlock), which the
// fake runs for real and whose printed line it returns as the runner would. So the lock is taken, the revision's files are generated, the
// collector runs with node (the evidence is collected for real from the synthetic product of fixtures/incident-triage/product.mjs) and
// the draft is published by the helper itself. Only the model and the gate helper are scripted: the classifier's answer is the case's
// classification.json, written to the answer file as the gateway would (a Codex candidate) or as a Claude subagent would (when the case's
// role table has only Claude), and the gate step prints the line core/scripts/gate.mjs would print (its own checks are in workflow-gate.mjs).
// Each case folder holds case.json: { about, report, params, models?, adapterFrom?, twinReport?, expect }; the keys of expect are read
// by verify() below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT }) {
  const WORKFLOW = path.join(ROOT, "core", "workflows", "incident-triage.js");
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
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

  /** The fake acts only on what the prompt says: a missing instruction fails the scenario (and the step does nothing). */
  const quote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
  function need(t, prompt, label, needle, what) {
    const ok = prompt.includes(needle);
    t.ok(ok, `the prompt of the step "${label}" no longer holds ${what}: ${needle.length > 160 ? needle.slice(0, 160) + "..." : needle}`);
    if (!ok) throw new Error(`the prompt of the step "${label}" lacks ${what}`);
  }
  const needField = (t, opts, label, field) => {
    const ok = Boolean(opts.schema && opts.schema.properties && opts.schema.properties[field] && (opts.schema.required || []).includes(field));
    t.ok(ok, `the schema of the step "${label}" does not require the field ${field}`);
    if (!ok) throw new Error(`the schema of the step "${label}" does not require ${field}`);
  };
  /** Preloaded code of a traced helper run: it logs the name (and, for incident.json, the state) of every file moved into place. */
  const TRACE_PRELOAD = String.raw`const fs = require("fs"), log = process.env.ZODCHI_TRACE, rn = fs.renameSync; fs.renameSync = function (a, b) { let s = ""; if (/incident\.json$/.test(b)) { try { s = ":" + JSON.parse(fs.readFileSync(a, "utf8")).state; } catch { /* not a record */ } } fs.appendFileSync(log, String(b).replace(/\\/g, "/").split("/").pop() + s + "\n"); return rn.apply(this, arguments); }; process.argv.splice(1, 0, process.env.ZODCHI_GATE); import(require("url").pathToFileURL(process.env.ZODCHI_GATE).href);`;
  /**
   * A helper step: the prompt holds ONE command of the bootstrap with the expected helper command and a spec for this incident folder; the
   * runner runs it and returns its exit code and the line it printed. The fake runs gate.mjs of this checkout with that spec (the bootstrap
   * itself is checked in workflow-gate.mjs) and returns what it printed, as it is.
   */
  function helperStep(t, ctx, prompt, opts, label, command, retype = (spec) => spec) {
    need(t, prompt, label, "Run ONE command and return what it printed", "the instruction to run one command and return its output");
    need(t, prompt, label, "copy it unchanged", "the instruction to return the printed line unchanged");
    need(t, prompt, label, "never touch the incident folder or its lock yourself", "the rule that the runner touches no file itself");
    for (const fld of ["exitCode", "stdout"]) needField(t, opts, label, fld);
    t.ok((prompt.match(/node -e /g) || []).length === 1, `the step "${label}" runs one command`);
    const m = prompt.match(/ -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" ([a-z-]+) '((?:[^']|'\\'')*)'\n/);
    t.ok(Boolean(m) && m[1] === command, `the step "${label}" runs the helper command ${command} (${m ? m[1] : "none"})`);
    if (!m || m[1] !== command) throw new Error(`the step "${label}" does not run ${command}`);
    const spec = JSON.parse(m[2].replace(/'\\''/g, "'"));
    t.ok(spec.api === 1 && spec.tmp === ctx.tmp && spec.incident === ctx.incident, `the step "${label}" names this incident folder and incident`);
    // retype: a fault of the runner, which typed the command with a value changed (the workflow's spec is what the prompt holds).
    // The publish command is run with a trace of the files it moves into place (in order), to check the order of the publish.
    const traced = command === "incident-publish";
    const traceFile = path.join(ctx.tmp, "..", `trace-${path.basename(ctx.tmp)}.log`);
    const r = traced
      ? spawnSync(process.execPath, ["-e", TRACE_PRELOAD, command, JSON.stringify(retype(spec))], { encoding: "utf8", windowsHide: true, env: { ...process.env, ZODCHI_TRACE: traceFile, ZODCHI_GATE: GATE } })
      : spawnSync(process.execPath, [GATE, command, JSON.stringify(retype(spec))], { encoding: "utf8", windowsHide: true });
    if (traced) { ctx.publishRan = true; try { ctx.publishOrder = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean); fs.rmSync(traceFile, { force: true }); } catch { ctx.publishOrder = []; } }
    return { spec, answer: { exitCode: r.status ?? -1, stdout: r.stdout || "", error: (r.stderr || "").slice(0, 300) } };
  }

  function fakeAgent(ctx) {
    return async (prompt, opts = {}) => {
      const label = opts.label || "";
      ctx.prompts.push({ label, prompt, opts });
      const { tmp, t } = ctx;
      if (label.startsWith("gate ")) {
        // The helper's one line, as the runner would return it (what the helper prints is checked in workflow-gate.mjs).
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, roles: CODEX_TABLE, modelsErrors: [], account: ACCOUNT, accountError: "", ignoreExit: 0 }) + "\n", error: "" };
      }
      if (label.startsWith("open ")) {
        const { spec, answer } = helperStep(t, ctx, prompt, opts, label, "incident-open");
        t.ok(spec.adapter === ctx.adapter, `the step "${label}" names the adapter`);
        return answer;
      }
      if (label.startsWith("collect ")) {
        const { spec, answer } = helperStep(t, ctx, prompt, opts, label, "incident-collect", ctx.retypeCollect || undefined);
        for (const k of ["token", "revision", "adapterSha256", "report", "classifier"]) t.ok(spec[k] !== undefined && spec[k] !== "", `the step "${label}" hands the helper ${k}`);
        ctx.revDir = `${tmp}/rev-${spec.revision}`;
        ctx.collector = readIf(`${ctx.revDir}/collect.cjs`);
        return answer;
      }
      if (label.startsWith("classify ")) {
        if (ctx.failClassify) return { ok: false, infra: "the gateway created no job (mock)", unknownKey: "" };
        const text = fs.readFileSync(path.join(ctx.caseDir, "classification.json"), "utf8");
        const revDir = ctx.revDir; // the revision folder the collect step made
        t.ok(Boolean(revDir), `the step "${label}" ran before any collect step`);
        if (!revDir) throw new Error("no revision folder");
        const rawFile = `${revDir}/classification.raw.json`;
        if (opts.agentType === "zodchi-core:runner") {
          // The gateway path: the gateway writes the answer to the --out file; the runner reports how the job ended, never the file.
          need(t, prompt, label, "zodchi run --role", "the gateway command");
          need(t, prompt, label, "in the foreground", "the rule to wait in the foreground");
          need(t, prompt, label, `--prompt ${quote(`${revDir}/classify-prompt.md`)}`, "the generated classification request (--prompt)");
          need(t, prompt, label, `--attach ${quote(`${revDir}/evidence.json`)}`, "the evidence attachment");
          need(t, prompt, label, `--out ${quote(rawFile)}`, "the answer file (--out)");
          need(t, prompt, label, "Do not open, copy or return the answer file", "the rule that the runner never retells the answer");
          for (const fld of ["ok", "infra"]) needField(t, opts, label, fld);
          t.ok(!(opts.schema.properties || {}).answer, `the step "${label}" asks for no answer text`);
          fs.writeFileSync(rawFile, text);
          ctx.classifier = "codex/" + (prompt.match(/--model (\S+)/) || [])[1];
          return { ok: true, infra: "", unknownKey: "" };
        }
        // A Claude subagent: it reads the frame, the schema, the request and the evidence, runs nothing and writes its own answer file.
        need(t, prompt, label, "with the Read tool", "the instruction to read the files");
        need(t, prompt, label, `${revDir}/classifier/incident-classify.md`, "the frame file");
        need(t, prompt, label, `${revDir}/classifier/incident-classify.schema.json`, "the schema file");
        need(t, prompt, label, `${revDir}/classify-prompt.md`, "the generated classification request");
        need(t, prompt, label, `${revDir}/evidence.json`, "the evidence file");
        need(t, prompt, label, "Run no command", "the rule to run nothing");
        need(t, prompt, label, `with the Write tool to ${rawFile}`, "the answer file it writes");
        t.ok(Boolean(opts.schema) && Boolean(opts.model), `the step "${label}" gives the Claude classifier no schema or model`);
        fs.writeFileSync(rawFile, text);
        ctx.classifier = `claude/${opts.model}`;
        return { written: true };
      }
      if (label.startsWith("mark failed ")) {
        // Fault injection: a runner that never ran the command, or one that changed the line it returns (a hash retyped).
        if (ctx.faultCleanup === "omit") return { exitCode: -1, stdout: "", error: "" };
        const { spec, answer } = helperStep(t, ctx, prompt, opts, label, "incident-fail");
        t.ok(Number.isInteger(spec.revision) && /^[0-9a-f]{16,}$/.test(spec.token), `the step "${label}" names the revision and the lock token`);
        if (ctx.faultCleanup === "badhash") return { ...answer, stdout: answer.stdout.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${"0".repeat(64)}"`) };
        return answer;
      }
      if (label.startsWith("publish ")) return helperStep(t, ctx, prompt, opts, label, "incident-publish").answer;
      if (label.startsWith("unlock ")) return helperStep(t, ctx, prompt, opts, label, "incident-unlock").answer;
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
    const ctx = { t, tmp, adapter, caseDir, incident: `case-${name}`, prompts: [], failClassify: Boolean(overrides.failClassify), faultCleanup: overrides.faultCleanup || "", retypeCollect: overrides.retypeCollect || null };
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
    // Publish order: classification and the intermediate pointer come before draft.md and the final pointer.
    if (ctx.publishRan && !(ctx.publishOrder || []).length) bad.push("the publish step ran but its trace of files moved into place is empty or unreadable");
    if (ctx.publishOrder && ctx.publishOrder.length) {
      const seen = ctx.publishOrder.filter((x) => /^(classification\.json|draft\.md|incident\.json:.*)$/.test(x));
      const i = (x) => seen.indexOf(x);
      const mid = seen.findIndex((x) => x.startsWith("incident.json:"));
      if (i("classification.json") < 0 || i("draft.md") < 0 || i("classification.json") > i("draft.md")) bad.push(`publish order ${JSON.stringify(seen)}: classification.json must come before draft.md`);
      if (mid < 0 || mid > i("draft.md")) bad.push(`publish order ${JSON.stringify(seen)}: the intermediate incident.json pointer must be written before draft.md`);
      const fin = `incident.json:${r.state}`;
      if (["drafted", "needs-evidence"].includes(r.state)) {
        if (i(fin) >= 0 && i(fin) < i("draft.md")) bad.push(`publish order ${JSON.stringify(seen)}: ${r.state} was written before draft.md`);
        if (seen[seen.length - 1] !== fin) bad.push(`publish order ${JSON.stringify(seen)}: the final ${r.state} pointer must come last, after draft.md`);
      }
    }
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
  // something the allow-list refuses, a question about access instead of a fix of the tool, a product fix with a second package for the agent skill.
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
    const snapshot = (dir) => Object.fromEntries(filesUnder(dir).map((f) => [slash(path.relative(dir, f)), sha(fs.readFileSync(f))]).sort(([a], [b]) => (a < b ? -1 : 1)));
    const before = snapshot(`${first.tmp}/rev-1`);
    for (const f of ["evidence.json", "classification.json", "draft.md", "adapterHash"]) t.ok(f in before, `rev-1 holds ${f} before the second run: ${Object.keys(before).join(", ")}`);
    const second = await runCase(t, "stale", { tmp: first.tmp });
    t.eq(second.result.revision, 2, "the second run in the same folder gets revision 2");
    t.eq(snapshot(`${first.tmp}/rev-1`), before, "rev-1 is left as it was: the same files with the same sha256, none added, removed or changed");
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

    // a failed revision whose failed pointer is not verified (the runner did not run the helper, or changed the line it printed):
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

  scenario("incident-triage-incident-record", "an incident.json that exists is a record or a refusal: one holding \"\" (what a runner once returned for a missing file) refuses the run and starts no revision; a lock held by another run's token is never taken over", async (t) => {
    for (const [what, text] of [["\"\"", "\"\""], ["an empty file", ""], ["not JSON", "{"], ["another incident", JSON.stringify({ id: "other", revision: 1, state: "drafted", adapterHash: "", revisions: [{ n: 1, state: "drafted" }] })]]) {
      const tmp = slash(fs.mkdtempSync(path.join(os.tmpdir(), "incident-triage-record-")));
      t.cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      fs.writeFileSync(`${tmp}/incident.json`, text);
      const run = await runCase(t, "stale", { tmp });
      t.ok(Array.isArray(run.result.refused) && /incident\.json/.test(run.result.refused[0]), `${what}: the run is refused (${JSON.stringify(run.result.refused)})`);
      t.ok(!fs.readdirSync(tmp).some((n) => /^rev-/.test(n)) && !run.ctx.prompts.some((p) => /^collect /.test(p.label)), `${what}: no revision was started`);
      t.eq(readIf(`${tmp}/incident.json`), text, `${what}: incident.json is left as it was`);
      t.ok(!fs.existsSync(`${tmp}/.lock`), `${what}: the lock this run took is released`);
    }
    // A record of this incident whose state or history is not one of the documented states, or whose revision numbers are not whole numbers
    // from 1, is refused the same way: no revision, and the file is not replaced (its malformed history is not carried on).
    const rec = (over) => JSON.stringify({ id: "case-stale", revision: 1, state: "drafted", adapterHash: "", revisions: [{ n: 1, state: "drafted" }], ...over });
    for (const [what, text] of [
      ["an unknown state", rec({ state: "done" })],
      ["a history entry without a state", rec({ revisions: [{ n: 1 }] })],
      ["a history entry with an unknown state", rec({ revisions: [{ n: 1, state: "weird" }] })],
      ["revision 0", rec({ revision: 0, revisions: [{ n: 0, state: "drafted" }] })],
      ["a history entry that is not an object", rec({ revisions: [1] })],
    ]) {
      const tmp = slash(fs.mkdtempSync(path.join(os.tmpdir(), "incident-triage-record-")));
      t.cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      fs.writeFileSync(`${tmp}/incident.json`, text);
      const run = await runCase(t, "stale", { tmp });
      t.ok(Array.isArray(run.result.refused) && /incident\.json/.test(run.result.refused[0]), `${what}: the run is refused (${JSON.stringify(run.result.refused)})`);
      t.ok(!fs.readdirSync(tmp).some((n) => /^rev-/.test(n)) && !run.ctx.prompts.some((p) => /^collect /.test(p.label)), `${what}: no revision was started`);
      t.eq(readIf(`${tmp}/incident.json`), text, `${what}: incident.json is left as it was`);
    }
  });

  scenario("incident-triage-collect-inputs", "a runner that types the collect command with another operation value (one that still matches its pattern), another report, another withheld decision or another classifier gets a refusal from the helper: no revision folder, no operation run, nothing classified, the revision marked failed", async (t) => {
    for (const [what, retype] of [
      ["another job id that matches its pattern", (spec) => ({ ...spec, params: { ...spec.params, id: "4712" } })],
      ["a report without its last character", (spec) => ({ ...spec, report: spec.report.slice(0, -1) })],
      ["a withheld decision added", (spec) => ({ ...spec, withheld: { id: { kind: "shell", fails: [] } } })],
      ["another classifier effort", (spec) => ({ ...spec, classifier: { ...spec.classifier, effort: "low" } })],
    ]) {
      const run = await runCase(t, "stale", { retypeCollect: retype });
      const r = run.result;
      t.ok(/^facts \(.*inputSha256 differs/.test(r.stoppedAt || ""), `${what}: the helper refuses (${r.stoppedAt})`);
      t.ok(!fs.existsSync(`${run.tmp}/rev-1`) && !run.ctx.collector, `${what}: no revision folder was made and no collector was written or run`);
      t.ok(!run.ctx.prompts.some((p) => /^classify /.test(p.label)), `${what}: nothing was classified`);
      t.eq((JSON.parse(readIf(`${run.tmp}/incident.json`) || "{}")).state, "failed", `${what}: the revision is marked failed`);
      t.ok(!fs.existsSync(`${run.tmp}/.lock`), `${what}: the lock was released`);
    }
    const plain = await runCase(t, "stale");
    const m = plain.ctx.prompts.find((p) => /^collect /.test(p.label)).prompt.match(/ incident-collect '((?:[^']|'\'')*)'\n/);
    const spec = JSON.parse(m[1].replace(/'\''/g, "'"));
    t.ok(/^[0-9a-f]{64}$/.test(spec.inputSha256) && plain.result.state === "drafted", "the command carries the digest of its inputs, and a run typed exactly goes through");
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
