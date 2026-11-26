import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, samePath, STUB, FIXED }) {
  const events = (journal) => fs.readFileSync(path.join(journal, "events.jsonl"), "utf8").split(/\r?\n/).slice(0, -1).map(JSON.parse);
  const exitDetail = ({ json, err }) => {
    const reason = json?.refused || json?.infra || json?.stoppedAt || err.trim();
    return reason ? ` (${reason})` : "";
  };
  const whileRunning = (t, job) => {
    let stopped;
    job.then(result => {
      stopped = () => t.ok(false, `the package exited ${result.code} before reaching the expected state${exitDetail(result)}`);
    }, error => { stopped = () => { throw error; }; });
    return probe => () => { stopped?.(); return probe(); };
  };

  scenario("flow-check-slot", "packages serialize their checks, resume between commands, and screen private check paths", async (t) => {
    const first = flowWorld(t, "slot-first");
    const second = flowWorld(t, "slot-second");
    second.w.zhome = first.w.zhome;
    second.w.env.ZODCHI_HOME = first.w.zhome;
    first.w.env.ZODCHI_CHECK_SLOT_DIR = second.w.env.ZODCHI_CHECK_SLOT_DIR = path.join(first.w.dir, "slot");
    const trace = path.join(first.w.dir, "check-times.jsonl");
    const release = path.join(first.w.dir, "release-verify");
    const backgroundReady = path.join(first.w.dir, "background-ready");
    const backgroundRelease = path.join(first.w.dir, "release-background");
    const backgroundWrite = path.join(first.w.dir, "background-write");
    const stageLikeFixtures = [".p-fixture", ".p-deadbeef"];
    t.cleanups.push(() => fs.writeFileSync(backgroundRelease, ""));
    const times = () => fs.existsSync(trace)
      ? fs.readFileSync(trace, "utf8").split("\n").slice(0, -1).map(JSON.parse)
      : [];
    for (const [name, fixture] of [["first", first], ["second", second]]) {
      fs.writeFileSync(path.join(fixture.r, "slot-check.mjs"), `
import fs from "node:fs";
import { spawn } from "node:child_process";
const phase = process.argv[2];
const project = ${JSON.stringify(name)};
const stageLikeFixtures = ${JSON.stringify(stageLikeFixtures)};
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
  for (const fixture of stageLikeFixtures) {
    fs.mkdirSync("../" + fixture);
    fs.writeFileSync("../" + fixture + "/input", fixture);
  }
}
if (project === "first" && phase === "verify") {
  if (fs.readFileSync("../fixture", "utf8") !== "created by the cheap check") throw new Error("The original checkout was lost");
  for (const fixture of stageLikeFixtures) {
    if (fs.readFileSync("../" + fixture + "/input", "utf8") !== fixture) throw new Error("The sibling fixture was lost");
  }
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

    const checkRoot = path.join(first.w.zhome, "flow-checks");
    const slug = fs.readdirSync(checkRoot).find(name => fs.existsSync(path.join(checkRoot, name, "checkout")));
    t.ok(slug, "the interrupted check has a published checkout");
    const cleaned = await zodchi(t, first.w, ["flow", "cleanup", "--apply"], { cwd: first.r });
    t.eq(cleaned.code, 0, "cleanup runs between the cheap check and verify");
    for (const fixture of stageLikeFixtures) {
      const dir = path.join(checkRoot, slug, fixture);
      t.ok(!cleaned.json.items.some(item => samePath(item.path, dir)), `cleanup leaves the ${fixture} fixture out of its plan`);
      t.eq(fs.readFileSync(path.join(dir, "input"), "utf8"), fixture, `cleanup preserves the ${fixture} fixture for verify`);
    }

    const started = first.flow(["--resume", firstId], { ZODCHI_FLOW_CUT: "checks 1" });
    const firstRunning = whileRunning(t, started);
    // Keep both packages alive together, with the first one's verify command holding the slot.
    let queued;
    let secondId;
    try {
      await t.until("first verify started", firstRunning(() =>
        times().some(e => e.project === "first" && e.phase === "verify" && e.event === "start")));
      queued = second.flow(["--args", second.args({ checks: [], verify: [] })]);
      const secondRunning = whileRunning(t, queued);
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
    failed.w.env.ZODCHI_CHECK_SLOT_DIR = path.join(failed.w.dir, "slot");
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

  const checkDifferentHomes = async (t, { fallback = false } = {}) => {
    const fixture = fallback ? "slot-fallback" : "slot-home";
    const first = flowWorld(t, `${fixture}-first`);
    const second = flowWorld(t, `${fixture}-second`);
    const runtime = path.join(first.w.dir, "runtime");
    const slotTmp = path.join(first.w.dir, "slot-tmp");
    const localAppData = path.join(first.w.dir, "local-appdata");
    const onWindows = process.platform === "win32";
    const slot = onWindows ? path.join(runtime, "zodchi", "locks") : path.join(slotTmp, `zodchi-${process.geteuid()}`);
    const trace = path.join(first.w.dir, "check-order");
    const release = path.join(first.w.dir, "release-check");
    fs.mkdirSync(runtime);
    if (!onWindows) fs.mkdirSync(slotTmp);
    const order = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n") : [];
    t.ok(!samePath(first.w.zhome, second.w.zhome), "the packages use different Zodchi homes");
    for (const [name, f] of [["first", first], ["second", second]]) {
      for (const key of Object.keys(f.w.env)) {
        if (["LOCALAPPDATA", "PROGRAMDATA", "XDG_RUNTIME_DIR", "ZODCHI_CHECK_SLOT_DIR"].includes(key.toUpperCase())) delete f.w.env[key];
      }
      if (onWindows) {
        // Distinct profiles exercise the ProgramData lock. The fallback pair shares one profile.
        f.w.env.LOCALAPPDATA = fallback ? localAppData : path.join(f.w.dir, "local-appdata");
        if (!fallback || name === "first") f.w.env.ProgramData = runtime;
      } else {
        // The enclosing verifier may already hold the host's default slot.
        f.w.env.ZODCHI_TEST_CHECK_SLOT_TMP = slotTmp;
        if (name === "first") f.w.env.XDG_RUNTIME_DIR = runtime;
      }
      fs.writeFileSync(path.join(f.r, "slot-order.mjs"), `
import fs from "node:fs";
const trace = ${JSON.stringify(trace)};
fs.appendFileSync(trace, "${name} start\\n");
if (${name === "first"}) {
  const deadline = Date.now() + 45000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the check release");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
fs.appendFileSync(trace, "${name} end\\n");
`);
      gitOut(f.r, ["add", "--", "slot-order.mjs"]);
      gitOut(f.r, ["commit", "-qm", "Add a timed check"]);
      f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
      f.answer("review 1", f.review("approved"));
    }

    const run = f => f.flow(["--args", f.args({ checks: ["node slot-order.mjs"], verify: [] })]);
    const started = run(first);
    let queued;
    try {
      await t.until("the first check holds the slot", whileRunning(t, started)(() => order()[0] === "first start"));
      const firstId = fs.readdirSync(path.join(first.w.zhome, "flows"))[0];
      const namesHolder = dir => {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, "check-slot.json"), "utf8"));
        return owner.runId === firstId && samePath(owner.home, first.w.zhome);
      };
      t.ok(namesHolder(slot), "the shared slot identifies the holder and its home");
      if (onWindows) t.ok(namesHolder(path.join(localAppData, "zodchi", "locks")), "the per-user receipt identifies the same holder");
      queued = run(second);
      const running = whileRunning(t, queued);
      const flows = path.join(second.w.zhome, "flows");
      const secondId = await t.until("the second package has a journal", running(() => fs.existsSync(flows) && fs.readdirSync(flows)
        .find(id => fs.existsSync(path.join(flows, id, "run.json")))));
      const journal = path.join(flows, secondId);
      const waiting = await t.until("the second package waits for the first home", running(() => events(journal)
        .find(e => e.kind === "waiting for the check slot")));
      t.ok(waiting.holder === firstId && samePath(waiting.holderHome, first.w.zhome), "the wait names the run in the other home");
      t.eq(order(), ["first start"], "the second check has not started while the first is held");
    } finally {
      fs.writeFileSync(release, "");
      await Promise.allSettled([started, queued]);
    }
    const results = await Promise.all([started, queued]);
    t.eq(results.map(result => [result.code, result.json?.approved]), [[0, true], [0, true]], "both packages finish approved");
    t.eq(order(), ["first start", "first end", "second start", "second end"], "the checks in the two homes never overlap");
  };

  scenario("flow-check-slot-homes", "packages in different Zodchi homes contend for the same default check slot", async (t) => {
    await checkDifferentHomes(t);
    if (process.platform === "win32") await checkDifferentHomes(t, { fallback: true });
  });
}
