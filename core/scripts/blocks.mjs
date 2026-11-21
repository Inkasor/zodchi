import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_MAX_LINES = 30;
const MAX_LINES = 200;
const sha = (data) => createHash("sha256").update(data).digest("hex");
export const lineSha = (obj) => sha(Buffer.from(JSON.stringify(obj), "utf8"));
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const temporary = (file) => `${file}.tmp-${process.pid}`;

class Refusal extends Error {}

function requireField(condition, field, message) {
  if (!condition) throw new Refusal(`${field}: ${message}`);
}

function fields(value, field, allowed) {
  requireField(value !== null && typeof value === "object" && !Array.isArray(value), field, "expected an object");
  for (const key of Object.keys(value)) {
    requireField(allowed.includes(key), `${field}.${key}`, "unexpected field");
  }
}

function array(value, field, min = 0, max = Infinity) {
  requireField(Array.isArray(value), field, "expected an array");
  requireField(value.length >= min && value.length <= max, field, "wrong number of entries");
}

function integer(value, field, min, max) {
  requireField(Number.isInteger(value) && value >= min && value <= max, field, `expected an integer from ${min} to ${max}`);
}

function oneOf(value, field, choices) {
  requireField(choices.includes(value), field, `expected one of ${choices.join(", ")}`);
}

function digest(value, field) {
  requireField(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), field, "expected a SHA-256 digest");
}

function parts(id, field) {
  requireField(typeof id === "string" && /^[1-9]\d*\.[1-9]\d*$/u.test(id), field, "expected a decimal round.number id");
  return id.split(".").map(Number);
}

function compareIds(a, b) {
  const [leftRound, leftNumber] = a.split(".").map(Number);
  const [rightRound, rightNumber] = b.split(".").map(Number);
  return leftRound - rightRound || leftNumber - rightNumber;
}

function canonical(value, field, min, max) {
  requireField(typeof value === "string", field, "expected a string");
  const text = value.trim().replace(/\s+/gu, (run) => /[\r\n\u2028\u2029]/u.test(run) ? " " : run);
  requireField(!/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u.test(text), field, "contains a control character");
  integer([...text].length, `${field} length`, min, max);
  return text;
}

function storedText(value, field, min = 1, max = 600) {
  requireField(canonical(value, field, min, max) === value, field, "expected canonical text");
}

function absolute(value, field) {
  requireField(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") &&
    !value.split(/[\\/]/u).includes(".."), field, "expected an absolute path without ..");
  return path.resolve(value);
}

function real(file, field) {
  try { return fs.realpathSync(file); }
  catch (error) { throw new Refusal(`${field}: ${error.message}`); }
}

function runPaths(spec) {
  const tmp = absolute(spec.tmp, "tmp");
  const root = real(tmp, "tmp");
  requireField(fs.statSync(root).isDirectory(), "tmp", "expected an existing directory");
  integer(spec.round, "round", 1, 999);
  const dir = path.join(tmp, "rounds", String(spec.round));
  const files = {
    listFile: path.join(dir, "list.json"), mdFile: path.join(dir, "list.md"), replyFile: path.join(dir, "reply.json"),
    decisionsFile: path.join(tmp, "decisions.json"), decisionsMdFile: path.join(tmp, "decisions.md"),
  };
  for (const file of Object.values(files)) {
    for (const destination of [file, temporary(file)]) {
      let ancestor = destination;
      while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
      const resolved = real(ancestor, destination);
      const relative = path.relative(root, resolved);
      requireField(relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
        destination, "outside tmp");
      const stat = fs.statSync(resolved);
      if (ancestor !== destination) requireField(stat.isDirectory(), ancestor, "expected a directory");
      else {
        requireField(destination === file, destination, "temporary destination already exists");
        requireField(stat.isFile(), file, "expected a regular file");
      }
    }
  }
  return files;
}

function writeAtomic(file, bytes) {
  const temp = temporary(file);
  const fd = fs.openSync(temp, "wx");
  try {
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.unlinkSync(temp);
    throw error;
  }
}

function parse(bytes, field) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Refusal(`${field}: invalid UTF-8 JSON (${error.message})`); }
}

function optionalBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function readAnswer(file) {
  const name = absolute(file, "answerFile");
  const field = `answerFile ${name}`;
  const stat = fs.statSync(real(name, field));
  requireField(stat.isFile(), field, "expected a regular file");
  requireField(stat.size <= 256 * 1024, field, "larger than 256 KiB");
  const bytes = fs.readFileSync(name);
  const answer = parse(bytes, field);
  fields(answer, field, ["items", "assumptions"]);
  array(answer.items, `${field}.items`, 1, MAX_LINES);
  const assumptions = "assumptions" in answer ? answer.assumptions : [];
  array(assumptions, `${field}.assumptions`, 0, MAX_LINES - answer.items.length);
  const lines = [];
  for (const [kind, key, rows] of [["line", "items", answer.items], ["assumption", "assumptions", assumptions]]) {
    rows.forEach((row, index) => {
      const at = `${field}.${key}[${index}]`;
      fields(row, at, kind === "line" ? ["text", "group", "replaces"] : ["text", "why"]);
      const line = { kind, text: canonical(row.text, `${at}.text`, 1, 600) };
      if ("group" in row) line.group = canonical(row.group, `${at}.group`, 0, 80);
      if ("why" in row) line.why = canonical(row.why, `${at}.why`, 0, 300);
      if ("replaces" in row) {
        array(row.replaces, `${at}.replaces`, 0, 20);
        row.replaces.forEach((id, i) => parts(id, `${at}.replaces[${i}]`));
        line.replaces = row.replaces;
      }
      lines.push(line);
    });
  }
  return { answerSha256: sha(bytes), lines };
}

function checkVersion(value, file, keys) {
  fields(value, file, ["version", ...keys]);
  requireField(value.version === 1, `${file}.version`, "expected 1");
}

function checkLine(line, at) {
  oneOf(line.kind, `${at}.kind`, ["line", "assumption"]);
  storedText(line.text, `${at}.text`);
  if ("group" in line) {
    requireField(line.kind === "line", `${at}.group`, "only a proposal has a group");
    storedText(line.group, `${at}.group`, 0, 80);
  }
  if ("why" in line) {
    requireField(line.kind === "assumption", `${at}.why`, "only an assumption has a reason");
    storedText(line.why, `${at}.why`, 0, 300);
  }
}

function readList(bytes, file, round) {
  const list = parse(bytes, file);
  checkVersion(list, file, ["round", "answerSha256", "maxLinesAtBuild", "lines", "ignoredReplaces"]);
  requireField(list.round === round, `${file}.round`, `expected ${round}`);
  digest(list.answerSha256, `${file}.answerSha256`);
  integer(list.maxLinesAtBuild, `${file}.maxLinesAtBuild`, 1, MAX_LINES);
  array(list.lines, `${file}.lines`, 1, MAX_LINES);
  list.lines.forEach((line, i) => {
    const at = `${file}.lines[${i}]`;
    fields(line, at, ["n", "id", "kind", "text", "group", "why", "replaces"]);
    requireField(line.n === i + 1, `${at}.n`, `expected ${i + 1}`);
    requireField(line.id === `${round}.${line.n}`, `${at}.id`, "does not match round and n");
    checkLine(line, at);
    requireField(i === 0 ? line.kind === "line" : list.lines[i - 1].kind === "line" || line.kind === "assumption",
      `${at}.kind`, "expected proposals followed by assumptions");
    if ("replaces" in line) {
      requireField(line.kind === "line", `${at}.replaces`, "an assumption cannot replace a decision");
      array(line.replaces, `${at}.replaces`, 0, 20);
      line.replaces.forEach((target, j) => {
        const ref = `${at}.replaces[${j}]`;
        fields(target, ref, ["id", "text", "state"]);
        requireField(parts(target.id, `${ref}.id`)[0] < round, `${ref}.id`, "expected an earlier round");
        storedText(target.text, `${ref}.text`);
        oneOf(target.state, `${ref}.state`, ["accepted", "open"]);
      });
    }
  });
  array(list.ignoredReplaces, `${file}.ignoredReplaces`);
  list.ignoredReplaces.forEach((ref, i) => {
    const at = `${file}.ignoredReplaces[${i}]`;
    fields(ref, at, ["line", "id", "reason"]);
    requireField(list.lines.some(line => line.id === ref.line && line.kind === "line"), `${at}.line`, "unknown proposal");
    parts(ref.id, `${at}.id`);
    oneOf(ref.reason, `${at}.reason`, ["unknown", "this-round", "superseded", "rejected"]);
  });
  return list;
}

const states = ["accepted", "rejected", "open", "superseded"];

