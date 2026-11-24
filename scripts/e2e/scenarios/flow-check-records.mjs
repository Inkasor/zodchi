import fs from "node:fs";
import path from "node:path";

export default function ({ scenario, flowWorld, gitOut, STUB, FIXED, ROOT }) {
  scenario("flow-fork-publish-guard", "fork verification preserves the marker without inheriting remote URLs", async t => {
    const f = flowWorld(t, "flow-fork-publish-guard");
    const fixtures = "scripts/e2e/fixtures";
    for (const source of ["src/math.mjs", "src/other.mjs", "test/math.test.mjs", "smoke.mjs"]) {
      const destination = `${fixtures}/${source}`;
      fs.mkdirSync(path.dirname(path.join(f.r, destination)), { recursive: true });
      gitOut(f.r, ["mv", "--", source, destination]);
    }
    const math = "src/clamp.rs";
    const support = {
      [math]: "pub fn clamp(x: i32, _lo: i32, _hi: i32) -> i32 { x }\n",
      "models.json": '{}\n',
      "roles/.keep": "",
      ".claude-plugin/marketplace.json": '{"plugins":[]}\n',
      ".zodchi/allowed-words.txt": "publish-guard-fixture\n",
      "scripts/check.mjs": fs.readFileSync(path.join(ROOT, "scripts/check.mjs")),
    };
    for (const prefix of ["plugins/codex", "plugins/claude-code/core"]) {
      const skill = `${prefix}/skills/zodchi-flow/SKILL.md`;
      support[skill] = "---\nname: zodchi-flow\ndescription: Fixture for the guard.\n---\n";
    }
    for (const [file, data] of Object.entries(support)) {
      const target = path.join(f.r, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    gitOut(f.r, ["add", "--", ...Object.keys(support)]);
    gitOut(f.r, ["commit", "-qm", "fixture publish guard"]);
    gitOut(f.r, ["remote", "add", "upstream", "https://upstream.example.test/fixture.git"]);
    gitOut(f.r, ["remote", "add", "origin", "https://origin.example.test/fixture.git"]);
    f.answer("write", { status: "done", summary: "Fixed clamp.", criteria: [], questions: [], changedFiles: [], checks: [],
      flowWrites: { [math]: "pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 { x.clamp(lo, hi) }\n" } });
    f.answer("review 1", f.review("approved"));
    const boundary = 'test "$(git remote)" = upstream && ! git config --local --get remote.upstream.url && ! git config --local --get remote.upstream.fetch';
    const result = await f.flow(["--args", f.args({
      mode: "agent", isolated: true, files: [math], checks: ["node scripts/check.mjs", boundary],
      verify: ["git diff --quiet HEAD --"],
    })]);
    t.eq([result.code, result.json?.verdict], [0, "approved"], "the real publish guard approves the isolated candidate copy");
    const { checks } = result.json.rounds[0];
    t.eq(checks.evidence.slice(0, 2).map(row => row.exitCode), [0, 0], "the snapshot has the fork marker without either remote connection");
    t.ok(fs.readFileSync(checks.evidence[0].log, "utf8").includes("word(s) allowed"), "the committed allow-list actually took effect");
  });
  scenario("flow-review-check-records", "review receives the check record for the committed tree, with private text removed", async t => {
    const f = flowWorld(t, "flow-review-check-records");
    const neighbor = "export const other = 'staged elsewhere';\n";
    fs.writeFileSync(path.join(f.r, "src", "other.mjs"), neighbor);
    gitOut(f.r, ["add", "--", "src/other.mjs"]);
    t.eq(gitOut(f.r, ["diff", "--cached", "--name-only"]), "src/other.mjs", "a neighboring change is staged");

    const privateWord = "review-fixture-private-word";
    const pemBody = "fixture-body-must-stay-local";
    const keyType = ["PRIVATE", "KEY"].join(" ");
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), privateWord + "\n");
    const gitCheck = "git diff --quiet HEAD -- && git ls-files --error-unmatch src/math.mjs && git rev-parse --show-toplevel 'HEAD^{tree}'";
    const privateCheck = "printf '%s\\n' " +
      [privateWord, `-----BEGIN ${keyType}-----`, pemBody, `-----END ${keyType}-----`, "end of check"]
        .map(line => `'${line}'`).join(" ");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args({ checks: [gitCheck], verify: ["node smoke.mjs", privateCheck] })]);
    t.eq([res.code, res.json?.verdict], [0, "approved"], "the Git-dependent check and both verification commands pass");
    const { checks, commit } = res.json.rounds[0];

    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const { prompt } = turns.find(turn => turn.step === "review 1");
    const attachment = prompt.match(/<attachment path="verification\.json">\n([\s\S]*?)\n<\/attachment>/);
    t.ok(attachment, "the review has a separate JSON attachment with the engine records");
    const proof = JSON.parse(attachment[1]);
    t.eq([proof.commit, proof.tree], [commit.commit, checks.tree], "the attachment names the checked commit and tree");
    t.eq(proof.tree, gitOut(f.r, ["rev-parse", "HEAD^{tree}"]), "the real commit has the checked tree");
    t.eq(proof.commands.map(command => [command.check, command.exitCode]), [
      ["checks #1", 0], ["args.verify #1", 0], ["args.verify #2", 0],
    ], "the receipt records a code for each command");
    t.eq(proof.commands[0].command, gitCheck, "the receipt names the Git check");
    t.eq(proof.commands[0].output, ["src/math.mjs", "<candidate>", checks.tree].join("\n"), "Git sees the candidate index and tree");
    t.eq([proof.commands[1].command, proof.commands[1].output], ["node smoke.mjs", "smoke 4"], "the receipt names verify and preserves its output");
    t.ok(proof.commands[2].output.includes("end of check") && proof.commands[2].output.includes("[private text removed]"), "sanitized output preserves public lines");
    t.ok(!prompt.includes(privateWord) && !prompt.includes(pemBody), "neither the command nor output exposes private text");
    t.ok(fs.readFileSync(checks.evidence[2].log, "utf8").includes(pemBody), "the raw local log is retained");
    t.eq(gitOut(f.r, ["diff", "--cached", "--name-only"]), "src/other.mjs", "the neighboring staged change is preserved");
    t.eq(fs.readFileSync(path.join(f.r, "src", "other.mjs"), "utf8"), neighbor, "the neighboring worktree file is preserved");
  });
}
