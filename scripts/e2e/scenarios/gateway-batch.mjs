import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function release(t, home, key) {
  fs.writeFileSync(path.join(home, `fake-release-${key}`), "");
  t.log(`released HOLD:${key}`);
}

function hold(t, home, key) {
  t.cleanups.push(() => release(t, home, key));
  return `HOLD:${key}`;
}

const entered = (home, key) => fs.existsSync(path.join(home, `fake-entered-${key}`));
function turns(home, needle) {
  return fs.readFileSync(path.join(home, "fake-turns.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(turn => turn.prompt.includes(needle));
}

function listFile(cwd, name, jobs, role) {
  const file = path.join(cwd, name + ".json");
  fs.writeFileSync(file, JSON.stringify({ role, jobs }));
  return file;
}

export default function ({ scenario, world, repo, prompt, zodchi, samePath }) {
  scenario("gateway-batch-submit", "list preflight, ordered submission, resolved roles and idempotency", async t => {
    const w = world("gateway-batch-submit");
    const cwd = repo(t, w);
    const call = (...args) => zodchi(t, w, args, { cwd });
    const jobDir = key => path.join(cwd, ".agent-tmp", "gateway", key);
    const stored = key => JSON.parse(fs.readFileSync(path.join(jobDir(key), "request.json"), "utf8"));
    const entries = ["plain", "attached", "structured"].map(key => {
      const file = `${key}.md`;
      fs.writeFileSync(path.join(cwd, file), `marker-${key}`);
      return { key, prompt: file };
    });
    fs.writeFileSync(path.join(cwd, "notes.md"), "attachment-marker");
    entries[1].attach = ["notes.md"];
    entries[2].role = "structured";
    const list = listFile(cwd, "submit", entries, "ask");
    const quiet = await call("submit", "--list", list, "--quiet");
    t.eq(quiet.code, 0, "quiet list submission succeeds");
    const lines = quiet.out.trimEnd().split(/\r?\n/);
    t.eq(lines.length, entries.length, "one line per entry");
    for (const [index, { key }] of entries.entries()) {
      t.ok(new RegExp(`^${key} (queued|running|succeeded)$`).test(lines[index]), `quiet status for ${key} in order`);
      t.eq(stored(key).role.name, index === 2 ? "structured" : "ask", `stored role for ${key}`);
    }

    async function absent(key) {
      t.ok(!fs.existsSync(jobDir(key)), `no job folder for ${key}`);
      const status = await call("status", "--json", key);
      t.eq([status.code, status.json], [2, []], `no status for ${key}`);
    }
    for (const reason of ["duplicate", "role", "prompt", "out", "mixed", "field", "sibling"]) {
      const jobs = entries.map(({ prompt }, i) => ({ key: `${reason}-${i}`, prompt }));
      const last = jobs[2];
      const args = [];
      switch (reason) {
        case "duplicate": last.key = jobs[0].key; break;
        case "role": last.role = "missing-role"; break;
        case "prompt": last.prompt = "missing.md"; break;
        case "out": jobs[0].out = "answer.md"; last.out = "ANSWER.md"; break;
        case "mixed": args.push("--key", last.key); break;
        case "field": last.unknownField = true; break;
        case "sibling": jobs[0].out = "img/p-12.png"; last.role = "picture"; last.out = "img/p.png"; break;
      }
      const file = listFile(cwd, reason, jobs, "ask");
      const refusal = await call("submit", "--list", file, ...args);
      t.eq(refusal.code, 1, `preflight refuses ${reason}`);
      t.ok(refusal.err.includes(last.key) || refusal.err.includes(file), "stderr identifies the entry or file");
      if (reason === "field") t.ok(refusal.err.includes("unknownField"), "the unknown field is named");
      for (const key of new Set(jobs.map(job => job.key))) await absent(key);
    }

    const original = prompt(w, "original.md", "original-marker");
    const changed = prompt(w, "changed.md", "changed-marker");
    const fresh = prompt(w, "fresh.md", "fresh-marker");
    t.eq((await call("submit", "--key", "k2", "--role", "ask", "--prompt", original)).code, 0, "store original k2");
    const conflict = listFile(cwd, "conflict", [
      { key: "k1", prompt: fresh }, { key: "k2", prompt: changed }, { key: "k3", prompt: changed },
    ]);
    const refused = await call("submit", "--list", conflict, "--role", "ask");
    t.ok(refused.code === 1 && refused.err.includes("k2"), "submission stops on the conflicting k2");
    t.eq(stored("k1").prompt.trim(), "fresh-marker", "the preceding entry stays stored");
    t.eq(stored("k2").prompt.trim(), "original-marker", "k2 still holds its original request");
    await absent("k3");

    const keys = entries.map(entry => entry.key);
    t.eq((await call("wait", "--all", "--keys", [...keys, "k1", "k2"].join(","), "--wait-sec", "30")).code, 0, "all submitted jobs finish");
    for (const [index, key] of keys.entries()) {
      const matches = turns(w.codex, `marker-${key}`);
      t.eq(matches.map(turn => turn.schema), [index === 2], `one turn with the resolved schema for ${key}`);
      if (index === 1) t.ok(matches[0].prompt.includes("attachment-marker"), "the second prompt includes the attachment");
    }
    const again = await call("submit", "--list", list);
    t.eq(again.code, 0, "repeat succeeds");
    t.eq(again.json.jobs.map(row => [row.key, row.status, row.created]), keys.map(key => [key, "succeeded", false]), "repeat reuses every finished job");
    for (const key of keys) t.eq(turns(w.codex, `marker-${key}`).length, 1, `repeat did not rerun ${key}`);
    t.eq(["fresh-marker", "original-marker", "changed-marker"].map(word => turns(w.codex, word).length), [1, 1, 0], "the partial submission ran only the two original requests");
  });

  scenario("gateway-wait-many", "batch wait conditions, deadlines, ordered delivery and destination ownership", async t => {
    const w = world("gateway-wait-many");
    const cwd = repo(t, w);
    const call = (...args) => zodchi(t, w, args, { cwd });
    const exists = file => fs.existsSync(path.join(cwd, file));
    const plain = prompt(w, "plain.md", "plain prompt");
    for (const [key, role] of [["text-job", "ask"], ["x", "picture"]]) {
      t.eq((await call("submit", "--key", key, "--role", role, "--prompt", plain)).code, 0, `store ${key} separately`);
    }
    for (const [name, first, second] of [["same", "Output.md", "Output.md"], ["siblings", "img/p.png", "img/p-2.png"]]) {
      const list = listFile(cwd, name, [{ key: "x", out: first }, { key: "text-job", out: second }]);
      const collision = await call("wait", "--all", "--list", list, "--wait-sec", "0");
      t.eq(collision.code, 1, `refuse ${name} collision`);
      t.ok(/\bx\b/.test(collision.err) && collision.err.includes("text-job") && collision.err.includes(path.basename(second)), "collision identifies both owners and path");
      t.ok(!exists(first) && !exists(second), "collision writes nothing");
    }
    const form = listFile(cwd, "form", [{ key: "text-job" }]);
    for (const args of [
      ["--list", form], ["--all"], ["--all", "--any", "--list", form], ["--all", "--key", "text-job"],
      ["--all", "--list", form, "--out", "wrong.md"], ["--all", "--keys", ""],
      ["--all", "--list", form, "--keys", "x"], ["--any", "--keys", "text-job,text-job"],
      ["--all", "--list", listFile(cwd, "empty", [])], ["--all", "--keys", "x", "--keys", "x"],
      ["--all", "--keys", "../bad"], ["--all", "--list", listFile(cwd, "repeat", [{ key: "x" }, { key: "x" }])],
    ]) {
      const wrong = await call("wait", ...args, "--wait-sec", "2");
      t.ok(wrong.code === 1 && wrong.err.trim(), `refuse wait ${args.join(" ")}`);
    }

    async function held(keys) {
      const jobs = keys.map(key => ({
        key, prompt: prompt(w, `${key}.md`, hold(t, w.codex, key)), out: `${key}.out`,
      }));
      const list = listFile(cwd, `held-${keys.join("-")}`, jobs, "ask");
      t.eq((await call("submit", "--list", list)).code, 0, "store held jobs");
      await t.until("all held jobs entered", () => keys.every(key => entered(w.codex, key)));
      return list;
    }
    async function stillWaiting(wait, message) {
      const running = await Promise.race([wait.then(() => false), delay(2000, true)]);
      t.ok(running, message);
    }
    function checkReport(result, code, mode, keys, done, pending) {
      t.eq(result.code, code, `exit code of --${mode}`);
      const report = result.json;
      t.eq([report.mode, report.jobs.map(job => job.key), report.done, report.pending], [mode, keys, done, pending], "ordered jobs and final and pending keys");
      t.ok(report.jobs.every(job => Number.isInteger(job.elapsedSeconds) && job.elapsedSeconds >= 0 && Array.isArray(job.written)), "every job has elapsed seconds and a written array");
    }
    function delivered(row, out) {
      t.ok(row.status === "succeeded" && row.written.length === 1 && path.isAbsolute(row.written[0])
        && samePath(row.written[0], path.join(cwd, out)) && exists(out), `${row.key} delivered to ${out}`);
    }

    const list = await held(["a", "b"]);
    const started = performance.now();
    const unknown = await call("wait", "--all", "--keys", "b,missing-job", "--wait-sec", "30");
    t.ok(unknown.code === 1 && unknown.err.includes("missing-job") && performance.now() - started < 10000, "unknown key after a running job is reported before waiting");
    const any = call("wait", "--any", "--list", list, "--wait-sec", "30");
    await stillWaiting(any, "--any blocks with both turns held");
    const releasedAt = performance.now();
    release(t, w.codex, "a");
    const first = await any;
    t.ok(performance.now() - releasedAt < 15000, "--any wakes on completion before its deadline");
    checkReport(first, 0, "any", ["a", "b"], ["a"], ["b"]);
    delivered(first.json.jobs[0], "a.out");
    t.eq([first.json.jobs[1].status, first.json.jobs[1].written, exists("b.out")], ["running", [], false], "pending b has no delivery");
    release(t, w.codex, "b");
    t.eq((await call("wait", "--key", "b", "--wait-sec", "30")).code, 0, "b finishes before the next held pair");
    const legacy = await call("wait", "--key", "a");
    t.eq([legacy.code, legacy.json.job.key, legacy.json.job.status], [0, "a", "succeeded"], "legacy wait keeps its single-job result");

    const pair = await held(["c", "d"]);
    const all = call("wait", "--all", "--list", pair, "--wait-sec", "30");
    await stillWaiting(all, "--all blocks with both turns held");
    release(t, w.codex, "c");
    await stillWaiting(all, "--all keeps waiting after c is released");
    t.ok(!exists("c.out") && !exists("d.out"), "no delivery before --all completes");
    release(t, w.codex, "d");
    const both = await all;
    checkReport(both, 0, "all", ["c", "d"], ["c", "d"], []);
    for (const row of both.json.jobs) delivered(row, row.key + ".out");

    await held(["e"]);
    for (const mode of ["all", "any"]) {
      const start = performance.now();
      const expired = await call("wait", `--${mode}`, "--keys", "e", "--wait-sec", "2");
      checkReport(expired, 3, mode, ["e"], [], ["e"]);
      t.eq([expired.json.jobs[0].status, expired.json.jobs[0].written, exists("e.out")], ["running", [], false], "timeout leaves e pending");
      t.ok(performance.now() - start >= 1900, "wait reached its deadline");
    }
    release(t, w.codex, "e");
    t.eq((await call("wait", "--key", "e", "--wait-sec", "30")).code, 0, "e finishes");

    const subset = listFile(cwd, "subset", ["a", "b", "c"].map(key => ({ key, out: `subset/${key}`, ignored: true })));
    const second = await call("wait", "--any", "--list", subset, "--keys", "b");
    checkReport(second, 0, "any", ["b"], ["b"], []);
    delivered(second.json.jobs[0], "subset/b");
    t.ok(!exists("subset/a") && !exists("subset/c"), "only the selected file was written");

    const badPrompt = prompt(w, "fail.md", "FAIL");
    t.eq((await call("submit", "--key", "failed", "--role", "ask", "--prompt", badPrompt)).code, 0, "store failing turn");
    const mixed = listFile(cwd, "mixed", [{ key: "failed", out: "failed.out" }, { key: "c", out: "mixed.out" }]);
    for (const mode of ["all", "any"]) {
      const failed = await call("wait", `--${mode}`, "--list", mixed, "--wait-sec", "30");
      checkReport(failed, 2, mode, ["failed", "c"], ["failed", "c"], []);
      t.eq([failed.json.jobs[0].status, failed.json.jobs[0].written, exists("failed.out")], ["failed", [], false], "the failed job has no delivery");
      delivered(failed.json.jobs[1], "mixed.out");
    }
    const unwritable = listFile(cwd, "unwritable", [{ key: "a", out: "first.out" }, { key: "b", out: "first.out/b" }]);
    const error = await call("wait", "--all", "--list", unwritable);
    t.ok(error.code === 1 && error.err.includes("deliver b:") && error.out === "" && exists("first.out"), "a delivery error preserves preceding output and prints only the error");
  });
}
