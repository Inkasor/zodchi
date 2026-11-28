import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED }) {
  async function checkJournalReaders(t, f) {
    const home = path.join(f.w.dir, "reader-home");
    fs.mkdirSync(home);
    const caller = (args, extraEnv = {}) => zodchi(t, f.w, ["flow", ...args], {
      cwd: f.w.dir, env: { ...f.w.env, ZODCHI_HOME: home, ...extraEnv }, timeoutMs: 10000,
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

    const opsId = "ops-to-close";
    seed(opsId, { kind: "waiting", step: "dry 0" }, {
      workflow: "ops-script", ownerFile: "lock/owner.json", ownerPid: 2147483647,
    });
    const cut = await caller(["cancel", opsId, "--reason", "The operator withdrew the request."], {
      ZODCHI_FLOW_CUT: "flow close claim",
    });
    t.eq(cut.code, 75, "cancel on an inactive run starts closure and can be interrupted");
    const recovered = await caller(["ops-script", "--resume", opsId, "--detach"]);
    t.eq([recovered.code, recovered.json?.verdict, recovered.json?.stoppedAt, recovered.json?.reason],
      [2, "closed", "dry 0", "The operator withdrew the request."], "resume completes closure before loading workflow inputs");
    t.ok(!fs.existsSync(path.join(home, "flows", opsId, "lock")), "a closed workflow releases its own run lock");
    const opsWait = await caller(["wait", opsId]);
    t.eq([opsWait.code, opsWait.json?.status], [2, "closed"], "wait reports closure as an unapproved end");
  }

  async function checkRemarkDuringWrite(t, { failReview = false } = {}) {
    const f = flowWorld(t, failReview ? "flow-worker-remark-rerun" : "flow-worker-live-remark");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    const review = f.review("changes_requested", [f.finding("F1")]);
    f.answer("review 1", failReview ? { flowError: { message: "Fixture review failed." } } : review);
    f.answer("close 1", f.patch([f.modify("src/math.mjs", FIXED, `// Keep values in range.\n${FIXED}`)]));
    f.answer("review 2", f.review("approved"));
    const release = path.join(f.w.dir, "release-held-writer");
    const wrapper = path.join(f.w.dir, "hold-writer.mjs");
    fs.writeFileSync(wrapper, `
      import fs from "node:fs";
      const release = ${JSON.stringify(release)};
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (line, ...args) => {
        if (!String(line).includes('"method":"turn/completed"') || fs.existsSync(release)) {
          return write(line, ...args);
        }
        const poll = setInterval(() => {
          if (fs.existsSync(release)) {
            clearInterval(poll);
            write(line, ...args);
          }
        }, 25);
        return true;
      };
      await import(${JSON.stringify(pathToFileURL(f.w.env.ZODCHI_CODEX_BIN).href)});
    `);
    f.w.env.ZODCHI_CODEX_BIN = wrapper;
    t.cleanups.push(() => fs.writeFileSync(release, ""));
    const owner = (...args) => zodchi(t, f.w, ["flow", ...args], { cwd: f.r, env: f.w.env });
    const started = await f.flow(["--args", f.args({ rounds: 2 }), "--detach"]);
    t.eq([started.code, started.json?.status], [0, "submitted"], "the fake writer runs in the detached worker");
    const id = started.json.runId;
    await t.until("the fake writer has started its held turn", () => f.steps().includes("write"));
    const message = "Check the upper bound before approving.";
    const file = path.join(f.w.dir, "remark.txt");
    fs.writeFileSync(file, message);
    let remarkId;
    try {
      const remark = await owner("remark", id, "--file", file);
      t.eq([remark.code, remark.json?.step, remark.json?.afterStep], [0, "next model step", "write"],
        "remark explains that delivery follows the active writer turn");
      remarkId = remark.json.remarkId;
      const status = await owner("status", id);
      t.eq([status.code, status.json?.status, status.json?.pendingRemarks?.map(row => [row.remarkId, row.text])],
        [0, "running", [[remarkId, message]]], "status lists the remark while the writer is still running");
    } finally {
      fs.writeFileSync(release, "");
    }
    const waited = await owner("wait", id, "--timeout-min", "0.5");
    if (failReview) {
      t.eq([waited.code, waited.json?.status], [2, "stopped"], "the failed review leaves a resumable stop");
      const stopped = await owner("status", id);
      t.eq([stopped.code, stopped.json?.stoppedAt, stopped.json?.pendingRemarks?.map(row => [row.remarkId, row.text])],
        [0, "gateway failed at review 1", [[remarkId, message]]], "status keeps the remark pending after the gateway failure");
      f.answer("review 1", review);
      const rerun = await f.flow(["--resume", id, "--rerun", "review 1"]);
      t.eq([rerun.code, rerun.json?.approved], [0, true], "the rerun completes the package");
    } else {
      t.eq([waited.code, waited.json?.status], [0, "finished"], "the package completes after the fake writer is released");
    }
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const reviewTurns = failReview ? [["review 1", 1], ["review 1", 1]] : [["review 1", 1]];
    t.eq(turns.map(turn => [turn.step, turn.prompt.split(message).length - 1]),
      [["write", 0], ...reviewTurns, ["close 1", 0], ["review 2", 0]],
      failReview ? "the failed review and its rerun each receive the remark once" : "exactly the next model step receives the remark once");
    t.eq((await owner("status", id)).json?.pendingRemarks ?? [], [], "status clears the delivered remark");
  }

  async function checkCloseAfterFileIntent(t) {
    for (const [cut, step] of [["apply write", "apply write"], ["index 1", "commit 1"]]) {
      const f = flowWorld(t, `flow-worker-close-${cut.replaceAll(" ", "-")}`);
      f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
      const interrupted = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: cut });
      t.eq(interrupted.code, 75, `the worker was cut at ${cut}`);
      const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
      const closed = await zodchi(t, f.w, ["flow", "close", id, "--reason", "The owner ended the interrupted run."], { cwd: f.r, env: f.w.env });
      t.eq([closed.code, closed.json?.verdict, closed.json?.unknownOutcome, closed.json?.unknownOutcomeFiles],
        [0, "closed", step, ["src/math.mjs"]], `close reports the step and paths with an unsettled ${cut} intent`);
      t.eq([f.commits(), f.steps(), f.claim()?.status], [[], ["write"], "closed"], "closing leaves the file effects as recorded and makes no new call");
    }
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
    const journal = path.join(f.w.zhome, "flows", id);
    const liveState = () => [fs.readdirSync(journal).sort(), fs.readFileSync(path.join(journal, "events.jsonl"), "utf8"), f.claim(), f.steps()];
    const beforeClose = liveState();
    const refused = await fromAnotherDirectory(["close", id, "--reason", "The reader tried to close a live run."]);
    t.ok(refused.code === 1 && refused.err.includes(`pid ${start.json.pid}`) && refused.err.includes("flow cancel"),
      "close refuses a live run and names its worker and the cancel command");
    t.eq(liveState(), beforeClose, "refusing to close a live run leaves its journal, claim and model calls alone");
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
    await t.until("the finished worker has published its final receipt", () => fs.existsSync(path.join(journal, "worker-result.json")));
    const beforeFinished = [homeState(journal), f.claim(), f.steps()];
    for (const command of ["close", "cancel"]) {
      const ended = await fromAnotherDirectory([command, id, "--reason", "Already reviewed."]);
      t.ok(ended.code === 1 && ended.err.includes(`run ${id} has finished`), `${command} refuses a finished run`);
    }
    t.eq([homeState(journal), f.claim(), f.steps()], beforeFinished, "both refusals leave the finished run unchanged");

    const heldReview = flowWorld(t, "flow-worker-cancel");
    // The isolated checkout must preserve the LF bytes used to hash the fake patches.
    gitOut(heldReview.r, ["config", "core.autocrlf", "false"]);
    heldReview.answer("write", heldReview.patch([heldReview.modify("src/math.mjs", STUB, FIXED)]));
    heldReview.answer("review 1", { flowHang: true });
    const reviewRelease = path.join(heldReview.w.dir, "release-held-review");
    const wrapper = path.join(heldReview.w.dir, "hold-review.mjs");
    fs.writeFileSync(wrapper, `
      import fs from "node:fs";
      setInterval(() => { if (fs.existsSync(${JSON.stringify(reviewRelease)})) process.exit(1); }, 25).unref();
      await import(${JSON.stringify(pathToFileURL(heldReview.w.env.ZODCHI_CODEX_BIN).href)});
    `);
    heldReview.w.env.ZODCHI_CODEX_BIN = wrapper;
    t.cleanups.push(() => fs.writeFileSync(reviewRelease, ""));
    const started = await heldReview.flow(["--args", heldReview.args({ isolated: true }), "--detach"]);
    t.eq([started.code, started.json?.status], [0, "submitted"], "the review can run detached");
    const cancelledId = started.json.runId;
    const cancelledJournal = path.join(heldReview.w.zhome, "flows", cancelledId);
    const file = (name) => path.join(cancelledJournal, name);
    const events = () => fs.readFileSync(file("events.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map(JSON.parse);
    await t.until("the held review turn started and its submission was recorded", () => heldReview.steps().includes("review 1")
      && events().some((event) => event.kind === "submitted" && event.step === "review 1"));
    const candidateRef = `refs/zodchi/candidates/${cancelledId}/1`;
    const candidate = gitOut(heldReview.r, ["rev-parse", candidateRef]);
    t.ok(/^[0-9a-f]{40}$/.test(candidate), "the isolated review has a retained candidate before cancellation");
    const cancel = (args, options = {}) => zodchi(t, heldReview.w, ["flow", ...args], {
      cwd: heldReview.w.dir, timeoutMs: 10000, ...options,
    });
    const reason = "The owner withdrew the review.";
    const requestedOnly = await cancel(["cancel", cancelledId, "--reason", reason], {
      env: { ...heldReview.w.env, ZODCHI_FLOW_CUT: "flow cancel request" },
    });
    const pendingRequest = JSON.parse(fs.readFileSync(file("shutdown-request.json"), "utf8"));
    t.eq([requestedOnly.code, pendingRequest.kind, pendingRequest.pid, pendingRequest.reason, heldReview.claim()?.status],
      [75, "cancel requested", started.json.pid, reason, "open"], "the cancellation event is durable before the worker is signalled");
    const stillRunning = await cancel(["status", cancelledId]);
    t.eq(stillRunning.json?.status, "running", "a cut before signalling leaves the worker live");
    const cancelStarted = performance.now();
    const cancelled = await cancel(["cancel", cancelledId, "--reason", reason], { timeoutMs: 65000 });
    t.eq([cancelled.code, cancelled.json?.verdict, cancelled.json?.reason, cancelled.json?.stoppedAt, cancelled.json?.unknownOutcome],
      [0, "closed", reason, "review 1", "review 1"], "cancel reports the in-flight review as an unknown outcome");
    t.ok(performance.now() - cancelStarted < 60000, "cancel completes within the worker wait limit");
    const workerExited = () => {
      const pid = started.json.pid;
      try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat[stat.lastIndexOf(") ") + 2] === "Z";
        }
        return false;
      } catch (error) {
        return error.code === "ESRCH" || error.code === "ENOENT";
      }
    };
    t.ok(workerExited() && !fs.existsSync(file("lock")), "cancel waits for the worker to exit and releases its lock");
    t.eq([heldReview.claim()?.status, JSON.parse(fs.readFileSync(file("result.json"), "utf8"))],
      ["closed", cancelled.json], "cancel closes the claim and saves the returned result");
    const history = events();
    const requested = history.find((event) => event.kind === "cancel requested");
    const closed = history.find((event) => event.kind === "closed");
    t.ok(requested?.reason === reason && requested.pid === started.json.pid && requested.requestedAt === pendingRequest.at
      && requested.seq < closed?.seq,
      "the cancellation request identifies the worker before the closing event");
    const continued = await cancel(["code-package", "--resume", cancelledId, "--detach"]);
    t.eq([continued.code, continued.json, heldReview.steps()], [2, cancelled.json, ["write", "review 1"]],
      "resume returns the saved unknown outcome without retrying the review");
    const retry = await cancel(["code-package", "--resume", cancelledId, "--rerun", "review 1"]);
    t.eq([retry.code, heldReview.steps()], [1, ["write", "review 1"]], "an explicit rerun cannot repeat a closed review");
    const applied = await cancel(["apply", cancelledId]);
    t.eq([applied.code, applied.json?.status, gitOut(heldReview.r, ["rev-parse", candidateRef]), heldReview.commits()],
      [2, "blocked", candidate, []], "a cancelled isolated candidate stays available and cannot be applied");
    t.eq(cancelled.json?.candidate?.ref, candidateRef, "cancel records the retained candidate even without a saved result");
    await checkRemarkDuringWrite(t);
    await checkRemarkDuringWrite(t, { failReview: true });
    await checkCloseAfterFileIntent(t);
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

    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    f.answer("write", f.patch([f.modify("src/math.mjs", FIXED, `// Keep the clamp in range.\n${FIXED}`)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    f.answer("close 1", { ...f.patch([]), status: "blocked", questions: ["Should the comment name the limits?"] });
    const waiting = await f.flow(["--args", f.args({ isolated: true, rounds: 2 })]);
    const waitingId = waiting.json.runId;
    t.eq([waiting.code, waiting.json?.status, f.claim()?.status, waiting.json?.openFindings?.length],
      [2, "waiting", "open", 1], "the second run waits for the owner with an open review finding");
    const waitingJournal = path.join(f.w.zhome, "flows", waitingId);
    const earlier = homeState(path.join(f.w.zhome, "flows", id));
    const before = [homeState(waitingJournal), f.claim(), f.steps()];
    for (const args of [["close", waitingId], ["cancel", waitingId], ["close", waitingId, "--reason", "x".repeat(501)]]) {
      t.eq((await caller(args)).code, 1, `${args[0]} rejects a missing or oversized reason`);
    }
    t.eq([homeState(waitingJournal), f.claim(), f.steps()], before, "invalid reasons leave the waiting run unchanged");
    fs.mkdirSync(path.join(waitingJournal, "tmp"), { recursive: true });
    const raw = `The owner deferred the change.\n${privateWord}`;
    const savedReason = "The owner deferred the change.\n[private text removed]";
    const closed = await caller(["close", waitingId, "--reason", raw]);
    const saved = JSON.parse(fs.readFileSync(path.join(waitingJournal, "result.json"), "utf8"));
    t.eq([closed.code, closed.json, saved.verdict, saved.reason, saved.stoppedAt, saved.openFindings, f.claim()?.status],
      [0, saved, "closed", savedReason, "close 1", waiting.json.openFindings, "closed"],
      "close preserves the stopped step and open findings and closes the claim with the screened reason");
    t.eq(saved.candidate, waiting.json.candidate, "close recovers the newest retained candidate from its ref");
    const eventsText = fs.readFileSync(path.join(waitingJournal, "events.jsonl"), "utf8");
    const history = eventsText.trimEnd().split("\n").map(JSON.parse);
    const closing = history.find((event) => event.kind === "closed");
    t.ok(!eventsText.includes(privateWord) && closing?.reason === savedReason && Number.isFinite(Date.parse(closing?.at)),
      "the closed event has a timestamp and records only screened text");
    t.ok(!fs.existsSync(path.join(waitingJournal, "tmp")), "close runs the normal post-run cleanup");
    const status = await caller(["status", waitingId]);
    const runs = await caller(["runs"]);
    const listed = runs.json?.find((run) => run.runId === waitingId);
    t.eq([status.code, status.json?.status, status.json?.event, status.json?.result, runs.code, listed?.status, listed?.live],
      [0, "closed", "closed", saved, 0, "closed", false], "status and runs show the closed run");
    const restored = await caller(["code-package", "--resume", waitingId]);
    t.eq([restored.code, restored.json, f.steps(), homeState(path.join(f.w.zhome, "flows", id))],
      [0, saved, before[2], earlier], "resume prints the saved owner close without a model call or touching the earlier run");
    const afterClose = [homeState(waitingJournal), f.claim(), f.steps()];
    const repeated = await caller(["close", waitingId, "--reason", "A second reason."]);
    t.ok(repeated.code === 1 && repeated.err.includes(`run ${waitingId} has finished`),
      "an explicitly closed run is finished");
    t.eq([homeState(waitingJournal), f.claim(), f.steps()], afterClose, "a repeated close cannot replace the saved reason");

    // Seed a stored claim at the documented 60-character limit. The current
    // new-run parser caps labels at 40 characters.
    const storedId = "stored-code-package";
    const storedLabel = "stored-" + "x".repeat(53);
    const storedJournal = path.join(f.w.zhome, "flows", storedId);
    const storedRunFile = path.join(storedJournal, "run.json");
    const storedRun = JSON.parse(fs.readFileSync(path.join(waitingJournal, "run.json"), "utf8"));
    storedRun.runId = storedId;
    storedRun.inputs.args.label = "../" + storedLabel;
    const claimEvent = history.find((event) => event.kind === "done" && event.step === "claim");
    const storedClaim = path.join(path.dirname(claimEvent.result.file), storedLabel + ".json");
    fs.writeFileSync(storedClaim, JSON.stringify({ ...f.claim(), label: storedLabel, run: storedId, status: "open", closedAt: undefined }));
    fs.mkdirSync(storedJournal);
    fs.writeFileSync(storedRunFile, JSON.stringify(storedRun));
    fs.writeFileSync(path.join(storedJournal, "events.jsonl"), JSON.stringify({ kind: "waiting", step: "write" }) + "\n");
    const beforeInvalid = homeState(storedJournal);
    const invalid = await caller(["cancel", storedId, "--reason", "Stop the stored run."]);
    t.ok(invalid.code === 1 && invalid.err.includes("no valid package label"), "cancel rejects an unsafe stored label");
    t.eq(homeState(storedJournal), beforeInvalid, "an invalid claim identity leaves the run without a shutdown request");

    storedRun.inputs.args.label = storedLabel;
    fs.writeFileSync(storedRunFile, JSON.stringify(storedRun));
    const closedStored = await caller(["close", storedId, "--reason", "Stop the stored run."]);
    const own = JSON.parse(fs.readFileSync(storedClaim, "utf8"));
    t.eq([closedStored.code, closedStored.json?.verdict, own.run, own.status, f.claim()],
      [0, "closed", storedId, "closed", afterClose[1]], "close releases the stored long-label claim and leaves the other claim alone");
    const restoredStored = await caller(["code-package", "--resume", storedId]);
    t.eq([restoredStored.code, restoredStored.json, f.steps()], [0, closedStored.json, afterClose[2]],
      "resume returns the stored long-label result without a model call");
  });
}
