import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, zodchi, STUB, FIXED }) {
  function fixture(t, name) {
    const f = flowWorld(t, name);
    const ledger = path.join(f.r, "asset.ledger.json");
    const args = path.join(f.w.dir, "asset.json");
    const pkg = f.args();
    const plan = { repo: f.r, ledger, tmp: path.join(f.w.dir, "asset-output"), label: "shelf", stage: 1,
      summary: "Make the shelf support check explicit", package: pkg };
    const write = (value, input = plan) => {
      fs.writeFileSync(ledger, JSON.stringify(value, null, 1) + "\n");
      fs.writeFileSync(args, JSON.stringify(input));
    };
    write({ method: "timber", rounds: [] });
    const flow = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], {
      cwd: f.r, env: { ...f.w.env, ...env },
    });
    const read = () => JSON.parse(fs.readFileSync(ledger, "utf8"));
    return { f, args, ledger, write, read, flow, plan };
  }

  scenario("flow-asset-round-resume", "the asset ledger and a code package survive an interrupted round", async t => {
    const { f, args, read, flow } = fixture(t, "flow-asset-round-resume");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const cut = await flow(["asset-round", "--args", args], { ZODCHI_FLOW_CUT: "asset ledger" });
    t.eq(cut.code, 75, "the parent stopped just after recording the ledger row");
    const original = read().rounds[0];
    t.eq([original.n, original.owner], [1, null], "one round awaits its owner");
    const id = original.runId;
    const waiting = await flow(["asset-round", "--resume", id]);
    t.eq([waiting.code, waiting.json?.status], [2, "waiting"], "another CLI process sees the same pending round");
    t.eq(f.steps(), ["write", "review 1"], "the child model steps ran once");
    const answer = path.join(f.w.dir, "owner.txt");
    fs.writeFileSync(answer, "accepted shelf support\n");
    const reply = await flow(["reply", id, "--file", answer]);
    t.eq(reply.code, 0, "the owner verdict is attached to this run");
    const done = await flow(["asset-round", "--resume", id]);
    t.eq([done.code, done.json?.approved, read().rounds.length], [0, true, 1], "owner acceptance closes exactly one round");
    t.eq(read().rounds[0].owner, "accepted shelf support", "the ledger holds the exact verdict");
    t.eq(f.steps(), ["write", "review 1"], "acceptance never starts the child again");
  });

  scenario("flow-asset-round-gate", "stage and latest method decide whether another round can proceed", async t => {
    const { f, args, write, flow, plan } = fixture(t, "flow-asset-round-gate");
    write({ method: "timber", rounds: [] }, { ...plan, stage: 2 });
    const missing = await flow(["asset-round", "--args", args]);
    t.eq(missing.code, 2, "the look stage needs a selected look method");
    const rounds = [
      { n: 1, owner: "accepted blockout" }, { n: 2, owner: "revise" },
      { n: 3, owner: "revise" }, { n: 4, owner: "revise" },
    ];
    write({ method: "timber", lookMethod: { afterRound: 1, name: "split wood" }, rounds }, { ...plan, stage: 2 });
    const limited = await flow(["asset-round", "--args", args]);
    t.eq(limited.code, 2, "an earlier acceptance does not reset the limit under a new method");
    t.ok(String(limited.json?.refused).includes("Three rounds"), "the refusal identifies the current method");
    write({ method: "timber", rounds: [{ n: 1, owner: null }] });
    const blocked = await flow(["asset-round", "--args", args]);
    t.eq([blocked.code, f.steps()], [2, []], "an unjudged prior round spends no model turns");
  });
}
