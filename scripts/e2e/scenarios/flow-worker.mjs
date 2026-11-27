import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

function homeState(dir) {
  const mtime = String(fs.statSync(dir, { bigint: true }).mtimeNs);
  const entries = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.statSync(file, { bigint: true });
    return [name, stat.isDirectory() ? homeState(file)
      : [String(stat.mtimeNs), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  });
  return [mtime, entries];
}

export default function register({ scenario, flowWorld, zodchi, STUB, FIXED }) {
  async function checkJournalReaders(t, f) {
    const home = path.join(f.w.dir, "reader-home");
    fs.mkdirSync(home);
    const caller = (args) => zodchi(t, f.w, ["flow", ...args], {
      cwd: f.w.dir, env: { ...f.w.env, ZODCHI_HOME: home }, timeoutMs: 10000,
    });
    const empty = await caller(["runs"]);
    t.eq([empty.code, empty.json], [0, []], "a home without a flows directory has no runs");
    t.ok(!fs.existsSync(path.join(home, "flows")), "runs does not create a flows directory");

    const newest = Math.floor(Date.now() / 1000) - 30;
    const old = newest - 7200;
    const leapDay = Date.parse("2020-02-29T12:34:56.500Z") / 1000;
    const seed = (id, event, { workflow = "code-package", label, runAt, eventsAt, result, resultAt, ownerFile, ownerPid, tail = "" }) => {
      const put = (name, contents, at) => {
        const file = path.join(home, "flows", id, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        if (at !== undefined) fs.utimesSync(file, at, at);
      };
      put("run.json", JSON.stringify({ runId: id, workflow, label }), runAt);
      put("events.jsonl", (typeof event === "string" ? event : JSON.stringify(event)) + "\n" + tail, eventsAt);
      if (result !== undefined) put("result.json", JSON.stringify(result), resultAt);
      if (ownerFile) put(ownerFile, JSON.stringify({ pid: ownerPid }));
      return put;
    };
    seed("done", { kind: "finished", step: "result" }, {
      label: "approved fixture", runAt: newest - 20, eventsAt: newest - 10,
      result: { approved: true }, resultAt: newest,
    });
    seed("awaiting", {
      kind: "waiting", step: "review 1", decisions: ["Pick a boundary"], question: "Which boundary?",
      next: "Reply and resume this run.",
    }, { runAt: newest - 10, eventsAt: newest });
    seed("fresh", { kind: "intent", step: "write" }, {
      label: "live fixture", runAt: newest - 60, eventsAt: newest - 70,
      ownerFile: "lock/owner.json", ownerPid: process.pid, tail: '{"kind":',
    });
    seed("damaged", "{bad event", { label: "broken fixture", runAt: newest - 120, eventsAt: newest - 120 });
    const writeStale = seed("stale", { kind: "intent", step: "review 1" }, {
      runAt: old - 10, eventsAt: old, ownerFile: "worker.json", ownerPid: process.pid,
    });
    writeStale("worker.log", "Fresh worker output");
    seed("dead", { kind: "intent", step: "write" }, {
      runAt: leapDay - 10, eventsAt: leapDay, ownerFile: "worker.json", ownerPid: 2147483647,
    });

    const snapshot = () => [homeState(home), homeState(f.w.home)];
    const before = snapshot();
    const beforeList = Date.now() / 1000;
    const listed = await caller(["runs"]);
    const afterList = Date.now() / 1000;
    t.eq(listed.code, 0, "a damaged journal does not fail runs");
    t.ok(Array.isArray(listed.json), "runs prints one JSON array");
    const fields = (row) => [row.runId, row.workflow, row.label, row.status, row.step, row.live, row.waiting, row.stale];
    t.eq(listed.json.map(fields), [
      ["awaiting", "code-package", null, "waiting", "review 1", false, "decision", false],
      ["done", "code-package", "approved fixture", "finished", "result", false, null, false],
      ["fresh", "code-package", "live fixture", "running", "write", true, null, false],
      ["damaged", "code-package", "broken fixture", null, null, false, null, false],
      ["stale", "code-package", null, "running", "review 1", true, null, true],
      ["dead", "code-package", null, "interrupted", "write", false, null, false],
    ], "runs reports the journal status and liveness in newest-first order with ties broken by run ID");
    const expectedTimes = [newest, newest, newest - 60, newest - 120, old, leapDay];
    for (const [i, row] of listed.json.entries()) {
      const time = expectedTimes[i];
      t.ok(row.lastWriteAt.endsWith("Z") && Date.parse(row.lastWriteAt) === time * 1000,
        row.runId + " has the UTC timestamp of its newest journal file");
      t.ok(Number.isInteger(row.secondsSinceLastWrite) && row.secondsSinceLastWrite >= Math.floor(beforeList - time)
        && row.secondsSinceLastWrite <= Math.floor(afterList - time), row.runId + " reports the whole-second age of that file");
    }
    t.ok(listed.json[3].error?.includes("broken at line 1") && listed.json.every((row, i) => i === 3 || row.error === null),
      "only the damaged journal gets an error, and the incomplete write on the live run is ignored");
    const active = await caller(["runs", "--active"]);
    t.eq([active.code, active.json.map(fields)], [0, [0, 2, 4].map((i) => fields(listed.json[i]))],
      "runs --active includes live and waiting runs in the same order");
    t.eq(snapshot(), before, "runs leaves all file hashes and mtimes in the fixture homes unchanged");

    const done = await caller(["wait", "fresh", "done"]);
    t.eq([done.code, done.json], [0, {
      runId: "done", workflow: "code-package", label: "approved fixture", status: "finished", step: "result", waiting: null,
    }], "wait returns immediately for an approved run even when another named run is live");
    const waiting = await caller(["wait", "awaiting"]);
    t.eq([waiting.code, waiting.json], [2, {
      runId: "awaiting", workflow: "code-package", label: null, status: "waiting", step: "review 1", waiting: "decision",
      question: "Which boundary?", next: "Reply and resume this run.",
    }], "wait immediately reports the owner decision and the recorded next action");
    const dead = await caller(["wait", "dead"]);
    t.eq([dead.code, dead.json?.status], [2, "interrupted"], "a dead worker is an immediate unapproved end");
    const started = performance.now();
    const timeout = await caller(["wait", "--all", "--timeout-min", "0.05"]);
    t.eq([timeout.code, timeout.json?.runs?.map((row) => [row.runId, row.status])],
      [3, [["fresh", "running"], ["stale", "running"]]], "a fractional timeout returns current rows for all initially live runs");
    t.ok(performance.now() - started >= 2900, "wait lets the three-second timeout elapse");
    for (const args of [
      ["runs", "--active", "extra"], ["runs", "--args"], ["wait", "unknown-run"],
      ["wait", "done", "extra"], ["wait", "--all", "done"], ["wait", "done", "--timeout-min", "NaN"],
    ]) {
      t.eq((await caller(args)).code, 1, args.join(" ") + " is a wrong call");
    }
    t.eq(snapshot(), before, "wait also leaves the fixture homes unchanged");

    const finished = { kind: "finished", step: "result" };
    for (const [workflow, result] of [
      ["candidate-acceptance", { verdict: "pass" }],
      ["ops-script", { ready: true }],
      ["voiceover", { status: "rendered" }],
      ["youtube-publish", { verdict: "private_verified" }],
    ]) {
      seed(workflow, finished, { workflow, result });
      const success = await caller(["wait", workflow]);
      t.eq([success.code, success.json?.status], [0, "finished"], workflow + " reports its recorded success");
    }
    seed("changes", finished, { result: { verdict: "changes_requested", next: "Resolve the findings." } });
    const changes = await caller(["wait", "changes"]);
    t.eq([changes.code, changes.json?.status, changes.json?.next],
      [2, "finished", "Resolve the findings."], "wait reports a finished but unapproved result and its next action");
  }

  scenario("flow-worker-reattach", "a detached flow keeps one run and a second caller can inspect and resume it", async (t) => {
    const f = flowWorld(t, "flow-worker-reattach");
    await checkJournalReaders(t, f);
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const gate = path.join(f.w.dir, "worker-gate.mjs");
    const ready = path.join(f.w.dir, "worker-ready");
    const release = path.join(f.w.dir, "worker-release");
    fs.writeFileSync(gate, [
      'import fs from "node:fs";',
      'import { setTimeout as pause } from "node:timers/promises";',
      "const deadline = Date.now() + 30000;",
      "fs.writeFileSync(" + JSON.stringify(ready) + ', "");',
      "while (!fs.existsSync(" + JSON.stringify(release) + ")) {",
      '  if (Date.now() >= deadline) throw new Error("Worker fixture was not released");',
      "  await pause(25);",
      "}",
    ].join("\n"));
    t.cleanups.push(() => fs.writeFileSync(release, ""));
    const gateArg = "'" + gate.replace(/\\/g, "/").replaceAll("'", "'\\''") + "'";
    const start = await f.flow(["--args", f.args({
      verify: ["node smoke.mjs", "node " + gateArg],
    }), "--detach"]);
    t.eq([start.code, start.json.status], [0, "submitted"], "the caller leaves after collecting the run ID");
    const id = start.json.runId;
    const fromAnotherDirectory = (args, options = {}) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, ...options });
    const attach = await fromAnotherDirectory(["code-package", "--resume", id]);
    t.eq(attach.json.runId, id, "the second caller attaches to the same run");
    const limit = Date.now() + 30000;
    await t.until("the detached worker reached the held verification", () => fs.existsSync(ready), limit - Date.now());
    const remaining = Math.max(1, limit - Date.now());
    const waiting = fromAnotherDirectory(["wait", id, "--timeout-min", "0.5"], { timeoutMs: remaining });
    const [held, pending] = await Promise.all([
      fromAnotherDirectory(["runs", "--active"], { timeoutMs: remaining }),
      Promise.race([waiting.then(() => false), pause(250, true)]),
    ]);
    t.eq([held.code, held.json.map((row) => [row.runId, row.label, row.status])], [0, [[id, "clamp", "running"]]],
      "the detached worker is live and has its code-package label before verification is released");
    t.ok(pending, "wait stays pending while the worker is held");
    fs.writeFileSync(release, "");
    const waited = await waiting;
    t.eq([waited.code, waited.json?.runId, waited.json?.label, waited.json?.status], [0, id, "clamp", "finished"],
      "wait returns when the detached worker finishes the same run");
    const inspected = await fromAnotherDirectory(["status", id]);
    const final = inspected.json?.status === "finished" ? inspected.json.result : null;
    t.eq([final?.approved, f.claim().status, f.commits().length, f.steps()],
      [true, "done", 1, ["write", "review 1"]], "detached execution, inspection and resume do not duplicate effects");
  });

  scenario("flow-owner-reply", "the run waits for an answer, scrubs owner inputs before saving them and resumes the same claim", async (t) => {
    const f = flowWorld(t, "flow-owner-reply");
    f.answer("write", { ...f.patch([]), status: "blocked", questions: ["Which boundary applies?"] });
    const first = await f.flow(["--args", f.args()]);
    const id = first.json.runId;
    t.eq([first.code, first.json.status, f.claim().status], [2, "waiting", "open"], "the decision preserves the run and claim");
    const caller = (args) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: f.w.env });
    const inspected = await caller(["status", id]);
    t.eq(inspected.json.status, "waiting", "the second caller can see the decision");
    const wait = await zodchi(t, f.w, ["flow", "wait", id], { cwd: f.w.dir, timeoutMs: 10000 });
    t.eq([wait.code, wait.json?.runId, wait.json?.status, wait.json?.waiting, wait.json?.question],
      [2, id, "waiting", "question", inspected.json.question], "wait immediately returns the owner's free-form question");
    await caller(["code-package", "--resume", id]);
    t.eq(f.steps(), ["write"], "resume before an answer spends no second turn");
    const privateWord = "SampleSensitiveName";
    const input = path.join(f.w.dir, "input.txt");
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), privateWord + "\n");
    const fixturePayload = "LOCAL_FIXTURE_VALUE";
    const boundary = (tag) => "-----" + tag + " TEST PRIVATE KEY-----";
    const block = [boundary("BEGIN"), fixturePayload, boundary("END")].join("\n");
    fs.writeFileSync(input, "Keep the output integer.\n" + privateWord + "\n" + block);
    const remark = await caller(["remark", id, "--file", input]);
    t.eq([remark.code, remark.json.status], [0, "recorded"], "the steering remark is accepted");
    const persisted = fs.readFileSync(path.join(f.w.zhome, "flows", id, "remarks", remark.json.remarkId + ".json"), "utf8");
    t.ok(!persisted.includes(fixturePayload), "a multiline private key shaped block is scrubbed before persistence");
    fs.writeFileSync(input, "Use the limits from the brief.");
    const reply = await caller(["reply", id, "--file", input]);
    t.eq([reply.code, reply.json.status], [0, "ready"], "the owner explicitly answers");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const result = await caller(["code-package", "--resume", id]);
    t.eq([result.code, result.json.runId, result.json.verdict, f.claim().status, f.steps()],
      [0, id, "approved", "done", ["write", "write", "review 1"]], "the explicit continuation finishes under the original run ID");
    const next = fs.readFileSync(path.join(f.w.zhome, "flows", id, "requests", `flow-${id}-write-a2.json`), "utf8");
    t.ok(next.includes("Keep the output integer.") && next.includes("Use the limits from the brief.")
      && next.includes("[private text removed]") && !next.includes(privateWord), "the next prompt includes only scrubbed owner input");
  });
}
