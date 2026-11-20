// design-brief: the material for the review goes in a few runners, not one runner per part.
//
// The workflow (core/workflows/design-brief.js) cuts the JSON of its goal, questions, facts and unknowns into parts as large as the b64:
// argument allows (the whole argument a runner types is at most 4000 characters, MATERIAL_ARG_MAX), and one runner sends a batch of up to 8 parts,
// one helper command after another. Here the workflow runs for real over a fake agent whose runner runs the real helper with each command exactly as
// typed: a material of about 56000 characters (Latin and Cyrillic) goes in as many runners as its parts divided by 8, rounded up, with every argument
// within the cap; a part damaged, failed or unanswered inside a batch is sent again alone by a fresh runner (one runner per part) while the rest are
// not; a batch whose runner answered only its first, failed command still gets its other parts sent, each alone, and the run reaches the review; a
// batch that returned nothing sends all its own parts again, each alone, and no other batch's; the labels of an unchanged run are the same on every
// run (a resumed run finds its finished runners in the journal).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { commandsIn } from "../spec-arg.mjs";

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MARK = "<!-- design-brief: db -->";
const BRIEF = `${MARK}\n# Title\n\n## Goal\nMake the export resumable.\n\n## Review boundary\nImportant: a lost row.\n\n## Checks\nnode scripts/check.mjs\n`;
const HEADINGS = ["# Title", "## Goal", "## What to build", "## Owner decisions", "## Review boundary", "## Checks"];
const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
const ROLES = {
  writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }] },
  architect: { candidates: [{ provider: "codex", model: "gpt-x", effort: "high" }] },
};

