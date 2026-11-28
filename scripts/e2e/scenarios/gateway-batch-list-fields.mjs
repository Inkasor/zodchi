import fs from "node:fs";
import path from "node:path";
import { registerBatchSubmit } from "./gateway-batch.mjs";

async function checkListFields(t, { w, cwd, prompt, call, jobDir }) {
  const promptFile = prompt(w, "batch-list-fields-prompt.txt", "Reply briefly.");
  const file = path.join(cwd, "batch-list-fields.json");
  const key = "batch-list-fields-rejected";

  fs.writeFileSync(file, JSON.stringify({
    role: "ask",
    jobs: [{ key, prompt: promptFile }],
    roel: "ask",
  }));
  const rejected = await call("submit", "--list", file);
  t.eq(rejected.code, 1, "unknown top-level field is rejected");
  t.ok(rejected.err.includes(file), "diagnostic names the list file");
  t.ok(rejected.err.includes("unknown field 'roel'"), "diagnostic names the unexpected field");
  t.ok(!fs.existsSync(jobDir(key)), "no job is saved");

  fs.writeFileSync(file, JSON.stringify({ role: 42, jobs: [], roel: "ask" }));
  const invalidRole = await call("submit", "--list", file);
  t.eq(invalidRole.code, 1, "unknown field with invalid role is rejected");
  t.ok(invalidRole.err.includes("unknown field 'roel'"), "top-level fields are checked before the role");

  fs.writeFileSync(file, JSON.stringify({ role: "ask", jobs: [{}], roel: "ask" }));
  const invalidJob = await call("submit", "--list", file);
  t.eq(invalidJob.code, 1, "unknown field with invalid job is rejected");
  t.ok(invalidJob.err.includes("unknown field 'roel'"), "top-level fields are checked before jobs");

  fs.writeFileSync(file, JSON.stringify({ role: "ask", jobs: [], roel: "ask" }));
  const waited = await call("wait", "--all", "--list", file);
  t.eq(waited.code, 1, "empty wait list is rejected");
  t.ok(waited.err.includes("batch wait needs at least one key"), "wait retains its existing list behavior");
}

export default function register(helpers) {
  registerBatchSubmit(helpers, checkListFields);
}
