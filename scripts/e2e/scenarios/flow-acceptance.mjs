import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi }) {
  scenario("flow-candidate-acceptance", "accept committed local candidate tests and resume receipts", async t => {
    const f = flowWorld(t, "flow-candidate-acceptance");
    fs.appendFileSync(path.join(f.r, ".gitignore"), "\nnode_modules/\n");
    const png = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082";
    for (const name of ["first", "second"]) {
      fs.writeFileSync(path.join(f.r, `test/${name}.mjs`), `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
test('${name}', async () => {
  assert.equal(fs.readFileSync('node_modules/prepared', 'utf8'), 'ready');
  assert.equal(fs.realpathSync.native(process.env.WB_TEST_CHROME).toLowerCase(), fs.realpathSync.native(process.execPath).toLowerCase());
  if (process.platform === 'win32') assert.ok(!process.env.WB_TEST_CHROME.startsWith('\\\\\\\\?\\\\'));
  const frames = path.resolve(process.env.ZODCHI_ACCEPTANCE_FRAMES);
  assert.equal(path.basename(frames), 'frames');
  assert.equal(path.basename(path.dirname(frames)), '${name}');
  const server = createServer((req,res) => res.end('local'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), 'local'); }
  finally { await new Promise(resolve => server.close(resolve)); }
  fs.appendFileSync('node_modules/${name}-calls', '1');
  fs.writeFileSync(path.join(frames, 'screen.png'), Buffer.from('${png}', 'hex'));
});`);
    }
    fs.writeFileSync(path.join(f.r, "test/skip.mjs"), "import test from 'node:test'; process.stderr.write('# pass 1\\n'); test.skip('skipped', () => {});");
    fs.writeFileSync(path.join(f.r, "test/missing.mjs"), "import test from 'node:test'; test('pass', () => {});");
    fs.writeFileSync(path.join(f.r, "test/fail.mjs"), "import test from 'node:test'; process.stderr.write(Buffer.from([255])); test('fail', () => { throw new Error('fixture failure'); });");
    fs.writeFileSync(path.join(f.r, "test/verbose.mjs"), "import test from 'node:test'; test('verbose', () => { console.log('x'.repeat(17 * 1024 * 1024)); });");
    gitOut(f.r, ["add", "--", ".gitignore", "test/first.mjs", "test/second.mjs", "test/skip.mjs", "test/missing.mjs", "test/fail.mjs", "test/verbose.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Add candidate fixture tests"]);
    const head = gitOut(f.r, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(f.r, "test/first.mjs"), "throw new Error('dirty live file');");
    const plan = { repo: f.r, head, label: "Candidate", browser: { node: process.execPath, executable: process.execPath, variable: "WB_TEST_CHROME" },
      setup: ["mkdir -p node_modules && printf ready > node_modules/prepared && printf 1 >> node_modules/setup-calls"], review: "Check both screens",
      scenarios: ["first", "second"].map(id => ({ id, label: id, test: `test/${id}.mjs`, frames: ["screen.png"] })) };
    const args = path.join(f.w.dir, "candidate.json");
    const invoke = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], { cwd: f.r, env: { ...f.w.env, ...env } });
    const write = () => fs.writeFileSync(args, JSON.stringify(plan));
    f.answer("visual-review", { verdict: "pass", reason: "Both frames" });
    write();
    const stagingCut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "acceptance checkout staging" });
    t.eq(stagingCut.code, 75, "cut while checkout staging is incomplete");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const cut = await invoke(["candidate-acceptance", "--resume", id], { ZODCHI_FLOW_CUT: "acceptance receipt candidate test:first" });
    t.eq(cut.code, 75, "cut after the first test receipt");
    const reviewCut = await invoke(["candidate-acceptance", "--resume", id], { ZODCHI_FLOW_CUT: "acceptance model visual-review" });
    t.eq(reviewCut.code, 75, "cut after the visual review result is durable");
    t.eq(f.steps(), ["visual-review"], "visual review ran once before the cut");
    const completed = await invoke(["candidate-acceptance", "--resume", id]);
    t.eq([completed.code, completed.json?.verdict, completed.json?.head], [0, "pass", head], "both committed tests and review pass");
    t.eq(completed.json.scenarios.map(s => [s.id, s.tool.exitCode, s.frames.length]), [["first", 0, 1], ["second", 0, 1]], "real exit and image receipts");
    const checkout = path.join(completed.json.journal, "candidate-checkout");
    const tree = gitOut(f.r, ["rev-parse", `${head}^{tree}`]);
    t.eq([gitOut(checkout, ["rev-parse", "HEAD"]).trim(), completed.json.tree, fs.readFileSync(path.join(checkout, "node_modules/setup-calls"), "utf8"), fs.readFileSync(path.join(checkout, "node_modules/first-calls"), "utf8"), fs.readFileSync(path.join(checkout, "node_modules/second-calls"), "utf8")], [head, tree, "1", "1", "1"], "pinned checkout, tree and no replay");
    t.ok(completed.json.scenarios.every(s => s.head === head && s.tree === tree && /^[a-f0-9]{64}$/.test(s.frames[0].sha256)), "scenario receipts identify source and image digests");
    t.eq([completed.json.review.answer.verdict, completed.json.review.answer.reason, f.steps()], ["pass", "Both frames", ["visual-review"]], "resume reuses the durable visual verdict without another model call");
    plan.scenarios = [{ id: "bad", test: "../escape.mjs" }]; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.status, "refused", "escaping test is refused");
    plan.scenarios = [{ id: "skip", test: "test/skip.mjs" }]; delete plan.review; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "fail", "skip-only test cannot pass despite a positive stderr diagnostic");
    plan.scenarios = [{ id: "verbose", test: "test/verbose.mjs" }]; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "pass", "the final TAP summary survives output larger than 16 MiB");
    plan.review = "Check image"; plan.scenarios = [{ id: "missing", test: "test/missing.mjs", frames: ["missing.png"] }]; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "blocked", "missing image blocks review");
    plan.scenarios = [{ id: "failed", test: "test/fail.mjs", frames: ["missing.png"] }]; write();
    const failed = await invoke(["candidate-acceptance", "--args", args]);
    t.eq([failed.json?.verdict, failed.json?.scenarios?.[0]?.status, failed.json?.scenarios?.[0]?.tool?.exitCode], ["fail", "fail", 1], "failed test exit is retained with invalid UTF-8 and a missing frame");
  });
  function fixture(t, name) {
    const f = flowWorld(t, name);
    const calls = path.join(f.w.dir, "browser-calls");
    const controls = path.join(f.w.dir, "browser-controls");
    const module = path.join(f.w.dir, "browser.cjs");
    fs.writeFileSync(module, `
      const fs = require('node:fs');
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082','hex');
      exports.chromium = {async launch(options) {
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({headless:options.headless}) + '\\n');
        return { close:async()=>{}, async newContext({ storageState }) {
          let url = 'about:blank';
          let checked = false;
          let route;
          const events = {};
          if (storageState) fs.writeFileSync(${JSON.stringify(controls)}, JSON.stringify({
            cookies:storageState.cookies.map(cookie => cookie.name), origins:storageState.origins.map(row => row.origin),
          }) + '\\n');
          return { async route(_, callback){route=callback;}, routeWebSocket:async()=>{}, request:{async get(endpoint) {
            const data = endpoint.endsWith('/amount') ? {spend:-1234.5} : {sha: endpoint.endsWith('/stale') ? 'b'.repeat(40) : ${JSON.stringify(f.base)}};
            return { ok:()=>true, status:()=>200, json:async()=>data, dispose:async()=>{} };
          }}, async newPage() {
            return { on:(event, handler)=>{events[event]=handler;}, url:()=>url, async goto(target){
              url=target;
              if (url.endsWith('/diagnostics')) {
                const blocked = new URL('/preferences?query_fixture=local-value#fragment', target).href;
                const message = (text, source) => events.console({type:()=> 'error', text:()=>text, location:()=>({url:source})});
                await route({request:()=>({url:()=>blocked, method:()=> 'POST'}),
                  abort:async reason=>{if(reason==='blockedbyclient') message('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', blocked);}});
                message('Fixture widget error\\nextra detail', target);
                message('password = fixture-console-secret', target);
              }
              return {ok:()=>true,status:()=>200};
            }, locator:selector=>({
                async count(){return selector === '#missing' || (selector === '#ready' && url.endsWith('/loading')) ? 0 : 1;},
                async isVisible(){return selector !== '#hidden';},
                async innerText(){return selector === '#amount' ? 'Сумма −1 234,50 ₽ (за период)' : selector === '#result' ? '—' : String(checked);},
                async setChecked(state){checked=state;fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,state}) + '\\n');},
              }), screenshot:async ({path})=>fs.writeFileSync(path,png) };
          }};
        }};
      }};
    `);
    const open = { id: "open", open: "/dashboard", expect: { selector: "#summary" } };
    const plan = { repo: f.r, head: f.base, label: "Dashboard", baseUrl: "http://127.0.0.1:9999",
      health: { path: "/health", pointer: "/sha" }, browser: { executable: process.execPath, module },
      scenarios: [{ id: "first", label: "Required screen", steps: [open] }, { id: "second", label: "Secondary screen", steps: [open] }],
    };
    const args = path.join(f.w.dir, "acceptance.json");
    const write = () => fs.writeFileSync(args, JSON.stringify(plan));
    const invoke = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], { cwd: f.r, env: { ...f.w.env, ...env } });
    return { f, args, write, plan, calls, controls, invoke };
  }

  scenario("flow-release-acceptance-resume", "resume a selected browser scenario without replaying the script or model selection", async t => {
    const { f, args, write, plan, calls, invoke } = fixture(t, "flow-release-acceptance-resume");
    plan.choose = "Check the required screen";
    plan.review = "Confirm the attached frame was captured";
    f.answer("select", { scenarios: ["first"] });
    f.answer("visual-review", { verdict: "pass", reason: "Captured" });
    write();
    const cut = await invoke(["release-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "acceptance receipt browser:first" });
    t.eq(cut.code, 75, "stop after the tool receipt and before its event");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    plan.scenarios[0].steps[0].open = "/changed";
    write();
    const mismatched = await invoke(["release-acceptance", "--resume", id, "--args", args]);
    t.ok(mismatched.code !== 0, "a modified caller plan cannot replace the frozen plan");
    const completed = await invoke(["release-acceptance", "--resume", id]);
    t.eq([completed.code, completed.json?.verdict, completed.json?.selected], [0, "pass", ["first"]], "only the selected scenario passes");
    t.eq(f.steps(), ["select", "visual-review"], "each model step runs once");
    t.eq(fs.readFileSync(calls, "utf8").trim(), '{"headless":true}', "browser ran once in the headless context");
    const final = await invoke(["status", id, "--handoff"]);
    t.eq([final.json?.status, final.json?.verdict, final.json?.scenarios], ["finished", "pass", [{ id: "first", status: "pass" }]], "the handoff carries the exact finished scenario");
  });

  scenario("flow-release-acceptance-gate", "reject an undeclared action and skip UI actions on the wrong deployed SHA", async t => {
    const { args, write, plan, calls, invoke } = fixture(t, "flow-release-acceptance-gate");
    const step = plan.scenarios[0].steps[0];
    step.submit = "#save";
    write();
    const refused = await invoke(["release-acceptance", "--args", args]);
    t.eq([refused.code, refused.json?.status, fs.existsSync(calls)], [2, "refused", false], "unknown actions fail the gate before launch");
    delete step.submit;
    plan.health.path = "/stale";
    write();
    const stale = await invoke(["release-acceptance", "--args", args]);
    t.eq([stale.code, stale.json?.verdict, stale.json?.scenarios[0]?.observed.steps.length], [2, "fail", 0], "the SHA guard runs before opening the product page");
  });

  scenario("flow-release-acceptance-filters", "apply a desired checkbox state and read a localized amount with shared-domain cookies", async t => {
    const { f, args, write, plan, calls, controls, invoke } = fixture(t, "flow-release-acceptance-filters");
    plan.baseUrl = "https://dashboard.example.test";
    plan.scenarios = [plan.scenarios[0]];
    const cookie = (name, domain) => ({ name, domain, value: "fixture", path: "/" });
    const storage = path.join(f.w.dir, "storage.json");
    fs.writeFileSync(storage, JSON.stringify({
      cookies: [cookie("parent", ".example.test"), cookie("host", "dashboard.example.test"),
        cookie("parentHostOnly", "example.test"), cookie("sibling", "sibling.example.test"), cookie("other", ".other.test")],
      origins: [{ origin: plan.baseUrl }, { origin: "https://sibling.example.test" }],
    }));
    plan.storageState = storage;
    const { steps } = plan.scenarios[0];
    steps.push({ id: "select-account", check: { selector: "#account", checked: "true" }, expect: { selector: "#state", text: "true" } });
    write();
    const invalid = await invoke(["release-acceptance", "--args", args]);
    t.ok(invalid.code === 2 && /check.checked must be true or false/.test(invalid.json?.reason ?? "") && !fs.existsSync(calls),
      "the gate requires an actual boolean before launching the browser");
    steps[1].check.checked = true;
    steps.push({ id: "exclude-account", check: { selector: "#account", checked: false }, expect: { selector: "#state", text: "false" } });
    plan.scenarios[0].apiCheck = { selector: "#amount", path: "/amount", pointer: "/spend",
      extract: "first-number", decimal: "," };
    write();
    const accepted = await invoke(["release-acceptance", "--args", args]);
    t.eq([accepted.code, accepted.json?.verdict, accepted.json?.scenarios[0]?.observed?.apiCheck?.ui],
      [0, "pass", -1234.5], "a localized signed currency amount matches the API");
    t.eq([accepted.json.scenarios[0].observed.apiCheck.matches, accepted.json.scenarios[0].observed.apiCheck.visible,
      accepted.json.scenarios[0].observed.apiCheck.text], [1, true, 'Сумма −1 234,50 ₽ (за период)'],
    "the numeric receipt explains what the visible element contained");
    t.eq(fs.readFileSync(controls, "utf8").trim().split(/\r?\n/).map(JSON.parse), [
      { cookies: ["parent", "host"], origins: [plan.baseUrl] },
      { selector: "#account", state: true }, { selector: "#account", state: false },
    ], "the adapter retains matching domain cookies and explicitly asks for each checkbox state");
  });

  scenario("flow-release-acceptance-evidence", "readiness guards placeholders and diagnostics describe visible evidence safely", async t => {
    const { f, args, write, plan, invoke } = fixture(t, "flow-release-acceptance-evidence");
    const step = (id, open, expect) => ({id, open, expect, maxSeconds: 1});
    const compare = selector => ({selector, path: "/amount", pointer: "/spend"});
    plan.scenarios = [
      {id: "loading", ready: {selector: "#ready"}, steps: [step("open", "/loading", {selector: "#result", text: "—"})]},
      {id: "hidden", steps: [step("open", "/dashboard", {selector: "#summary"})], apiCheck: compare("#hidden")},
      {id: "missing", steps: [step("open", "/dashboard", {selector: "#summary"})], apiCheck: compare("#missing")},
      {id: "diagnostics", ready: {selector: "#ready"}, steps: [step("open", "/diagnostics", [{selector: "#summary"}, {selector: "#result", text: "—"}])]},
    ];
    write();
    const result = await invoke(["release-acceptance", "--args", args]);
    t.eq([result.code, result.json?.scenarios?.map(row => row.status)], [2, ["fail", "fail", "fail", "pass"]],
      "the placeholder, hidden amount and missing amount fail while the ready scenario passes");
    const [loading, hidden, missing, diagnostics] = result.json.scenarios.map(row => row.observed);
    t.eq(loading.steps[0].unmet[0].matches, 0, "the timeout identifies the missing readiness locator");
    t.eq([hidden.apiCheck.matches, hidden.apiCheck.visible, hidden.apiCheck.ui, missing.apiCheck.matches, missing.apiCheck.ui],
      [1, false, null, 0, null], "an invisible or absent amount never appears as zero");
    t.eq(diagnostics.network, [{kind:"blocked request", method:"POST", sameOrigin:true, path:"/preferences"}],
      "blocked requests keep their path without query data");
    t.eq(diagnostics.console.map(row => [row.message, row.causedByAdapter]), [
      ["Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", true], ["Fixture widget error", false], ["[source line withheld]", false],
    ], "console evidence preserves only a screened first line and attributes the direct transport block");
    const local = path.join(f.w.zhome, "flows", result.json.runId, "acceptance", "diagnostics", "browser", "browser-result.json");
    t.ok(!/fixture-console-secret|query_fixture|extra detail/.test(fs.readFileSync(local, "utf8")),
      "the driver evidence on disk never holds raw diagnostic secrets or the second line");
  });
}
