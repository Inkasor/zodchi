import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED }) {
  scenario("flow-check-slot", "packages serialize their checks, resume between commands, and screen private check paths", async (t) => {
    const first = flowWorld(t, "slot-first");
    const second = flowWorld(t, "slot-second");
    second.w.zhome = first.w.zhome;
    second.w.env.ZODCHI_HOME = first.w.zhome;
    const trace = path.join(first.w.dir, "check-times.jsonl");
    const release = path.join(first.w.dir, "release-verify");
    const backgroundReady = path.join(first.w.dir, "background-ready");
    const backgroundRelease = path.join(first.w.dir, "release-background");
    const backgroundWrite = path.join(first.w.dir, "background-write");
    t.cleanups.push(() => fs.writeFileSync(backgroundRelease, ""));
    const times = () => fs.existsSync(trace)
      ? fs.readFileSync(trace, "utf8").split("\n").slice(0, -1).map(JSON.parse)
      : [];
    const events = (journal) => fs.readFileSync(path.join(journal, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const exitDetail = ({ json, err }) => {
      const reason = json?.refused || json?.infra || json?.stoppedAt || err.trim();
      return reason ? ` (${reason})` : "";
    };

    for (const [name, fixture] of [["first", first], ["second", second]]) {
      fs.writeFileSync(path.join(fixture.r, "slot-check.mjs"), `
import fs from "node:fs";
import { spawn } from "node:child_process";
const phase = process.argv[2];
const project = ${JSON.stringify(name)};
const backgroundReady = ${JSON.stringify(backgroundReady)};
const backgroundRelease = ${JSON.stringify(backgroundRelease)};
const waitFor = async (file) => {
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + file);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
if (phase === "background") {
  const ready = backgroundReady + ".tmp";
  fs.writeFileSync(ready, String(process.pid));
  fs.renameSync(ready, backgroundReady);
  await waitFor(backgroundRelease);
  fs.writeFileSync(${JSON.stringify(backgroundWrite)}, "a previous check is still running");
  process.exit(0);
}
const cache = process.env.CHECK_SLOT_CACHE;
if (!cache || !fs.statSync(cache).isDirectory()) throw new Error("Expected the declared cache directory");
const record = event => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ project, phase, event, at: Date.now() }) + "\\n");
record("start");
if (project === "first" && phase === "check") {
  fs.writeFileSync("../fixture", "created by the cheap check");
}
if (project === "first" && phase === "verify") {
  if (fs.readFileSync("../fixture", "utf8") !== "created by the cheap check") throw new Error("The original checkout was lost");
  if (process.platform === "win32") {
    spawn(process.execPath, [process.argv[1], "background"], { stdio: "ignore", windowsHide: true }).unref();
    await waitFor(backgroundReady);
  }
  await waitFor(${JSON.stringify(release)});
}
if (project === "second" && phase === "check" && process.platform === "win32") {
  // The previous command has exited. Its worker must be gone before this holder can use the slot.
  const pid = Number(fs.readFileSync(backgroundReady, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("The background worker did not record its PID");
  try {
    process.kill(pid, 0);
    throw new Error("The previous check's background process is still alive");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  fs.writeFileSync(backgroundRelease, "");
}
record("end");
`);
      fs.mkdirSync(path.join(fixture.r, ".zodchi"), { recursive: true });
      fs.writeFileSync(path.join(fixture.r, ".zodchi", "verify.json"), JSON.stringify({
        tools: ["node"],
        env: { CHECK_SLOT_CACHE: "{cache}" },
        checks: ["node slot-check.mjs check"],
        verify: ["node slot-check.mjs verify"],
      }));
      gitOut(fixture.r, ["add", "--", ".zodchi/verify.json", "slot-check.mjs"]);
      gitOut(fixture.r, ["commit", "-qm", "Declare timed checks"]);
      fixture.answer("write", fixture.patch([fixture.modify("src/math.mjs", STUB, FIXED)]));
      fixture.answer("review 1", fixture.review("approved"));
    }

    const interruption = await first.flow(["--args", first.args({ checks: [], verify: [] })],
      { ZODCHI_FLOW_CUT: "checks 1 project.checks #1" });
    const cutDetail = interruption.code === 75 ? "" : exitDetail(interruption);
    t.eq(interruption.code, 75, `the first package is cut after its cheap check and before verify${cutDetail}`);
    const flows = path.join(first.w.zhome, "flows");
    const [firstId] = fs.readdirSync(flows);
    const firstJournal = path.join(flows, firstId);
    const between = events(firstJournal);
    const intent = between.find(e => e.step === "checks 1" && e.kind === "intent");
    t.eq(between.filter(e => e.step === "checks 1" && e.kind === "check ended").map(e =>
      [e.tree, e.commandIndex, e.result?.source, e.result?.exitCode]),
      [[intent?.tree, 1, "project.checks", 0]], "only the cheap check has a durable result for the candidate tree");
    t.ok(!between.some(e => e.step === "checks 1" && e.kind === "done"), "the whole step has no receipt yet");
    t.eq(times().map(e => [e.project, e.phase, e.event]),
      [["first", "check", "start"], ["first", "check", "end"]], "no verify command started before the cut");

    const whileRunning = (job) => {
      let stopped;
      job.then(result => {
        stopped = () => t.ok(false, `the package exited ${result.code} before reaching the expected state${exitDetail(result)}`);
      }, error => { stopped = () => { throw error; }; });
      return probe => () => { stopped?.(); return probe(); };
    };
    const started = first.flow(["--resume", firstId], { ZODCHI_FLOW_CUT: "checks 1" });
    const firstRunning = whileRunning(started);
    // Keep both packages alive together, with the first one's verify command holding the slot.
    let queued;
    let secondId;
    try {
      await t.until("first verify started", firstRunning(() =>
        times().some(e => e.project === "first" && e.phase === "verify" && e.event === "start")));
      queued = second.flow(["--args", second.args({ checks: [], verify: [] })]);
      const secondRunning = whileRunning(queued);
      secondId = await t.until("the second package has a journal", secondRunning(() => fs.readdirSync(flows)
        .find(id => id !== firstId && fs.existsSync(path.join(flows, id, "run.json")))));
      const eventFile = path.join(flows, secondId, "events.jsonl");
      await t.until("the second package is waiting", secondRunning(() =>
        fs.readFileSync(eventFile, "utf8").includes('"kind":"waiting for the check slot"')));
      const status = await zodchi(t, second.w, ["flow", "status", secondId], { cwd: second.r });
      t.eq([status.code, status.json?.status, status.json?.event, status.json?.step],
        [0, "running", "waiting for the check slot", `checks 1 (held by ${firstId})`], "status names the wait and the holder");
      t.eq(second.steps(), ["write"], "the second writer ran while the first verify command held the slot");
      t.ok(times().every(e => e.project === "first"), "the second check has not started");
    } finally {
      fs.writeFileSync(release, "");
      await Promise.allSettled([started, queued]);
    }

    const cut = await started;
    t.eq(cut.code, 75, "the first run cut with its check receipt saved and the slot still held");
    const [resumed, finished] = await Promise.all([first.flow(["--resume", firstId]), queued]);
    t.eq([resumed.code, resumed.json?.approved, finished.code, finished.json?.approved],
      [0, true, 0, true], "both packages finished and the second took over the released slot");
    t.eq(events(path.join(flows, secondId)).filter(e => e.kind === "waiting for the check slot" || e.kind === "check slot acquired").map(e => e.kind),
      ["waiting for the check slot", "check slot acquired"], "the waiter records one wait and one acquisition");
    t.eq(resumed.json.verification.evidence.map(e => [e.source, e.exitCode]),
      [["project.checks", 0], ["project.verify", 0]], "the final evidence keeps the result from before the cut");
    const recorded = times();
    t.eq(recorded.map(e => [e.project, e.phase, e.event]),
      ["first", "second"].flatMap(project => ["check", "verify"].flatMap(phase => ["start", "end"].map(event => [project, phase, event]))),
      "both checks and verifies ran once, including after resume");
    t.ok(recorded[3].at <= recorded[4].at, "the first verify command ended before the second check command started");
    if (process.platform === "win32") {
      t.ok(fs.existsSync(backgroundReady) && fs.existsSync(backgroundRelease) && !fs.existsSync(backgroundWrite),
        "the previous check's worker was stopped before it could write after slot handoff");
    }

    const privateName = "boreal";
    const failed = flowWorld(t, privateName);
    failed.answer("write", failed.patch([failed.modify("src/math.mjs", STUB, FIXED)]));
    failed.answer("fix 1.1", { ...failed.patch([]), status: "blocked" });
    const failure = await failed.flow(["--args", failed.args({
      fixes: 1,
      verify: [`node -e "console.error(require('node:path').resolve('..', 'fixture')); process.exit(4)"`],
    })]);
    t.eq([failure.code, failed.steps()], [2, ["write", "fix 1.1"]], "the failure reaches the fixing writer");
    const failedCommand = events(failure.json.journal).find(e => e.kind === "check ended" && e.result?.exitCode === 4);
    const log = fs.readFileSync(failedCommand.result.log, "utf8");
    t.ok(log.includes(`${privateName}-repo-`) && log.includes("fixture"), "the raw diagnostic names the sibling in a private path");
    const turns = fs.readFileSync(path.join(failed.w.codex, "fake-turns.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const prompt = turns.find(turn => turn.step === "fix 1.1").prompt;
    t.ok(/<check-workspace>[/\\]fixture/.test(prompt) && !prompt.includes(privateName),
      "the fixing prompt preserves the diagnostic without the private repository name");
  });
}
