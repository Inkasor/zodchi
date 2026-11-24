import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export default function register({ scenario, flowWorld, zodchi }) {
  function fixture(t, name) {
    const f = flowWorld(t, name);
    const roles = path.join(f.r, ".zodchi", "roles");
    fs.mkdirSync(roles, { recursive: true });
    fs.writeFileSync(path.join(roles, "upright.json"), JSON.stringify({
      kind: "decisions", mode: "expert", model: "fixture-model", questions: "upright.questions.json",
    }));
    fs.writeFileSync(path.join(roles, "upright.questions.json"), JSON.stringify([
      { name: "upright", type: "predicate", instructions: "Does the shelf look upright?", expect: true },
    ]));
    const picture = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082", "hex");
    const frames = ["sound.png", "defect.png"].map((name, i) => {
      const file = path.join(f.w.dir, name);
      fs.writeFileSync(file, picture);
      return { file, note: "The workshop shelf", sound: i === 0, defects: i === 0 ? [] : ["upright"] };
    });
    const args = { repo: f.r, tmp: path.join(f.w.dir, "verdicts"), label: "shelf", role: "upright", frames, paid: true };
    const file = path.join(f.w.dir, "args.json");
    const write = () => fs.writeFileSync(file, JSON.stringify(args));
    const run = (argv, env = {}) => zodchi(t, f.w, argv, {
      cwd: f.r, env: { ...f.w.env, ...env },
    });
    write();
    return { f, run, args, file, frames, picture, write };
  }

  scenario("flow-rubric-probe-guard", "refuse unapproved spend and an invalid later frame before starting any job", async t => {
    const { f, run, args, file, frames, write } = fixture(t, "flow-rubric-probe-guard");
    args.paid = false;
    write();
    const unpaid = await run(["flow", "rubric-probe", "--args", file]);
    t.eq(unpaid.code, 2, "the caller explicitly authorizes the Decisions charge");
    t.ok(String(unpaid.json?.refused).includes("args.paid"), "the refusal names the required authority");
    args.paid = true;
    fs.writeFileSync(frames[1].file, Buffer.from("89504e470d0a1a0a0000000000000000", "hex"));
    write();
    const invalid = await run(["flow", "rubric-probe", "--args", file]);
    t.eq(invalid.code, 2, "all frames are checked before the first submission");
    t.ok(String(invalid.json?.refused).includes("frames[1]"), "the invalid frame is named");
    t.ok(!fs.existsSync(path.join(f.w.zhome, "flows")), "no run or paid intent exists");
  });

  scenario("flow-rubric-probe-resume", "reuse the pinned image and exact frame keys with fixture Decisions results", async t => {
    const { f, run, file, frames, picture } = fixture(t, "flow-rubric-probe-resume");
    const ctx = turn => ({ ZODCHI_FLOW_CUT: "submit frame " + turn });
    const first = await run(["flow", "rubric-probe", "--args", file], ctx(1));
    t.eq(first.code, 75, "the CLI interrupted after submitting the first fixture frame");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    fs.writeFileSync(frames[1].file, "new content from a neighboring editor");
    for (const n of [1, 2]) {
      const key = "flow-" + id + "-frame-" + n;
      const response = await run(["wait", "--key", key, "--wait-sec", "30"]);
      t.eq(response.json?.job?.status, "auth_required", "this isolated test has no API key and makes no network call");
      const folder = path.join(f.r, ".agent-tmp", "gateway", key);
      const request = JSON.parse(fs.readFileSync(path.join(folder, "request.json"), "utf8"));
      t.eq(request.images[0].sha256, crypto.createHash("sha256").update(picture).digest("hex"), "the job reads the pinned bytes even after an original changes");
      // Feed a recorded provider result through the gateway's normal read path in this scratch repository.
      const final = path.join(folder, "final.json");
      const receipt = JSON.parse(fs.readFileSync(final, "utf8"));
      const outcome = n === 1 ? "pass" : "fail";
      fs.writeFileSync(final, JSON.stringify({
        ...receipt, status: "succeeded", error: "", tokens: { inputTokens: 10 },
        result: { data: { verdict: { questions: [{ name: "upright", outcome, agreement: n === 1 ? 0.98 : 0.04 }] } } },
      }));
      if (n === 1) {
        const second = await run(["flow", "rubric-probe", "--resume", id], ctx(2));
        t.eq(second.code, 75, "the next CLI advances to the second frame");
      }
    }
    const done = await run(["flow", "rubric-probe", "--resume", id]);
    t.eq([done.code, done.json?.runId, done.json?.inputTokens], [0, id, 20], "the exact run merges the two frame results");
    t.eq(done.json.verdicts[0].verdict, "keep", "the rubric detects the known defect and passes the sound frame");
    t.eq(done.json.verdicts[0].answers.map(row => row.frame), frames.map(frame => frame.file), "the matrix identifies the exact supplied paths");
    t.eq(fs.readdirSync(path.join(f.r, ".agent-tmp", "gateway")).filter(name => name.startsWith("flow-" + id)).length, 2, "resume submits each frame once");
  });
}
