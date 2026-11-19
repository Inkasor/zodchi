// The spec of a helper command travels as base64, and a material part that arrived damaged is sent once more.
//
// core/scripts/gate.mjs takes its spec as plain JSON or as "b64:" and the base64 of the UTF-8 JSON text; the four workflows
// (code-package, design-brief, incident-triage, ops-script) send the second form, so that a runner which retypes the command has no
// quote, backslash or brace to "repair". Here: the real helper with both forms (same answer byte for byte, every kind of damage named,
// text with quotes, backslashes, apostrophes, Russian and emoji round-tripping exactly), the encoder and the helperRun of each workflow
// (taken from the source and run in a context without Buffer), and design-brief run for real over a fake agent whose runner damages
// the end of the argument of a material part: once (the run reaches the review) and twice (the run stops with its stop text).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MARK = "<!-- design-brief: db -->";
const BRIEF = `${MARK}\n# Title\n\n## Goal\nMake the export resumable.\n\n## Review boundary\nImportant: a lost row.\n\n## Checks\nnode scripts/check.mjs\n`;
const HEADINGS = ["# Title", "## Goal", "## What to build", "## Owner decisions", "## Review boundary", "## Checks"];
const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
const ROLES = {
  writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] },
  architect: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }] },
};
// The text a spec must carry exactly: quotes, backslashes, an apostrophe, shell characters, Russian, an emoji (outside the BMP) and a line break.
const HARD = "He said \"it's a\\b\\c\" and $HOME `x` ; 'quoted' \\\\ — Привет, мир! Ёжик 😀 end\nnext line\ttab";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-b64-${name}-`)).replace(/\\/g, "/");
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const enc = (text) => `b64:${Buffer.from(text, "utf8").toString("base64")}`;
  /** One command of the helper with the spec argument exactly as given: exit code, stdout, stderr and the parsed line. */
  const gate = (t, command, arg) => {
    const r = spawnSync(process.execPath, [GATE, command, arg], { encoding: "utf8", windowsHide: true });
    t.log(`gate.mjs ${command} ${arg.slice(0, 80)}${arg.length > 80 ? "..." : ""}: exit ${r.status}\n${r.stdout.slice(0, 600)}${r.stderr}`);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
    return { code: r.status, out: r.stdout, err: r.stderr, json };
  };

  scenario("spec-b64-gate", "gate.mjs takes the spec as plain JSON or as b64: and the base64 of its UTF-8 JSON text, with the same answer byte for byte; bad base64, invalid UTF-8 and bad JSON after b64: each exit 2 with an error that says which", async (t) => {
    const spec = JSON.stringify({ api: 1 });
    const plain = gate(t, "plugin", spec);
    const b64 = gate(t, "plugin", enc(spec));
    t.ok(plain.code === 0 && plain.json && plain.json.ok === true, "plain JSON still works");
    t.ok(b64.code === 0 && b64.out === plain.out, "b64: of the same JSON gives the same answer, byte for byte");
    t.ok(b64.out.trim().split("\n").length === 1 && b64.err === "", "one line on stdout and nothing on stderr");
    const bad = (arg, re, why) => {
      const r = gate(t, "plugin", arg);
      t.ok(r.code === 2 && r.json && r.json.ok === false && r.json.api === 1 && re.test(r.json.error) && r.out.trim().split("\n").length === 1, `${why}: exit 2, { ok:false, api, error } naming it (${r.json && r.json.error})`);
      t.eq(Object.keys(r.json).sort(), ["api", "error", "ok"], `${why}: the error line keeps its shape`);
    };
    const good = Buffer.from(spec, "utf8").toString("base64");
    bad(`b64:${good}!`, /not valid base64/, "a character outside the alphabet");
    bad(`b64:${good.replace(/=+$/, "")}x`, /not valid base64/, "bad padding");
    bad(`b64:${good.slice(0, -1)}`, /not valid base64/, "a dropped tail character (length not a multiple of 4)");
    bad("b64:", /not JSON/, "an empty body is valid base64 of the empty text, which is not JSON");
    bad(`b64:${Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64")}`, /UTF-8/, "bytes that are not UTF-8");
    bad(`b64:${Buffer.from("not json at all", "utf8").toString("base64")}`, /not JSON/, "base64 of text that is not JSON");
    bad(`b64:${Buffer.from(spec.slice(0, -1), "utf8").toString("base64")}`, /not JSON/, "base64 of a JSON text with its end cut off");
    bad(enc(JSON.stringify(5)), /not an object/, "base64 of JSON that is not an object");
    const noApi = gate(t, "plugin", enc(JSON.stringify({ api: 2 })));
    t.ok(noApi.code === 3 && noApi.json && noApi.json.ok === false, "the api check applies to the decoded spec");
    const none = spawnSync(process.execPath, [GATE, "plugin"], { encoding: "utf8", windowsHide: true });
    t.ok(none.status === 2 && /not JSON/.test(none.stdout), "no spec at all is still a bad call");
  });

  scenario("spec-b64-roundtrip", "text with quotes, backslashes, an apostrophe, shell characters, Russian and emoji reaches the helper exactly in both forms (brief-material writes it, the file and its hash are compared)", async (t) => {
    const dir = scratch(t, "round");
    const text = HARD.repeat(3);
    for (const [name, arg] of [["plain", JSON.stringify({ api: 1, dir: `${dir}/plain`, part: 1, of: 1, text })], ["b64", enc(JSON.stringify({ api: 1, dir: `${dir}/b64`, part: 1, of: 1, text }))]]) {
      const r = gate(t, "brief-material", arg);
      t.ok(r.code === 0 && r.json && r.json.ok === true, `${name}: the helper answers`);
      t.eq(r.json.sha256, sha(text), `${name}: the hash is the hash of the text sent`);
      t.eq(fs.readFileSync(`${dir}/${name}/material/1-of-1.part`, "utf8"), text, `${name}: the file holds the text exactly`);
    }
  });

  /** The lines of a workflow source that the command line is made from, run without Buffer or btoa, as the workflow sandbox may be. */
  const WORKFLOWS = ["code-package", "design-brief", "incident-triage", "ops-script"];
  const helperOf = (name) => {
    const src = fs.readFileSync(path.join(ROOT, "core", "workflows", `${name}.js`), "utf8");
    const one = (re, what) => { const m = src.match(re); if (!m) throw new Error(`${name}.js: no ${what}`); return m[0]; };
    const encoder = one(/const B64 = [^\n]*\nconst b64 = \(text\) => \{\n[\s\S]*?\n\}\n/, "b64 encoder");
    const code = [one(/^const q = [^\n]*$/m, "q"), one(/^const GATE_API = [^\n]*$/m, "GATE_API"), one(/^const GATE_BOOT = [^\n]*$/m, "GATE_BOOT"), one(/^const SESSION_PROJECT = [^\n]*$/m, "SESSION_PROJECT"), encoder, one(/^const helperRun = [^\n]*$/m, "helperRun")].join("\n");
    const ctx = vm.createContext({ a: {}, result: null });
    vm.runInContext(`${code}\nresult = { helperRun, b64, GATE_BOOT, GATE_API }`, ctx);
    return { ...ctx.result, encoder, src };
  };

  scenario("spec-b64-workflow-encoder", "the four workflows carry the same pure-JS UTF-8 to base64 encoder, it matches Buffer for every length and every kind of text, and helperRun sends b64: only", async (t) => {
    const samples = ["", "a", "ab", "abc", "abcd", "{\"api\":1}", HARD, "Привет", "😀", "😀😀😀", "\u0000\u007f\u0080\u07ff\u0800\uffff", ...Array.from({ length: 9 }, (_, i) => "x".repeat(i) + "я")];
    const first = helperOf(WORKFLOWS[0]);
    for (const name of WORKFLOWS) {
      const h = helperOf(name);
      t.eq(h.encoder, first.encoder, `${name}: the encoder is the text of the others`);
      t.ok(samples.every((s) => h.b64(s) === Buffer.from(s, "utf8").toString("base64")), `${name}: b64 equals the real base64 of the UTF-8 text`);
      t.ok(!/Buffer|btoa/.test(h.encoder), `${name}: the encoder needs neither Buffer nor btoa`);
      const spec = { text: HARD, list: ["it's", "\\"], nested: { ru: "Ёж", emoji: "😀" } };
      const cmd = h.helperRun("claim", spec);
      const m = cmd.match(/ -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" claim '(b64:[A-Za-z0-9+/]+={0,2})'$/);
      t.ok(m, `${name}: the command ends with the spec as one quoted b64: argument (no brace, quote or backslash in it)`);
      const arg = m ? m[1] : "";
      t.eq(JSON.parse(Buffer.from(arg.slice(4), "base64").toString("utf8")), { api: h.GATE_API, ...spec }, `${name}: the argument decodes to the spec with the api`);
      // The bootstrap hands the argument on unchanged and the helper takes it.
      const r = spawnSync(process.execPath, ["-e", h.GATE_BOOT, "--", ROOT, "plugin", enc(JSON.stringify({ api: h.GATE_API }))], { encoding: "utf8", windowsHide: true, env: { ...process.env, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core") } });
      let line = null;
      try { line = JSON.parse(r.stdout); } catch { /* checked below */ }
      t.ok(r.status === 0 && line && line.ok === true, `${name}: the bootstrap passes the b64: argument through to the helper (exit ${r.status}: ${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)})`);
      t.ok(!/q\(JSON\.stringify\(\{ api: GATE_API/.test(h.src), `${name}: no plain-JSON spec is built any more`);
    }
  });

  /** design-brief for real, over a fake agent: the material parts run through the real helper with the argument as typed (and damaged on request). */
  let runs = 0;
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-b64-run-")).replace(/\\/g, "/");
  process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });
  const SRC = () => fs.readFileSync(path.join(ROOT, "core", "workflows", "design-brief.js"), "utf8");

  /** `damage(label, arg, attempt)` returns the argument the fake runner types, or undefined for a correct copy. */
  async function run(damage) {
    const disk = `${SCRATCH}/run-${++runs}`;
    const repo = `${disk}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    const args = { label: "db", goal: "Make the export resumable, because a cut run loses an hour.", repos: [repo], questions: ["How is the export written?"], out: `${repo}/.agent-tmp/db/brief.md`, tmp: `${repo}/.agent-tmp/db` };
    const calls = [];
    const attempts = new Map();
    const reviewDir = `${args.tmp}/review`;
    const ioLine = (facts) => { const body = { ok: true, ...facts, api: 1, plugin: PLUGIN }; return { exitCode: 0, stdout: JSON.stringify({ ...body, lineSha256: sha(JSON.stringify(body)) }) + "\n" }; };
    // Long claims, so that the material is several parts.
    const facts = Array.from({ length: 6 }, (_, i) => ({ claim: `The export writes row group ${i} with a long explanation. ${"Why it matters here, ".repeat(70)}`, source: `${repo}/src/export.js:${i + 1}` }));
    const sandbox = {
      args, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => {
        const label = opts.label;
        calls.push({ label, prompt, opts });
        if (label === "gate db") return { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, roles: ROLES, modelsErrors: [], account: { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null }, accountError: "", ignoreExit: 0 }) + "\n" };
        if (label === "facts 1") return { facts, unknowns: [] };
        if (label === "draft db") return { done: true, summary: "wrote", ownerDecisions: [], leftForLater: [], wrongFacts: [], unverified: [] };
        if (label === "inspect draft db") return ioLine({ exists: true, sha256: sha(BRIEF), bytes: BRIEF.length, firstLine: MARK, headings: HEADINGS });
        if (/^material /.test(label)) {
          const m = prompt.match(/ -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" brief-material '((?:[^']|'\\'')*)'\n/);
          if (!m) throw new Error(`${label}: no brief-material command in the prompt`);
          const typed = m[1].replace(/'\\''/g, "'");
          const n = (attempts.get(label) || 0) + 1;
          attempts.set(label, n);
          const arg = damage(label, typed, label.includes(" again ") ? 2 : 1) ?? typed;
          const r = spawnSync(process.execPath, [GATE, "brief-material", arg], { encoding: "utf8", windowsHide: true });
          return { exitCode: r.status ?? -1, stdout: r.stdout || "", error: (r.stderr || "").slice(0, 300) };
        }
        if (label === "preflight db") {
          // The parts as the real helper wrote them: the hash of their join is what the workflow compares with its own.
          const files = fs.existsSync(`${reviewDir}/material`) ? fs.readdirSync(`${reviewDir}/material`).sort((x, y) => parseInt(x, 10) - parseInt(y, 10)) : [];
          const joined = files.map((f) => fs.readFileSync(`${reviewDir}/material/${f}`, "utf8")).join("");
          return ioLine({ publicRepo: false, changed: false, briefSha256: sha(BRIEF), problems: [], inputSha256: sha(joined), written: true, excerpts: { missing: 0 } });
        }
        if (label === "review") return { ok: false, summary: "the fake stops here", gateway: "final", infra: "" };
        throw new Error(`no scripted answer for the step "${label}"`);
      },
    };
    const fn = vm.runInNewContext(`(async () => {\n${SRC().replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "design-brief.js" });
    const out = await fn();
    return { out, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  /** The spec a prompt's brief-material command carries, decoded. */
  const specOf = (arg) => JSON.parse(Buffer.from(arg.slice(4), "base64").toString("utf8"));
  const partOf = (prompt) => specOf(prompt.match(/ brief-material '(b64:[A-Za-z0-9+/]+={0,2})'\n/)[1]);
  /** Valid base64 of a spec whose text has another last character: the helper takes it, its hash is not the part's. */
  const changed = (arg) => { const o = specOf(arg); o.text = `${o.text.slice(0, -1)}#`; return enc(JSON.stringify(o)); };
  /** What the runner types is the argument cut short. */
  const cut = (n) => (_label, arg) => arg.slice(0, -n);
  const when = (pick, f) => (label, arg, attempt) => (pick(label, attempt) ? f(label, arg) : undefined);

  scenario("spec-b64-material-retry", "a material part that arrives damaged (the end of the argument dropped; valid base64 of another text) is sent once more by a fresh runner under its own label and the run reaches the review; a part damaged twice stops the run with the usual stop text", async (t) => {
    const clean = await run(() => undefined);
    const n = clean.of(/^material /).length;
    t.ok(n >= 3, `the material is several parts (${n})`);
    t.ok(clean.of(/^material /).every((c) => /^material \d+\/\d+ db$/.test(c.label)), "without damage each part is sent once");
    t.ok(clean.of(/^material /).every((c) => Array.from(partOf(c.prompt).text).length <= 2000), "no part is over 2000 characters");
    t.ok(clean.out.stoppedAt && /^review \(the fake stops here\)/.test(clean.out.stoppedAt) && clean.of(/^review$/).length === 1, `an undamaged run reaches the review (${clean.out.stoppedAt})`);
    for (const c of clean.calls.filter((x) => / -- "\$\(pwd -W/.test(x.prompt))) t.ok(/ (roles|brief-[a-z]+|review-read) 'b64:[A-Za-z0-9+/]+={0,2}'\n/.test(c.prompt), `${c.label}: the command carries its spec as b64:`);

    // The last characters of the argument dropped, in two ways: a broken length, and a base64 that is valid but of a cut text.
    const second = 2;
    const pickSecond = (label, attempt) => attempt === 1 && label.startsWith(`material ${second}/`);
    for (const [name, damage] of [
      ["the last 3 characters dropped", cut(3)],
      ["the last 4 characters dropped (valid base64, cut JSON)", cut(4)],
    ]) {
      const r = await run(when(pickSecond, damage));
      const parts = r.of(/^material /);
      t.ok(r.out.stoppedAt && /^review \(the fake stops here\)/.test(r.out.stoppedAt) && r.of(/^review$/).length === 1 && r.of(/^preflight /).length === 1, `${name}: the run reaches the review (${r.out.stoppedAt})`);
      t.eq(parts.length, n + 1, `${name}: exactly one more command than parts`);
      t.ok(parts.some((c) => c.label === `material ${second}/${n} again db`) && parts.filter((c) => c.label === `material ${second}/${n} db`).length === 1, `${name}: the second attempt has a label of its own`);
      t.eq(new Set(parts.map((c) => c.label)).size, parts.length, `${name}: no two commands share a label, so the journal cannot hand back the bad answer`);
      t.ok(!parts.some((c) => /again/.test(c.label) && !c.label.startsWith(`material ${second}/`)), `${name}: only the damaged part is sent again`);
    }
    // The text of a part changed but still a valid spec: the helper takes it, the hash of what it got is not the part's.
    const altered = await run(when(pickSecond, (_l, arg) => changed(arg)));
    t.ok(/^review \(the fake stops here\)/.test(altered.out.stoppedAt || "") && altered.of(/^material .* again /).length === 1, `a part whose hash differs is sent again and the run reaches the review (${altered.out.stoppedAt})`);

    // Both attempts damaged: the run stops, with the stop text it had.
    const twice = await run((label, arg) => (label.startsWith(`material ${second}/`) ? arg.slice(0, -3) : undefined));
    t.ok(/^review \(part 2 of the material was not written: the material helper \(part 2\): /.test(twice.out.stoppedAt || ""), `a part damaged twice stops the run (${twice.out.stoppedAt})`);
    t.ok(twice.of(/^preflight /).length === 0 && twice.of(/^review$/).length === 0, "nothing was preflighted or sent to the gateway");
    t.eq(twice.of(/^material 2\//).length, 2, "the part was sent twice, not more");
    const hash = await run((label, arg) => (label.startsWith(`material ${second}/`) ? changed(arg) : undefined));
    t.ok(/^review \(part 2 of the material did not reach the helper exactly \(its sha256 differs\)\)/.test(hash.out.stoppedAt || "") && hash.of(/^review$/).length === 0, `a part whose hash differs twice stops the run with the hash text (${hash.out.stoppedAt})`);
    // A fault in the first part is reported first, as before.
    const both = await run((label, arg) => (/^material [12]\//.test(label) ? arg.slice(0, -3) : undefined));
    t.ok(/^review \(part 1 of the material was not written/.test(both.out.stoppedAt || ""), "when several parts fail twice, the first is named");
  });

  scenario("spec-b64-too-many-parts", "the 200-part limit and its message are kept with the smaller parts", async (t) => {
    const src = SRC();
    t.ok(/const MATERIAL_PART = 2000\n/.test(src), "a part is 2000 code points");
    t.ok(/materialParts\.length > 200\) return stopPre\(`the facts of the research are too many to send \(\$\{materialText\.length\} characters in \$\{materialParts\.length\} parts, at most 200\)`/.test(src), "over 200 parts stops the run with the same text");
  });
}
