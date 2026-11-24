import fs from "node:fs";
import path from "node:path";

export default function ({ scenario, world, repo, prompt, zodchi }) {
  const name = "gateway-batch-submit-list-fields";
  scenario(name, "reject unknown top-level batch submission fields", async t => {
    const w = world(name);
    const cwd = repo(t, w);
    const promptFile = prompt(w, "batch-list-fields-prompt.txt", "Reply briefly.");
    const file = path.join(cwd, "batch-list-fields.json");
    const key = "batch-list-fields-rejected";

    fs.writeFileSync(file, JSON.stringify({
      role: "ask",
      jobs: [{ key, prompt: promptFile }],
      roel: "ask",
    }));
    const rejected = await zodchi(t, w, ["submit", "--list", file], { cwd });
    t.eq(rejected.code, 1, "unknown top-level field is rejected");
    t.ok(rejected.err.includes(file), "diagnostic names the list file");
    t.ok(rejected.err.includes("unknown field 'roel'"), "diagnostic names the unexpected field");
    t.ok(!fs.existsSync(path.join(cwd, ".agent-tmp", "gateway", key)), "no job is saved");

    fs.writeFileSync(file, JSON.stringify({ role: 42, jobs: [], roel: "ask" }));
    const invalidRole = await zodchi(t, w, ["submit", "--list", file], { cwd });
    t.eq(invalidRole.code, 1, "unknown field with invalid role is rejected");
    t.ok(invalidRole.err.includes("unknown field 'roel'"), "top-level fields are checked before the role");

    fs.writeFileSync(file, JSON.stringify({ role: "ask", jobs: [{}], roel: "ask" }));
    const invalidJob = await zodchi(t, w, ["submit", "--list", file], { cwd });
    t.eq(invalidJob.code, 1, "unknown field with invalid job is rejected");
    t.ok(invalidJob.err.includes("unknown field 'roel'"), "top-level fields are checked before jobs");

    fs.writeFileSync(file, JSON.stringify({ role: "ask", jobs: [], roel: "ask" }));
    const waited = await zodchi(t, w, ["wait", "--all", "--list", file], { cwd });
    t.eq(waited.code, 1, "empty wait list is rejected");
    t.ok(waited.err.includes("batch wait needs at least one key"), "wait retains its existing list behavior");
  });
}
