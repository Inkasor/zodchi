import fs from "node:fs";
import path from "node:path";

export default function ({ scenario, world, repo, prompt, zodchi }) {
  scenario("cli-parallel-jobs", "the configured limit bounds readers, the default admits five, and writers take turns", async (t) => {
    const w = world("cli-parallel-jobs", { maxParallelJobs: 3 });
    const cwd = repo(t, w);
    const cli = (args) => zodchi(t, w, args, { cwd });
    const config = path.join(w.zhome, "config.json");
    const configure = (value) => fs.writeFileSync(config, JSON.stringify(value));
    const entered = (key) => fs.existsSync(path.join(w.codex, `fake-entered-${key}`));
    const release = (key) => fs.writeFileSync(path.join(w.codex, `fake-release-${key}`), "");
    async function submit(key, role = "ask") {
      t.cleanups.push(() => release(key));
      const result = await cli(["submit", "--role", role, "--key", key, "--prompt", prompt(w, key, `HOLD:${key}`)]);
      t.eq(result.code, 0, `submitted ${key}`);
      t.eq(result.json.job.writes, role === "builder", `write access for ${key}`);
    }
    async function finish(key) {
      release(key);
      const result = await cli(["wait", "--key", key, "--wait-sec", "60"]);
      t.eq(result.code, 0, `${key} finished successfully`);
      return result.json.job;
    }
    async function expectQueued(key) {
      const job = await t.until(`the worker for ${key} is up`, async () => {
        const result = await cli(["job", "--key", key]);
        return result.json?.job.workerPid && result.json.job;
      });
      t.eq(job.status, "queued", `${key} is queued`);
    }

    const readers = ["reader-1", "reader-2", "reader-3"];
    for (const key of readers) await submit(key);
    await t.until("three readers are running together", () => readers.every(entered));
    await submit("reader-4");
    await expectQueued("reader-4");
    const first = await finish(readers[0]);
    await t.until("the fourth reader takes the freed slot", () => entered("reader-4"));
    const fourth = await finish("reader-4");
    t.ok(Date.parse(fourth.startedAt) >= Date.parse(first.finishedAt), "the fourth reader started after a slot was free");
    for (const key of readers.slice(1)) await finish(key);

    configure({});
    const defaults = ["default-1", "default-2", "default-3", "default-4", "default-5"];
    for (const key of defaults) await submit(key);
    await t.until("five readers are running with the key missing", () => defaults.every(entered));
    for (const key of defaults) await finish(key);

    await submit("writer-1", "builder");
    await t.until("the first writer is running", () => entered("writer-1"));
    await submit("writer-2", "builder");
    await expectQueued("writer-2");
    const firstWriter = await finish("writer-1");
    const secondWriter = await finish("writer-2");
    t.ok(Date.parse(secondWriter.startedAt) >= Date.parse(firstWriter.finishedAt), "the writers never overlapped");

    for (const value of [0, -1, 1.5, "3", null]) {
      configure({ maxParallelJobs: value });
      const result = await cli(["roles"]);
      t.eq(result.code, 0, "a defaulted limit still permits gateway commands");
      t.eq(/no limit on parallel jobs/.test(result.err), value !== 0, `fallback diagnostic for ${JSON.stringify(value)}`);
    }
  });
}
