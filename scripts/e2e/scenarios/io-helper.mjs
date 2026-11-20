// The file commands of the helper (core/scripts/gate.mjs, implemented in core/scripts/io.mjs), run for real on scratch folders: the
// incident commands of incident-triage (open, collect, publish, fail, unlock) and the brief commands of design-brief (inspect, preflight,
// review-read). Every file those workflows read or write goes through them; a runner only runs the command and returns the printed line,
// whose lineSha256 the workflow checks. Here: the lock (taken, busy, broken only when asked, held by a token), presence of incident.json
// apart from its content, the adapter's hash, a collector run with a failing and a refusing operation, the answer file's hash, the screen
// of a public brief with a secret-shaped value and a machine path, and that nothing is written outside the folder a command was given.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
  /** The canonical JSON (sorted keys) the workflow hashes for inputSha256 of incident-collect. */
  const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v === undefined ? null : v));
  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-io-${name}-`)).replace(/\\/g, "/");
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  /** One command of the helper: its exit code, the parsed line, and whether lineSha256 is the SHA-256 of the rest of the line. */
  const io = (t, command, spec) => {
    const r = spawnSync(process.execPath, [GATE, command, JSON.stringify({ api: 1, ...spec })], { encoding: "utf8", windowsHide: true });
    t.log(`gate.mjs ${command}: exit ${r.status}\n${r.stdout.slice(0, 1500)}${r.stderr}`);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* checked below */ }
    t.ok(r.status === 0 && json && r.stdout.trim().split("\n").length === 1, `${command}: exit 0 and one line of JSON`);
    const { lineSha256, ...rest } = json;
    t.ok(lineSha256 === sha(JSON.stringify(rest)), `${command}: lineSha256 is the SHA-256 of the rest of the line`);
    t.ok(json.api === 1 && json.plugin && json.plugin.root, `${command}: the line names its api and plugin copy`);
    return json;
  };
  /** The publish run with a trace of the files moved into place, in order (incident.json with its state). */
  const TRACE_PRELOAD = String.raw`const fs = require("fs"), log = process.env.ZODCHI_TRACE, rn = fs.renameSync; fs.renameSync = function (a, b) { let s = ""; if (/incident\.json$/.test(b)) { try { s = ":" + JSON.parse(fs.readFileSync(a, "utf8")).state; } catch { /* not a record */ } } fs.appendFileSync(log, String(b).replace(/\\/g, "/").split("/").pop() + s + "\n"); return rn.apply(this, arguments); }; process.argv.splice(1, 0, process.env.ZODCHI_GATE); import(require("url").pathToFileURL(process.env.ZODCHI_GATE).href);`;
  const tracedPublish = (t, spec, traceFile) => {
    const r = spawnSync(process.execPath, ["-e", TRACE_PRELOAD, "incident-publish", JSON.stringify({ api: 1, ...spec })], { encoding: "utf8", windowsHide: true, env: { ...process.env, ZODCHI_TRACE: traceFile, ZODCHI_GATE: GATE } });
    t.log(`traced incident-publish: exit ${r.status}\n${r.stdout.slice(0, 600)}${r.stderr}`);
    return { json: JSON.parse(r.stdout), order: fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean) : [] };
  };
  /** Every file under a folder, relative, sorted. */
  const listing = (dir) => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).replace(/\\/g, "/")); } };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
  };

  /** A synthetic product: one operation that answers, one that fails, one the product refuses. */
  function product(dir) {
    fs.mkdirSync(`${dir}/product`, { recursive: true });
    fs.writeFileSync(`${dir}/product/ok.js`, "console.log('status: running, job ' + process.argv[2])\n");
    fs.writeFileSync(`${dir}/product/fail.js`, "console.error('boom: the log store is down'); process.exit(3)\n");
    fs.writeFileSync(`${dir}/product/refuse.js`, "console.error('permission denied: not in the allow-list'); process.exit(1)\n");
    const adapter = {
      adapterVersion: 1, product: "Example Shop", owner: "product owner",
      operations: {
        job: { description: "the job by id", provides: ["job", "status"], argv: ["node", "ok.js", "{id}"], args: { id: "[0-9]{1,9}" } },
        logs: { description: "the logs", provides: ["logs"], argv: ["node", "fail.js"] },
        config: { description: "the config", provides: ["config"], argv: ["node", "refuse.js"] },
      },
    };
    const text = JSON.stringify(adapter, null, 2) + "\n";
    fs.writeFileSync(`${dir}/product/adapter.json`, text);
    return { adapter: `${dir}/product/adapter.json`, adapterSha: sha(Buffer.from(text, "utf8")) };
  }

  scenario("io-helper-incident-lock", "incident-open takes the lock with a token, reports a held lock as busy and leaves it, breaks it only when asked and says so, tells a missing incident.json from one that is not a record (\"\" included), and hashes the adapter; unlock needs the token", async (t) => {
    const dir = scratch(t, "lock");
    const { adapter, adapterSha } = product(dir);
    const tmp = `${dir}/inc`;
    const first = io(t, "incident-open", { tmp, incident: "i1", adapter });
    t.eq([first.ok, first.locked, first.lockBroken], [true, true, false], "the lock is taken");
    t.ok(/^[0-9a-f]{24}$/.test(first.token) && fs.existsSync(`${tmp}/.lock/owner`), "with a token kept in the lock");
    t.eq([first.incident.present, first.incident.valid, first.revs], [false, true, []], "no incident.json: not present, and nothing to refuse");
    t.eq([first.adapter.readable, first.adapter.sha256, first.adapter.problems], [true, adapterSha, []], "the adapter's hash is the SHA-256 of its bytes, and it passes the check");
    t.eq(first.adapter.argPatterns, { job: { id: "[0-9]{1,9}" } }, "the argument patterns come back for the workflow's own checks");
    const busy = io(t, "incident-open", { tmp, incident: "i1", adapter });
    t.eq([busy.ok, busy.locked, busy.busy], [true, false, true], "a held lock: busy, not taken");
    t.ok(fs.readFileSync(`${tmp}/.lock/owner`, "utf8").includes(first.token), "and left as it was");
    const wrong = io(t, "incident-unlock", { tmp, incident: "i1", token: "0".repeat(24) });
    t.ok(wrong.ok === false && /another run/.test(wrong.error) && fs.existsSync(`${tmp}/.lock`), "unlock with another token is refused; the lock stays");
    const broken = io(t, "incident-open", { tmp, incident: "i1", adapter, breakLock: true });
    t.eq([broken.locked, broken.lockBroken], [true, true], "breakLock takes it over and says so");
    t.ok(broken.token !== first.token, "with a new token");
    const stale = io(t, "incident-unlock", { tmp, incident: "i1", token: first.token });
    t.ok(stale.ok === false && fs.existsSync(`${tmp}/.lock`), "the run whose lock was broken can no longer remove it");
    t.eq(io(t, "incident-unlock", { tmp, incident: "i1", token: broken.token }).removed, true, "the holder removes it");
    t.ok(!fs.existsSync(`${tmp}/.lock`), "and it is gone");

    for (const [what, text] of [["\"\"", "\"\""], ["empty", ""], ["not JSON", "{"], ["a string", "\"x\""], ["another incident", JSON.stringify({ id: "i2", revision: 1, state: "drafted", revisions: [{ n: 1, state: "drafted" }] })],
      ["an unknown state", JSON.stringify({ id: "i1", revision: 1, state: "done", revisions: [{ n: 1, state: "drafted" }] })],
      ["a history entry without a state", JSON.stringify({ id: "i1", revision: 1, state: "drafted", revisions: [{ n: 1 }] })],
      ["a history entry with an unknown state", JSON.stringify({ id: "i1", revision: 1, state: "drafted", revisions: [{ n: 1, state: "odd" }] })],
      ["revision 0", JSON.stringify({ id: "i1", revision: 0, state: "drafted", revisions: [{ n: 0, state: "drafted" }] })],
      ["a revision beyond the safe integers", JSON.stringify({ id: "i1", revision: 2 ** 60, state: "drafted", revisions: [] })]]) {
      fs.writeFileSync(`${tmp}/incident.json`, text);
      const r = io(t, "incident-open", { tmp, incident: "i1", adapter });
      t.eq([r.locked, r.incident.present, r.incident.valid], [true, true, false], `incident.json holding ${what}: present and not a record`);
      t.ok(/incident\.json/.test(r.incident.error), `with the reason (${r.incident.error})`);
      io(t, "incident-unlock", { tmp, incident: "i1", token: r.token });
    }
    fs.writeFileSync(`${tmp}/incident.json`, JSON.stringify({ id: "i1", revision: 2, state: "drafted", adapterHash: adapterSha, revisions: [{ n: 1, state: "drafted" }, { n: 2, state: "drafted" }] }));
    fs.mkdirSync(`${tmp}/rev-1`); fs.mkdirSync(`${tmp}/rev-3`);
    const rec = io(t, "incident-open", { tmp, incident: "i1", adapter: `${dir}/product/missing.json` });
    t.eq([rec.incident.valid, rec.incident.revision, rec.revs], [true, 2, [1, 3]], "a valid record and the revision folders are reported");
    t.eq(rec.adapter.readable, false, "a missing adapter is not readable, said apart");
    io(t, "incident-unlock", { tmp, incident: "i1", token: rec.token });
    const bad = io(t, "incident-open", { tmp: "relative/inc", incident: "i1", adapter });
    t.ok(bad.ok === false && /absolute/.test(bad.error) && !fs.existsSync(path.join(process.cwd(), "relative")), "a relative folder is refused and nothing is made");
  });

  scenario("io-helper-incident-link", "incident.json that is a link (dangling or not) or not a regular file is refused with a reason, never read as missing and never replaced", async (t) => {
    const dir = scratch(t, "link");
    const { adapter } = product(dir);
    const tmp = `${dir}/inc`;
    fs.mkdirSync(tmp, { recursive: true });
    const link = (target, file) => {
      try { fs.symlinkSync(target, file, "file"); return true; } catch { /* no right to make links */ }
      return false;
    };
    const mine = io(t, "incident-open", { tmp, incident: "i1", adapter });
    t.eq([mine.incident.present, mine.incident.valid], [false, true], "no incident.json: absent, as before");
    io(t, "incident-unlock", { tmp, incident: "i1", token: mine.token });
    if (!link(`${dir}/nowhere.json`, `${tmp}/incident.json`)) {
      t.log("the dangling link case is skipped: this OS refused to create a symbolic link (no right to make links)");
    } else {
      const r = io(t, "incident-open", { tmp, incident: "i1", adapter });
      t.eq([r.incident.present, r.incident.valid], [true, false], "a dangling incident.json link is present and not valid, not missing");
      t.ok(/link/.test(r.incident.error), `with a clear reason (${r.incident.error})`);
      t.ok(fs.lstatSync(`${tmp}/incident.json`).isSymbolicLink(), "and the link is left as it was");
      io(t, "incident-unlock", { tmp, incident: "i1", token: r.token });
      fs.rmSync(`${tmp}/incident.json`, { force: true });
      fs.writeFileSync(`${dir}/real.json`, JSON.stringify({ id: "i1", revision: 1, state: "drafted", revisions: [{ n: 1, state: "drafted" }] }));
      if (link(`${dir}/real.json`, `${tmp}/incident.json`)) {
        const r2 = io(t, "incident-open", { tmp, incident: "i1", adapter });
        t.eq([r2.incident.present, r2.incident.valid], [true, false], "a link to a valid record is refused too");
        io(t, "incident-unlock", { tmp, incident: "i1", token: r2.token });
      }
    }
    fs.rmSync(`${tmp}/incident.json`, { force: true });
    fs.mkdirSync(`${tmp}/incident.json`);
    const d = io(t, "incident-open", { tmp, incident: "i1", adapter });
    t.eq([d.incident.present, d.incident.valid], [true, false], "incident.json that is a folder is present and not valid");
    t.ok(/regular file/.test(d.incident.error), `with a clear reason (${d.incident.error})`);
  });

  scenario("io-helper-incident-collect-publish", "incident-collect writes the revision's files itself and runs the collector once (a failing and a refusing operation are results), incident-publish reads the answer file with its hash and writes the classification and the draft; nothing is written outside the incident folder", async (t) => {
    const dir = scratch(t, "collect");
    const { adapter, adapterSha } = product(dir);
    const tmp = `${dir}/inc`;
    const open = io(t, "incident-open", { tmp, incident: "i1", adapter });
    const report = "Job 4711 failed at night. token: [REDACTED]";
    const inputs = { incident: "i1", revision: 1, report, params: { id: "4711" }, withheld: {}, classifier: { model: "m", effort: "high" } };
    const base = { tmp, adapter, adapterSha256: adapterSha, ...inputs, inputSha256: sha(Buffer.from(canon(inputs), "utf8")) };
    const refusedToken = io(t, "incident-collect", { ...base, token: "f".repeat(24) });
    t.ok(refusedToken.ok === false && !fs.existsSync(`${tmp}/rev-1`), "without the lock's token nothing is written");
    const outside = listing(dir).filter((f) => !f.startsWith("inc/"));
    for (const [what, wrong] of [["another job id that matches its pattern", { params: { id: "4712" } }], ["no digest", { inputSha256: undefined }], ["another report", { report: `${report}.` }], ["a withheld value", { withheld: { id: { kind: "shell", fails: [] } } }]]) {
      const x = io(t, "incident-collect", { ...base, token: open.token, ...wrong });
      t.ok(x.ok === false && /inputSha256 differs/.test(x.error) && !fs.existsSync(`${tmp}/rev-1`) && !fs.existsSync(`${tmp}/incident.json`), `${what}: refused before anything is made or run`);
    }
    const c = io(t, "incident-collect", { ...base, token: open.token });
    t.eq(c.ok, true, `the collector ran (${c.error || ""})`);
    t.eq(c.reportSha256, sha(Buffer.from(report, "utf8")), "reportSha256 is the hash of the report the helper got");
    for (const [name, hash] of Object.entries(c.files)) {
      const file = name === "incident.json" ? `${tmp}/incident.json` : `${tmp}/rev-1/${name}`;
      t.eq(sha(fs.readFileSync(file)), hash, `${name}: written with the hash it reports`);
    }
    t.ok(["adapterHash", "collect.cjs", "classify-prompt.md", "classifier/incident-classify.md", "classifier/incident-classify.schema.json", "classifier/incident-classify.json"].every((n) => n in c.files), "every generated file of the revision");
    t.eq(JSON.parse(fs.readFileSync(`${tmp}/incident.json`, "utf8")).state, "collecting", "incident.json points to the revision being collected");
    const outcomes = Object.fromEntries(c.evidence.items.map((i) => [i.source, i.outcome]));
    t.eq(outcomes, { report: "ok", "op:job": "ok", "op:logs": "failed", "op:config": "refused" }, "a failing and a refusing operation are recorded, and the others went on");
    t.eq(c.evidence.sha256, sha(fs.readFileSync(`${tmp}/rev-1/evidence.json`)), "the bundle's hash is the file's");
    t.ok(fs.readFileSync(`${tmp}/rev-1/collect.out`, "utf8").includes(c.evidence.sha256), "collect.out is kept, written by the helper");
    t.eq(listing(dir).filter((f) => !f.startsWith("inc/")), outside, "nothing was written outside the incident folder");
    const again = io(t, "incident-collect", { ...base, token: open.token });
    t.ok(again.ok === false && /never reused/.test(again.error), "a revision folder is never made twice");

    // publish: no answer yet, then an answer file
    const pub = { tmp, incident: "i1", adapter, adapterSha256: adapterSha, evidenceSha256: c.evidence.sha256, revision: 1, token: open.token, classifier: { provider: "codex", model: "m", effort: "high", key: "k" } };
    const none = io(t, "incident-publish", pub);
    t.eq([none.ok, none.published, none.answer.present], [true, false, false], "no answer file: nothing is published, and it says so");
    t.ok(!fs.existsSync(`${tmp}/rev-1/classification.json`), "nothing was written");
    const answer = JSON.stringify({
      findings: [{ kind: "infra", hypothesis: "", about: "other", confidence: "medium", summary: "the log store is down", evidence: ["E3"], fixedBy: [], deployedIn: [] }],
      gaps: [{ what: "the config read was refused", evidence: ["E4"], operation: "", proposal: "a product report of the config" }],
      next: { route: "awaiting-operator", role: "the operator", question: "", reason: "infrastructure" },
      facts: "The log store did not answer.", reply: "r", leadLine: "l", recommendRetry: false,
      fixBrief: { goal: "", files: [], done: [], checks: [], agentsAffected: false, agentSkillChange: "" },
    }, null, 2) + "\r\n";
    fs.writeFileSync(`${tmp}/rev-1/classification.raw.json`, answer);
    const traceFile = `${dir}/publish-trace.log`;
    const traced = tracedPublish(t, pub, traceFile);
    t.eq(traced.order, ["classification.json", "incident.json:classified", "draft.md", "incident.json:drafted"], "publish order: classification and the intermediate pointer are written before draft.md and the final pointer");
    const p = traced.json;
    t.eq([p.published, p.answer.sha256, p.answer.bytes], [true, sha(Buffer.from(answer, "utf8")), Buffer.byteLength(answer)], "the answer file is read with its hash and size, as it is on disk (CRLF included)");
    t.eq([p.state, p.route, p.kinds, p.role, p.refused], ["drafted", "awaiting-operator", ["infra"], "the operator", []], "the judged answer: state, route, kinds and role");
    const cls = JSON.parse(fs.readFileSync(`${tmp}/rev-1/classification.json`, "utf8"));
    t.eq([cls.rawSha256, cls.evidenceSha256, cls.classifier.key], [p.answer.sha256, c.evidence.sha256, "k"], "classification.json names the answer, the bundle and the key");
    t.ok(fs.readFileSync(`${tmp}/rev-1/draft.md`, "utf8").startsWith("# Incident i1, revision 1"), "draft.md is written by the helper");
    t.eq(JSON.parse(fs.readFileSync(`${tmp}/incident.json`, "utf8")).state, "drafted", "incident.json says drafted");
    const twice = io(t, "incident-publish", pub);
    t.ok(twice.ok === false && /never overwritten/.test(twice.error), "a published revision is never overwritten");
    const changedEvidence = io(t, "incident-publish", { ...pub, evidenceSha256: "0".repeat(64) });
    t.ok(changedEvidence.ok === false && /evidence\.json/.test(changedEvidence.error), "a bundle that is not the one collected is refused");

    // fail and unlock
    const f = io(t, "incident-fail", { tmp, incident: "i1", revision: 1, token: open.token, adapterSha256: adapterSha });
    t.eq([f.state, f.revision, f.sha256], ["failed", 1, sha(fs.readFileSync(`${tmp}/incident.json`))], "incident-fail writes failed and reports the file's hash");
    t.ok(fs.existsSync(`${tmp}/.lock`), "and leaves the lock");
    fs.writeFileSync(`${tmp}/incident.json`, "\"\"");
    const refusedFail = io(t, "incident-fail", { tmp, incident: "i1", revision: 1, token: open.token });
    t.ok(refusedFail.ok === false && fs.readFileSync(`${tmp}/incident.json`, "utf8") === "\"\"", "an incident.json that is not a record is never overwritten");
    t.eq(io(t, "incident-unlock", { tmp, incident: "i1", token: open.token }).removed, true, "the lock is removed with the token");
  });

  scenario("io-helper-brief", "brief-inspect hashes the brief and lists its headings; brief-preflight screens a public brief (a secret-shaped value, a machine path) and writes nothing then, writes the redacted request without machine paths otherwise, and refuses a brief that changed; review-read hashes and parses the answer", async (t) => {
    const dir = scratch(t, "brief");
    const repo = `${dir}/repo`;
    fs.mkdirSync(`${repo}/src`, { recursive: true });
    fs.writeFileSync(`${repo}/src/export.js`, Array.from({ length: 20 }, (_, i) => (i === 9 ? `const token = "abcd1234efgh5678"; // line 10, see ${repo}/x` : `line ${i + 1}`)).join("\n") + "\n");
    const mark = "<!-- design-brief: b -->";
    const clean = `${mark}\n# Title\n\n## Review boundary\nImportant: x.\n\n## Checks\nnode t.js\n`;
    const brief = `${repo}/.agent-tmp/b/brief.md`;
    fs.mkdirSync(path.dirname(brief), { recursive: true });
    fs.writeFileSync(brief, clean);
    const ins = io(t, "brief-inspect", { brief, mark });
    t.eq([ins.exists, ins.sha256, ins.bytes, ins.firstLine, ins.markOk, ins.headings], [true, sha(clean), Buffer.byteLength(clean), mark, true, ["# Title", "## Review boundary", "## Checks"]], "the brief's hash, size, first line and headings");
    t.eq(io(t, "brief-inspect", { brief: `${repo}/none.md` }).exists, false, "a missing brief does not exist");

    const reviewDir = `${repo}/.agent-tmp/b/review`;
    const facts = [{ id: "T1", claim: "The export keeps a token", source: `${repo}/src/export.js:10`, question: 1 }, { id: "T2", claim: "Gone", source: `${repo}/src/gone.js:3`, question: 1 }];
    const goal = `Resume the export in ${repo}/src.`;
    const tmp = `${repo}/.agent-tmp/b`;
    const input = { goal, questions: [{ question: "How?" }], tmp, repos: [repo], gatewayRepo: repo, brief, label: "b", publicRepo: true };
    const inputSha256 = sha(JSON.stringify(input));
    const spec = { label: "b", brief, expectSha256: sha(clean), dir: reviewDir, tmp, repos: [repo], gatewayRepo: repo, publicRepo: true, reviewer: { model: "gpt-x", effort: "high" }, inputSha256 };
    const drive = ["C", ":"].join("");
    const key = ["sk", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
    const dirty = `${clean}Run it in ${drive}/work/app.\nThe client sends ${key}.\n`;
    fs.writeFileSync(brief, dirty);
    const screened = io(t, "brief-preflight", { ...spec, expectSha256: sha(dirty) });
    t.eq([screened.written, screened.publicRepo, screened.problems], [false, true, ["line 9: a machine path", "line 10: a secret-shaped value"]], "a public brief with a machine path and a secret-shaped value: both lines are named, and the mode used is said");
    for (const [what, mode] of [["omitted", undefined], ["a string", "true"], ["null", null]]) {
      const x = io(t, "brief-preflight", { ...spec, publicRepo: mode, expectSha256: sha(dirty) });
      t.ok(x.ok === false && /publicRepo must be true or false/.test(x.error) && !fs.existsSync(reviewDir), `publicRepo ${what}: refused, never screened as not public`);
    }
    t.ok(!JSON.stringify(screened).includes(key) && !fs.existsSync(reviewDir), "the value is not repeated, and nothing was written");
    const priv = io(t, "brief-preflight", { ...spec, publicRepo: false, expectSha256: sha(dirty) });
    t.eq([priv.publicRepo, priv.problems], [false, ["line 10: a secret-shaped value"]], "a brief not marked public may name a path, never a secret; the answer says it screened as not public");
    fs.writeFileSync(brief, clean);
    const changed = io(t, "brief-preflight", { ...spec, expectSha256: sha(dirty) });
    t.ok(changed.changed === true && !changed.written && !fs.existsSync(reviewDir), "a brief that is not the one inspected is not screened or sent");

    const init = io(t, "brief-manifest", { tmp, input, inputSha256 });
    t.eq(init.slots, [{ slot: 1, status: "missing" }], "the expected slot is missing");
    t.ok(/incomplete/.test(io(t, "brief-preflight", spec).error), "preflight refuses an incomplete manifest");
    const file = `${tmp}/facts/1.json`;
    const body = JSON.stringify({ facts: facts.map(({ claim, source }) => ({ claim, source })), unknowns: [] });
    fs.writeFileSync(file, body);
    const receipt = { slot: 1, count: 2, path: file, sha256: sha(body) };
    const submit = (report) => io(t, "brief-manifest", { tmp, inputSha256, reports: [report], reportsSha256: sha(JSON.stringify([report])) });
    for (const [field, value, reason] of [["count", 1, /count/], ["sha256", "0".repeat(64), /hash/], ["path", brief, /assigned slot path/]]) {
      const [slot] = submit({ ...receipt, [field]: value }).slots;
      t.ok(slot.status === "rejected" && reason.test(slot.reason), `a wrong ${field} is rejected with its reason`);
    }
    for (const [bytes, reason] of [[Buffer.from([0xff]), "UTF-8 JSON"], [JSON.stringify({ facts: [{}], unknowns: [] }), "schema"]]) {
      fs.writeFileSync(file, bytes);
      const [slot] = submit({ ...receipt, count: 1, sha256: sha(bytes) }).slots;
      t.ok(slot.status === "rejected" && slot.reason.includes(reason), "even a matching digest needs a valid " + reason);
    }
    fs.writeFileSync(file, body);
    const accepted = submit(receipt);
    spec.manifestSha256 = accepted.manifestSha256;
    spec.writerSha256 = accepted.writerSha256;
    t.eq(accepted.slots, [{ slot: 1, status: "accepted" }], "the correct receipt pins the slot");
    fs.appendFileSync(file, " ");
    t.ok(/accepted slot 1 changed/.test(io(t, "brief-preflight", spec).error) && !fs.existsSync(reviewDir), "preflight hashes even parse-equivalent bytes before writing");
    fs.writeFileSync(file, body);

    const before = listing(dir).filter((f) => !f.startsWith("repo/.agent-tmp/b/review/"));
    const ok = io(t, "brief-preflight", spec);
    t.eq([ok.written, ok.problems, ok.excerpts], [true, [], { total: 2, missing: 1 }], "a clean brief: the request is written; an excerpt that cannot be read is counted");
    t.eq(ok.inputSha256, inputSha256, "the review uses the bound goal and questions");
    t.eq(Object.keys(ok.files).sort(), ["design-review.json", "design-review.md", "design-review.schema.json", "excerpts.md", "facts.json", "prompt.md"], "the six files of the request");
    for (const [name, hash] of Object.entries(ok.files)) t.eq(sha(fs.readFileSync(`${reviewDir}/${name}`)), hash, `${name}: written with the hash it reports`);
    const material = ["facts.json", "excerpts.md", "prompt.md"].map((n) => fs.readFileSync(`${reviewDir}/${n}`, "utf8")).join("\n");
    t.ok(!material.includes(repo) && !material.includes("abcd1234efgh5678") && material.includes("<repo1>/src/export.js:10") && material.includes("[REDACTED"), "no machine path and no secret in what the reviewer gets: aliases and redaction");
    t.ok(/## T1 <repo1>\/src\/export\.js:10 \(lines 7-13\)\n~~~\n7: line 7/.test(material) && /## T2 .*\n\(not available\)/.test(material), "the cited lines with 3 around them, numbered as in the file; a missing file is said");
    t.eq(JSON.parse(fs.readFileSync(`${reviewDir}/design-review.json`, "utf8")).model, "gpt-x", "the role file carries the reviewer");
    t.eq(listing(dir).filter((f) => !f.startsWith("repo/.agent-tmp/b/review/")), before, "nothing was written outside the review folder");

    const rv = `${reviewDir}/review.json`;
    const answer = JSON.stringify({ verdict: "changes_requested", summary: "s", findings: [{ id: "F1", severity: "important", location: "Goal", problem: "x".repeat(3000), fix: "f" }, "not an object"], notVerified: [] });
    fs.writeFileSync(rv, answer);
    const read = io(t, "review-read", { file: rv });
    t.eq([read.answer.present, read.answer.sha256, read.answer.json, read.review.verdict, read.review.findingsTotal], [true, sha(answer), true, "changes_requested", 2], "the answer's hash and verdict");
    t.ok(read.review.findings[0].problem.length <= 803 && read.review.findings[1] === null, "each text is capped, and a finding that is not an object is null for the workflow to refuse");
    const many = JSON.stringify({ verdict: "changes_requested", summary: "s".repeat(5000), findings: Array.from({ length: 100 }, (_, i) => ({ id: `F${i}`, severity: "minor", location: "l".repeat(5000), problem: "p".repeat(5000), fix: "f".repeat(5000) })), notVerified: Array.from({ length: 100 }, () => "n".repeat(5000)) });
    fs.writeFileSync(rv, many);
    const big = io(t, "review-read", { file: rv });
    t.ok(big.review.findings.length === 40 && big.review.findingsTotal === 100 && big.review.notVerified.length === 20 && JSON.stringify(big).length < 160000, "a long answer gives a bounded line: 40 findings, 20 notVerified, each text capped; the total is said");
    t.eq([big.review.shapeOk, big.review.severities], [true, { blocker: 0, important: 0, minor: 100, other: 0 }], "the shape and the severities are judged over every finding");
    const f = (i, severity) => ({ id: `F${i}`, severity, location: "l", problem: "p", fix: "f" });
    fs.writeFileSync(rv, JSON.stringify({ verdict: "approved", summary: "s", findings: [...Array.from({ length: 40 }, (_, i) => f(i, "minor")), f(40, "important"), f(41, "Critical")], notVerified: [] }));
    const hidden = io(t, "review-read", { file: rv });
    t.eq([hidden.review.findings.length, hidden.review.shapeOk, hidden.review.severities], [40, true, { blocker: 0, important: 1, minor: 40, other: 1 }], "a blocking finding after the first 40 is counted, though not listed");
    fs.writeFileSync(rv, JSON.stringify({ verdict: "approved", summary: "s", findings: [...Array.from({ length: 40 }, (_, i) => f(i, "minor")), "not an object"], notVerified: [] }));
    t.eq(io(t, "review-read", { file: rv }).review.shapeOk, false, "a malformed finding after the first 40 makes the shape fail");
    fs.writeFileSync(rv, "no json");
    t.eq([io(t, "review-read", { file: rv }).answer.json, io(t, "review-read", { file: `${reviewDir}/none.json` }).answer.present], [false, false], "an answer that is not JSON, and none at all, are said apart");
  });

  scenario("io-helper-no-retyping", "no prompt of incident-triage or design-brief asks a runner to return a file's content or to write a file from text in the prompt", async (t) => {
    for (const rel of ["core/workflows/incident-triage.js", "core/workflows/design-brief.js"]) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const s of ["exactly as read", "<<<FILE", "every character"]) t.ok(!src.includes(s), `${rel}: no "${s}"`);
      t.ok(!/sha256sum/.test(src), `${rel}: no runner is asked to hash a file`);
    }
  });

  scenario("io-helper-brief-linked-facts", "an assigned facts folder that links outside the run is refused before any slot is assigned", async (t) => {
    const dir = scratch(t, "linked-facts");
    const tmp = `${dir}/run`;
    const away = `${dir}/away`;
    fs.mkdirSync(tmp);
    fs.mkdirSync(away);
    fs.symlinkSync(away, `${tmp}/facts`, "junction");
    const input = { tmp, goal: "Check the source", questions: [{ question: "Where?" }], repos: [dir], publicRepo: false };
    const result = io(t, "brief-manifest", { tmp, input, inputSha256: sha(JSON.stringify(input)) });
    t.ok(result.ok === false && /is a link or resolves outside/.test(result.error), "the linked facts folder is refused");
    t.eq(listing(away), [], "nothing was written through the link");
    fs.unlinkSync(`${tmp}/facts`);
  });
}
