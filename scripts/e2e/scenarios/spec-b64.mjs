// The spec of a helper command travels as base64, and a material part that arrived damaged is sent once more.
//
// core/scripts/gate.mjs takes its spec as plain JSON or as "b64:" and the base64 of the UTF-8 JSON text; the four workflows
// (code-package, design-brief, incident-triage, ops-script) send the second form, so that a runner which retypes the command has no
// quote, backslash or brace to "repair". Here: the real helper with both forms (same answer byte for byte, every kind of damage named,
// text with quotes, backslashes, apostrophes, Russian and emoji round-tripping exactly), the encoder and the helperRun of each workflow
// (taken from the source and run in a context without Buffer), the cap on the length of the argument (b64: only up to B64_MAX characters,
// a longer spec as plain JSON exactly as before; a material part of the worst text always fits the 4000 characters a runner-typed material argument is held to), and design-brief run for real over a fake
// agent whose runner damages the end of the argument of a material part: once (the part is sent again alone and the run reaches the review) and twice
// (the run stops with its stop text).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { unquote, plainPrompt, commandsIn, encodeSpec, specIn } from "../spec-arg.mjs";

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
    const cap = one(/const B64_MAX = [^\n]*\nconst specArg = \(spec\) => \{\n[\s\S]*?\n\}\n/, "B64_MAX and specArg");
    const code = [one(/^const q = [^\n]*$/m, "q"), one(/^const GATE_API = [^\n]*$/m, "GATE_API"), one(/^const GATE_BOOT = [^\n]*$/m, "GATE_BOOT"), one(/^const SESSION_PROJECT = [^\n]*$/m, "SESSION_PROJECT"), encoder, cap, one(/^const helperRun = [^\n]*$/m, "helperRun")].join("\n");
    const ctx = vm.createContext({ a: {}, result: null });
    vm.runInContext(`${code}\nresult = { helperRun, specArg, b64, B64_MAX, GATE_BOOT, GATE_API }`, ctx);
    return { ...ctx.result, encoder, cap, src };
  };

  scenario("spec-b64-workflow-encoder", "the four workflows carry the same pure-JS UTF-8 to base64 encoder, it matches Buffer for every length and every kind of text, and helperRun sends b64: for a spec that fits the cap", async (t) => {
    const samples = ["", "a", "ab", "abc", "abcd", "{\"api\":1}", HARD, "Привет", "😀", "😀😀😀", "\u0000\u007f\u0080\u07ff\u0800\uffff", ...Array.from({ length: 9 }, (_, i) => "x".repeat(i) + "я")];
    const first = helperOf(WORKFLOWS[0]);
    for (const name of WORKFLOWS) {
      const h = helperOf(name);
      t.eq(h.encoder, first.encoder, `${name}: the encoder is the text of the others`);
      t.eq(h.cap, first.cap, `${name}: the cap and the choice of the form are the text of the others`);
      t.eq(h.B64_MAX, 12000, `${name}: the cap is 12000 characters`);
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
      t.ok(!/q\(JSON\.stringify\(\{ api: GATE_API/.test(h.src), `${name}: helperRun does not build the plain form itself (specArg chooses)`);
    }
  });

  scenario("spec-b64-cap", "a spec goes as b64: only while the argument is at most B64_MAX (12000) characters, prefix included; a longer one goes as the plain JSON of before, which a long Russian report needs (b64 of it would not start on Windows); every workflow draws the line at the same place", async (t) => {
    const MAX = 12000;
    const ESC = String.raw`'\''`;
    for (const name of WORKFLOWS) {
      const h = helperOf(name);
      const jsonOf = (spec) => JSON.stringify({ api: h.GATE_API, ...spec });
      // The edge: the longest spec that fits is 8997 bytes of JSON (4 + 4 * 2999 = 12000 characters); one byte more goes plain.
      const base = jsonOf({ text: "" }).length;
      const fit = { text: "x".repeat(8997 - base) };
      const over = { text: "x".repeat(8998 - base) };
      t.eq(h.specArg(fit).length, MAX, `${name}: the longest spec that fits is sent as b64: of exactly ${MAX} characters`);
      t.ok(h.specArg(fit).startsWith("b64:"), `${name}: and it is the b64: form`);
      t.eq(h.specArg(over), jsonOf(over), `${name}: one byte more is sent as plain JSON, as the older workflows sent it`);
      // A long Russian report: plain, the very command of before; b64 of the same spec would be far over what Windows starts.
      const long = { report: "Не удалось выгрузить заказы, остатки не сошлись. ".repeat(290), incident: "inc-1" };
      const cmd = h.helperRun("incident-collect", long);
      t.ok(cmd.endsWith(` incident-collect '${jsonOf(long).replace(/'/g, ESC)}'`), `${name}: a long Russian spec is sent as plain JSON, exactly as before`);
      const asB64 = cmd.length - jsonOf(long).length + ("b64:" + h.b64(jsonOf(long))).length;
      t.ok(asB64 > 30000 && cmd.length < 20000, `${name}: the command stays ${cmd.length} characters; as b64 it would have been ${asB64}`);
      // The real process start with that argument: the bootstrap passes it on and the helper reads it.
      const r = spawnSync(process.execPath, ["-e", h.GATE_BOOT, "--", ROOT, "plugin", h.specArg(long)], { encoding: "utf8", windowsHide: true, env: { ...process.env, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core") } });
      let line = null;
      try { line = JSON.parse(r.stdout); } catch { /* checked below */ }
      t.ok(r.status === 0 && line && line.ok === true, `${name}: the long plain argument starts the bootstrap and the helper takes it (exit ${r.status}, ${r.error ? r.error.message : r.stderr.slice(0, 200)})`);
      // Nothing is longer than on main beyond the cap: b64 never exceeds it, and a longer spec is main's own text.
      for (const text of ["я".repeat(5000), "😀".repeat(2200), "a".repeat(20000), HARD.repeat(300)]) {
        const arg = h.specArg({ text });
        t.ok(arg.startsWith("b64:") ? arg.length <= MAX : arg === jsonOf({ text }), `${name}: ${text.length} characters of ${text.slice(0, 2)}... are b64 within the cap or exactly the plain JSON`);
      }
    }
  });

  scenario("spec-b64-material-part-fits", "a material part of the worst text (4-byte, 3-byte, escaped or Cyrillic characters, with a long folder name) goes as b64:, within the 4000-character cap of a runner-typed argument, in design-brief, and no part is over the 4000 characters the helper takes", async (t) => {
    const src = SRC();
    t.eq(Number(src.match(/^const MATERIAL_PART = (\d+)$/m)[1]), 4000, "a part is at most 4000 characters, what brief-material takes");
    // The parts are cut from JSON.stringify of the material, so a part never holds a control character or a lone surrogate (JSON writes those
    // as ASCII escapes); each of its characters is then one of these, and the longest in the spec is the 4-byte emoji (a backslash and a quote double).
    // A folder of 400 letters (the review folder is longer by the repository and the run name): the cut leaves room for it beside the heaviest part.
    const tail = `/${"ж".repeat(100)}/${"ж".repeat(100)}/${"f".repeat(200)}`;
    for (const [what, ch, whole] of [["4-byte emoji", "😀", false], ["3-byte characters", "字", false], ["Cyrillic", "ж", true], ["backslashes (each doubled)", "\\", true], ["quotes (each escaped)", "\"", true], ["ASCII", "a", true]]) {
      const r = await run(() => undefined, { tmpTail: tail, facts: (repo) => [{ claim: ch.repeat(9000), source: `${repo}/src/export.js:1` }] });
      const calls = r.of(/^material /);
      const parts = partsIn(calls);
      t.ok(parts.length >= 3, `${what}: the material is several parts (${parts.length})`);
      t.ok(parts.every((c) => /^b64:[A-Za-z0-9+/]+={0,2}$/.test(c.arg) && c.arg.length <= 4000), `${what}: every part goes as b64: within the 4000-character cap of a runner-typed argument (largest ${Math.max(...parts.map((c) => c.arg.length))}, a folder name of ${(parts[0] ? parts[0].spec.dir : "").length} characters)`);
      const lens = parts.map((c) => c.spec.text.length);
      t.ok(lens.every((n) => n <= 4000), `${what}: no part is over 4000 characters (largest ${Math.max(...lens)})`);
      t.ok(parts[0].arg.length >= 3980, `${what}: the first part uses what the cap allows, not less (${parts[0].arg.length} of 4000 characters, ${lens[0]} characters of text${whole ? "" : ", fewer because each character is heavy"})`);
      t.eq(calls.length, Math.ceil(parts.length / 8), `${what}: one runner for every 8 parts`);
      t.ok(/^review \(the fake stops here\)/.test(r.out.stoppedAt || "") && r.of(/^material .* again /).length === 0, `${what}: the run reaches the review with no part sent again (${r.out.stoppedAt})`);
    }
  });

  /** design-brief for real, over a fake agent: the material parts run through the real helper with the argument as typed (and damaged on request). */
  let runs = 0;
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-b64-run-")).replace(/\\/g, "/");
  process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });
  const SRC = () => fs.readFileSync(path.join(ROOT, "core", "workflows", "design-brief.js"), "utf8");

  /** `damage(label, arg, attempt, part)` returns the argument the fake runner types for that part, or undefined for a correct copy. */
  async function run(damage, opts = {}) {
    const oldHelperLine = opts.oldHelperLine;
    const lose = opts.lose;
    const disk = `${SCRATCH}/run-${++runs}`;
    const repo = `${disk}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    const args = { label: "db", goal: "Make the export resumable, because a cut run loses an hour.", repos: [repo], questions: ["How is the export written?"], out: `${repo}/.agent-tmp/db/brief.md`, tmp: `${repo}/.agent-tmp/db${opts.tmpTail || ""}` };
    const calls = [];
    // How every material prompt is typed, checked before the fake damages an argument or loses the answer: a resend is a prompt like the first batch.
    const encoding = [];
    const reviewDir = `${args.tmp}/review`;
    const ioLine = (facts) => { const body = { ok: true, ...facts, api: 1, plugin: PLUGIN }; return { exitCode: 0, stdout: JSON.stringify({ ...body, lineSha256: sha(JSON.stringify(body)) }) + "\n" }; };
    // Long claims, so that the material is several parts.
    const facts = opts.facts ? opts.facts(repo) : Array.from({ length: 6 }, (_, i) => ({ claim: `The export writes row group ${i} with a long explanation. ${"Why it matters here, ".repeat(70)}`, source: `${repo}/src/export.js:${i + 1}` }));
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
          // One runner, several commands one after another: one answer for each, in order. damage(label, argument, attempt, part) types the argument of a part.
          encoding.push({ label, ...commandsB64(prompt) });
          if (lose && lose(label)) return null;
          const cmds = commandsIn(prompt, "brief-material");
          if (!cmds.length) throw new Error(`${label}: no brief-material command in the prompt`);
          if ((prompt.match(/node -e /g) || []).length !== cmds.length) throw new Error(`${label}: a command of the prompt is not a brief-material command`);
          if (oldHelperLine) return { answers: cmds.map(() => ({ exitCode: 2, stdout: `${oldHelperLine}\n` })) };
          return {
            answers: cmds.map((c) => {
              const arg = damage(label, c.arg, label.includes(" again ") ? 2 : 1, c.spec.part) ?? c.arg;
              const r = spawnSync(process.execPath, [GATE, "brief-material", arg], { encoding: "utf8", windowsHide: true });
              return { exitCode: r.status ?? -1, stdout: r.stdout || "", error: (r.stderr || "").slice(0, 300) };
            }),
          };
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
    return { out, calls, encoding, of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  /** The spec a prompt's brief-material command carries, decoded. */
  const specOf = (arg) => JSON.parse(Buffer.from(arg.slice(4), "base64").toString("utf8"));
  /** The commands of the runner calls given (one runner sends several parts): { arg, spec } of each, in order. */
  const partsIn = (calls) => calls.flatMap((c) => commandsIn(c.prompt, "brief-material"));
  /** Valid base64 of a spec whose text has another last character: the helper takes it, its hash is not the part's. */
  const changed = (arg) => { const o = specOf(arg); o.text = `${o.text.slice(0, -1)}#`; return enc(JSON.stringify(o)); };
  /** What the runner types is the argument cut short. */
  const cut = (n) => (_label, arg) => arg.slice(0, -n);
  const when = (pick, f) => (label, arg, attempt, part) => (pick(label, attempt, part) ? f(label, arg) : undefined);

  /** Every helper command of a prompt (`node -e ... -- "$(pwd -W ...)" <command> '<arg>'`): how many there are, how many read as a command with one single-quoted argument, and those whose argument is not b64:. */
  const commandsB64 = (prompt) => {
    const total = (prompt.match(/ -- "\$\(pwd -W/g) || []).length;
    const found = [...prompt.matchAll(/ -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" ([a-z-]+) '((?:[^']|'\\'')*)'(?=\n|$)/gm)].map((m) => ({ command: m[1], arg: m[2] }));
    return { total, matched: found.length, plain: found.filter((c) => !/^b64:[A-Za-z0-9+/]+={0,2}$/.test(c.arg)) };
  };

  /** Every material prompt of a run (the batches and the resends) has every helper command read as a command with a b64: argument. */
  const everyPromptB64 = (t, r, what) => t.ok(r.encoding.length > 0 && r.encoding.every((k) => k.total > 0 && k.matched === k.total && k.plain.length === 0), `${what}: every helper command of every material prompt, resends included, carries its spec as b64: (${r.encoding.map((k) => `${k.label}: ${k.matched}/${k.total}, plain ${k.plain.length}`).join("; ")})`);

  scenario("spec-b64-material-retry", "a material part that arrives damaged (the end of the argument dropped; valid base64 of another text) is sent once more on its own by a fresh runner under its own label while the parts that arrived are not, and the run reaches the review; a part damaged twice stops the run with the usual stop text", async (t) => {
    const clean = await run(() => undefined);
    const n = partsIn(clean.of(/^material /)).length;
    t.ok(n >= 3, `the material is several parts (${n})`);
    t.eq(clean.of(/^material /).map((c) => c.label), [`material 1-${n}/${n} db`], "without damage the parts go in one runner, once, under one label");
    t.ok(partsIn(clean.of(/^material /)).every((c) => c.spec.text.length <= 4000), "no part is over 4000 characters");
    t.ok(clean.out.stoppedAt && /^review \(the fake stops here\)/.test(clean.out.stoppedAt) && clean.of(/^review$/).length === 1, `an undamaged run reaches the review (${clean.out.stoppedAt})`);
    // Every helper command of a prompt carries its spec as b64: a runner of a batch sends several, and one plain-JSON command among them must fail this check.
    for (const c of clean.calls.filter((x) => / -- "\$\(pwd -W/.test(x.prompt))) {
      const k = commandsB64(c.prompt);
      t.ok(k.total > 0 && k.matched === k.total && k.plain.length === 0, `${c.label}: every one of its ${k.total} helper commands carries its spec as b64: (${k.matched} read, plain: ${JSON.stringify(k.plain.map((p) => p.command))})`);
    }
    // The check itself: the same batch with one command (the second) typed as plain JSON is not accepted, and neither is one that cannot be read as a command at all.
    const batch = partsIn(clean.of(/^material /))[1];
    const batchPrompt = clean.of(/^material /)[0].prompt;
    const quoted = (text) => `'${text.replace(/'/g, "'\\''")}'`;
    const oneJson = batchPrompt.replace(` '${batch.arg}'`, () => ` ${quoted(JSON.stringify(batch.spec))}`);
    t.ok(oneJson !== batchPrompt, "the probe: one command of the batch is rewritten as plain JSON");
    const probe = commandsB64(oneJson);
    t.ok(probe.total > 0 && probe.matched === probe.total && probe.plain.length === 1, `a batch with one plain-JSON command fails the check: it is found (plain: ${JSON.stringify(probe.plain.map((p) => p.command))})`);
    const probe2 = commandsB64(batchPrompt.replace(` '${batch.arg}'`, () => ` "${batch.arg}"`));
    t.ok(probe2.matched !== probe2.total, "and so does a command whose argument is not one single-quoted word");

    // The last characters of the argument dropped, in two ways: a broken length, and a base64 that is valid but of a cut text.
    const second = 2;
    const pickSecond = (_label, attempt, part) => attempt === 1 && part === second;
    for (const [name, damage] of [
      ["the last 3 characters dropped", cut(3)],
      ["the last 4 characters dropped (valid base64, cut JSON)", cut(4)],
      // The helper answers this one exactly as a copy that does not read b64: does ("Unexpected token 'b'"): after the gate answered, it is damage.
      ["the colon of b64: dropped", (_label, arg) => arg.replace(/^b64:/, "b64")],
    ]) {
      const r = await run(when(pickSecond, damage));
      const runners = r.of(/^material /);
      everyPromptB64(t, r, name);
      t.ok(r.out.stoppedAt && /^review \(the fake stops here\)/.test(r.out.stoppedAt) && r.of(/^review$/).length === 1 && r.of(/^preflight /).length === 1, `${name}: the run reaches the review (${r.out.stoppedAt})`);
      t.eq(runners.map((c) => c.label), [`material 1-${n}/${n} db`, `material ${second}/${n} again db`], `${name}: one runner for the batch, then one more for the damaged part, under a label of its own`);
      t.eq(partsIn(runners.slice(1)).map((c) => c.spec.part), [second], `${name}: only the damaged part is sent again`);
      t.eq(new Set(runners.map((c) => c.label)).size, runners.length, `${name}: no two runners share a label, so the journal cannot hand back the bad answer`);
    }
    // The text of a part changed but still a valid spec: the helper takes it, the hash of what it got is not the part's.
    const altered = await run(when(pickSecond, (_l, arg) => changed(arg)));
    everyPromptB64(t, altered, "a part with another text");
    t.ok(/^review \(the fake stops here\)/.test(altered.out.stoppedAt || "") && altered.of(/^material .* again /).length === 1, `a part whose hash differs is sent again and the run reaches the review (${altered.out.stoppedAt})`);

    // Both attempts damaged: the run stops, with the stop text it had.
    const twice = await run((_label, arg, _attempt, part) => (part === second ? arg.slice(0, -3) : undefined));
    everyPromptB64(t, twice, "a part damaged twice");
    t.ok(/^review \(part 2 of the material was not written: the material helper \(part 2\): /.test(twice.out.stoppedAt || ""), `a part damaged twice stops the run (${twice.out.stoppedAt})`);
    t.ok(twice.of(/^preflight /).length === 0 && twice.of(/^review$/).length === 0, "nothing was preflighted or sent to the gateway");
    t.eq(partsIn(twice.of(/^material /)).filter((c) => c.spec.part === second).length, 2, "the part was sent twice, not more");
    t.eq(twice.of(/^material /).length, 2, "two runners: the batch and the one that sent the damaged part again");
    const hash = await run((_label, arg, _attempt, part) => (part === second ? changed(arg) : undefined));
    everyPromptB64(t, hash, "a part with a wrong hash twice");
    t.ok(/^review \(part 2 of the material did not reach the helper exactly \(its sha256 differs\)\)/.test(hash.out.stoppedAt || "") && hash.of(/^review$/).length === 0, `a part whose hash differs twice stops the run with the hash text (${hash.out.stoppedAt})`);
    // A fault in the first part is reported first, as before.
    const both = await run((_label, arg, _attempt, part) => (part <= 2 ? arg.slice(0, -3) : undefined));
    everyPromptB64(t, both, "two parts damaged");
    t.ok(/^review \(part 1 of the material was not written/.test(both.out.stoppedAt || ""), "when several parts fail twice, the first is named");
    t.eq(both.of(/^material /).map((c) => c.label), [`material 1-${n}/${n} db`, `material 1/${n} again db`, `material 2/${n} again db`], "the damaged parts of a batch are sent again one runner each, the part that arrived is not sent again");
    // A runner that returned nothing at all (the whole batch failed): every part of it is sent again, each alone by a fresh runner of its own, and the run goes on.
    const lost = await run(() => undefined, { lose: (label) => label === `material 1-${n}/${n} db` });
    everyPromptB64(t, lost, "a batch that returned nothing, sent again part by part");
    // A resend is checked as a prompt of its own: its one command as plain JSON fails the check, as in the first batch.
    const resend = lost.of(/^material .* again /)[0].prompt, resendCmd = partsIn(lost.of(/^material .* again /))[0];
    const resendPlain = commandsB64(resend.replace(` '${resendCmd.arg}'`, () => ` ${quoted(JSON.stringify(resendCmd.spec))}`));
    t.ok(resendPlain.total > 0 && resendPlain.plain.length === 1, `a resend with its command as plain JSON fails the check (plain: ${JSON.stringify(resendPlain.plain.map((p) => p.command))})`);
    t.ok(/^review \(the fake stops here\)/.test(lost.out.stoppedAt || "") && lost.of(/^material /).map((c) => c.label).join() === [`material 1-${n}/${n} db`, ...Array.from({ length: n }, (_, k) => `material ${k + 1}/${n} again db`)].join(), `a batch that returned no result has each of its parts sent again alone and the run reaches the review (${lost.out.stoppedAt}; ${lost.of(/^material /).map((c) => c.label)})`);
  });

  scenario("spec-b64-material-long-folder", "the material is cut by the size of the whole spec: with a long review folder and the heaviest text the parts are smaller than 4000 characters, every one still goes as b64: within the cap, and they rejoin exactly", async (t) => {
    // 5 folders of 200 letters: about 1000 bytes in every part's spec, so 2000 four-byte code points (8000 bytes, the most a part of 4000 characters holds) no longer fit beside it.
    const tail = Array.from({ length: 5 }, (_, i) => `/${String.fromCharCode(97 + i).repeat(200)}`).join("");
    const emoji = (repo) => Array.from({ length: 4 }, (_, i) => ({ claim: "😀".repeat(2500), source: `${repo}/src/export.js:${i + 1}` }));
    // macOS refuses a path over 1024 bytes (PATH_MAX), so the helper cannot write into a 1000-character folder there and such a folder cannot occur.
    // The cut by the whole spec is the same code on every platform; it runs on Windows and Linux. The folder-too-long stop below needs no folder.
    if (process.platform === "darwin") {
      const huge = await run(() => undefined, { tmpTail: Array.from({ length: 45 }, (_, i) => `/${"x".repeat(200)}${i}`).join("") });
      t.ok(/^review \(the review folder name is too long/.test(huge.out.stoppedAt || "") && huge.of(/^material /).length === 0, `a folder with no room stops the run (${huge.out.stoppedAt})`);
      return { skip: "macOS: a review folder over 1024 bytes cannot be created (PATH_MAX); the long-folder cut runs on Windows and Linux" };
    }
    const r = await run(() => undefined, { tmpTail: tail, facts: emoji });
    const calls = r.of(/^material /);
    const parts = partsIn(calls);
    const dir = parts.length ? parts[0].spec.dir : "";
    t.ok(dir.length > 1000, `the review folder of the run is long (${dir.length} characters)`);
    t.ok(parts.length >= 6, `the material is several parts (${parts.length})`);
    t.eq(calls.length, Math.ceil(parts.length / 8), "sent by one runner for every 8 parts");
    t.ok(parts.every((c) => /^b64:[A-Za-z0-9+/]+={0,2}$/.test(c.arg)), "every part goes as b64:, none as plain JSON");
    const lens = parts.map((c) => c.spec.text.length);
    t.ok(lens.every((n) => n <= 4000) && lens.some((n) => n < 4000), `no part is over 4000 characters and the folder made some smaller (largest ${Math.max(...lens)}, smallest ${Math.min(...lens)})`);
    t.ok(parts.every((c) => c.arg.length <= 4000), "every argument is within the 4000-character cap");
    const joined = parts.map((c) => c.spec).sort((x, y) => x.part - y.part);
    t.ok(joined.every((x, i) => x.part === i + 1 && x.of === parts.length), "the parts are numbered 1..n of n");
    const text = joined.map((x) => x.text).join("");
    t.eq(JSON.parse(text).facts.length, 4, "the parts rejoin to the material JSON");
    t.ok(/^review \(the fake stops here\)/.test(r.out.stoppedAt || "") && r.of(/^material .* again /).length === 0, `the run reaches the review with no part sent again (the helper's hash of each part and of the whole matched; ${r.out.stoppedAt})`);
    // A folder so long that nothing fits beside it stops before anything is sent, with its own text.
    const huge = await run(() => undefined, { tmpTail: Array.from({ length: 45 }, (_, i) => `/${"x".repeat(200)}${i}`).join("") });
    t.ok(/^review \(the review folder name is too long/.test(huge.out.stoppedAt || "") && huge.of(/^material /).length === 0, `a folder with no room stops the run (${huge.out.stoppedAt})`);
  });

  scenario("spec-b64-quote-escape", "the shared reader of the scenarios undoes exactly the shell escape q() of the workflows writes (an apostrophe is four characters), and writes exactly that escape when it shows a b64: argument as plain JSON", async (t) => {
    const ESC = String.raw`'\''`;
    t.eq(ESC.length, 4, "the escape is four characters: apostrophe, backslash, apostrophe, apostrophe");
    for (const name of WORKFLOWS) {
      const ctx = vm.createContext({});
      vm.runInContext(`${helperOf(name).src.match(/^const q = [^\n]*$/m)[0]}\nglobalThis.q = q`, ctx);
      const q = ctx.q;
      t.eq(q("it's"), `'it${ESC}s'`, `${name}: q() writes an apostrophe as the four-character escape`);
      for (const text of ["it's", "'", "''", "a'b'c", "\'", "x\\'' y", "Привет, it's 😀"]) t.eq(unquote(q(text).slice(1, -1)), text, `${name}: unquote of the inside of q(${JSON.stringify(text)}) is the text`);
    }
    const spec = { api: 1, text: "it's a test", list: ["'", "\'"] };
    const b64Prompt = `run it\n -- "$(pwd -W 2>/dev/null || pwd)" claim '${encodeSpec(spec)}'\nthen stop`;
    const shown = plainPrompt(b64Prompt);
    t.ok(shown.includes(`claim '${JSON.stringify(spec).replace(/'/g, ESC)}'\n`), "plainPrompt writes the apostrophes of the plain JSON as the same escape q() writes");
    t.ok(!shown.includes("b64:"), "and leaves no b64: argument in the text it shows");
    t.eq(specIn(shown, "claim"), spec, "the plain form it shows is read back to the same spec (apostrophes survive the round trip)");
    t.eq(specIn(b64Prompt, "claim"), spec, "the b64: form of the same prompt gives the same spec");
    t.eq(commandsIn(shown, "claim").map((c) => c.arg), [JSON.stringify(spec)], "the unquoted argument is the plain JSON text");
  });

  /** What a helper copy of before b64: answers: exit 2 and the error JSON.parse makes of "b64:..." (the text of this Node, and the text of an older Node). */
  const OLD_ANSWERS = [
    (() => { try { JSON.parse(enc("{}")); } catch (e) { return `the spec is not JSON: ${e.message}`; } throw new Error("JSON.parse took b64:"); })(),
    "the spec is not JSON: Unexpected token b in JSON at position 0",
  ];
  const errorLine = (error) => JSON.stringify({ ok: false, api: 1, error });
  /** One workflow run to its first helper answer: every agent call is answered with the given runner result. */
  async function runFirst(name, answer, extra = {}) {
    const dir = `${SCRATCH}/first-${++runs}`;
    fs.mkdirSync(dir, { recursive: true });
    const ARGS = {
      "code-package": { label: "pkg", brief: `${dir}/brief.md`, repo: dir, files: ["src/a.js"], tmp: `${dir}/.agent-tmp/pkg`, checks: ["node t.js"], models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } },
      "design-brief": { label: "db", goal: "Make the export resumable.", repos: [dir], questions: ["How?"], out: `${dir}/brief.md`, tmp: `${dir}/.agent-tmp/db` },
      "incident-triage": { incident: "inc-1", tmp: `${dir}/tmp`, adapter: `${dir}/adapter.json`, report: "The export stopped." },
      "ops-script": { script: `${dir}/ops.sh`, tmp: `${dir}/tmp`, sudo: "sudo bash ops.sh" },
    }[name];
    const calls = [];
    const sandbox = {
      args: { ...ARGS, ...extra }, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt }); return answer; },
    };
    const src = fs.readFileSync(path.join(ROOT, "core", "workflows", `${name}.js`), "utf8").replace(/^export const meta/, "const meta");
    const out = await vm.runInNewContext(`(async () => {\n${src}\n})`, sandbox, { filename: `${name}.js` })();
    return { out, calls };
  }
  const OLD_STOP = (at) => new RegExp(`the zodchi-core copy ${at} is older than this workflow \\(it does not read b64: specs\\): rerun the installer, reload plugins, or pass args.pluginRoot of a current copy`);

  scenario("spec-b64-old-helper", "a helper copy of before b64: (it answers a b64: spec with exit 2 and 'the spec is not JSON: Unexpected token b...') stops every workflow with a text that names the cause and the way out, with no plain-JSON fallback; every other answer keeps its own text", async (t) => {
    for (const name of WORKFLOWS) {
      for (const error of OLD_ANSWERS) {
        const answer = { exitCode: 2, stdout: `${errorLine(error)}\n` };
        const bare = await runFirst(name, answer);
        const stop = String(bare.out.stoppedAt);
        t.ok(OLD_STOP("this session loaded").test(stop) && !stop.includes(error), `${name}: the stop names the old copy and the way out, not the bare parse error (${stop.slice(0, 230)})`);
        t.eq(bare.calls.length, 1, `${name}: it stopped at the first helper answer; nothing else was asked`);
        t.ok(/ 'b64:[A-Za-z0-9+/]+={0,2}'\n/.test(bare.calls[0].prompt), `${name}: that first command did go as b64:`);
        const named = await runFirst(name, answer, { pluginRoot: "/old/core" });
        t.ok(OLD_STOP("at /old/core").test(String(named.out.stoppedAt)), `${name}: with args.pluginRoot the stop names that folder (${String(named.out.stoppedAt).slice(0, 120)})`);
      }
      // Anything else keeps its own text: another error with exit 2, a failure of a current helper, the old text with another exit code.
      for (const [what, answer, want] of [
        ["a bad base64 told by a current helper", { exitCode: 2, stdout: `${errorLine("the spec is not valid base64 (b64: must be followed by standard base64 with its = padding)")}\n` }, /not valid base64/],
        ["a plain JSON failure of the helper", { exitCode: 2, stdout: `${errorLine("the spec is not JSON: Unexpected token '{', \"{\\\"api\\\":1\"... is not valid JSON")}\n` }, /the spec is not JSON: Unexpected token '\{'/],
        ["exit 1 with the old text", { exitCode: 1, stdout: `${errorLine(OLD_ANSWERS[0])}\n` }, /the spec is not JSON/],
      ]) {
        const r = await runFirst(name, answer);
        const stop = String(r.out.stoppedAt);
        t.ok(want.test(stop) && !/older than this workflow/.test(stop), `${name}: ${what} is not taken for an old copy (${stop.slice(0, 160)})`);
      }
    }
    // design-brief, a material part answered with the old copy's text after the gate answered a b64: spec: the copy reads b64:, so this is damage, not an
    // old copy. The part is sent once more and, answered the same way again, the run stops before the review with the usual text, not the reinstall one.
    const r = await run(() => undefined, { oldHelperLine: errorLine(OLD_ANSWERS[0]) });
    t.ok(!/older than this workflow/.test(r.out.stoppedAt || "") && /^review \(part \d+ of the material was not written: /.test(r.out.stoppedAt || "") && r.of(/^material .* again /).length >= 1 && r.of(/^preflight /).length === 0 && r.of(/^review$/).length === 0, `design-brief: the old copy's text on a material part after the gate is damage: sent again, then the usual stop before the review (${String(r.out.stoppedAt).slice(0, 200)})`);
  });

  scenario("spec-b64-too-many-parts", "the 200-part limit and its message are kept with the larger parts and the batches", async (t) => {
    const src = SRC();
    t.ok(/const MATERIAL_PART = 4000\n/.test(src), "a part is 4000 characters");
    t.ok(/materialParts\.length > 200\) return stopPre\(`the facts of the research are too many to send \(\$\{materialText\.length\} characters in \$\{materialParts\.length\} parts, at most 200\)`/.test(src), "over 200 parts stops the run with the same text");
  });
}
