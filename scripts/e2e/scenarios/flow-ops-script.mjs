import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// The Bash fake is used only for tool preflight: these fixtures are Python
// only. No shell, sudo, model, or network is invoked.
let fakeBashPath;
function fakeBash(w) {
  if (fakeBashPath) return fakeBashPath;
  const dir = path.dirname(w.dir);
  const source = path.join(dir, "ops-fake-bash.rs");
  fakeBashPath = path.join(dir, process.platform === "win32" ? "ops-fake-bash.exe" : "ops-fake-bash");
  fs.writeFileSync(source, 'fn main() { let exe = std::env::current_exe().unwrap(); if exe.file_name().unwrap().to_string_lossy().contains("sha256sum") { println!("sha256sum (GNU coreutils) fixture"); } else { println!("GNU bash, version fixture"); } }\n');
  const built = spawnSync("rustc", [source, "-o", fakeBashPath], { encoding: "utf8", windowsHide: true });
  if (built.status !== 0) throw new Error(`Cannot build fake Bash: ${built.stderr}`);
  const sum = path.join(dir, process.platform === "win32" ? "sha256sum.exe" : "sha256sum");
  fs.copyFileSync(fakeBashPath, sum);
  if (process.platform !== "win32") fs.chmodSync(sum, 0o755);
  return fakeBashPath;
}
function python() {
  for (const name of ["python3", "python"]) {
    const r = spawnSync(name, ["-c", "import sys; assert sys.version_info.major == 3; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return name;
  }
  throw new Error("Python 3 is required for the ops-script fixtures");
}

export default function register({ scenario: registerScenario, world, zodchi, flowWorld, gitOut }) {
  function fixture(name) {
    const w = world(name);
    const interpreter = python();
    w.env.ZODCHI_BASH = fakeBash(w);
    w.env.PATH = `${path.dirname(w.env.ZODCHI_BASH)}${path.delimiter}${w.env.PATH}`;
    delete w.env.ZODCHI_FLOW_CUT;
    const tmp = path.join(w.dir, "snapshots with spaces");
    fs.mkdirSync(tmp, { recursive: true });
    const script = path.join(w.dir, "script with spaces.py");
    const companion = path.join(w.dir, "payload with spaces.txt");
    fs.writeFileSync(companion, "expected payload\n");
    const args = path.join(w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ script, tmp, files: [companion], check: [interpreter, "{copy}", "--check"], sudo: ["sudo", interpreter, "{script}", "--apply"], fixes: 0 }));
    return { w, script, companion, tmp, args, interpreter };
  }
  const invoke = (t, f, args, env = {}) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: { ...f.w.env, ...env } });
  const scenario = (name, description, run) => registerScenario(name, description, async (t) => {
    if (process.platform !== "darwin") return run(t);
    const w = world(`${name}-unsupported`);
    const tmp = path.join(w.dir, "snapshots");
    const script = path.join(w.dir, "script.sh");
    const args = path.join(w.dir, "args.json");
    fs.mkdirSync(tmp);
    fs.writeFileSync(script, "#!/bin/sh\necho never-run\n");
    fs.writeFileSync(args, JSON.stringify({ script, tmp, sudo: ["sudo", "bash", "{script}"], fixes: 0 }));
    const f = { w, tmp, args };
    const result = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(result.code === 2 && result.json?.refused?.includes("cannot enforce") && fs.readdirSync(f.tmp).length === 0, "macOS is explicitly refused before effects");
  });

  scenario("flow-ops-script", "checks exact local snapshots without sudo and pins the human command", async (t) => {
    const f = fixture("flow-ops-script");
    fs.writeFileSync(f.script, "import sys\nassert '--check' in sys.argv\nassert open('payload with spaces.txt').read() == 'expected payload\\n'\nprint('checked')\n");
    const good = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.eq([good.code, good.json?.ready, good.json?.dry?.stdout.trim()], [0, true, "checked"], "the unprivileged check succeeds");
    t.eq(good.json?.static?.shellcheck, "not applicable", "Python-only checks do not claim ShellCheck ran");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(f.script)).digest("hex");
    t.ok(good.json?.forHuman.includes(digest) && good.json?.forHuman.includes("sha256sum -c -") && good.json?.forHuman.includes("'sudo'"), "the human command checks the snapshot hash before sudo");
    if (process.platform === "linux") {
      const shellScript = path.join(f.w.dir, "direct.sh");
      fs.writeFileSync(shellScript, "#!/bin/sh\nprintf 'shell=%s\\n' \"${BASH_VERSION:-other}\"\n", { mode: 0o755 });
      const directArgs = path.join(f.w.dir, "direct.json");
      fs.writeFileSync(directArgs, JSON.stringify({ script: shellScript, tmp: f.tmp, check: ["{copy}", "--check"], sudo: ["sudo", "{script}"], fixes: 0 }));
      const realTools = { ZODCHI_BASH: "/bin/bash", PATH: f.w.env.PATH.split(path.delimiter).slice(1).join(path.delimiter) };
      const direct = await invoke(t, f, ["ops-script", "--args", directArgs], realTools);
      const hostShell = spawnSync("/bin/sh", [shellScript, "--check"], { encoding: "utf8" });
      t.eq([direct.code, direct.json?.dry?.stdout.trim()], [hostShell.status, hostShell.stdout.trim()], "direct dry run follows the host shebang interpreter");
      fs.writeFileSync(shellScript, "#!/bin/sh\nif then\n", { mode: 0o755 });
      const lintDir = path.join(f.w.dir, "lint-tools");
      fs.mkdirSync(lintDir);
      fs.writeFileSync(path.join(lintDir, "shellcheck"), "#!/bin/sh\necho 'ShellCheck fixture'\n", { mode: 0o755 });
      const syntax = await invoke(t, f, ["ops-script", "--args", directArgs], { ...realTools, PATH: `${lintDir}${path.delimiter}${realTools.PATH}` });
      t.ok(syntax.code === 2 && syntax.json?.step === "static 0" && !syntax.json?.dry, "real Bash rejects invalid syntax before the dry run");
      t.eq(syntax.json?.detail?.shellcheck, "not reached", "an early syntax failure is not reported as a ShellCheck run");
      fs.writeFileSync(shellScript, "#!/usr/bin/env bash\necho never\n", { mode: 0o755 });
      const envShebang = await invoke(t, f, ["ops-script", "--args", directArgs], realTools);
      t.ok(envShebang.code === 2 && !envShebang.json?.runId, "a PATH-dependent direct shebang is refused before journaling");
      fs.writeFileSync(shellScript, "#!/bin/sh\r\necho never\n", { mode: 0o755 });
      const crlf = await invoke(t, f, ["ops-script", "--args", directArgs], realTools);
      t.ok(crlf.code === 2 && !crlf.json?.runId, "a CRLF direct shebang is refused before journaling");
      const missing = ["/usr/local/bin/python3", "/usr/local/bin/python", "/usr/bin/python3", "/usr/bin/python"].find(p => !fs.existsSync(p));
      if (missing) {
        const missingScript = path.join(f.w.dir, "missing.py");
        fs.writeFileSync(missingScript, `#!${missing}\nprint('never')\n`, { mode: 0o755 });
        fs.writeFileSync(directArgs, JSON.stringify({ script: missingScript, tmp: f.tmp, check: ["{copy}", "--check"], sudo: ["sudo", "{script}"], fixes: 0 }));
        const missingDirect = await invoke(t, f, ["ops-script", "--args", directArgs], realTools);
        t.ok(missingDirect.code === 2 && !missingDirect.json?.runId && missingDirect.json?.refused?.includes("unavailable"), "an unavailable absolute shebang is refused before journaling");
      }

      const a = path.join(f.w.dir, "python-a"), b = path.join(f.w.dir, "python-b");
      fs.mkdirSync(a); fs.mkdirSync(b);
      const pythonExe = spawnSync(f.interpreter, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
      const quotedPython = `'${pythonExe.replaceAll("'", "'\\''")}'`;
      for (const [dir, label] of [[a, "first"], [b, "second"]]) {
        fs.writeFileSync(path.join(dir, "python3"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Python 3.0'; exit 0; fi\necho ${label}\nexec ${quotedPython} "$@"\n`, { mode: 0o755 });
      }
      const selected = { ...realTools, PATH: `${a}${path.delimiter}${b}${path.delimiter}${realTools.PATH}` };
      const alternate = { ...realTools, PATH: `${b}${path.delimiter}${a}${path.delimiter}${realTools.PATH}` };
      const directPython = path.join(f.w.dir, "direct-python.py");
      fs.writeFileSync(directPython, `#!${path.join(a, "python3")}\nimport sys\nassert '--check' in sys.argv\n`, { mode: 0o755 });
      fs.writeFileSync(directArgs, JSON.stringify({ script: directPython, tmp: f.tmp, check: ["{copy}", "--check"], sudo: ["sudo", "{script}"], fixes: 0 }));
      const directCut = await invoke(t, f, ["ops-script", "--args", directArgs], { ...alternate, ZODCHI_FLOW_CUT: "ops-done static 0" });
      t.eq(directCut.code, 75, "direct Python cuts after static checks");
      const directId = fs.readdirSync(path.join(f.w.zhome, "flows")).find(id => {
        const events = path.join(f.w.zhome, "flows", id, "events.jsonl");
        if (!fs.existsSync(events)) return false;
        const rows = fs.readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
        return rows.some(e => e.kind === "ops-done" && e.step === "static 0" && e.result?.python === path.join(a, "python3")) && !rows.some(e => e.step === "dry 0");
      });
      t.ok(directId, "direct static compilation records the shebang interpreter");
      const directResume = await invoke(t, f, ["ops-script", "--resume", directId], alternate);
      t.ok(directResume.json?.ready && directResume.json?.dry?.stdout.startsWith("first\n") && directResume.json?.forHuman.includes("'sudo'"), "direct dry run and operator command retain the shebang interpreter after PATH changes");
      const pinnedArgs = path.join(f.w.dir, "pinned.json");
      fs.writeFileSync(pinnedArgs, JSON.stringify({ script: f.script, tmp: f.tmp, files: [f.companion], check: ["python3", "{copy}", "--check"], sudo: ["sudo", "python3", "{script}"], fixes: 0 }));
      const pinned = await invoke(t, f, ["ops-script", "--args", pinnedArgs], { ...selected, ZODCHI_FLOW_CUT: "ops-done dry 0" });
      t.eq(pinned.code, 75, "cut after saving the selected interpreter");
      const pinnedEvents = fs.readdirSync(path.join(f.w.zhome, "flows")).flatMap(id => {
        const events = path.join(f.w.zhome, "flows", id, "events.jsonl");
        return fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").map(line => ({ id, event: JSON.parse(line) })) : [];
      });
      const pinnedId = pinnedEvents.find(({ event }) => event.kind === "ops-done" && event.step === "dry 0" && event.result?.interpreter === path.join(a, "python3"))?.id;
      t.ok(pinnedId, "the dry receipt records the selected executable");
      const resumed = await invoke(t, f, ["ops-script", "--resume", pinnedId], alternate);
      t.ok(resumed.json?.ready && resumed.json.forHuman.includes(path.join(a, "python3")) && !resumed.json.forHuman.includes(path.join(b, "python3")), "resume renders the executable used by the dry run even after PATH changes");
      const staticCut = await invoke(t, f, ["ops-script", "--args", pinnedArgs], { ...selected, ZODCHI_FLOW_CUT: "ops-done static 0" });
      t.eq(staticCut.code, 75, "cut after static receipt");
      const staticId = fs.readdirSync(path.join(f.w.zhome, "flows")).find(id => {
        const events = path.join(f.w.zhome, "flows", id, "events.jsonl");
        if (!fs.existsSync(events)) return false;
        const rows = fs.readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
        return rows.some(e => e.kind === "ops-done" && e.step === "static 0" && e.result?.python === path.join(a, "python3")) && !rows.some(e => e.step === "dry 0");
      });
      t.ok(staticId, "static receipt records the selected Python");
      const staticResume = await invoke(t, f, ["ops-script", "--resume", staticId], alternate);
      t.ok(staticResume.json?.ready && staticResume.json?.dry?.stdout.startsWith("first\n") && staticResume.json?.dry?.interpreter === path.join(a, "python3") && staticResume.json?.forHuman.includes(path.join(a, "python3")), "dry run and command retain the static interpreter after PATH changes");
    }
    fs.appendFileSync(path.join(good.json.snapshot.dir, path.basename(f.script)), "# changed after check\n");
    const stale = await invoke(t, f, ["ops-script", "--resume", good.json.runId]);
    t.eq([stale.code, stale.json?.ready, stale.json?.status], [2, false, "changed"], "resume refuses a modified completed snapshot");
    const staleStatus = await invoke(t, f, ["status", good.json.runId]);
    t.ok(staleStatus.json?.result?.ready === false && !staleStatus.json?.result?.forHuman, "status does not repeat a stale command");
    fs.writeFileSync(f.script, "import sys\nsys.exit(7)\n");
    const bad = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.eq([bad.code, bad.json?.ready, bad.json?.detail?.code], [2, false, 7], "a nonzero check refuses readiness");
    fs.writeFileSync(f.script, "with open(__file__, 'a') as f: f.write('# mutated\\n')\n");
    const changed = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(changed.code === 2 && changed.json?.ready === false && !changed.json?.forHuman, "a changed snapshot cannot produce the human command");
    fs.writeFileSync(f.script, "p = __file__\nwith open(p, 'rb') as f: original = f.read()\nwith open(p, 'ab') as f: f.write(b'# temporary\\n')\nwith open(p, 'wb') as f: f.write(original)\n");
    const restored = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(restored.code === 2 && restored.json?.ready === false && !restored.json?.forHuman, "a copy changed and restored to the same bytes is refused");
    if (process.platform === "win32") {
      fs.writeFileSync(f.script, "import subprocess, sys\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nprint(p.pid)\n");
      const childRun = await invoke(t, f, ["ops-script", "--args", f.args]);
      t.eq([childRun.code, childRun.json?.ready], [0, true], "a check that leaves a child can complete safely");
      const pid = Number(childRun.json.dry.stdout.trim());
      t.ok(Number.isSafeInteger(pid) && pid > 0, "the fixture reported its child pid");
      await t.until("the child process was terminated before readiness", () => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      });
    }
  });

  scenario("flow-ops-script-refusal", "refuses unsafe templates and remote root before effects", async (t) => {
    const f = fixture("flow-ops-script-refusal");
    fs.writeFileSync(f.script, "print('never run')\n");
    const data = JSON.parse(fs.readFileSync(f.args, "utf8"));
    data.check = ["bash", "-c", "{copy}"];
    fs.writeFileSync(f.args, JSON.stringify(data));
    const shell = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(shell.code === 2 && shell.json?.refused && fs.readdirSync(f.tmp).length === 0, "shell injection is refused before snapshots");
    data.check = ["python3", "{copy}", "--check"];
    data.sudo = ["sudo", "python", "{script}"];
    fs.writeFileSync(f.args, JSON.stringify(data));
    const mismatch = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(mismatch.code === 2 && mismatch.json?.refused?.includes("same interpreter") && fs.readdirSync(f.tmp).length === 0, "different operator interpreter is refused before snapshots");
    delete data.check;
    data.check = [f.interpreter, "{copy}", "--check"];
    data.sudo = ["sudo", f.interpreter, "{script}", "--apply"];
    data.remote = ["root", "example.invalid"].join("@");
    fs.writeFileSync(f.args, JSON.stringify(data));
    const remote = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(remote.code === 2 && remote.json?.refused && fs.readdirSync(f.tmp).length === 0, "remote root is refused without connecting");
    data.remote = ["operator", "example.invalid"].join("@");
    fs.writeFileSync(f.args, JSON.stringify(data));
    const unsupported = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(unsupported.code === 2 && unsupported.json?.refused?.includes("no remote action") && fs.readdirSync(f.tmp).length === 0, "a valid remote is explicitly refused before effects");
    delete data.remote;
    data.check = ["{copy}", "--check"];
    data.sudo = ["sudo", "{script}"];
    data.repo = f.w.dir;
    data.fixes = 1;
    fs.writeFileSync(f.args, JSON.stringify(data));
    const direct = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.ok(direct.code === 2 && direct.json?.refused && !direct.json?.runId && fs.readdirSync(f.tmp).length === 0, "unsupported direct invocation is refused before a snapshot or repair child");
  });

  scenario("flow-ops-script-resume", "reuses the completed snapshot and never replays an interrupted dry run", async (t) => {
    const f = fixture("flow-ops-script-resume");
    fs.writeFileSync(f.script, "print('checked')\n");
    const cut = await invoke(t, f, ["ops-script", "--args", f.args], { ZODCHI_FLOW_CUT: "ops-done snapshot 0" });
    t.eq(cut.code, 75, "cut after snapshot receipt");
    const flows = path.join(f.w.zhome, "flows");
    const [id] = fs.readdirSync(flows);
    const events = path.join(flows, id, "events.jsonl");
    const snapshot = JSON.parse(fs.readFileSync(events, "utf8").trim().split("\n").at(-1)).result.snapshot.dir;
    fs.writeFileSync(path.join(flows, id, "worker.json"), JSON.stringify({ pid: 4294967295, start: "dead" }));
    const resumed = await invoke(t, f, ["ops-script", "--resume", id]);
    t.eq([resumed.code, resumed.json?.snapshot?.dir], [0, snapshot], "resume uses the original snapshot");
    fs.rmSync(f.script);
    const reused = await invoke(t, f, ["ops-script", "--resume", id], { PATH: "" });
    t.eq([reused.code, reused.json?.ready, reused.json?.snapshot?.dir], [0, true, snapshot], "completed receipt remains usable without the original or tools");
    fs.writeFileSync(f.script, "print('checked')\n");
    const second = await invoke(t, f, ["ops-script", "--args", f.args], { ZODCHI_FLOW_CUT: "ops-start dry 0" });
    t.eq(second.code, 75, "cut after dry-run intent");
    const all = fs.readdirSync(flows);
    const other = all.find(value => value !== id);
    const unresolved = await invoke(t, f, ["ops-script", "--resume", other]);
    t.eq([unresolved.code, unresolved.json?.status, unresolved.json?.step], [2, "unresolved", "dry 0"], "an interrupted dry run is not replayed");

    const data = JSON.parse(fs.readFileSync(f.args, "utf8"));
    data.fixes = 1;
    fs.writeFileSync(f.args, JSON.stringify(data));
    fs.writeFileSync(f.script, "import sys\nsys.exit(9)\n");
    const waiting = await invoke(t, f, ["ops-script", "--args", f.args]);
    t.eq([waiting.code, waiting.json?.status], [2, "waiting"], "failure is handed to the owner");
    const failedId = waiting.json.runId;
    const prior = fs.readFileSync(path.join(flows, failedId, "events.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).find(event => event.step === "snapshot 0" && event.kind === "ops-done").result.snapshot.dir;
    fs.writeFileSync(f.script, "print('fixed')\n");
    const answer = path.join(f.w.dir, "answer.txt");
    fs.writeFileSync(answer, "Fixed the original script.\n");
    const reply = await invoke(t, f, ["reply", failedId, "--file", answer]);
    t.eq(reply.code, 0, "owner response is journaled");
    const repaired = await invoke(t, f, ["ops-script", "--resume", failedId]);
    t.ok(repaired.code === 0 && repaired.json?.snapshot?.dir !== prior, "the resumed handoff checks a fresh snapshot");
    t.ok(!fs.existsSync(path.join(f.w.codex, "fake-turns.jsonl")), "handoff spent no model calls");

    const detached = await invoke(t, f, ["ops-script", "--args", f.args, "--detach"]);
    t.eq([detached.code, detached.json?.status], [0, "submitted"], "a detached worker starts");
    const detachedJournal = path.join(flows, detached.json.runId, "events.jsonl");
    await t.until("detached run has a durable result", () => fs.existsSync(detachedJournal)
      && fs.readFileSync(detachedJournal, "utf8").split("\n").some(line => line.includes('"kind":"finished"')));
    const finished = await invoke(t, f, ["status", detached.json.runId]);
    t.eq(finished.json?.result?.ready, true, "status exposes the completed detached result");
  });

  scenario("flow-ops-script-recovery", "preserves damaged check outcomes and never repeats an uncertain repair gate", async (t) => {
    const completed = fixture("flow-ops-script-recovery-completed");
    fs.writeFileSync(completed.script, "print('completed')\n");
    const completedCut = await invoke(t, completed, ["ops-script", "--args", completed.args], { ZODCHI_FLOW_CUT: "ops-done dry 0" });
    t.eq(completedCut.code, 75, "cut after the successful dry-run receipt");
    const [completedId] = fs.readdirSync(path.join(completed.w.zhome, "flows"));
    fs.rmSync(completed.script);
    const completedResume = await invoke(t, completed, ["ops-script", "--resume", completedId], { PATH: "" });
    t.eq([completedResume.code, completedResume.json?.ready, completedResume.json?.dry?.stdout.trim()], [0, true, "completed"], "completed receipts are reused without the original or tools");

    const damaged = fixture("flow-ops-script-recovery-damaged");
    fs.writeFileSync(damaged.script, "with open(__file__, 'a') as f: f.write('# changed\\n')\n");
    const cut = await invoke(t, damaged, ["ops-script", "--args", damaged.args], { ZODCHI_FLOW_CUT: "ops-done dry 0" });
    t.eq(cut.code, 75, "cut after the failed dry run is recorded");
    const flows = path.join(damaged.w.zhome, "flows");
    const [id] = fs.readdirSync(flows);
    fs.rmSync(damaged.tmp, { recursive: true });
    fs.rmSync(damaged.script);
    const resumed = await invoke(t, damaged, ["ops-script", "--resume", id]);
    t.eq([resumed.code, resumed.json?.status, resumed.json?.step], [2, "failed", "dry 0"], "recorded failure survives missing inputs and snapshot directory");

    const interrupted = fixture("flow-ops-script-recovery-interrupted");
    fs.writeFileSync(interrupted.script, "print('not run')\n");
    const started = await invoke(t, interrupted, ["ops-script", "--args", interrupted.args], { ZODCHI_FLOW_CUT: "ops-start dry 0" });
    t.eq(started.code, 75, "cut after dry-run intent");
    const interruptedFlows = path.join(interrupted.w.zhome, "flows");
    const [interruptedId] = fs.readdirSync(interruptedFlows);
    const events = fs.readFileSync(path.join(interruptedFlows, interruptedId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const snapshot = events.find(event => event.kind === "ops-done" && event.step === "snapshot 0").result.snapshot.dir;
    fs.appendFileSync(path.join(snapshot, path.basename(interrupted.script)), "# damaged\n");
    fs.rmSync(interrupted.tmp, { recursive: true });
    fs.rmSync(interrupted.script);
    const unresolved = await invoke(t, interrupted, ["ops-script", "--resume", interruptedId]);
    t.eq([unresolved.code, unresolved.json?.status, unresolved.json?.step], [2, "unresolved", "dry 0"], "interrupted dry run stays unresolved when inputs and snapshot are missing");

    const repair = fixture("flow-ops-script-recovery-repair");
    fs.writeFileSync(repair.script, "print('benign-output')\nprint('pass' + 'word=private-fixture')\nraise SystemExit(9)\n");
    const repairArgs = JSON.parse(fs.readFileSync(repair.args, "utf8"));
    repairArgs.repo = repair.w.dir;
    repairArgs.fixes = 1;
    delete repairArgs.files;
    fs.writeFileSync(repair.args, JSON.stringify(repairArgs));
    const repairCut = await invoke(t, repair, ["ops-script", "--args", repair.args], { ZODCHI_FLOW_CUT: "ops-repair 0" });
    t.eq(repairCut.code, 75, "child id is saved before the repair gate");
    const repairFlows = path.join(repair.w.zhome, "flows");
    const [repairId] = fs.readdirSync(repairFlows);
    const repairEvents = fs.readFileSync(path.join(repairFlows, repairId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const originalReceipt = repairEvents.find(event => event.kind === "ops-done" && event.step === "dry 0").result;
    const briefName = fs.readdirSync(path.join(repairFlows, repairId)).find(name => name.startsWith("repair-0-") && name.endsWith(".md"));
    const modelBrief = fs.readFileSync(path.join(repairFlows, repairId, briefName), "utf8");
    const escapedInterpreter = JSON.stringify(originalReceipt.interpreter).slice(1, -1);
    t.ok(originalReceipt.stdout.includes("benign-output") && modelBrief.includes("benign-output"), "repair brief retains benign output");
    t.ok(!modelBrief.includes("private-fixture"), "repair brief scrubs private output");
    t.ok(originalReceipt.interpreter && !modelBrief.includes(originalReceipt.interpreter) && !modelBrief.includes(escapedInterpreter), "repair brief removes raw and JSON-escaped interpreter paths");
    const child = repairEvents.find(event => event.kind === "ops-repair").child;
    fs.rmSync(repair.script);
    const repairResume = await invoke(t, repair, ["ops-script", "--resume", repairId]);
    t.ok(repairResume.json?.status === "unresolved" && repairResume.json?.step.includes(child), "an uncertain gate is not started again even when the original is missing");
    t.ok(!fs.existsSync(path.join(repairFlows, child)) && !fs.existsSync(path.join(repair.w.codex, "fake-turns.jsonl")), "the cut and resume make no model call");

    const echoed = fixture("flow-ops-script-echoed-data");
    fs.writeFileSync(echoed.script, "print(open('payload with spaces.txt').read())\nraise SystemExit(9)\n");
    const echoedArgs = JSON.parse(fs.readFileSync(echoed.args, "utf8"));
    echoedArgs.repo = echoed.w.dir;
    echoedArgs.fixes = 1;
    fs.writeFileSync(echoed.args, JSON.stringify(echoedArgs));
    const echoedCut = await invoke(t, echoed, ["ops-script", "--args", echoed.args], { ZODCHI_FLOW_CUT: "ops-repair 0" });
    t.eq(echoedCut.code, 75, "save a repair after a check echoes companion data");
    const echoedFlows = path.join(echoed.w.zhome, "flows");
    const [echoedId] = fs.readdirSync(echoedFlows);
    const echoedDir = path.join(echoedFlows, echoedId);
    const echoedEvents = fs.readFileSync(path.join(echoedDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const echoedBrief = fs.readFileSync(path.join(echoedDir, fs.readdirSync(echoedDir).find(name => name.startsWith("repair-0-") && name.endsWith(".md"))), "utf8");
    t.ok(echoedEvents.find(event => event.kind === "ops-done" && event.step === "dry 0").result.stdout.includes("expected payload") && !echoedBrief.includes("expected payload"), "echoed data stays in the local receipt and out of the repair brief");

    const staticFailure = fixture("flow-ops-script-private-static-label");
    const privateCompanion = path.join(staticFailure.w.dir, "private-project-settings.py");
    fs.writeFileSync(staticFailure.script, "print('ok')\n");
    fs.writeFileSync(privateCompanion, "def broken(:\n");
    const staticArgs = JSON.parse(fs.readFileSync(staticFailure.args, "utf8"));
    Object.assign(staticArgs, { files: [privateCompanion], repo: staticFailure.w.dir, fixes: 1 });
    fs.writeFileSync(staticFailure.args, JSON.stringify(staticArgs));
    const staticResult = await invoke(t, staticFailure, ["ops-script", "--args", staticFailure.args]);
    t.eq(staticResult.json?.status, "waiting", "an unselected companion static failure hands off to the owner");
    const staticFlows = path.join(staticFailure.w.zhome, "flows");
    const [staticId] = fs.readdirSync(staticFlows);
    const staticDir = path.join(staticFlows, staticId);
    const staticEvents = fs.readFileSync(path.join(staticDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const staticReceipt = staticEvents.find(event => event.kind === "ops-done" && event.step === "static 0").result;
    t.ok(JSON.stringify(staticReceipt).includes("private-project-settings.py") && JSON.stringify(staticResult.json?.detail).includes("private-project-settings.py"), "the local diagnostic names the failing companion");
    t.ok(!staticEvents.some(event => event.kind === "ops-repair") && fs.readdirSync(staticFlows).length === 1 && !fs.existsSync(path.join(staticFailure.w.codex, "fake-turns.jsonl")), "the handoff creates no repair event, child, or model call");

    for (const [name, source, deny] of [
      ["credential", "# password=synthetic\nraise SystemExit(9)\n", ""],
      ["private-word", "# local-only-fixture\nraise SystemExit(9)\n", "local-only-fixture\n"],
    ]) {
      const hidden = fixture(`flow-ops-script-hidden-${name}`);
      fs.writeFileSync(hidden.script, source);
      const denylist = path.join(hidden.w.dir, "denylist.txt");
      fs.writeFileSync(denylist, deny);
      hidden.w.env.ZODCHI_DENYLIST = denylist;
      const hiddenArgs = JSON.parse(fs.readFileSync(hidden.args, "utf8"));
      hiddenArgs.repo = hidden.w.dir;
      hiddenArgs.fixes = 1;
      fs.writeFileSync(hidden.args, JSON.stringify(hiddenArgs));
      const handoff = await invoke(t, hidden, ["ops-script", "--args", hidden.args]);
      t.eq(handoff.json?.status, "waiting", `${name} in source hands repair to the owner`);
      t.ok(!fs.existsSync(path.join(hidden.w.codex, "fake-turns.jsonl")), `${name} source causes no model call`);
    }
  });

  scenario("flow-ops-script-scoped-repair", "repairs only the claimed script with an independent fake reviewer and resumes the same child", async (t) => {
    const f = flowWorld(t, "flow-ops-script-scoped-repair");
    f.w.env.ZODCHI_BASH = fakeBash(f.w);
    f.w.env.PATH = `${path.dirname(f.w.env.ZODCHI_BASH)}${path.delimiter}${f.w.env.PATH}`;
    const original = "raise SystemExit(9)\n";
    const fixed = "import sys\nassert '--check' in sys.argv\nprint('repaired')\n";
    const script = path.join(f.r, "src", "operator.py");
    const data = path.join(f.r, "src", "payload.json");
    const settings = path.join(f.r, "src", "settings.py");
    const syntheticValue = "synthetic-local-payload-67291";
    const syntheticSetting = "synthetic-local-region-48261";
    fs.writeFileSync(script, original);
    fs.writeFileSync(data, JSON.stringify({ value: syntheticValue }));
    fs.writeFileSync(settings, `REGION = '${syntheticSetting}'\n`);
    gitOut(f.r, ["add", "src/operator.py", "src/payload.json", "src/settings.py"]);
    gitOut(f.r, ["commit", "-q", "-m", "add fixture"]);
    f.answer("write", f.patch([f.modify("src/operator.py", original, fixed)], "repair the operator check"));
    f.answer("review 1", f.review("approved"));
    const tmp = path.join(f.w.dir, "ops snapshots");
    fs.mkdirSync(tmp);
    const args = path.join(f.w.dir, "ops-args.json");
    const models = {
      expertWriter: { candidates: [{ provider: "codex", model: "scoped-writer" }] },
      reviewer: { candidates: [{ provider: "codex", model: "scoped-reviewer" }] },
    };
    const interpreter = python();
    fs.writeFileSync(args, JSON.stringify({ script, files: [data, settings], tmp, repo: f.r, check: [interpreter, "{copy}", "--check"], sudo: ["sudo", interpreter, "{script}"], fixes: 1, models }));
    const cut = await zodchi(t, f.w, ["flow", "ops-script", "--args", args], { cwd: f.r, env: { ...f.w.env, ZODCHI_FLOW_CUT: "submit write" } });
    t.eq(cut.code, 75, "cut after the child submitted its writer");
    const flows = path.join(f.w.zhome, "flows");
    const ids = fs.readdirSync(flows);
    const parent = ids.find(id => JSON.parse(fs.readFileSync(path.join(flows, id, "run.json"), "utf8")).workflow === "ops-script");
    const events = fs.readFileSync(path.join(flows, parent, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const repair = events.find(event => event.kind === "ops-repair");
    t.eq(repair.args.files, ["src/operator.py"], "the child claim contains only the named script");
    const snapshot = events.find(event => event.kind === "ops-done" && event.step === "snapshot 0").result.snapshot;
    t.ok(snapshot.files.some(file => file.name === "payload.json") && fs.readFileSync(path.join(snapshot.dir, "payload.json"), "utf8").includes(syntheticValue), "data remains in the checked snapshot");
    t.ok(snapshot.files.some(file => file.name === "settings.py") && fs.readFileSync(path.join(snapshot.dir, "settings.py"), "utf8").includes(syntheticSetting), "Python settings remain in the checked snapshot");
    const result = await zodchi(t, f.w, ["flow", "ops-script", "--resume", parent], { cwd: f.r, env: f.w.env });
    t.eq([result.code, result.json?.ready, result.json?.dry?.stdout.trim()], [0, true, "repaired"], "approved repair receives a fresh successful check");
    const child = JSON.parse(fs.readFileSync(path.join(flows, repair.child, "run.json"), "utf8"));
    t.eq([child.pair.expertWriter.model, child.pair.reviewer.model], ["scoped-writer", "scoped-reviewer"], "both role overrides reach independent models");
    t.eq(f.steps(), ["write", "review 1"], "resume does not submit a second writer call");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.ok(turns.some(turn => turn.step === "write") && !turns.find(turn => turn.step === "write").prompt.includes(syntheticValue), "writer request excludes the local data value");
    t.ok(!turns.find(turn => turn.step === "write").prompt.includes(syntheticSetting) && !turns.find(turn => turn.step === "write").prompt.includes("settings.py"), "writer request excludes the Python settings companion");

    const selected = flowWorld(t, "flow-ops-script-selected-repair");
    selected.w.env.ZODCHI_BASH = fakeBash(selected.w);
    selected.w.env.PATH = `${path.dirname(selected.w.env.ZODCHI_BASH)}${path.delimiter}${selected.w.env.PATH}`;
    const selectedScript = path.join(selected.r, "src", "operator.py");
    const helper = path.join(selected.r, "src", "helper.py");
    const helperOriginal = "VALUE = 0\n";
    const helperFixed = "VALUE = 1\n";
    const selectedOriginal = "from helper import VALUE\nraise SystemExit(0 if VALUE else 9)\n";
    fs.writeFileSync(selectedScript, selectedOriginal);
    fs.writeFileSync(helper, helperOriginal);
    gitOut(selected.r, ["add", "src/operator.py", "src/helper.py"]);
    gitOut(selected.r, ["commit", "-q", "-m", "add selected fixture"]);
    selected.answer("write", selected.patch([selected.modify("src/helper.py", helperOriginal, helperFixed)], "repair helper"));
    selected.answer("review 1", selected.review("approved"));
    const selectedTmp = path.join(selected.w.dir, "snapshots");
    fs.mkdirSync(selectedTmp);
    const selectedArgs = path.join(selected.w.dir, "args.json");
    fs.writeFileSync(selectedArgs, JSON.stringify({ script: selectedScript, files: [helper], repairFiles: [helper], tmp: selectedTmp, repo: selected.r, check: [interpreter, "{copy}", "--check"], sudo: ["sudo", interpreter, "{script}"], fixes: 1, models }));
    const selectedResult = await zodchi(t, selected.w, ["flow", "ops-script", "--args", selectedArgs], { cwd: selected.r, env: selected.w.env });
    t.eq([selectedResult.code, selectedResult.json?.ready, fs.readFileSync(helper, "utf8")], [0, true, helperFixed], "repairFiles allows an eligible companion to be repaired");
    const selectedEvents = fs.readFileSync(path.join(selected.w.zhome, "flows", selectedResult.json.runId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.eq(selectedEvents.find(event => event.kind === "ops-repair").args.files, ["src/operator.py", "src/helper.py"], "explicit companion joins the child claim");

    fs.writeFileSync(script, original);
    gitOut(f.r, ["add", "src/operator.py"]);
    gitOut(f.r, ["commit", "-q", "-m", "new failing check"]);
    const earlier = new Set(fs.readdirSync(flows));
    const contextCut = await zodchi(t, f.w, ["flow", "ops-script", "--args", args], { cwd: f.r, env: { ...f.w.env, ZODCHI_FLOW_CUT: "code-package context" } });
    t.eq(contextCut.code, 75, "cut before child context is durable");
    const newIds = fs.readdirSync(flows).filter(id => !earlier.has(id));
    const nextParent = newIds.find(id => JSON.parse(fs.readFileSync(path.join(flows, id, "run.json"), "utf8")).workflow === "ops-script");
    const nextEvents = fs.readFileSync(path.join(flows, nextParent, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const incomplete = nextEvents.find(event => event.kind === "ops-repair").child;
    const contextResume = await zodchi(t, f.w, ["flow", "ops-script", "--resume", nextParent], { cwd: f.r, env: f.w.env });
    t.ok(contextResume.json?.status === "unresolved" && contextResume.json?.step.includes(incomplete), "incomplete child initialization is unresolved");
    t.ok(!fs.existsSync(path.join(flows, incomplete, "initialized")), "child is not published as resumable");
    t.eq(f.steps(), ["write", "review 1"], "the incomplete child gate is not repeated");

    const normalized = path.resolve(f.r).replace(/\\/g, "/");
    const folded = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    const claimDir = path.join(f.w.home, ".zodchi", "packages", folded.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(path.join(claimDir, "other.json"), JSON.stringify({ label: "other", status: "open", files: ["src/operator.py"] }));
    const conflict = await zodchi(t, f.w, ["flow", "ops-script", "--args", args], { cwd: f.r, env: f.w.env });
    t.eq([conflict.code, conflict.json?.status], [2, "waiting"], "a finished child claim refusal becomes an owner handoff");
    const conflictEvents = fs.readFileSync(path.join(flows, conflict.json.runId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.ok(conflictEvents.some(event => event.kind === "waiting"), "the handoff is journaled");
    t.eq(f.steps(), ["write", "review 1"], "a claim conflict makes no model call");

    const rejected = flowWorld(t, "flow-ops-script-rejected-repair");
    rejected.w.env.ZODCHI_BASH = fakeBash(rejected.w);
    rejected.w.env.PATH = `${path.dirname(rejected.w.env.ZODCHI_BASH)}${path.delimiter}${rejected.w.env.PATH}`;
    const rejectedScript = path.join(rejected.r, "src", "operator.py");
    fs.writeFileSync(rejectedScript, original);
    gitOut(rejected.r, ["add", "src/operator.py"]);
    gitOut(rejected.r, ["commit", "-q", "-m", "add failing fixture"]);
    rejected.answer("write", rejected.patch([rejected.modify("src/operator.py", original, fixed)], "propose repair"));
    rejected.answer("review 1", rejected.review("changes_requested", [rejected.finding("F1")]));
    const rejectedTmp = path.join(rejected.w.dir, "snapshots");
    fs.mkdirSync(rejectedTmp);
    const rejectedArgs = path.join(rejected.w.dir, "args.json");
    fs.writeFileSync(rejectedArgs, JSON.stringify({ script: rejectedScript, tmp: rejectedTmp, repo: rejected.r, check: [interpreter, "{copy}", "--check"], sudo: ["sudo", interpreter, "{script}"], fixes: 1, models }));
    const handoff = await zodchi(t, rejected.w, ["flow", "ops-script", "--args", rejectedArgs], { cwd: rejected.r, env: rejected.w.env });
    t.ok(handoff.code === 2 && handoff.json?.status === "waiting" && handoff.json?.childRunId && handoff.json?.reason, "a finished non-approved review hands control to the owner with its reason");
    const rejectedFlows = path.join(rejected.w.zhome, "flows");
    const childResult = JSON.parse(fs.readFileSync(path.join(rejectedFlows, handoff.json.childRunId, "result.json"), "utf8"));
    const reason = childResult.reason ?? childResult.question ?? childResult.infra ?? childResult.refused ?? childResult.next ?? childResult.stoppedAt ?? childResult.verdict;
    const handoffEvents = fs.readFileSync(path.join(rejectedFlows, handoff.json.runId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.eq(handoff.json.reason, reason, "the response preserves the child diagnostic");
    t.eq(handoffEvents.find(event => event.kind === "waiting").reason, reason, "the journal preserves the child diagnostic");
    t.eq(rejected.steps(), ["write", "review 1"], "a rejected repair is not retried automatically");

    const failedCheck = flowWorld(t, "flow-ops-script-child-check-failure");
    delete failedCheck.w.env.ZODCHI_BASH;
    const failingScript = path.join(failedCheck.r, "src", "operator.py");
    fs.writeFileSync(failingScript, original);
    fs.mkdirSync(path.join(failedCheck.r, ".zodchi"), { recursive: true });
    fs.writeFileSync(path.join(failedCheck.r, ".zodchi", "verify.json"), JSON.stringify({ checks: ["node -e 'process.exit(7)'"] }));
    gitOut(failedCheck.r, ["add", "src/operator.py", ".zodchi/verify.json"]);
    gitOut(failedCheck.r, ["commit", "-q", "-m", "add failing check fixture"]);
    failedCheck.answer("write", failedCheck.patch([failedCheck.modify("src/operator.py", original, fixed)], "propose repair"));
    const checkTmp = path.join(failedCheck.w.dir, "snapshots");
    fs.mkdirSync(checkTmp);
    const checkArgs = path.join(failedCheck.w.dir, "args.json");
    fs.writeFileSync(checkArgs, JSON.stringify({ script: failingScript, tmp: checkTmp, repo: failedCheck.r, check: [interpreter, "{copy}", "--check"], sudo: ["sudo", interpreter, "{script}"], fixes: 1, models }));
    const checkHandoff = await zodchi(t, failedCheck.w, ["flow", "ops-script", "--args", checkArgs], { cwd: failedCheck.r, env: failedCheck.w.env });
    const checkFlows = path.join(failedCheck.w.zhome, "flows");
    const checkChild = JSON.parse(fs.readFileSync(path.join(checkFlows, checkHandoff.json.childRunId, "result.json"), "utf8"));
    const checkEvents = fs.readFileSync(path.join(checkFlows, checkHandoff.json.runId, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.ok(checkHandoff.code === 2 && checkHandoff.json?.status === "waiting" && checkChild.stoppedAt?.startsWith("checks") && checkChild.next?.includes("verification.evidence") && checkChild.next?.includes("work tree"), "terminal child check failure explains the logs and uncommitted work");
    t.eq(checkHandoff.json.reason, checkChild.next, "response preserves child check recovery instructions");
    t.eq(checkEvents.find(event => event.kind === "waiting").reason, checkChild.next, "journal preserves child check recovery instructions");
  });
}
