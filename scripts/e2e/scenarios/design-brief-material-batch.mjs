// Research slots, checked manifests and resume through the workflow and the real file helper.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { commandsIn } from "../spec-arg.mjs";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MARK = "<!-- design-brief: db -->";
const BRIEF = `${MARK}\n# Title\n\n## Goal\nMake the export resumable.\n\n## Review boundary\nImportant: a lost row.\n\n## Checks\nnode scripts/check.mjs\n`;
const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
const ROLES = {
  writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] },
  architect: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }] },
};

export default function register({ scenario, ROOT, scratch }) {
  const gate = path.join(ROOT, "core", "scripts", "gate.mjs");
  const src = fs.readFileSync(path.join(ROOT, "core", "workflows", "design-brief.js"), "utf8").replace(/^export const meta/, "const meta");

  function fixture() {
    const repo = fs.mkdtempSync(path.join(scratch, "slots-")).replace(/\\/g, "/");
    const tmp = `${repo}/run`;
    const questions = ["Where is state kept?", "What is written?", "How is it checked?"];
    const args = { label: "db", tmp, goal: "Resume the export", questions, repos: [repo], out: `${repo}/brief.md` };
    const journal = new Map();
    const claims = questions.map((_, i) => `Research evidence ${i + 1} ${"recorded ".repeat(2400).trim()}`);
    fs.writeFileSync(`${repo}/source.md`, "first\nsecond\nthird\n");
    async function run({ receipt, changeCommand } = {}) {
      const calls = [], commands = [];
      const agent = async (prompt, opts) => {
        const key = JSON.stringify([prompt, opts]);
        if (journal.has(key)) return journal.get(key);
        const { label } = opts;
        calls.push({ label, prompt, opts });
        let result;
        if (label === "gate db") {
          const stdout = JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, account: { connected: true }, roles: ROLES, ignoreExit: 0 });
          result = { exitCode: 0, stdout };
        } else if (label.startsWith("facts ")) {
          const slot = parseInt(label.slice(6), 10);
          const file = `${tmp}/facts/${slot}.json`;
          if (!prompt.includes(`Write only the assigned UTF-8 JSON file ${file}.`)) throw new Error("wrong assigned slot");
          const body = JSON.stringify({ facts: [{ claim: claims[slot - 1], source: `${repo}/source.md:${slot}` }], unknowns: [] });
          fs.writeFileSync(file, body);
          result = { path: file, count: 1, sha256: sha(body) };
          if (receipt) result = receipt(slot, label, result);
        } else if (label === "draft db") {
          fs.writeFileSync(args.out, BRIEF);
          result = { done: true, summary: "written", ownerDecisions: [] };
        } else if (label === "review") {
          result = { ok: false, summary: "attachment captured", gateway: "final", infra: "" };
        } else {
          const [cmd] = commandsIn(prompt, "brief-manifest|brief-inspect|brief-preflight");
          commands.push(cmd);
          const arg = changeCommand ? changeCommand(cmd, label) : cmd.arg;
          const res = spawnSync(process.execPath, [gate, cmd.command, arg], { encoding: "utf8", windowsHide: true });
          result = { exitCode: res.status, stdout: res.stdout, error: res.stderr };
        }
        journal.set(key, result);
        return result;
      };
      const sandbox = {
        args, agent, phase: () => {}, log: () => {},
        parallel: thunks => Promise.all(thunks.map(async thunk => {
          try { const v = await thunk(); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
          catch { return null; }
        })),
      };
      const out = await vm.runInNewContext(`(async () => {\n${src}\n})()`, sandbox, { filename: "design-brief.js" });
      return { out, calls, commands, researchers: calls.filter(c => c.label.startsWith("facts ")).map(c => c.label) };
    }
    return { run, args, tmp, claims };
  }

  scenario("design-brief-facts-files", "three researchers write three files and only a damaged receipt is retried", async t => {
    for (const fault of ["hash", "count", "throw"]) {
      const { run, args, tmp, claims } = fixture();
      const r = await run({ receipt(slot, label, report) {
        if (slot !== 2 || label.endsWith("again")) return report;
        if (fault === "throw") throw new Error("researcher interrupted");
        return fault === "hash" ? { ...report, sha256: "0".repeat(64) } : { ...report, count: 2 };
      } });
      t.eq(r.researchers, ["facts 1", "facts 2", "facts 3", "facts 2 again"], `only slot 2 repeats after ${fault}`);
      t.eq(fs.readdirSync(`${tmp}/facts`).sort(), ["1.json", "2.json", "3.json"], "one file per slot");
      const inputSha256 = sha(fs.readFileSync(`${tmp}/manifest/input/entry.json`));
      const entries = [], facts = [];
      for (let slot = 1; slot <= 3; slot++) {
        const file = `${tmp}/facts/${slot}.json`;
        const bytes = fs.readFileSync(file);
        const entry = JSON.parse(fs.readFileSync(`${tmp}/manifest/${slot}/entry.json`, "utf8"));
        t.eq(entry, { slot, path: file, count: 1, sha256: sha(bytes), inputSha256 }, "manifest pins the researcher bytes");
        entries.push(entry);
        facts.push({ id: `T${slot}`, ...JSON.parse(bytes).facts[0], question: slot });
      }
      const expected = { label: "db", questions: args.questions, facts, unknowns: [] };
      const hash = sha(JSON.stringify(expected, null, 2) + "\n");
      const review = r.calls.find(c => c.label === "review");
      t.ok(review && review.prompt.includes(`--attach '${tmp}/review/facts.json'`), "the review attaches the assembled facts");
      t.eq(sha(fs.readFileSync(`${tmp}/review/facts.json`)), hash, "the attachment hash covers exactly the ordered facts");
      const draft = r.calls.find(c => c.label === "draft db");
      t.ok(draft.prompt.includes(`${tmp}/facts.json (sha256 ${hash})`), "the writer receives the same verified facts by file");
      const [open] = r.commands.filter(c => c.spec.input);
      t.ok(open.arg.startsWith("b64:") && open.arg.length <= 4000, "the research input fits one bounded argument");
      t.eq([open.spec.input.goal, open.spec.input.questions.map(q => q.question), open.spec.inputSha256],
        [args.goal, args.questions, inputSha256], "the manifest binds the exact goal and ordered questions");
      const pre = r.commands.find(c => c.command === "brief-preflight");
      t.eq(pre.spec.manifestSha256, sha(JSON.stringify({ inputSha256, entries })), "preflight pins the same ordered receipts");
      for (const claim of claims) {
        const marker = claim.slice(0, claim.indexOf("recorded"));
        t.ok(r.calls.every(c => !c.prompt.includes(marker)) && r.commands.every(c => !JSON.stringify(c.spec).includes(marker)),
          "even the beginning of the claim is absent from prompts and decoded commands");
      }
    }
  });

  scenario("design-brief-manifest-resume", "a resume checks live files and runs only missing researchers", async t => {
    const { run, args, tmp } = fixture();
    const first = await run({ receipt: (slot, label, report) => slot === 2 ? { ...report, count: 5 } : report });
    t.ok(first.out.stoppedAt.includes("incomplete") && !fs.existsSync(`${tmp}/review`), "a twice-rejected slot stops before the draft and review");
    const resumed = await run();
    t.eq(resumed.researchers, ["facts 2"], "resume reuses slots 1 and 3");
    t.ok(resumed.calls.some(c => c.label === "review"), "the completed manifest reaches review");
    const file = `${tmp}/facts/3.json`;
    fs.appendFileSync(file, " ");
    const changed = await run();
    t.ok(changed.out.stoppedAt.includes("accepted slot 3 changed") && changed.researchers.length === 0, "changed accepted bytes stop even with journaled successes");
    args.questions.reverse();
    const reordered = await run();
    t.ok(reordered.out.stoppedAt.includes("different inputs") && !reordered.researchers.length, "another question order cannot reuse the folder");
  });

  scenario("design-brief-input-resend", "one resend repairs damaged goal bytes and oversized inputs stop before research", async t => {
    for (const twice of [false, true]) {
      const { run, tmp } = fixture();
      const wrongFolder = tmp + "-damaged";
      const r = await run({ changeCommand(cmd, label) {
        if (!cmd.spec.input || (!twice && label.includes("again"))) return cmd.arg;
        const spec = { ...cmd.spec, tmp: wrongFolder, input: { ...cmd.spec.input, tmp: wrongFolder, goal: "changed" } };
        return "b64:" + Buffer.from(JSON.stringify(spec)).toString("base64");
      } });
      t.eq(r.commands.filter(c => c.spec.input).length, 2, "one resend");
      t.ok(!fs.existsSync(wrongFolder), "a damaged opening command creates nothing at its destination");
      t.eq(r.calls.some(c => c.label === "review"), !twice, "only the original input can reach the review");
      if (twice) t.ok(!r.researchers.length && r.out.stoppedAt.includes("expected hash"), "two damaged commands stop before research");
    }
    const { run, args } = fixture();
    args.goal = "x".repeat(4000);
    const large = await run();
    t.ok(large.out.stoppedAt.includes("4000-character") && large.commands.length === 0, "oversized inputs stop before any manifest command");
  });
}
