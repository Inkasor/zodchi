import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export default function register({ scenario, flowWorld, zodchi }) {
  scenario("flow-workspace-audit-copies", "approve a pinned inventory and copy only the eligible original bytes", async t => {
    const f = flowWorld(t, "flow-workspace-audit-copies");
    const root = path.join(f.w.dir, "workspace");
    const archive = path.join(f.w.dir, "verified copy");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "source repo"));
    fs.mkdirSync(path.join(root, "source repo", ".git"));
    fs.writeFileSync(path.join(root, "first.txt"), "original file");
    fs.writeFileSync(path.join(root, "second.txt"), "changes before copying");
    const args = path.join(f.w.dir, "audit.json");
    const reply = path.join(f.w.dir, "reply.json");
    fs.writeFileSync(args, JSON.stringify({ root, archive }));
    const run = argv => zodchi(t, f.w, ["flow", ...argv], { cwd: f.r, env: f.w.env });
    const opened = await run(["workspace-audit", "--args", args]);
    t.eq([opened.code, opened.json?.status], [2, "waiting"], "the workflow hands the inventory to the owner");
    const id = opened.json.runId;
    const status = await run(["status", id]);
    t.eq([status.json?.status, status.json?.step], ["waiting", "owner decisions"], "the next process sees the owner gate");
    const inventory = JSON.parse(fs.readFileSync(opened.json.inventory, "utf8"));
    t.eq(inventory.items.find(item => item.path === "source repo")?.archivable ?? null, false, "a repository is reported and cannot be picked");
    t.ok(!fs.existsSync(archive), "survey creates no archive");
    fs.writeFileSync(reply, JSON.stringify({ inventorySha256: "a different inventory", copy: ["first.txt"] }));
    const accepted = await run(["reply", id, "--file", reply]);
    t.eq(accepted.code, 0, "the reply is stored for validation by the resumed workflow");
    const mismatch = await run(["workspace-audit", "--resume", id]);
    t.eq([mismatch.code, mismatch.json?.status], [2, "waiting"], "a stale approval cannot authorize copies");
    t.ok(!fs.existsSync(archive), "no archive from a stale approval");
    fs.writeFileSync(path.join(root, "second.txt"), "new source bytes");
    fs.writeFileSync(reply, JSON.stringify({
      inventorySha256: opened.json.inventorySha256, copy: ["first.txt", "second.txt"],
    }));
    t.eq((await run(["reply", id, "--file", reply])).code, 0, "record the exact approved selection");
    const copied = await run(["workspace-audit", "--resume", id]);
    t.eq([copied.code, copied.json?.outcome], [2, "partial"], "a changed source is reported and skipped");
    t.eq(copied.json.copies.map(item => item.status), ["verified", "skipped"], "the receipts reflect each actual action");
    const first = fs.readFileSync(path.join(archive, "first.txt"));
    const hash = crypto.createHash("sha256").update(first).digest("hex");
    t.eq([first.toString(), hash], ["original file", copied.json.copies[0].sha256], "the archived bytes match the inventory");
    t.ok(fs.existsSync(path.join(root, "first.txt")) && !fs.existsSync(path.join(archive, "second.txt")), "the approval preserves the original");
    const replay = await run(["workspace-audit", "--resume", id]);
    t.eq([replay.code, replay.json?.copies], [2, copied.json.copies], "resume returns the original receipt");
  });
}