function readLedger(files) {
  const file = files.decisionsFile;
  const bytes = optionalBytes(file);
  if (!bytes) {
    requireField(!fs.existsSync(files.decisionsMdFile), file, "missing ledger for existing decisions.md");
    const secondList = path.join(path.dirname(file), "rounds", "2", "list.json");
    requireField(!fs.existsSync(secondList), file, "round 1 was already applied before round 2 was built");
    return { ledger: { version: 1, appliedRounds: [], entries: [] }, bytes };
  }
  const ledger = parse(bytes, file);
  checkVersion(ledger, file, ["appliedRounds", "entries"]);
  array(ledger.appliedRounds, `${file}.appliedRounds`, 0, 999);
  ledger.appliedRounds.forEach((round, i) => requireField(round === i + 1, `${file}.appliedRounds[${i}]`, `expected ${i + 1}`));
  array(ledger.entries, `${file}.entries`);
  let previous;
  for (const [i, entry] of ledger.entries.entries()) {
    const at = `${file}.entries[${i}]`;
    fields(entry, at, ["id", "round", "n", "kind", "text", "group", "why", "state", "was", "supersededBy", "decidedInRound"]);
    integer(entry.round, `${at}.round`, 1, ledger.appliedRounds.length);
    integer(entry.n, `${at}.n`, 1, MAX_LINES);
    requireField(entry.id === `${entry.round}.${entry.n}`, `${at}.id`, "does not match round and n");
    const sameRound = previous?.round === entry.round;
    if (!sameRound) requireField(entry.round === (previous?.round || 0) + 1, `${at}.round`, "expected consecutive rounds");
    requireField(entry.n === (sameRound ? previous.n + 1 : 1), `${at}.n`, "expected consecutive line numbers");
    previous = entry;
    checkLine(entry, at);
    oneOf(entry.state, `${at}.state`, states);
    if ("was" in entry) {
      requireField(["accepted", "superseded"].includes(entry.state), `${at}.was`, "only a fixed decision has previous text");
      storedText(entry.was, `${at}.was`);
    }
    if (entry.state === "superseded") {
      requireField(parts(entry.supersededBy, `${at}.supersededBy`)[0] > entry.round, `${at}.supersededBy`, "expected a later decision");
    } else requireField(!("supersededBy" in entry), `${at}.supersededBy`, "decision is not superseded");
    if (entry.state === "accepted" || entry.state === "rejected") {
      integer(entry.decidedInRound, `${at}.decidedInRound`, entry.round, ledger.appliedRounds.length);
    } else requireField(!("decidedInRound" in entry), `${at}.decidedInRound`, "unexpected for this state");
  }
  requireField((previous?.round || 0) === ledger.appliedRounds.length, `${file}.entries`, "missing entries for an applied round");
  const ids = new Set(ledger.entries.map(entry => entry.id));
  ledger.entries.forEach((entry, i) => {
    if (entry.supersededBy) requireField(ids.has(entry.supersededBy), `${file}.entries[${i}].supersededBy`, "unknown decision");
  });
  return { ledger, bytes };
}

function makeList(answer, round, maxLines, ledger) {
  const earlier = new Map(ledger.entries.map(entry => [entry.id, entry]));
  const ignoredReplaces = [];
  const lines = answer.lines.map(({ replaces = [], ...proposal }, i) => {
    const line = { n: i + 1, id: `${round}.${i + 1}`, ...proposal };
    for (const id of replaces) {
      const target = earlier.get(id);
      if (target && ["accepted", "open"].includes(target.state)) {
        line.replaces ??= [];
        line.replaces.push({ id, text: target.text, state: target.state });
      } else {
        const reason = id.startsWith(`${round}.`) ? "this-round" : target?.state || "unknown";
        ignoredReplaces.push({ line: line.id, id, reason });
      }
    }
    return line;
  });
  return { version: 1, round, answerSha256: answer.answerSha256, maxLinesAtBuild: maxLines, lines, ignoredReplaces };
}

function listMarkdown(list) {
  const rows = [
    `# Список для принятия, круг ${list.round}`, "",
    "Ответьте номерами: «1, 2 — принять; 3 — поправить: <как верно>; 5 — убрать». Строка, которую вы не назвали, остаётся открытой, а не принятой. Ответ принимается один раз за круг: назовите всё сразу.",
    "",
  ];
  let previous;
  for (const line of list.lines) {
    if (line.group && line.group !== previous?.group) {
      if (previous) rows.push("");
      rows.push(`### ${line.group}`, "");
    }
    if (line.kind === "assumption" && previous.kind !== "assumption") {
      rows.push("", "## Допущения эксперта", "", "Эксперт решил это сам, потому что уточнить не мог. Каждое допущение тоже ждёт ваших слов.", "");
    }
    rows.push(`${line.n}. ${line.text}${line.why ? ` (почему: ${line.why})` : ""}`);
    for (const ref of line.replaces || []) {
      const state = ref.state === "accepted" ? "принято" : "открыто";
      rows.push(`   Заменит прежнее решение ${ref.id}: «${ref.text}» (сейчас: ${state}). Оно отменится, только если вы примете или поправите эту строку.`);
    }
    previous = line;
  }
  return Buffer.from(rows.join("\n") + "\n");
}

