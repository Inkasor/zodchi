// Exercise the installed gate protocol and the bytes a lead actually gives the owner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const base = {
  items: [
    { text: "Верстак ставим вдоль длинной стены.", group: "Планировка" },
    { text: "Сверлильный станок ставим у окна." },
    { text: "Заточной станок ставим у двери." },
  ],
  assumptions: [{ text: "Розетки уже проведены.", why: "в запросе про розетки ничего нет" }, { text: "Высота потолка не меньше 3 м." }],
};
const expectedList = `# Список для принятия, круг 1

Ответьте номерами: «1, 2 — принять; 3 — поправить: <как верно>; 5 — убрать». Строка, которую вы не назвали, остаётся открытой, а не принятой. Ответ принимается один раз за круг: назовите всё сразу.

### Планировка

1. Верстак ставим вдоль длинной стены.
2. Сверлильный станок ставим у окна.
3. Заточной станок ставим у двери.

## Допущения эксперта

Эксперт решил это сам, потому что уточнить не мог. Каждое допущение тоже ждёт ваших слов.

4. Розетки уже проведены. (почему: в запросе про розетки ничего нет)
5. Высота потолка не меньше 3 м.
`;
const corrected = "Сверлильный станок ставим у верстака.";
const firstReply = [{ n: 1, verdict: "accept" }, { n: 2, verdict: "fix", text: corrected }, { n: 3, verdict: "drop" }];
const second = { items: [
  { text: "Сверлильный станок переносим в угол.", replaces: ["1.2", "1.9"] },
  { text: "Верстак переносим к окну.", replaces: ["1.1"] },
] };
const secondReply = [{ n: 1, verdict: "accept" }, { id: "1.4", verdict: "fix", text: "Розетки нужны у окна." }, { n: 2, verdict: "drop" }];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = fs.readFileSync;
const json = (file) => JSON.parse(read(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const hashFile = (file) => sha(read(file));

function snapshot(dir, times = false) {
  const files = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    const name = path.relative(dir, file);
    if (stat.isDirectory()) {
      files.push([name, "directory"]);
      for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
    } else {
      const bytes = stat.isSymbolicLink() ? fs.readlinkSync(file) : read(file).toString("base64");
      files.push(times ? [name, bytes, stat.mtimeMs] : [name, bytes]);
    }
  }
  visit(dir);
  return files;
}

export default function register({ scenario, ROOT }) {
  const gate = path.join(ROOT, "core", "scripts", "gate.mjs");
  function invoke(t, command, argument, code) {
    const result = spawnSync(process.execPath, [gate, command, ...argument], { encoding: "utf8", windowsHide: true });
    t.log(`gate.mjs ${command} exit ${result.status}\n${result.stdout}\n${result.error || result.stderr}`);
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout.trimEnd().split("\n").length, 1);
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.api, 1);
    if (code === 0) {
      const { lineSha256, ...rest } = answer;
      assert.equal(lineSha256, sha(JSON.stringify(rest)));
      assert.equal(path.resolve(answer.plugin.root), path.join(ROOT, "core"));
    } else assert.ok(!Object.hasOwn(answer, "lineSha256"));
    return answer;
  }
  const call = (t, command, spec) => invoke(t, command, [JSON.stringify({ api: 1, ...spec })], 0);
  function success(t, command, spec) {
    const result = call(t, command, spec);
    assert.equal(result.ok, true, result.error);
    return result;
  }

  // Every invalid case starts in a fresh directory at the requested stage.
  function fixture(t, stage = "empty", answer = base) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-"));
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tmp = path.join(dir, "run");
    fs.mkdirSync(tmp);
    const build = { tmp, round: 1, answerFile: path.join(dir, "answer.json") };
    write(build.answerFile, answer);
    const reply = { tmp, round: 1, reply: firstReply };
    const world = { dir, tmp, build, reply };
    if (stage === "empty") return world;
    world.firstList = success(t, "list-build", build);
    if (stage === "listed") return world;
    world.first = success(t, "list-reply", reply);
    if (stage === "closed") return world;
    world.nextBuild = { tmp, round: 2, answerFile: path.join(dir, "second.json") };
    write(world.nextBuild.answerFile, second);
    world.nextList = success(t, "list-build", world.nextBuild);
    world.nextReply = { tmp, round: 2, reply: secondReply };
    return world;
  }
  function refusal(t, w, command, spec, field) {
    const before = snapshot(w.dir, true);
    const result = call(t, command, spec);
    assert.equal(result.ok, false);
    assert.match(result.error, field);
    assert.deepEqual(snapshot(w.dir, true), before, "refusal changed the fixture or created a receipt");
  }
  function checkCurrent(result, rounds, counts) {
    assert.deepEqual(result.current, { appliedRounds: rounds, counts,
      decisionsSha256: hashFile(result.decisionsFile), decisionsMdSha256: hashFile(result.decisionsMdFile) });
    assert.equal(result.outcome.decisionsSha256, result.current.decisionsSha256);
    assert.equal(result.outcome.decisionsMdSha256, result.current.decisionsMdSha256);
    assert.deepEqual(result.outcome.counts, counts);
  }

  scenario("blocks-helper-list", "numbered Russian text, canonical input, limits, immutable lists and round order", async t => {
    const w = fixture(t, "listed");
    const result = w.firstList;
    const lines = [...base.items, ...base.assumptions].map((line, i) => ({
      n: i + 1, id: `1.${i + 1}`, kind: i < 3 ? "line" : "assumption", ...line,
    }));
    assert.deepEqual(json(result.listFile), { version: 1, round: 1, answerSha256: hashFile(w.build.answerFile),
      maxLinesAtBuild: 30, lines, ignoredReplaces: [] });
    assert.deepEqual(read(result.mdFile), Buffer.from(expectedList));
    assert.deepEqual([result.count, result.items, result.assumptions, result.maxLines, result.tooLong, result.round,
      result.already, result.repaired, result.replaces, result.ignoredReplaces], [5, 3, 2, 30, false, 1, false, [], [], []]);
    assert.equal(result.listFile, path.join(w.tmp, "rounds", "1", "list.json"));
    assert.equal(result.mdFile, path.join(w.tmp, "rounds", "1", "list.md"));
    assert.deepEqual([result.listSha256, result.mdSha256, result.answerSha256],
      [result.listFile, result.mdFile, w.build.answerFile].map(hashFile));
    const before = snapshot(w.tmp, true);
    const { lineSha256: originalSignature, ...first } = result;
    const { lineSha256: replaySignature, ...replay } = success(t, "list-build", { ...w.build, maxLines: 4 });
    assert.deepEqual(replay, { ...first, already: true, maxLines: 4, tooLong: true });
    assert.deepEqual(snapshot(w.tmp, true), before);

    for (const count of [30, 31]) {
      const fresh = fixture(t, "listed", { items: Array.from({ length: count }, (_, i) => ({ text: `Инструмент ${i + 1}` })) });
      assert.deepEqual([fresh.firstList.count, fresh.firstList.tooLong], [count, count > 30]);
    }
    const multiline = structuredClone(base);
    multiline.items[0].text = " \tВерстак ставим  \r\n\t вдоль длинной стены.  ";
    multiline.items[0].group = "  План\u2028 мастерской ";
    multiline.assumptions[0].why = "\tв запросе\u2029 про розетки ничего нет ";
    const normalized = fixture(t, "listed", multiline).firstList;
    assert.deepEqual(read(normalized.mdFile), Buffer.from(expectedList.replace("Планировка", "План мастерской")));
    assert.deepEqual(json(normalized.listFile).lines, lines.map((line, i) => i === 0 ? { ...line, group: "План мастерской" } : line));

    for (const maxLines of [0, 201]) {
      const fresh = fixture(t);
      refusal(t, fresh, "list-build", { ...fresh.build, maxLines }, /maxLines/);
    }
    for (const [answer, field] of [
      [{ items: [{ text: " " }] }, /items\[0\]\.text/],
      [{ items: [{ text: "я".repeat(601) }] }, /items\[0\]\.text/],
      [{ items: [{ text: "Полка", group: "я".repeat(81) }] }, /items\[0\]\.group/],
      [{ items: base.items, assumptions: [{ text: "Полка", why: "я".repeat(301) }] }, /assumptions\[0\]\.why/],
      [{ items: [{ text: "Ключ\u0001на полке" }] }, /items\[0\]\.text/],
      [{ items: [{ text: "Ключ", replaces: ["01.1"] }] }, /items\[0\]\.replaces\[0\]/],
      [{ items: [] }, /\.items/], [{}, /\.items/],
    ]) {
      const fresh = fixture(t, "empty", answer);
      refusal(t, fresh, "list-build", fresh.build, field);
    }
    const invalid = fixture(t);
    fs.writeFileSync(invalid.build.answerFile, "{");
    refusal(t, invalid, "list-build", invalid.build, /answerFile.*JSON/);
    const different = fixture(t, "listed");
    write(different.build.answerFile, second);
    refusal(t, different, "list-build", different.build, /answerFile.*different/);
    for (const [stage, round] of [["empty", 2], ["listed", 2], ["listed", 3]]) {
      const fresh = fixture(t, stage);
      refusal(t, fresh, "list-build", { ...fresh.build, round }, /round \d+ must be built next, after the reply/);
    }
  });

  scenario("blocks-helper-reply", "one owner batch, earlier open entries, visible replacements, historical outcomes and current digests", async t => {
    const w = fixture(t, "second");
    const first = w.first;
    const counts = { accepted: 2, rejected: 1, open: 2, superseded: 0 };
    checkCurrent(first, [1], counts);
    assert.deepEqual(first.outcome, {
      counts, thisRound: { accepted: 1, fixed: 1, dropped: 1, unnamed: 2 }, earlier: [], unnamed: ["1.4", "1.5"],
      superseded: [], decisionsSha256: first.current.decisionsSha256, decisionsMdSha256: first.current.decisionsMdSha256,
    });
    assert.deepEqual([first.round, first.already, first.repaired], [1, false, []]);
    assert.equal(first.replyFile, path.join(w.tmp, "rounds", "1", "reply.json"));
    assert.equal(first.decisionsFile, path.join(w.tmp, "decisions.json"));
    assert.equal(first.decisionsMdFile, path.join(w.tmp, "decisions.md"));
    const expectedEntries = json(w.firstList.listFile).lines.map((line, i) => {
      const entry = { ...line, round: 1, state: ["accepted", "accepted", "rejected", "open", "open"][i] };
      if (i < 3) entry.decidedInRound = 1;
      if (i === 1) Object.assign(entry, { was: line.text, text: corrected });
      return entry;
    });
    assert.deepEqual(json(first.decisionsFile), { version: 1, appliedRounds: [1], entries: expectedEntries });
    assert.deepEqual(json(first.replyFile), { version: 1, round: 1, listSha256: hashFile(w.firstList.listFile),
      entries: [{ id: "1.1", verdict: "accept" }, { id: "1.2", verdict: "fix", text: corrected }, { id: "1.3", verdict: "drop" }],
      outcome: first.outcome });
    assert.deepEqual(read(first.decisionsMdFile), Buffer.from(`# Список решений (после круга 1)

Этот список главнее любых прежних ответов эксперта.

## Принято
- 1.1 Верстак ставим вдоль длинной стены.
- 1.2 Сверлильный станок ставим у верстака. (владелец поправил; было: Сверлильный станок ставим у окна.)

## Отклонено
- 1.3 Заточной станок ставим у двери.

## Открыто
- 1.4 Розетки уже проведены. [допущение эксперта]
- 1.5 Высота потолка не меньше 3 м. [допущение эксперта]

## Отменено более поздним решением
(пусто)
`));
    const before = snapshot(w.tmp, true);
    const replay = success(t, "list-reply", w.reply);
    assert.deepEqual([replay.already, replay.outcome, replay.current, replay.repaired], [true, first.outcome, first.current, []]);
    assert.deepEqual(snapshot(w.tmp, true), before);
    const closed = fixture(t, "closed");
    refusal(t, closed, "list-reply", { ...closed.reply, reply: [] }, /reply\.json.*another reply/);

    const shown = read(w.nextList.mdFile, "utf8");
    assert.ok(shown.includes(`1. ${second.items[0].text}\n   Заменит прежнее решение 1.2: «${corrected}» (сейчас: принято). Оно отменится, только если вы примете или поправите эту строку.`));
    assert.ok(!shown.includes("1.9"));
    assert.deepEqual(w.nextList.ignoredReplaces, [{ line: "2.1", id: "1.9", reason: "unknown" }]);
    assert.deepEqual(w.nextList.replaces, [
      { line: "2.1", id: "1.2", text: corrected, state: "accepted" }, { line: "2.2", id: "1.1", text: base.items[0].text, state: "accepted" },
    ]);
    const applied = success(t, "list-reply", w.nextReply);
    checkCurrent(applied, [1, 2], { accepted: 3, rejected: 2, open: 1, superseded: 1 });
    assert.deepEqual(applied.outcome.earlier, [{ id: "1.4", verdict: "fix" }]);
    assert.deepEqual(applied.outcome.thisRound, { accepted: 1, fixed: 0, dropped: 1, unnamed: 0 });
    assert.deepEqual(applied.outcome.unnamed, []);
    assert.deepEqual(applied.outcome.superseded, [{ id: "1.2", by: "2.1", text: corrected }]);
    const ledger = json(applied.decisionsFile);
    assert.deepEqual(ledger.entries[0], expectedEntries[0]);
    assert.deepEqual(ledger.entries[3], { ...expectedEntries[3], text: secondReply[1].text, was: base.assumptions[0].text,
      state: "accepted", decidedInRound: 2 });
    assert.deepEqual(ledger.entries.filter(e => e.state === "superseded").map(e => [e.id, e.supersededBy, "decidedInRound" in e]),
      [["1.2", "2.1", false]]);
    assert.ok(read(applied.decisionsMdFile, "utf8").endsWith(`## Отменено более поздним решением\n- 1.2 ${corrected} — заменено 2.1\n`));
    const complete = snapshot(w.tmp, true);
    for (const batch of [secondReply, [
      { n: 2, verdict: "  УбРАТЬ " }, { id: "1.4", verdict: "ПОПРАВИТЬ", text: " Розетки нужны\nу окна. " }, { n: 1, verdict: " Принять " },
    ]]) {
      const repeated = success(t, "list-reply", { ...w.nextReply, reply: batch });
      assert.deepEqual([repeated.already, repeated.outcome, repeated.current], [true, applied.outcome, applied.current]);
    }
    const old = success(t, "list-reply", w.reply);
    assert.deepEqual([old.already, old.outcome, old.current], [true, first.outcome, applied.current]);
    const oldList = success(t, "list-build", w.nextBuild);
    assert.deepEqual([oldList.already, oldList.replaces, oldList.ignoredReplaces, oldList.mdSha256],
      [true, w.nextList.replaces, w.nextList.ignoredReplaces, w.nextList.mdSha256]);
    assert.equal(success(t, "list-build", w.build).listSha256, w.firstList.listSha256);
    assert.deepEqual(snapshot(w.tmp, true), complete);

    // Both proposals show the same open assumption. The lower accepted number cancels it
    // once, even when the same batch also fixes that assumption's wording.
    const thirdBuild = { ...w.nextBuild, round: 3, answerFile: path.join(w.dir, "third.json") };
    write(thirdBuild.answerFile, { items: [
      { text: "Высоту уточняем замером.", replaces: ["1.5", "1.3", "1.2", "3.2"] },
      { text: "Проверяем высоту у окна.", replaces: ["1.5"] },
    ] });
    const third = success(t, "list-build", thirdBuild);
    assert.deepEqual(third.ignoredReplaces, [
      { line: "3.1", id: "1.3", reason: "rejected" }, { line: "3.1", id: "1.2", reason: "superseded" },
      { line: "3.1", id: "3.2", reason: "this-round" },
    ]);
    assert.equal(read(third.mdFile, "utf8").split(`Заменит прежнее решение 1.5: «${base.assumptions[1].text}» (сейчас: открыто).`).length - 1, 2);
    const thirdResult = success(t, "list-reply", { tmp: w.tmp, round: 3, reply: [
      { n: 2, verdict: "accept" }, { id: "1.5", verdict: "fix", text: "Высота пока неизвестна." },
      { n: 1, verdict: "fix", text: "Измеряем высоту." },
    ] });
    assert.deepEqual(thirdResult.outcome.superseded, [{ id: "1.5", by: "3.1", text: base.assumptions[1].text }]);
    const target = json(thirdResult.decisionsFile).entries.find(entry => entry.id === "1.5");
    assert.deepEqual([target.state, target.supersededBy, target.was, target.text, "decidedInRound" in target],
      ["superseded", "3.1", base.assumptions[1].text, "Высота пока неизвестна.", false]);

    for (const batch of [[], [{ n: 2, verdict: "drop" }]]) {
      const fresh = fixture(t, "second");
      const result = success(t, "list-reply", { ...fresh.nextReply, reply: batch });
      assert.deepEqual(result.outcome.superseded, []);
      assert.deepEqual(json(result.decisionsFile).entries[1], expectedEntries[1]);
    }
    const partial = fixture(t, "listed");
    const only = success(t, "list-reply", { ...partial.reply, reply: [{ n: 4, verdict: "принять" }] });
    assert.deepEqual(json(only.decisionsFile).entries.map(e => e.state), ["open", "open", "open", "accepted", "open"]);
    const duplicate = fixture(t, "listed");
    const fix = { n: 2, verdict: "fix", text: corrected };
    const once = success(t, "list-reply", { ...duplicate.reply, reply: [fix, fix] });
    assert.deepEqual(json(once.replyFile).entries, [{ id: "1.2", verdict: "fix", text: corrected }]);
    assert.deepEqual(once.outcome.thisRound, { accepted: 0, fixed: 1, dropped: 0, unnamed: 4 });

    for (const [batch, field] of [
      [[{ n: 6, verdict: "accept" }], /reply\[0\]\.n/], [[{ n: 1, verdict: "fix" }], /reply\[0\]\.text/],
      [[{ n: 1, verdict: "accept", text: corrected }], /reply\[0\]\.text/],
      [[{ n: 1, verdict: "accept" }, { n: 1, verdict: "drop" }], /reply\[1\].*1\.1/],
      [[fix, { ...fix, text: "Переносим станок." }], /reply\[1\].*1\.2/],
      [[{ n: 1, id: "1.1", verdict: "drop" }], /reply\[0\].*n or id/], [[{ verdict: "drop" }], /reply\[0\].*n or id/],
      [[{ id: "1.3", verdict: "accept" }], /reply\[0\]\.id.*use n/], [[{ n: 1, verdict: "later" }], /reply\[0\]\.verdict/],
    ]) {
      const fresh = fixture(t, "listed");
      refusal(t, fresh, "list-reply", { ...fresh.reply, reply: batch }, field);
    }
    const decided = fixture(t, "second");
    refusal(t, decided, "list-reply", { ...decided.nextReply, reply: [{ id: "1.1", verdict: "drop" }] }, /reply\[0\]\.id.*1\.1.*not open/);
    for (const [change, field] of [[{ version: 2 }, /decisions\.json\.version/], [{ entries: {} }, /decisions\.json\.entries/]]) {
      const fresh = fixture(t, "second");
      write(fresh.first.decisionsFile, { ...json(fresh.first.decisionsFile), ...change });
      refusal(t, fresh, "list-reply", fresh.nextReply, field);
    }
    const stale = fixture(t, "second");
    const changed = json(stale.first.decisionsFile);
    changed.entries[1].text = "Станок уже перенесли.";
    write(stale.first.decisionsFile, changed);
    refusal(t, stale, "list-reply", stale.nextReply, /1\.2.*the ledger changed since the list was built/);
  });

  scenario("blocks-helper-resume", "recover each gap between atomic writes and preserve complete replies byte for byte", async t => {
    const w = fixture(t, "listed");
    const markdown = read(w.firstList.mdFile);
    fs.unlinkSync(w.firstList.mdFile);
    const rebuilt = success(t, "list-build", w.build);
    assert.deepEqual([rebuilt.already, rebuilt.repaired, read(rebuilt.mdFile)], [true, ["list.md"], markdown]);
    const edited = fixture(t, "listed");
    fs.appendFileSync(edited.firstList.mdFile, "Правка\n");
    refusal(t, edited, "list-build", edited.build, /list\.md.*differs/);

    for (const another of [true, false]) {
      const cut = fixture(t, "closed");
      const before = snapshot(cut.tmp);
      fs.unlinkSync(cut.first.decisionsFile);
      fs.unlinkSync(cut.first.decisionsMdFile);
      if (another) refusal(t, cut, "list-reply", { ...cut.reply, reply: [] }, /reply\.json.*another reply/);
      else {
        const result = success(t, "list-reply", cut.reply);
        assert.deepEqual([result.already, result.outcome, result.current], [false, cut.first.outcome, cut.first.current]);
        assert.deepEqual(snapshot(cut.tmp), before);
      }
    }
    const later = fixture(t, "second");
    const priorMd = read(later.first.decisionsMdFile);
    const priorLedger = read(later.first.decisionsFile);
    const result = success(t, "list-reply", later.nextReply);
    const uncut = snapshot(later.tmp);
    fs.writeFileSync(result.decisionsFile, priorLedger);
    fs.writeFileSync(result.decisionsMdFile, priorMd);
    assert.equal(success(t, "list-reply", later.nextReply).already, false);
    assert.deepEqual(snapshot(later.tmp), uncut);
    for (const missing of [false, true]) {
      if (missing) fs.unlinkSync(result.decisionsMdFile);
      else fs.writeFileSync(result.decisionsMdFile, priorMd);
      const ledgerMtime = fs.statSync(result.decisionsFile).mtimeMs;
      const repaired = success(t, "list-reply", later.nextReply);
      assert.deepEqual([repaired.already, repaired.repaired, repaired.outcome], [true, ["decisions.md"], result.outcome]);
      assert.equal(fs.statSync(result.decisionsFile).mtimeMs, ledgerMtime);
      assert.deepEqual(snapshot(later.tmp), uncut);
    }
    const complete = snapshot(later.tmp, true);
    assert.deepEqual(success(t, "list-reply", later.nextReply).repaired, []);
    assert.deepEqual(snapshot(later.tmp, true), complete);

    const bad = fixture(t, "second");
    fs.writeFileSync(bad.first.decisionsFile, "{");
    refusal(t, bad, "list-reply", bad.nextReply, /decisions\.json.*JSON/);
    const noReceipt = fixture(t, "closed");
    fs.unlinkSync(noReceipt.first.replyFile);
    refusal(t, noReceipt, "list-reply", noReceipt.reply, /reply\.json.*missing receipt/);
    const lostLedger = fixture(t, "second");
    fs.unlinkSync(lostLedger.first.decisionsFile);
    fs.unlinkSync(lostLedger.first.decisionsMdFile);
    refusal(t, lostLedger, "list-reply", lostLedger.reply, /decisions\.json.*already applied/);
    const wrongOutcome = fixture(t, "closed");
    fs.unlinkSync(wrongOutcome.first.decisionsFile);
    fs.unlinkSync(wrongOutcome.first.decisionsMdFile);
    const receipt = json(wrongOutcome.first.replyFile);
    receipt.outcome.counts.open++;
    write(wrongOutcome.first.replyFile, receipt);
    refusal(t, wrongOutcome, "list-reply", wrongOutcome.reply, /reply\.json\.outcome/);
  });

  scenario("blocks-helper-paths", "validate paths and confine writes through the real parents of both round directories", async t => {
    for (const change of [
      () => ({ tmp: "relative" }), w => ({ tmp: w.tmp + path.sep + ".." + path.sep + "run" }),
      w => ({ tmp: path.join(w.dir, "missing") }), () => ({ answerFile: "relative" }),
    ]) {
      const fresh = fixture(t);
      const invalid = change(fresh);
      refusal(t, fresh, "list-build", { ...fresh.build, ...invalid }, new RegExp(Object.keys(invalid)[0]));
    }
    for (const nested of [false, true]) {
      const fresh = fixture(t);
      const outside = path.join(fresh.dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "sentinel"), "workshop");
      const rounds = path.join(fresh.tmp, "rounds");
      if (nested) fs.mkdirSync(rounds);
      fs.symlinkSync(outside, nested ? path.join(rounds, "1") : rounds, process.platform === "win32" ? "junction" : "dir");
      refusal(t, fresh, "list-build", fresh.build, /rounds.*outside tmp/);
    }
  });

  scenario("blocks-helper-dispatch", "gate usage failures and signed file-command refusals retain their distinct exit codes", async t => {
    const unknown = invoke(t, "workshop-unknown", ["{}"], 2);
    assert.deepEqual(Object.keys(unknown).sort(), ["api", "error", "ok"]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown command.*list-build.*list-reply/);
    for (const argument of [[], ["{"], ["null"]]) {
      const result = invoke(t, "list-build", argument, 2);
      assert.equal(result.ok, false);
      assert.match(result.error, /spec/);
    }
    assert.match(invoke(t, "list-reply", ['{"api":2}'], 3).error, /api 2/);
    const fresh = fixture(t);
    refusal(t, fresh, "list-build", { round: 1, answerFile: fresh.build.answerFile }, /tmp/);
    success(t, "list-build", fresh.build);
    success(t, "list-reply", fresh.reply);
  });
}
