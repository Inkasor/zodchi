// Gate argument encoding, damage detection, size limits and compatibility with older helpers.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { unquote, plainPrompt, commandsIn, encodeSpec, specIn } from "../spec-arg.mjs";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
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

  scenario("spec-b64-roundtrip", "the manifest helper receives the exact UTF-8 goal and questions in either argument form", async (t) => {
    const dir = scratch(t, "round");
    for (const [name, encode] of [["plain", text => text], ["b64", enc]]) {
      const tmp = `${dir}/${name}`;
      const input = { label: "round", tmp, goal: HARD, questions: [{ question: HARD }], repos: [dir], publicRepo: false };
      const inputSha256 = sha(JSON.stringify(input));
      const r = gate(t, "brief-manifest", encode(JSON.stringify({ api: 1, tmp, input, inputSha256 })));
      t.ok(r.code === 0 && r.json.ok, `${name}: the helper accepts the inputs`);
      t.eq(r.json.inputSha256, inputSha256, "the input hash matches");
      t.eq(fs.readFileSync(`${tmp}/manifest/input/entry.json`, "utf8"), JSON.stringify(input), "the exact text reached the file");
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

  let runs = 0;
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-b64-run-")).replace(/\\/g, "/");
  process.on("exit", () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });
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
    const dir = `${SCRATCH}/first-${String(++runs).padStart(3, "0")}`;
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
      // As the Workflow runtime: a thunk result reaches the script as plain data (JSON), and a thunk that throws comes back as null.
      parallel: (thunks) => Promise.all(thunks.map(async (th) => { try { const v = await th(); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } })),
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
  });
}