function listBuild(spec) {
  const files = runPaths(spec);
  const { listFile, mdFile } = files;
  const { round, maxLines = DEFAULT_MAX_LINES } = spec;
  integer(maxLines, "maxLines", 1, MAX_LINES);
  const answer = readAnswer(spec.answerFile);
  let listBytes = optionalBytes(listFile);
  const already = listBytes !== null;
  let list;
  if (already) {
    list = readList(listBytes, listFile, round);
    requireField(answer.answerSha256 === list.answerSha256, "answerFile", `different answer for ${listFile}`);
  } else {
    const { ledger } = readLedger(files);
    const next = ledger.appliedRounds.length + 1;
    requireField(round === next, "round", `round ${round} must be built next, after the reply to round ${round - 1} (next eligible round: ${next})`);
    requireField(!fs.existsSync(files.replyFile), files.replyFile, "receipt exists without its list.json");
    list = makeList(answer, round, maxLines, ledger);
    listBytes = jsonBytes(list);
  }
  const markdown = listMarkdown(list);
  const existing = optionalBytes(mdFile);
  requireField(!existing || existing.equals(markdown), mdFile, "differs from the rendering of list.json");
  const count = list.lines.length;
  const items = list.lines.filter(line => line.kind === "line").length;
  const replaces = list.lines.flatMap(line => (line.replaces || []).map(ref => ({ line: line.id, ...ref })));
  const result = {
    ok: true, round, count, items, assumptions: count - items, maxLines, tooLong: count > maxLines,
    listFile, mdFile, listSha256: sha(listBytes), mdSha256: sha(markdown), answerSha256: list.answerSha256,
    replaces, ignoredReplaces: list.ignoredReplaces, already, repaired: already && !existing ? ["list.md"] : [],
  };
  if (!already) {
    fs.mkdirSync(path.dirname(listFile), { recursive: true });
    writeAtomic(listFile, listBytes);
  }
  if (!existing) writeAtomic(mdFile, markdown);
  return result;
}

const aliases = new Map([
  ["accept", "accept"], ["принять", "accept"], ["fix", "fix"], ["поправить", "fix"], ["drop", "drop"], ["убрать", "drop"],
]);

