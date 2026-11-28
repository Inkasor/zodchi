import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function ({ scenario, world, repo, prompt, zodchi, ZODCHI }) {
  scenario("cli-submit-pipe", "the caller gets stdout EOF while the detached job is still running", async (t) => {
    const w = world("cli-submit-pipe");
    const cwd = repo(t, w);
    const key = "pipe";
    const args = ["--role", "ask", "--key", key, "--prompt", prompt(w, "pipe.md", "HOLD:pipe")];
    const child = spawn(ZODCHI, ["submit", ...args], {
      cwd, env: w.env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let eofAt;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stdout.on("end", () => { eofAt = performance.now(); });
    const exit = new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let timer;
    const release = () => fs.writeFileSync(path.join(w.codex, "fake-release-pipe"), "");
    try {
      await t.until("the detached worker entered the fake turn", () => fs.existsSync(path.join(w.codex, "fake-entered-pipe")));
      const enteredAt = performance.now();
      // Give the fake a six-second turn. Even a submit that blocks on its child has a finite end.
      timer = setTimeout(release, 6000);
      t.eq(await exit, 0, "submit process exited successfully");
      await t.until("stdout reached EOF", () => eofAt, 8000);
      const elapsed = Math.round(eofAt - enteredAt);
      t.ok(elapsed < 3000, `pipe closed well before the six-second turn ended (offset ${elapsed} ms)`);
      t.eq(JSON.parse(stdout).job.key, key, "the pipe carries the usual JSON");
      const again = await zodchi(t, w, ["submit", "--quiet", ...args], { cwd });
      t.eq(again.code, 0, "quiet submit reads the same running job");
      t.ok(/^pipe running\r?\n$/.test(again.out), "quiet stdout is exactly one key/status line");
      const final = await zodchi(t, w, ["wait", "--key", key, "--wait-sec", "60"], { cwd });
      t.eq(final.code, 0, "the worker completed after its caller exited");
    } finally {
      clearTimeout(timer);
      release();
    }
    const turns = fs.readFileSync(path.join(w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n");
    t.eq(turns.length, 1, "repeat submit ran the model once");
  });

  scenario("cli-status", "poll running and finished keys together, and diagnose unknown keys and bad calls", async (t) => {
    const w = world("cli-status");
    const cwd = repo(t, w);
    const cli = (args) => zodchi(t, w, args, { cwd });
    const done = await cli(["run", "--role", "ask", "--key", "done", "--prompt", prompt(w, "done.md", "finish"), "--wait-sec", "10"]);
    t.eq(done.code, 0, "the first job finished");
    try {
      const sub = await cli(["submit", "--role", "ask", "--key", "live", "--prompt", prompt(w, "live.md", "HOLD:live")]);
      t.eq(sub.code, 0, "the second job was submitted");
      await t.until("the second job is running", () => fs.existsSync(path.join(w.codex, "fake-entered-live")));
      const lines = await cli(["status", "live", "done"]);
      t.eq(lines.code, 0, "polling succeeds for both states");
      t.ok(/^live running \d+s\r?\ndone succeeded \d+s\r?\n$/.test(lines.out), "one elapsed time and status per key, in order");
      const json = await cli(["status", "done", "--json", "live"]);
      t.eq(json.code, 0, "JSON poll succeeds");
      t.eq(json.json.map(({ key, status }) => [key, status]), [["done", "succeeded"], ["live", "running"]], "one ordered JSON array");
      t.ok(json.json.every((row) => Number.isInteger(row.elapsedSeconds) && row.elapsedSeconds >= 0), "JSON elapsed times are seconds");
      const mixed = await cli(["status", "live", "missing", "done"]);
      t.eq(mixed.code, 2, "a missing key makes the poll exit 2");
      t.ok(mixed.err.includes("No job missing") && /^live running \d+s\r?\ndone succeeded \d+s\r?\n$/.test(mixed.out), "the missing key is diagnosed and both known keys are printed");
      for (const args of [[], ["--json"], ["--root"], ["--bad", "live"]]) {
        t.eq((await cli(["status", ...args])).code, 2, "a malformed status call exits 2");
      }
      for (const args of [["job"], ["wait", "--wait-sec", "0"]]) {
        t.eq((await cli([...args, "--key", "live"])).code, 3, "existing running-job exit code");
      }
    } finally {
      fs.writeFileSync(path.join(w.codex, "fake-release-live"), "");
    }
    t.eq((await cli(["wait", "--key", "live", "--wait-sec", "60"])).code, 0, "the second job finished");
  });
}
