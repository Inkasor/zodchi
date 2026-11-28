// `zodchi flow code-package` with its model steps on a zodchi-server (docs/flow-server.md): a real `zodchi-server
// serve` on 127.0.0.1 with scripts/e2e/fake-codex-flow.mjs as the Codex of its users, and the engine, Git, claims,
// checks and journal on the fixture repository of flowWorld. `~/.zodchi/flow.json` names the server and a token file.
// The fake answers each step from fake-flow/<step>.json in the Codex home of the server's user and logs every turn in
// fake-turns.jsonl there, so these scenarios count the model turns that ran on the server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const FIXED = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Every file under `dir`, recursively. */
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile()) : []);

// Count actual HTTP requests across two CLI processes. Server job folders alone cannot distinguish a lookup
// from a second, idempotent POST. Keep the trace to method, path and status so it contains no token or prompt.
async function observeRequests(t, server) {
  const requests = [];
  const origin = new URL(`http://${server.address}`);
  const proxy = http.createServer((client, reply) => {
    const entry = { method: client.method, path: client.url };
    requests.push(entry);
    const upstream = http.request(origin, {
      method: client.method, path: client.url, headers: client.headers, agent: false,
    }, (response) => {
      entry.status = response.statusCode;
      reply.writeHead(response.statusCode, response.headers);
      response.pipe(reply);
    });
    upstream.on("error", (error) => reply.destroy(error));
    reply.on("close", () => upstream.destroy());
    client.pipe(upstream);
  });
  t.cleanups.push(() => { proxy.close(); proxy.closeAllConnections(); });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  return { url: `http://127.0.0.1:${proxy.address().port}`, requests };
}

