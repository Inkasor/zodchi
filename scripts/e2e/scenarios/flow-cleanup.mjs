import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, samePath, FIXED, STUB }) {
  const math = "src/math.mjs";
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const readEvents = (journal) => fs.readFileSync(path.join(journal, "events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const flow = (t, f, args, env = {}) => zodchi(t, f.w, ["flow", ...args], {
    cwd: f.r, env: { ...f.w.env, ...env },
  });

  scenario("flow-cleanup-auto", "finishing an agent package removes its writer workspace and records reclaimed bytes", async (t) => {
    const f = flowWorld(t, "flow-cleanup-auto");
    f.answer("write", {
      status: "done", flowWrites: { [math]: FIXED }, summary: "clamp inside the range",
      criteria: [], questions: [], changedFiles: [math], checks: [],
    });
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq([result.code, result.json?.verdict], [0, "approved"], "the agent package is approved");
    const { runId, journal } = result.json;
    const writers = path.join(f.w.zhome, "flow-writers", runId);
    const events = readEvents(journal);
    t.ok(events.some(event => event.kind === "writer prepared"), "a writer workspace was prepared");
    t.ok(!fs.existsSync(writers), "the finished run has no writer workspace");
    const cleanup = events.find(event => event.kind === "cleanup");
    t.ok(cleanup?.bytesFreed > 0 && cleanup.items.some(item =>
      item.kind === "writer-workspace" && item.removed && samePath(item.path, writers)),
    "the journal records the workspace and its reclaimed bytes");
    const handoff = await flow(t, f, ["status", runId, "--handoff"]);
    t.eq([handoff.code, handoff.json?.status, handoff.json?.verdict],
      [0, "finished", "approved"], "handoff still reports the approved run");
  });

  scenario("flow-cleanup-command", "preview and reclaim disk space while preserving an interrupted application", async (t) => {
    const f = flowWorld(t, "flow-cleanup-command");
    gitOut(f.r, ["config", "core.autocrlf", "false"]);
    f.answer("write", f.patch([f.modify(math, STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const approved = await f.flow(["--args", f.args({ isolated: true })]);
    t.eq([approved.code, approved.json?.application?.status], [0, "pending"], "an isolated candidate is approved");
    const { runId, journal, candidate } = approved.json;
    const cut = await flow(t, f, ["apply", runId], { ZODCHI_FLOW_CUT: "candidate files" });
    t.eq(cut.code, 75, "application is interrupted after recording its pending receipt");
    const legacyPackages = path.join(f.w.home, ".zodchi", "packages");
    const [slug] = fs.readdirSync(legacyPackages);
    const shared = path.join(legacyPackages, slug);
    const pending = path.join(shared, "applications", "pending.json");
    const claim = path.join(shared, "clamp.json");
    const pendingContents = fs.readFileSync(pending, "utf8");
    const claimContents = fs.readFileSync(claim, "utf8");
    t.eq(JSON.parse(pendingContents).runId, runId, "the pending receipt points at this run");
    t.eq([JSON.parse(claimContents).run, JSON.parse(claimContents).status],
      [runId, "open"], "the interrupted application owns the shared claim");

    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const events = readEvents(journal).map(event => event.kind === "finished" ? { ...event, at: old } : event);
    write(path.join(journal, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const unused = path.join(f.w.zhome, "flows", "old-unreferenced");
    write(path.join(unused, "run.json"), JSON.stringify({ runId: "old-unreferenced", workflow: "code-package" }));
    write(path.join(unused, "events.jsonl"), JSON.stringify({ kind: "finished", verdict: "blocked", at: old }) + "\n");
    write(path.join(unused, "result.json"), JSON.stringify({ approved: false, verdict: "blocked" }));

    const writers = path.join(f.w.zhome, "flow-writers", runId);
    write(path.join(writers, "old-writer", "node_modules", "fixture.js"), "export default 1;\n");
    const tempRoot = path.join(f.w.dir, "check-temp");
    const temp = path.join(tempRoot, `zodchi-flow-${runId}-verify-0123abcd`);
    write(path.join(temp, "left-over"), "interrupted check\n");
    const packages = path.join(f.w.zhome, "packages");
    const stale = path.join(packages, "another-checkout", "stale.json");
    const staleClaim = { run: "missing-run", label: "stale", status: "open", files: [math] };
    write(stale, JSON.stringify(staleClaim));

    const flags = ["cleanup", "--journals", "--retention-days", "1", "--claims"];
    const env = { TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot };
    const defaultCleanup = await flow(t, f, ["cleanup", "--claims", "--apply"], { ...env, ZODCHI_HOME: "" });
    t.eq(defaultCleanup.code, 0, "cleanup runs from the default profile while the custom home owns the run");
    for (const [file, contents] of [[claim, claimContents], [pending, pendingContents]]) {
      t.ok(defaultCleanup.json?.kept.some(item => samePath(item.path, file) && item.reason.includes("journal home")),
        `the default profile reports ${path.basename(file)} without archiving it`);
      t.eq(fs.readFileSync(file, "utf8"), contents, `the default profile preserves ${path.basename(file)}`);
    }

    const preview = await flow(t, f, flags, env);
    t.eq([preview.code, preview.json?.bytesFreed], [0, 0], "the default invocation is a dry run");
    const lookup = (report, file) => report.items.find(item => samePath(item.path, file));
    for (const file of [writers, temp, unused, stale]) {
      t.ok(fs.existsSync(file) && lookup(preview.json, file)?.removed === false, `preview lists and keeps ${path.basename(file)}`);
    }
    t.ok(!lookup(preview.json, journal), "the journal referenced by pending.json is ineligible even past retention");
    const applied = await flow(t, f, [...flags, "--apply"], env);
    t.ok(applied.code === 0 && applied.json?.bytesFreed > 0, "cleanup reports the bytes it reclaimed");
    for (const file of [writers, temp, unused, stale]) {
      t.ok(!fs.existsSync(file) && lookup(applied.json, file)?.removed === true, `cleanup removes ${path.basename(file)}`);
    }
    const destination = lookup(applied.json, stale).movedTo;
    t.eq(path.relative(packages, destination).split(path.sep)[0], ".removed", "the stale claim is archived under packages");
    t.eq(JSON.parse(fs.readFileSync(destination, "utf8")), staleClaim, "the archived claim retains its contents");
    t.ok(fs.existsSync(journal) && fs.existsSync(pending), "the journal and pending application survive cleanup");

    const resumed = await flow(t, f, ["apply", runId]);
    t.eq([resumed.code, resumed.json?.status, gitOut(f.r, ["rev-parse", "HEAD"])],
      [0, "applied", candidate.commit], "the interrupted application reaches the approved commit");

    fs.renameSync(journal, path.join(f.w.dir, "retired-journal"));
    const sharedRecords = [claim, pending].map(file => [file, fs.readFileSync(file, "utf8")]);
    const sharedPreview = await flow(t, f, ["cleanup", "--claims"], env);
    t.eq(sharedPreview.code, 0, "the custom home can preview its stale shared records");
    for (const [file, contents] of sharedRecords) {
      t.ok(lookup(sharedPreview.json, file)?.removed === false && fs.readFileSync(file, "utf8") === contents,
        `preview lists and keeps the shared ${path.basename(file)} after its journal disappears`);
    }

    const sharedCleanup = await flow(t, f, ["cleanup", "--claims", "--apply"], env);
    t.eq(sharedCleanup.code, 0, "the owning custom home can archive the stale shared records");
    for (const [file, contents] of sharedRecords) {
      const item = lookup(sharedCleanup.json, file);
      t.ok(item?.removed && !fs.existsSync(file), `cleanup archives the shared ${path.basename(file)}`);
      t.eq(path.relative(legacyPackages, item.movedTo).split(path.sep)[0], ".removed",
        "the shared record is archived in the default profile");
      t.eq(fs.readFileSync(item.movedTo, "utf8"), contents, "the archived record retains its contents");
    }
  });
}
