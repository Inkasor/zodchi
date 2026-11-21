// Research slots and recovery from a checked manifest through the workflow and the real file helper.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commandsIn } from "../spec-arg.mjs";
import { runDesignBrief } from "./design-brief.mjs";

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
  const src = fs.readFileSync(path.join(ROOT, "core", "workflows", "design-brief.js"), "utf8");

  function fixture() {
    const repo = fs.mkdtempSync(path.join(scratch, "slots-")).replace(/\\/g, "/");
    const tmp = `${repo}/run`;
    const questions = ["Where is state kept?", "What is written?", "How is it checked?"];
    const args = { label: "db", tmp, goal: "Resume the export", questions, repos: [repo], out: `${repo}/brief.md` };
    const claims = questions.map((_, i) => `Research evidence ${i + 1} ${"recorded ".repeat(2400).trim()}`);
    fs.writeFileSync(`${repo}/source.md`, "first\nsecond\nthird\n");
    async function run({ receipt, changeCommand, planned, changeQuestions, previousOpen } = {}) {
      const calls = [], commands = [];
      const agent = async (prompt, opts) => {
        const { label } = opts;
        const call = { label, prompt, opts };
        calls.push(call);
        let result;
        if (label === "gate db") {
          const stdout = JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, account: { connected: true }, roles: ROLES, ignoreExit: 0 });
          result = { exitCode: 0, stdout };
        } else if (label === "plan db") {
          result = { questions: planned };
        } else if (previousOpen && previousOpen.prompt === prompt) {
          return previousOpen.result;
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
          let fd;
          if (cmd.spec.questionsFromFile) {
            const questions = JSON.parse(prompt.split("\n").find(line => line.startsWith("[{")));
            fs.mkdirSync(tmp, { recursive: true });
            const file = `${tmp}/plan-${commands.length}.json`;
            fs.writeFileSync(file, JSON.stringify(changeQuestions ? changeQuestions(questions, label) : questions));
            fd = fs.openSync(file, "r");
          }
          try {
            const res = spawnSync(process.execPath, [gate, cmd.command, arg], {
              encoding: "utf8", windowsHide: true, stdio: [fd ?? "ignore", "pipe", "pipe"],
            });
            result = { exitCode: res.status, stdout: res.stdout, error: res.stderr };
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
          }
        }
        if (label.startsWith("open research")) call.result = result;
        return result;
      };
      const sandbox = {
        args, agent, phase: () => {}, log: () => {},
        parallel: thunks => Promise.all(thunks.map(async thunk => {
          try { const v = await thunk(); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
          catch { return null; }
        })),
      };
      const out = await runDesignBrief(src, sandbox);
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

  scenario("design-brief-manifest-recovery", "a fresh run checks live files and asks only researchers whose receipts are missing", async t => {
    const { run, args, tmp } = fixture();
    const first = await run({ receipt: (slot, label, report) => slot === 2 ? { ...report, count: 5 } : report });
    t.ok(first.out.stoppedAt.includes("incomplete") && !fs.existsSync(`${tmp}/review`), "a twice-rejected slot stops before the draft and review");
    t.ok(first.out.next.includes("fresh run with the same args.tmp"), "the stop explains how to reuse the manifest");
    const fresh = await run();
    t.eq(fresh.researchers, ["facts 2"], "the fresh run reuses slots 1 and 3");
    t.ok(fresh.calls.some(c => c.label === "review"), "the completed manifest reaches review");
    const file = `${tmp}/facts/3.json`;
    fs.appendFileSync(file, " ");
    const changed = await run();
    t.ok(changed.out.stoppedAt.includes("accepted slot 3 changed") && changed.researchers.length === 0, "changed accepted bytes stop before research");
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
    t.ok(/shorten.*goal/i.test(large.out.next) && !large.researchers.length, "the next step names the supplied goal");
  });

  scenario("design-brief-long-planner-questions", "file-backed planner questions retain their order and hash through review", async t => {
    for (const damaged of [false, true]) {
      const { args, tmp, run } = fixture();
      delete args.questions;
      const planned = ["first", "second", "third"].map(word => ({
        question: `Where is ${word} ${"é🐾".repeat(900)}?`, repo: args.repos[0], files: ["source.md"],
      }));
      const r = await run({ planned, changeQuestions: questions => damaged ? questions.reverse() : questions });
      const opens = r.commands.filter(c => c.spec.input);
      t.ok(opens.length > 0 && opens.every(c => c.spec.questionsFromFile && c.arg.startsWith("b64:") && c.arg.length <= 4000),
        "each opening command fits the research argument limit");
      if (damaged) {
        t.ok(r.out.stoppedAt.includes("expected hash") && !r.researchers.length && !fs.existsSync(`${tmp}/manifest`), "reordered file is refused before the manifest or research");
      } else {
        const header = fs.readFileSync(`${tmp}/manifest/input/entry.json`, "utf8");
        t.eq(sha(header), opens[0].spec.inputSha256, "the workflow bound the exact manifest input");
        t.eq(JSON.parse(header).questions, planned.map(q => ({ ...q, files: [`${args.repos[0]}/source.md`] })), "every question and resolved hint reaches its slot");
        t.eq(r.researchers, ["facts 1", "facts 2", "facts 3"], "all three slots reach research");
        t.ok(r.calls.some(c => c.label === "review"), "the run reaches review");
        t.eq(JSON.parse(fs.readFileSync(`${tmp}/review/facts.json`)).questions, planned.map(q => q.question), "review gets the same ordered questions");
      }
    }
  });

  scenario("design-brief-reports-digest", "empty lists have a digest and dropping a receipt list stops before another researcher round", async t => {
    const { run } = fixture();
    const r = await run({ changeCommand(cmd) {
      if (!cmd.spec.reports?.length) return cmd.arg;
      const { reports, ...withoutReports } = cmd.spec;
      return "b64:" + Buffer.from(JSON.stringify(withoutReports)).toString("base64");
    } });
    const open = r.commands.find(c => c.spec.input);
    t.eq([open.spec.reports, open.spec.reportsSha256], [[], sha("[]")], "the empty list is bound as well");
    t.ok(r.out.stoppedAt.includes("invalid slot report digest") && r.researchers.length === 3, "a dropped list stops at the helper");
    const badDigest = await fixture().run({ changeCommand(cmd) {
      if (!cmd.spec.input) return cmd.arg;
      const spec = { ...cmd.spec, reportsSha256: "0".repeat(64) };
      return "b64:" + Buffer.from(JSON.stringify(spec)).toString("base64");
    } });
    t.ok(badDigest.out.stoppedAt.includes("invalid slot report digest") && !badDigest.researchers.length, "an incorrect digest for the empty opening list stops before a researcher runs");
  });

  scenario("design-brief-accepted-slot-rerun", "resuming a named researcher reopens the manifest before assigning pending slots", async t => {
    const { args, tmp, run } = fixture();
    const first = await run({ receipt: (slot, label, report) => slot === 2 ? { ...report, count: 5 } : report });
    const accepted = [`${tmp}/facts/1.json`, `${tmp}/manifest/1/entry.json`];
    const snapshot = () => accepted.map(file => fs.readFileSync(file, "utf8"));
    const before = snapshot();
    args.rerun = { "facts 1": 2 };
    const resumed = await run({ previousOpen: first.calls.find(c => c.label === "open research db") });
    t.eq(resumed.researchers, ["facts 2"], "only the unaccepted researcher may write");
    t.eq(snapshot(), before, "accepted bytes and receipt are intact");
    t.ok(resumed.out.notes.some(n => n.includes("facts 1") && n.includes("accepted")) && resumed.calls.some(c => c.label === "review"), "the skipped rerun is explained and review proceeds");
  });
}