export default function (h) {
  const { scenario, serve, user, flowWorld, gitOut, STUB, ROOT } = h;

  /** A flow world whose model steps go to a zodchi-server: its user (signed in for the fake unless `signedIn` is
   *  false), the server (its roles folder made by `roles(dir)`, default the roles of this repository), flow.json and
   *  the token file. With `other`, a second user of the same server, signed in, whose token the scenario may put in
   *  the token file. */
  async function serverWorld(t, name, { signedIn = true, roles = null, extra = [], other = false } = {}) {
    const f = flowWorld(t, name);
    const data = path.join(f.w.dir, "server-data");
    const sw = roles ? { ...f.w, env: { ...f.w.env, ZODCHI_ROLES: roles(f.w.dir) } } : f.w;
    const u = await user(t, sw, data, "Flow user", signedIn);
    const o = other ? await user(t, sw, data, "Other user", true) : null;
    const server = await serve(t, sw, data, extra);
    const tokenFile = path.join(f.w.dir, "flow-token");
    fs.writeFileSync(tokenFile, `${u.token}\n`);
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ server: `http://${server.address}`, tokenFile }));
    const jobsDir = path.join(data, "users", u.id, "jobs");
    const answer = (step, value) => {
      fs.mkdirSync(path.join(u.home, "fake-flow"), { recursive: true });
      fs.writeFileSync(path.join(u.home, "fake-flow", `${step.replace(/ /g, "-")}.json`), JSON.stringify(value));
    };
    const steps = () => readJsonl(path.join(u.home, "fake-turns.jsonl")).map((x) => x.step);
    const turn = (step) => readJsonl(path.join(u.home, "fake-turns.jsonl")).find((x) => x.step === step);
    // Job folders only: the server keeps short-lived locks (".claim.lock") beside them, which are not jobs.
    const jobs = () => (fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter((n) => !n.startsWith(".")).sort() : []);
    /** The request the server stored for a job: the role as resolved, with its output schema. */
    const request = (key) => JSON.parse(fs.readFileSync(path.join(jobsDir, key, "request.json"), "utf8"));
    const runId = () => fs.readdirSync(path.join(f.w.zhome, "flows"))[0];
    const events = (id) => readJsonl(path.join(f.w.zhome, "flows", id, "events.jsonl"));
    /** The token is in no file of the journal, in no output of the run and in no commit. */
    const noToken = (res, id, ...earlier) => {
      const leaks = filesUnder(path.join(f.w.zhome, "flows", id)).filter((file) => fs.readFileSync(file, "utf8").includes(u.token));
      t.eq(leaks, [], "the token is in no file of the journal");
      t.ok([res, ...earlier].every(({ out, err }) => !out.includes(u.token) && !err.includes(u.token)), "the token is in no output of the run");
      t.ok(!gitOut(f.r, ["log", "-p", "--all"]).includes(u.token), "the token is in no commit");
    };
    return { ...f, data, u, o, server, tokenFile, jobsDir, answer, steps, turn, jobs, request, runId, events, noToken };
  }

  const schemaOf = (name, version = "v1") => JSON.parse(fs.readFileSync(path.join(ROOT, "rust", "crates", "zodchi-flow-code-package", "flows", "code-package", version, name), "utf8"));

  scenario("flow-server-approve", "resume a server-backed code package after posting the writer job: one server turn per step with the flow schemas, local checks and commit, no token in the journal, output or commit", async (t) => {
    const s = await serverWorld(t, "flow-server-approve");
    const observed = await observeRequests(t, s.server);
    fs.writeFileSync(path.join(s.w.zhome, "flow.json"), JSON.stringify({ server: observed.url, tokenFile: s.tokenFile }));
    s.answer("write", s.patch([s.modify("src/math.mjs", STUB, FIXED)]));
    s.answer("review 1", s.review("approved"));
    const first = await s.flow(["--args", s.args()], { ZODCHI_FLOW_CUT: "submit write" });
    t.eq(first.code, 75, "cut right after the write job was posted");
    const id = s.runId();
    t.eq(s.jobs(), [`flow-${id}-write`], "the server took the write job");
    t.eq(s.claim().status, "open", "the claim stays open across the cut");
    const intent = s.events(id).find(e => e.kind === "intent" && e.step === "write");
    const runDir = path.join(s.w.zhome, "flows", id);
    const frozen = fs.readFileSync(path.join(runDir, intent.request), "utf8");
    const { role } = JSON.parse(frozen);
    t.eq([role.server, role.user, intent.key], [observed.url, s.u.id, `flow-${id}-write`],
      "the request pins the server, authenticated account and write key");
    const route = `/v1/jobs/${intent.key}`;
    const lookup = async (suffix = "") => {
      const response = await fetch(`http://${s.server.address}${route}${suffix}`, {
        headers: { Authorization: `Bearer ${s.u.token}` }, signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, json: await response.json() };
    };
    const before = await lookup();
    t.eq([before.status, before.json?.job?.key], [200, intent.key], "the journaled key resolves before resume");
    t.ok(typeof before.json.job.createdAt === "string", "the lookup identifies a stored job");
    const started = await t.until("the server worker starts the journaled write job", async () => {
      const { status, json } = await lookup();
      return status === 200 && Number.isInteger(json.job?.workerPid) &&
        typeof json.job.turnStartedAt === "string" && s.turn("write") && json.job;
    });
    t.eq(s.steps(), ["write"], "only the writer started before resume");
    const posts = () => observed.requests.filter(e => e.method === "POST" && e.path === "/v1/jobs").map(e => e.status);
    t.eq(posts(), [201], "one successful submission before the cut");
    const resumeRequests = observed.requests.length;
    const res = await s.flow(["--resume", id]);
    const reentry = observed.requests.slice(resumeRequests);
    t.ok(reentry.some(e => e.method === "GET" && e.path === route && e.status === 200),
      "the client looks up the journaled write key on resume");
    t.ok(reentry.some(e => e.method === "GET" && e.path === `${route}/result` && e.status === 200),
      "the client fetches the result under the same key");
    const after = await lookup();
    t.eq([after.status, after.json?.job?.key, after.json?.job?.createdAt, after.json?.job?.status],
      [200, intent.key, before.json.job.createdAt, "succeeded"], "the same remote job succeeded");
    t.eq([after.json.job.workerPid, after.json.job.turnStartedAt],
      [started.workerPid, started.turnStartedAt], "the reattached job keeps its worker and turn identity");
    t.eq(fs.readFileSync(path.join(runDir, intent.request), "utf8"), frozen, "resume keeps the journaled request bytes");
    const answer = await lookup("/result");
    t.eq(answer.status, 200, "the remote result is available by the same key");
    const receipt = s.events(id).filter(e => e.kind === "done" && e.step === "write");
    t.eq(receipt.map(e => e.result), [answer.json], "one persisted write receipt contains the remote answer");
    t.eq([res.code, res.json?.verdict, res.json?.approved, res.json?.runId], [0, "approved", true, id], "the resumed run ends approved, exit 0");
    t.eq(posts(), [201, 201], "two actual POSTs in total, one writer and one reviewer");
    t.eq(s.steps(), ["write", "review 1"], "the writer and the reviewer each ran once, on the server");
    t.eq(readJsonl(path.join(s.w.codex, "fake-turns.jsonl")).length, 0, "no model turn ran on this machine");
    t.eq(s.jobs(), [`flow-${id}-review-1`, `flow-${id}-write`], "the server holds one job per step, under the journaled keys");
    const write = s.request(`flow-${id}-write`);
    const review = s.request(`flow-${id}-review-1`);
    t.eq([write.role.name, write.role.model, write.role.effort], ["flow-patch", "fake-writer", "medium"], "the write job: the installed role with the pinned model and effort");
    t.eq(write.role.outputSchema, schemaOf("patch.schema.json", "v2"), "the write job answers by the pinned exact-edit schema sent with the request");
    t.eq([review.role.name, review.role.model], ["code-review", "fake-reviewer"], "the review job: the installed role with the reviewer of the pair");
    t.eq(review.role.outputSchema, schemaOf("review.schema.json"), "the review job answers by the flow's review schema, not the installed role's");
    const reviewTurn = s.turn("review 1");
    t.ok(reviewTurn.prompt.includes("REVIEW-BASE-MARKER") && reviewTurn.prompt.includes('<attachment path="change.diff">'), "the review prompt carries the base REVIEW.md and the diff, inlined");
    t.eq(s.commits().length, 1, "one commit, made locally");
    t.ok(gitOut(s.r, ["log", "-1", "--format=%B"]).includes("Verified: checks exit 0; args.verify exit 0"), "the commit carries the stamp of the local checks");
    const events = s.events(id);
    const intents = events.filter((e) => e.kind === "intent" && e.effect === "gateway job");
    t.eq(intents.map((e) => [e.step, e.executor]), [["write", "server"], ["review 1", "server"]], "each model step's intent names the server executor");
    t.eq(events.filter((e) => e.kind === "intent" && e.step === "write").length, 1, "one intent for the write step");
    t.eq(events.filter((e) => e.kind === "submitted" && e.step === "write").length, 0, "the resumed run did not submit the write step again");
    t.eq(s.claim().status, "done", "the claim is closed as done");
    s.noToken(res, id, first);
  });

  scenario("flow-server-resume-before-post", "the write step's intent is journaled and its POST /v1/jobs stores nothing, as a cut between the two leaves it: --resume posts the journaled request again under the same key, and only with the token of the account it was made for; the model is asked once", async (t) => {
    const s = await serverWorld(t, "flow-server-resume-before-post", { other: true });
    s.answer("write", s.patch([s.modify("src/math.mjs", STUB, FIXED)]));
    s.answer("review 1", s.review("approved"));
    // A file where the user's job folder belongs: the roles and the account read as usual, but the server cannot count
    // the user's unfinished jobs, so it refuses the POST and stores nothing (the key stays free).
    t.eq(s.jobs(), [], "the user has no job yet");
    fs.rmSync(s.jobsDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(s.jobsDir), { recursive: true });
    fs.writeFileSync(s.jobsDir, "not a folder");
    const first = await s.flow(["--args", s.args()]);
    t.eq([first.code, first.json && first.json.stoppedAt], [2, "infrastructure at write"], "the POST of the write step was refused: an infrastructure stop at write");
    const id = s.runId();
    const writeIntents = () => s.events(id).filter((e) => e.kind === "intent" && e.step === "write").length;
    t.eq([writeIntents(), s.events(id).filter((e) => e.kind === "submitted").length], [1, 0], "the write step has its intent and no submitted record");
    fs.rmSync(s.jobsDir, { force: true });
    t.log("removed the file that held the user's job folder");
    // Another person's token in the token file: the journaled account is not the token's, so the key is not even looked
    // up under it, and the request is never posted under it.
    fs.writeFileSync(s.tokenFile, `${s.o.token}\n`);
    const foreign = await s.flow(["--resume", id]);
    t.eq([foreign.code, foreign.json && foreign.json.stoppedAt], [2, "infrastructure at write"], "with another account's token the resume is an infrastructure stop");
    const why = String(foreign.json && foreign.json.infra);
    t.ok(why.includes(`made for the account ${s.u.id}`) && why.includes(`is of the account ${s.o.id}`), "it names the request's account and the token's");
    const otherJobs = path.join(s.data, "users", s.o.id, "jobs");
    t.eq([fs.existsSync(otherJobs) ? fs.readdirSync(otherJobs) : [], readJsonl(path.join(s.o.home, "fake-turns.jsonl")).length], [[], 0], "no job and no model turn under the other account");
    fs.writeFileSync(s.tokenFile, `${s.u.token}\n`);
    t.log("put the user's own token back");
    const res = await s.flow(["--resume", id]);
    t.eq([res.code, res.json && res.json.verdict, res.json && res.json.runId], [0, "approved", id], "the resumed run ends approved");
    t.ok(res.err.includes(`did not know flow-${id}-write; its journaled request was posted again under the same key (a new job)`), "the journaled request of the write step was posted again under its own key");
    t.eq(s.steps(), ["write", "review 1"], "each model turn ran once");
    t.eq(s.jobs(), [`flow-${id}-review-1`, `flow-${id}-write`], "one job per step, under the journaled keys");
    t.eq(writeIntents(), 1, "still one intent for the write step: no new key");
    t.eq(s.commits().length, 1, "one commit");
    s.noToken(res, id);
  });

  scenario("flow-server-missing-role", "the server has no flow-patch role: the run stops with the missing role named before anything is submitted; no job on the server, no model turn, nothing applied or committed", async (t) => {
    const roles = (dir) => {
      const copy = path.join(dir, "server-roles");
      fs.cpSync(path.join(ROOT, "roles"), copy, { recursive: true });
      for (const file of ["flow-patch.json", "flow-patch.md"]) fs.rmSync(path.join(copy, file), { force: true });
      return copy;
    };
    const s = await serverWorld(t, "flow-server-missing-role", { roles });
    s.answer("write", s.patch([s.modify("src/math.mjs", STUB, FIXED)]));
    // A person whose model steps go to the server only: no local Codex sign-in.
    fs.rmSync(path.join(s.w.codex, "fake-auth.json"), { force: true });
    const res = await s.flow(["--args", s.args()]);
    t.eq([res.code, Boolean(res.json && res.json.approved)], [2, false], "the run is not approved, exit 2");
    const said = JSON.stringify(res.json);
    t.ok(/no role flow-patch/.test(said) && /Nothing was submitted/.test(said), "the result names the missing role and that nothing was submitted");
    // The gate asks the server before it claims: a refusal, no run and no claim.
    t.eq([typeof res.json.refused, res.json.runId, s.claim()], ["string", undefined, null], "refused by the gate, before any claim");
    t.eq([s.jobs(), s.steps()], [[], []], "no job on the server and no model turn");
    t.eq([s.commits().length, fs.readFileSync(path.join(s.r, "src", "math.mjs"), "utf8")], [0, STUB], "nothing applied or committed");
  });

  scenario("flow-server-signed-out", "the user's subscription on the server is not signed in: the gate refuses the run with the sign-in message before any claim; after signing in, a new run goes to approval", async (t) => {
    const s = await serverWorld(t, "flow-server-signed-out", { signedIn: false });
    s.answer("write", s.patch([s.modify("src/math.mjs", STUB, FIXED)]));
    s.answer("review 1", s.review("approved"));
    const res = await s.flow(["--args", s.args()]);
    t.eq([res.code, Boolean(res.json && res.json.approved)], [2, false], "the run is not approved, exit 2");
    const said = JSON.stringify(res.json);
    t.ok(/not signed in/.test(said) && /\/v1\/login/.test(said) && /Nothing was spent/.test(said), "the result asks the person to sign in on the server (POST /v1/login)");
    t.eq([s.jobs(), s.steps()], [[], []], "no job on the server and no model turn");
    t.eq(s.commits().length, 0, "nothing committed");
    t.eq([typeof res.json.refused, res.json.runId, s.claim()], ["string", undefined, null], "refused by the gate, before any claim");
    fs.writeFileSync(path.join(s.u.home, "fake-auth.json"), "{}");
    t.log("signed the server user in (fake)");
    const again = await s.flow(["--args", s.args()]);
    const id = again.json && again.json.runId;
    t.eq([again.code, again.json && again.json.verdict], [0, "approved"], "after signing in, a new run ends approved");
    t.eq(s.steps(), ["write", "review 1"], "each model turn ran once");
    s.noToken(again, id);
  });

  scenario("flow-server-busy", "the server answers 429 busy to the write job: the engine waits and posts the same key again; one job, one intent, approval", async (t) => {
    const s = await serverWorld(t, "flow-server-busy", { extra: ["--max-user-jobs", "1"] });
    s.answer("write", s.patch([s.modify("src/math.mjs", STUB, FIXED)]));
    s.answer("review 1", s.review("approved"));
    // A job folder whose record cannot be read counts as unfinished (the server's count fails closed): with one
    // unfinished job allowed per user, the first POST of the run is refused with 429.
    const blocker = path.join(s.jobsDir, "blocker");
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, "job.json"), "{");
    const running = s.flow(["--args", s.args()]);
    await t.until("the server refused a job of the user as over the limit (429)", () => s.server.stderr().includes("A user is over the unfinished-job limit."), 60000);
    fs.rmSync(blocker, { recursive: true, force: true });
    t.log("removed the unfinished job that held the user's place");
    const res = await running;
    t.eq([res.code, res.json && res.json.verdict], [0, "approved"], "the run ends approved");
    t.ok(/busy \(429\); asking again for flow-[^ ]+-write /.test(res.err), "the run said it was waiting for the busy server, for the same key");
    const id = res.json.runId;
    t.eq(s.jobs(), [`flow-${id}-review-1`, `flow-${id}-write`], "one job per step: the write job under its first key");
    t.eq(s.steps(), ["write", "review 1"], "each model turn ran once");
    t.eq(s.events(id).filter((e) => e.kind === "intent" && e.step === "write").length, 1, "one intent for the write step");
    s.noToken(res, id);
  });
}