function canonicalReply(reply, list) {
  array(reply, "reply");
  const byId = new Map();
  reply.forEach((row, i) => {
    const at = `reply[${i}]`;
    fields(row, at, ["id", "n", "verdict", "text"]);
    requireField(("n" in row) !== ("id" in row), at, "expected exactly one of n or id");
    let id = row.id;
    if ("n" in row) {
      integer(row.n, `${at}.n`, 1, list.lines.length);
      id = list.lines[row.n - 1].id;
    } else {
      const [round] = parts(id, `${at}.id`);
      requireField(round !== list.round, `${at}.id`, "use n for this round");
      requireField(round < list.round, `${at}.id`, "expected an earlier round");
    }
    const verdict = typeof row.verdict === "string" && aliases.get(row.verdict.trim().toLowerCase());
    requireField(verdict, `${at}.verdict`, "expected accept, fix or drop");
    const entry = { id, verdict };
    if (verdict === "fix") entry.text = canonical(row.text, `${at}.text`, 1, 600);
    else requireField(!("text" in row), `${at}.text`, "text is only allowed with fix");
    const previous = byId.get(id);
    requireField(!previous || isDeepStrictEqual(entry, previous), at, `conflicting verdict or text for ${id}`);
    byId.set(id, entry);
  });
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

function decisionsMarkdown(ledger) {
  const rows = [`# Список решений (после круга ${ledger.appliedRounds.at(-1)})`, "", "Этот список главнее любых прежних ответов эксперта."];
  const headings = ["Принято", "Отклонено", "Открыто", "Отменено более поздним решением"];
  for (const [i, state] of states.entries()) {
    rows.push("", `## ${headings[i]}`);
    const section = ledger.entries.filter(entry => entry.state === state);
    if (!section.length) rows.push("(пусто)");
    for (const entry of section) {
      let suffix = "";
      if (state === "accepted" && entry.was) suffix = ` (владелец поправил; было: ${entry.was})`;
      if (state === "open" && entry.kind === "assumption") suffix = " [допущение эксперта]";
      if (state === "superseded") suffix = ` — заменено ${entry.supersededBy}`;
      rows.push(`- ${entry.id} ${entry.text}${suffix}`);
    }
  }
  return Buffer.from(rows.join("\n") + "\n");
}

function countStates(ledger) {
  const counts = { accepted: 0, rejected: 0, open: 0, superseded: 0 };
  for (const entry of ledger.entries) counts[entry.state]++;
  return counts;
}

function roundSummary(list, entries) {
  const byId = new Map(entries.map(entry => [entry.id, entry.verdict]));
  const thisRound = { accepted: 0, fixed: 0, dropped: 0, unnamed: 0 };
  const unnamed = [];
  const keys = { accept: "accepted", fix: "fixed", drop: "dropped" };
  for (const { id } of list.lines) {
    const verdict = byId.get(id);
    thisRound[keys[verdict] || "unnamed"]++;
    if (!verdict) unnamed.push(id);
  }
  const earlier = entries.filter(entry => !entry.id.startsWith(`${list.round}.`)).map(({ id, verdict }) => ({ id, verdict }));
  return { thisRound, earlier, unnamed };
}

function readReceipt(bytes, file, list, listSha256) {
  const receipt = parse(bytes, file);
  checkVersion(receipt, file, ["round", "listSha256", "entries", "outcome"]);
  requireField(receipt.round === list.round, `${file}.round`, `expected ${list.round}`);
  requireField(receipt.listSha256 === listSha256, `${file}.listSha256`, "different list.json bytes");
  array(receipt.entries, `${file}.entries`);
  receipt.entries.forEach((entry, i) => {
    const at = `${file}.entries[${i}]`;
    fields(entry, at, ["id", "verdict", "text"]);
    const [round, n] = parts(entry.id, `${at}.id`);
    requireField(round < list.round || (round === list.round && n <= list.lines.length), `${at}.id`, "outside the list");
    requireField(i === 0 || compareIds(receipt.entries[i - 1].id, entry.id) < 0, `${at}.id`, "duplicate or out of order");
    oneOf(entry.verdict, `${at}.verdict`, ["accept", "fix", "drop"]);
    if (entry.verdict === "fix") storedText(entry.text, `${at}.text`);
    else requireField(!("text" in entry), `${at}.text`, "unexpected for this verdict");
  });
  const at = `${file}.outcome`;
  const outcome = receipt.outcome;
  fields(outcome, at, ["counts", "thisRound", "earlier", "unnamed", "superseded", "decisionsSha256", "decisionsMdSha256"]);
  fields(outcome.counts, `${at}.counts`, states);
  for (const state of states) integer(outcome.counts[state], `${at}.counts.${state}`, 0, list.round * MAX_LINES);
  for (const [key, expected] of Object.entries(roundSummary(list, receipt.entries))) {
    requireField(isDeepStrictEqual(outcome[key], expected), `${at}.${key}`, "inconsistent with receipt entries");
  }
  array(outcome.superseded, `${at}.superseded`);
  const replaced = new Set();
  const accepted = new Set(receipt.entries.filter(entry => entry.verdict !== "drop").map(entry => entry.id));
  for (const [i, ref] of outcome.superseded.entries()) {
    const field = `${at}.superseded[${i}]`;
    fields(ref, field, ["id", "by", "text"]);
    const line = list.lines.find(line => line.id === ref.by);
    requireField(line && accepted.has(line.id), `${field}.by`, "expected an accepted proposal");
    const target = line.replaces?.find(target => target.id === ref.id);
    requireField(target && !replaced.has(ref.id), `${field}.id`, "expected a unique replacement shown on the list");
    requireField(ref.text === target.text, `${field}.text`, "different from the list");
    replaced.add(ref.id);
  }
  digest(outcome.decisionsSha256, `${at}.decisionsSha256`);
  digest(outcome.decisionsMdSha256, `${at}.decisionsMdSha256`);
  return receipt;
}

// Check all live references against the same pre-reply ledger. Apply explicit verdicts
// before replacements so that an owner can also decide an earlier open line in this batch.
function applyRound(ledger, list, entries, reply) {
  const byId = new Map(ledger.entries.map(entry => [entry.id, entry]));
  for (const [i, row] of reply.entries()) {
    if ("id" in row) requireField(byId.get(row.id)?.state === "open", `reply[${i}].id`, `${row.id} is not open`);
  }
  for (const line of list.lines) {
    for (const ref of line.replaces || []) {
      const target = byId.get(ref.id);
      requireField(target && target.text === ref.text && target.state === ref.state, ref.id, "the ledger changed since the list was built");
    }
    const { replaces, ...proposal } = line;
    const entry = { ...proposal, round: list.round, state: "open" };
    byId.set(entry.id, entry);
    ledger.entries.push(entry);
  }
  for (const { id, verdict, text } of entries) {
    const entry = byId.get(id);
    entry.state = verdict === "drop" ? "rejected" : "accepted";
    entry.decidedInRound = list.round;
    if (verdict === "fix") {
      entry.was = entry.text;
      entry.text = text;
    }
  }
  const superseded = [];
  for (const line of list.lines) {
    if (byId.get(line.id).state !== "accepted") continue;
    for (const ref of line.replaces || []) {
      const target = byId.get(ref.id);
      if (target.state !== "open" && target.state !== "accepted") continue;
      target.state = "superseded";
      target.supersededBy = line.id;
      delete target.decidedInRound;
      superseded.push({ id: ref.id, by: line.id, text: ref.text });
    }
  }
  ledger.appliedRounds.push(list.round);
  return { ...roundSummary(list, entries), superseded };
}

function listReply(spec) {
  const files = runPaths(spec);
  const { listFile, mdFile, replyFile, decisionsFile, decisionsMdFile } = files;
  const { round } = spec;
  const listBytes = optionalBytes(listFile);
  requireField(listBytes, listFile, "missing list for this round");
  const list = readList(listBytes, listFile, round);
  const listSha256 = sha(listBytes);
  const entries = canonicalReply(spec.reply, list);
  const receiptBytes = optionalBytes(replyFile);
  const receipt = receiptBytes && readReceipt(receiptBytes, replyFile, list, listSha256);
  if (receipt) requireField(isDeepStrictEqual(receipt.entries, entries), replyFile, `another reply for round ${round}`);
  const { ledger, bytes } = readLedger(files);
  const already = ledger.appliedRounds.includes(round);
  let ledgerBytes = bytes;
  let outcome = receipt?.outcome;
  let summary;
  if (already) {
    requireField(receipt, replyFile, "missing receipt for an applied round");
  } else {
    requireField(ledger.appliedRounds.length === round - 1, decisionsFile, `round ${round} is not the next reply`);
    const shown = optionalBytes(mdFile);
    requireField(!shown || shown.equals(listMarkdown(list)), mdFile, "differs from the rendering of list.json");
    if (!receipt && list.lines.some(line => line.replaces?.length)) {
      requireField(shown, mdFile, "replay list-build to show the proposed replacements before submitting a reply");
    }
    summary = applyRound(ledger, list, entries, spec.reply);
    ledgerBytes = jsonBytes(ledger);
  }
  const markdown = decisionsMarkdown(ledger);
  const current = {
    appliedRounds: ledger.appliedRounds, counts: countStates(ledger),
    decisionsSha256: sha(ledgerBytes), decisionsMdSha256: sha(markdown),
  };
  if (!already) {
    outcome = { counts: current.counts, ...summary, decisionsSha256: current.decisionsSha256, decisionsMdSha256: current.decisionsMdSha256 };
    if (receipt) requireField(isDeepStrictEqual(receipt.outcome, outcome), `${replyFile}.outcome`, "does not match the recovered round");
  }
  const writeMarkdown = !optionalBytes(decisionsMdFile)?.equals(markdown);
  const repaired = already && writeMarkdown ? ["decisions.md"] : [];
  if (!receipt) writeAtomic(replyFile, jsonBytes({ version: 1, round, listSha256, entries, outcome }));
  if (!already) writeAtomic(decisionsFile, ledgerBytes);
  if (writeMarkdown) writeAtomic(decisionsMdFile, markdown);
  return { ok: true, round, already, repaired, outcome, current, replyFile, decisionsFile, decisionsMdFile };
}

function wrap(command) {
  return (spec) => {
    try { return command(spec); }
    catch (error) {
      if (error instanceof Refusal) return { ok: false, error: error.message.slice(0, 800) };
      throw error;
    }
  };
}

export const BLOCK_COMMANDS = { "list-build": wrap(listBuild), "list-reply": wrap(listReply) };