export default function register({ scenario, ROOT, scratch }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const SRC = fs.readFileSync(path.join(ROOT, "core", "workflows", "design-brief.js"), "utf8");
  // Under the suite's own scratch folder, which scripts/e2e.mjs removes at the end: nothing is made in the system temp folder.
  const SCRATCH = fs.mkdtempSync(path.join(scratch, "batch-")).replace(/\\/g, "/");
  let runs = 0;
  const ioLine = (facts) => { const body = { ok: true, ...facts, api: 1, plugin: PLUGIN }; return { exitCode: 0, stdout: JSON.stringify({ ...body, lineSha256: sha(JSON.stringify(body)) }) + "\n" }; };

  /**
   * The workflow over a fake agent. `facts(repo)` are the facts the researcher returns. `damage(part, attempt)` returns the argument the fake runner
   * types for a part (or undefined for the correct one); `lose(label)` makes a runner return nothing; `omit(part, attempt)` leaves that part's entry out of the runner's array;
   * `onlyFirst(label)` makes a runner answer its first command only, as a failed one (a runner that stopped its batch there).
   */
  async function run({ facts, damage = () => undefined, lose = () => false, omit = () => false, onlyFirst = () => false, folder = "" }) {
    const repo = `${SCRATCH}/run-${String(++runs).padStart(3, "0")}${folder ? `/${folder}` : ""}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    const args = { label: "db", goal: "Make the export resumable, because a cut run loses an hour.", repos: [repo], questions: ["How is the export written?"], out: `${repo}/.agent-tmp/db/brief.md`, tmp: `${repo}/.agent-tmp/db` };
    const reviewDir = `${args.tmp}/review`;
    const calls = [];
    const sandbox = {
      args, phase: () => {}, log: () => {},
      parallel: (thunks) => Promise.all(thunks.map((th) => th())),
      agent: async (prompt, opts) => {
        const label = opts.label;
        calls.push({ label, prompt, opts });
        if (label === "gate db") return { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, roles: ROLES, modelsErrors: [], account: { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: null }, accountError: "", ignoreExit: 0 }) + "\n" };
        if (label === "facts 1") return { facts: facts(repo), unknowns: [] };
        if (label === "draft db") return { done: true, summary: "wrote", ownerDecisions: [], leftForLater: [], wrongFacts: [], unverified: [] };
        if (label === "inspect draft db") return ioLine({ exists: true, sha256: sha(BRIEF), bytes: BRIEF.length, firstLine: MARK, headings: HEADINGS });
        if (/^material /.test(label)) {
          if (lose(label)) return null;
          const cmds = commandsIn(prompt, "brief-material");
          if ((prompt.match(/node -e /g) || []).length !== cmds.length) throw new Error(`${label}: a command of the prompt is not a brief-material command`);
          if (onlyFirst(label)) return { answers: [{ exitCode: 2, stdout: "", error: "bash: unexpected EOF while looking for matching quote" }] };
          return {
            answers: cmds.filter((c) => !omit(c.spec.part, label.includes(" again ") ? 2 : 1)).map((c) => {
              const arg = damage(c.spec.part, label.includes(" again ") ? 2 : 1, c.arg) ?? c.arg;
              const r = spawnSync(process.execPath, [GATE, "brief-material", arg], { encoding: "utf8", windowsHide: true });
              return { exitCode: r.status ?? -1, stdout: r.stdout || "", error: (r.stderr || "").slice(0, 300) };
            }),
          };
        }
        if (label === "preflight db") {
          const files = fs.existsSync(`${reviewDir}/material`) ? fs.readdirSync(`${reviewDir}/material`).sort((x, y) => parseInt(x, 10) - parseInt(y, 10)) : [];
          const joined = files.map((f) => fs.readFileSync(`${reviewDir}/material/${f}`, "utf8")).join("");
          return ioLine({ publicRepo: false, changed: false, briefSha256: sha(BRIEF), problems: [], inputSha256: sha(joined), written: true, excerpts: { missing: 0 } });
        }
        if (label === "review") return { ok: false, summary: "the fake stops here", gateway: "final", infra: "" };
        throw new Error(`no scripted answer for the step "${label}"`);
      },
    };
    const fn = vm.runInNewContext(`(async () => {\n${SRC.replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "design-brief.js" });
    const out = await fn();
    const material = calls.filter((c) => /^material /.test(c.label));
    return { repo, out, calls, material, parts: material.flatMap((c) => commandsIn(c.prompt, "brief-material")), of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  const reaches = (r) => /^review \(the fake stops here\)/.test(r.out.stoppedAt || "");
  // A fact of the research: a claim of a few sentences and a cited line. Latin, or Cyrillic (two bytes a letter, so a part of 4000 characters is the heaviest ordinary one).
  const LATIN = "The export writes the rows one by one and keeps a checkpoint after each group, so a cut run starts from the last one (see the state file and the retry loop). ";
  const CYRILLIC = "Выгрузка пишет строки по одной и хранит контрольную точку после каждой группы, поэтому прерванный запуск продолжается с последней (см. файл состояния и цикл повторов). ";
  // The workflow takes only a source that is an absolute path inside the repository, so the source carries the scratch path, whose length differs from one machine to another.
  // The claim is cut so that a claim and its source together are always `each` characters: the size of the material does not depend on that length.
  // On a scratch path longer than about 890 characters a claim keeps its 100-character floor, so a fact grows past `each`; `made.extra` holds that growth
  // and the size bounds add it, so no assertion depends on the length of the scratch path.
  const factsOf = (sentence, total) => {
    const made = (repo) => {
      const each = 1000;
      made.extra = 0;
      return Array.from({ length: Math.ceil(total / each) }, (_, i) => {
        const source = `${repo}/src/export.js:${String(i + 1).padStart(3, "0")}`;
        const head = `Fact ${String(i).padStart(3, "0")}: `;
        const fact = { claim: `${head}${sentence.repeat(Math.ceil(each / sentence.length)).slice(0, Math.max(100, each - source.length - head.length))}`.trim(), source };
        made.extra += Math.max(0, fact.claim.length + source.length - each);
        return fact;
      });
    };
    made.extra = 0;
    return made;
  };

  scenario("design-brief-material-batch", "a material of about 56000 characters (Latin or Cyrillic) goes to the helper in as many runners as its parts divided by 8, rounded up, up to 8 commands each, every argument within the 4000-character cap, and the parts rejoin to the material exactly", async (t) => {
    for (const [what, sentence] of [["Latin", LATIN], ["Cyrillic", CYRILLIC]]) {
      const facts = factsOf(sentence, 56000);
      const r = await run({ facts });
      const total = r.parts.reduce((n, c) => n + c.spec.text.length, 0);
      // A claim and its source are 1000 characters together on any ordinary scratch path; facts.extra adds what a very long path forces past that.
      t.ok(total >= 56000 && total <= 60000 + facts.extra, `${what}: the material is about 56000 characters (${total}) in ${r.parts.length} parts`);
      t.ok(r.parts.length > 8 && r.material.length < r.parts.length / 2, `${what}: a handful of runners, not one per part (${r.material.length} runners for ${r.parts.length} parts: ${r.material.map((c) => c.label).join(" | ")})`);
      t.ok(r.material.every((c) => c.opts.agentType === "zodchi-core:runner" && (c.prompt.match(/node -e /g) || []).length <= 8), `${what}: each runner is a Haiku-class runner with at most 8 commands`);
      t.eq(r.material.length, Math.ceil(r.parts.length / 8), `${what}: the runners are the parts divided by 8, rounded up`);
      t.ok(r.parts.every((c) => /^b64:[A-Za-z0-9+/]+={0,2}$/.test(c.arg) && c.arg.length <= 4000), `${what}: every part goes as b64: within the 4000-character cap (largest ${Math.max(...r.parts.map((c) => c.arg.length))})`);
      t.ok(r.parts.every((c) => c.spec.text.length <= 4000), `${what}: no part is over the 4000 characters the helper takes`);
      const ordered = r.parts.map((c) => c.spec).sort((x, y) => x.part - y.part);
      t.ok(ordered.every((x, i) => x.part === i + 1 && x.of === r.parts.length), `${what}: the parts are numbered 1..n of n`);
      t.eq(JSON.parse(ordered.map((x) => x.text).join("")).facts.length, 56, `${what}: the parts rejoin to the material JSON with all 56 facts`);
      t.ok(reaches(r) && r.of(/^material .* again /).length === 0 && r.of(/^preflight /).length === 1, `${what}: the run reaches the review with no part sent again (${r.out.stoppedAt})`);
    }
    // The runner count follows the number of parts divided by what a runner takes (8 parts), not the research part by part.
    const big = await run({ facts: factsOf(LATIN, 112000) });
    t.ok(big.parts.length > 20 && big.material.length === Math.ceil(big.parts.length / 8), `112000 characters: ${big.parts.length} parts in ${big.material.length} runners`);
  });

  scenario("design-brief-material-batch-retry", "a part damaged inside a batch is sent again alone by a fresh runner and the parts that arrived are not; a batch that returned nothing sends again its own parts only, each alone; a part damaged twice stops the run before the preflight; an unchanged run has the same labels", async (t) => {
    const facts = factsOf(LATIN, 56000);
    const clean = await run({ facts });
    const n = clean.parts.length;
    t.ok(n > 8, `the material is more than one batch (${n} parts)`);
    const labels = clean.material.map((c) => c.label);
    const expected = Array.from({ length: Math.ceil(n / 8) }, (_, b) => { const from = b * 8 + 1; const to = Math.min(n, from + 7); return `material ${from === to ? from : `${from}-${to}`}/${n} db`; });
    t.eq(labels, expected, "a batch is labelled by its parts' numbers and the count");
    const again = await run({ facts });
    t.eq(again.material.map((c) => c.label), labels, "an unchanged run gets the same labels, so a resumed run finds the finished runners in the journal");
    // The two runs differ only in their scratch folder, which has the same length; a part boundary may fall inside a path, so the parts are
    // compared by number and length and the joined material with the folder replaced.
    const shape = (r) => r.parts.map((c) => [c.spec.part, c.spec.of, c.spec.text.length]);
    const joined = (r) => r.parts.map((c) => c.spec.text).join("").split(r.repo).join("<repo>");
    t.eq(shape(again), shape(clean), "and the same parts, in the same order");
    t.ok(joined(again) === joined(clean), "and the same material in them");

    // A part of the second batch damaged: dropped end of the argument, or valid base64 of another text.
    const inSecond = 10;
    for (const [what, damage] of [["its argument cut short", (part, attempt, arg) => (part === inSecond && attempt === 1 ? arg.slice(0, -3) : undefined)], ["another text", (part, attempt, arg) => {
      if (part !== inSecond || attempt !== 1) return undefined;
      const spec = JSON.parse(Buffer.from(arg.slice(4), "base64").toString("utf8"));
      spec.text = `${spec.text.slice(0, -1)}#`;
      return `b64:${Buffer.from(JSON.stringify(spec), "utf8").toString("base64")}`;
    }]]) {
      const r = await run({ facts, damage });
      t.ok(reaches(r) && r.of(/^preflight /).length === 1, `${what}: the run reaches the review (${r.out.stoppedAt})`);
      t.eq(r.material.map((c) => c.label), [...labels, `material ${inSecond}/${n} again db`], `${what}: the batches once, then one fresh runner for the damaged part under a label of its own`);
      t.eq(r.material.slice(labels.length).flatMap((c) => commandsIn(c.prompt, "brief-material")).map((c) => c.spec.part), [inSecond], `${what}: only that part is sent again, alone`);
    }
    // Two damaged parts of one batch are sent again one runner each; the part between them that arrived is not sent again.
    const two = await run({ facts, damage: (part, attempt, arg) => ((part === 2 || part === 4) && attempt === 1 ? arg.slice(0, -3) : undefined) });
    t.eq(two.material.slice(labels.length).flatMap((c) => commandsIn(c.prompt, "brief-material")).map((c) => c.spec.part), [2, 4], "two damaged parts of a batch are sent again, those two only");
    t.eq(two.material.slice(labels.length).map((c) => c.label), [`material 2/${n} again db`, `material 4/${n} again db`], "each alone, in a fresh runner of its own, never as a batch again");
    t.ok(reaches(two), `the run reaches the review (${two.out.stoppedAt})`);
    // A batch whose runner returned nothing: each of its parts is sent again alone, and no part of the other batch.
    const lost = await run({ facts, lose: (label) => label === labels[0] });
    t.eq(lost.of(/^material /).map((c) => c.label), [...labels, ...Array.from({ length: 8 }, (_, k) => `material ${k + 1}/${n} again db`)], "a lost batch has each of its 8 parts sent again by a fresh runner of its own, the other batch is not");
    t.ok(reaches(lost), `and the run reaches the review (${lost.out.stoppedAt})`);
    // Damaged both times: the stop text of the second failure, before the preflight.
    const twice = await run({ facts, damage: (part, _attempt, arg) => (part === inSecond ? arg.slice(0, -3) : undefined) });
    t.ok(/^review \(part 10 of the material was not written: the material helper \(part 10\): /.test(twice.out.stoppedAt || "") && twice.of(/^preflight /).length === 0 && twice.of(/^review$/).length === 0, `a part damaged twice stops the run with its text (${twice.out.stoppedAt})`);
    t.eq(twice.parts.filter((c) => c.spec.part === inSecond).length, 2, "the part was sent twice, not more");
  });

  scenario("design-brief-material-batch-omitted", "a runner that leaves a middle receipt out of its array makes only that part be sent again: the later parts with valid receipts are matched by their part number", async (t) => {
    const facts = factsOf(LATIN, 56000);
    const clean = await run({ facts });
    const n = clean.parts.length;
    const labels = clean.material.map((c) => c.label);
    t.ok(n > 8, `the material is more than one batch (${n} parts)`);
    const sentAgain = (r) => r.material.slice(labels.length).flatMap((c) => commandsIn(c.prompt, "brief-material")).map((c) => c.spec.part);
    // Part 2 of the first batch has no entry; parts 3 and 4 (and the rest) came back intact in the places before it.
    const mid = await run({ facts, omit: (part, attempt) => part === 2 && attempt === 1 });
    t.eq(sentAgain(mid), [2], "part 2 left out: only part 2 is sent again, not parts 3 and 4");
    t.eq(mid.material.length, labels.length + 1, "in one fresh runner");
    t.ok(reaches(mid) && mid.of(/^preflight /).length === 1, `the run reaches the review (${mid.out.stoppedAt})`);
    // Two entries left out, one of them damaged beside: all by number.
    const two = await run({ facts, omit: (part, attempt) => (part === 3 || part === 5) && attempt === 1 });
    t.eq(sentAgain(two), [3, 5], "parts 3 and 5 left out: those two only are sent again");
    t.ok(reaches(two), `the run reaches the review (${two.out.stoppedAt})`);
    // The part left out twice stops the run before the preflight.
    const never = await run({ facts, omit: (part) => part === 2 });
    t.ok(/^review \(part 2 of the material was not written: /.test(never.out.stoppedAt || "") && never.of(/^preflight /).length === 0, `a part left out twice stops the run (${never.out.stoppedAt})`);
  });

  scenario("design-brief-material-batch-failed-first", "a batch whose command 1 fails and whose runner answers only that one still gets parts 2-8 sent, each alone by its own runner, and the run reaches the review; the runner is told that a failed command does not stop the others", async (t) => {
    const facts = factsOf(LATIN, 56000);
    const clean = await run({ facts });
    const n = clean.parts.length;
    const labels = clean.material.map((c) => c.label);
    t.ok(n > 8, `the material is more than one batch (${n} parts)`);
    t.ok(/independent of one another/.test(clean.material[0].prompt) && /is an answer, not a stop/.test(clean.material[0].prompt) && /return an answer for each/.test(clean.material[0].prompt), "the runner prompt says the commands are independent, a failed one is an answer and not a stop, and every command gets an answer");
    const r = await run({ facts, onlyFirst: (label) => label === labels[0] });
    const again = r.material.slice(labels.length);
    t.eq(r.material.slice(0, labels.length).map((c) => c.label), labels, "the batches go once, as before");
    t.eq(again.map((c) => c.label), Array.from({ length: 8 }, (_, k) => `material ${k + 1}/${n} again db`), "parts 1-8 of the failed batch are then sent again, one runner for each part, never as a batch again");
    t.ok(again.every((c) => commandsIn(c.prompt, "brief-material").length === 1), "each of those runners has exactly one command");
    t.eq(again.flatMap((c) => commandsIn(c.prompt, "brief-material")).map((c) => c.spec.part), [1, 2, 3, 4, 5, 6, 7, 8], "and the parts of the other batch, which arrived, are not sent again");
    t.ok(reaches(r) && r.of(/^preflight /).length === 1, `the run reaches the review (${r.out.stoppedAt})`);
    // A part that fails again when sent alone stops the run with its text: one resend only.
    const never = await run({ facts, onlyFirst: (label) => label === labels[0], omit: (part) => part === 3 });
    t.ok(/^review \(part 3 of the material was not written: /.test(never.out.stoppedAt || "") && never.of(/^preflight /).length === 0, `a part that fails when sent alone stops the run (${never.out.stoppedAt})`);
    t.eq(never.parts.filter((c) => c.spec.part === 3).length, 2, "it was sent twice, not more");
  });

  scenario("design-brief-material-batch-arg-cap", "every argument a runner types is within 4000 characters, as b64:, for Latin, Cyrillic and 4-byte text on a long folder name", async (t) => {
    const src = SRC;
    t.ok(/^const MATERIAL_ARG_MAX = 4000$/m.test(src), "the cap is a named constant of the workflow, 4000");
    const tail = `${"ж".repeat(100)}/${"f".repeat(200)}`;
    for (const [what, sentence] of [["Latin", LATIN], ["Cyrillic", CYRILLIC], ["4-byte emoji", "\u{1F600}\u{1F4A5} ".repeat(60)]]) {
      const r = await run({ facts: factsOf(sentence, 20000), folder: tail });
      const dirs = r.parts.map((c) => c.spec.dir.length);
      t.ok(r.parts.length > 8, `${what}: the material is several parts (${r.parts.length})`);
      t.ok(r.parts.every((c) => /^b64:[A-Za-z0-9+/]+={0,2}$/.test(c.arg) && c.arg.length <= 4000), `${what}: every argument is b64: within 4000 characters (largest ${Math.max(...r.parts.map((c) => c.arg.length))}, folder name of ${Math.max(...dirs)} characters)`);
      t.ok(r.parts.every((c) => c.spec.text.length >= 1 && c.spec.text.length <= 4000), `${what}: no part is over the 4000 characters the helper takes`);
      t.ok(reaches(r) && r.of(/^material .* again /).length === 0, `${what}: the run reaches the review with no part sent again (${r.out.stoppedAt})`);
    }
  });
}
