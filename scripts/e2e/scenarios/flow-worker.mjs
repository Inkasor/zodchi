import fs from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

export default function register({ scenario, flowWorld, zodchi, STUB, FIXED }) {
  scenario("flow-worker-reattach", "a detached flow keeps one run and a second caller can inspect and resume it", async (t) => {
    const f = flowWorld(t, "flow-worker-reattach");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const start = await f.flow(["--args", f.args(), "--detach"]);
    t.eq([start.code, start.json.status], [0, "submitted"], "the caller leaves after collecting the run ID");
    const id = start.json.runId;
    const fromAnotherDirectory = (args) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: f.w.env });
    const attach = await fromAnotherDirectory(["code-package", "--resume", id]);
    t.eq(attach.json.runId, id, "the second caller attaches to the same run");
    const limit = Date.now() + 30000;
    let final;
    while (Date.now() < limit) {
      const inspected = await fromAnotherDirectory(["status", id]);
      if (inspected.json?.status === "finished") {
        final = inspected.json.result;
        break;
      }
      await pause(150);
    }
    t.eq([final?.approved, f.claim().status, f.commits().length, f.steps()],
      [true, "done", 1, ["write", "review 1"]], "detached execution, inspection and resume do not duplicate effects");
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
  });
}
