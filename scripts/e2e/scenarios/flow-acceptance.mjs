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
  assert.equal(fs.realpathSync.native(process.env.APP_TEST_CHROME).toLowerCase(), fs.realpathSync.native(process.execPath).toLowerCase());
  if (process.platform === 'win32') assert.ok(!process.env.APP_TEST_CHROME.startsWith('\\\\\\\\?\\\\'));
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
    const plan = { repo: f.r, head, label: "Candidate", browser: { node: process.execPath, executable: process.execPath, variable: "APP_TEST_CHROME" },
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
          const request = async (target, method) => route({request:()=>({url:()=>target, method:()=>method}),
            abort:async()=>fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({method,target,blocked:true}) + '\\n'),
            fetch:async options=>{fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({target,fetchTimeout:options.timeout}) + '\\n'); return {status:()=>200,dispose:async()=>{}};},
            fulfill:async()=>fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({method,target,allowed:true}) + '\\n')});
          return { async route(_, callback){route=callback;}, routeWebSocket:async()=>{}, request:{async get(endpoint) {
            const data = endpoint.endsWith('/amount') ? {spend:-1234.5} : {sha: endpoint.endsWith('/stale') ? 'b'.repeat(40) : ${JSON.stringify(f.base)}};
            return { ok:()=>true, status:()=>200, json:async()=>data, dispose:async()=>{} };
          }}, async newPage() {
            return { on:(event, handler)=>{events[event]=handler;}, url:()=>url, async goto(target){
              url=target;
              if (url.endsWith('/writes')) {
                await request(new URL('/api/example-write?test=1', target).href, 'POST');
                await request(new URL('/api/example-write', target).href, 'PUT');
                await request(new URL('/api/other', target).href, 'POST');
              }
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
                async count(){return selector === '#missing' || (selector === '#ready' && url.endsWith('/loading')) ? 0 : selector === '#multiple' ? 2 : 1;},
                async isVisible(){return selector !== '#hidden';},
                async innerText(){return selector === '#whitespace' ? 'alpha\u00a0  beta' : selector === '#amount' ? 'Сумма −1 234,50 ₽ (за период)' : selector === '#result' ? '—' : String(checked);},
                async fill(value){fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,fill:value}) + '\\n');},
                async hover(){fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,hover:true}) + '\\n');},
                async press(value){fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,press:value}) + '\\n');},
                async evaluate(){return false;},
                async click(){if(selector === '#multiple') throw Object.assign(new Error('strict'), {name:'TimeoutError'}); if(url.endsWith('/budget-download')) await request(new URL(selector === '#button' ? '/export' : '/after-export', url).href, 'GET'); fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,click:true}) + '\\n');},
                async setChecked(state){checked=state;fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({selector,state}) + '\\n');},
              }), async waitForEvent(event) {
                if (url.endsWith('/no-event')) throw Object.assign(new Error('event timeout'), {name:'TimeoutError'});
                if (event === 'popup') return {on:()=>{}, url:()=>url.endsWith('/external-popup') ? 'https://outside.test/' : new URL('/popup', url).href,
                  waitForLoadState:async()=>{}, locator:()=>({count:async()=>1,isVisible:async()=>true}), screenshot:async({path})=>fs.writeFileSync(path,png)};
                return {saveAs:async destination=>{if(url.endsWith('/slow-download')) await new Promise(resolve=>setTimeout(resolve, 1500)); if(url.endsWith('/failed-download')) throw new Error('save failed'); if(!url.endsWith('/missing-download')) fs.writeFileSync(destination,'fixture download');}, failure:async()=>null, cancel:async()=>{fs.appendFileSync(${JSON.stringify(controls)}, JSON.stringify({cancelDownload:true}) + '\\n');}};
              }, screenshot:async ({path})=>fs.writeFileSync(path,Buffer.concat([png, Buffer.from(url)])) };
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

  scenario("flow-candidate-browser-actions", "validate managed browser actions and guards", async t => {
    const { f, args, write, plan, controls, invoke } = fixture(t, "flow-candidate-browser-actions");
    const script = path.join(f.r, "test/actions-fixture.mjs");
    fs.writeFileSync(script, `import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('local'));
server.listen(0, '127.0.0.1', () => console.log('baseUrl http://127.0.0.1:' + server.address().port));`);
    gitOut(f.r, ["add", "--", "test/actions-fixture.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Add actions fixture"]);
    plan.head = gitOut(f.r, ["rev-parse", "HEAD"]).trim();
    delete plan.baseUrl; delete plan.health;
    plan.fixture = { script: "test/actions-fixture.mjs", readyPrefix: "baseUrl ", allowedWrites: [{method:"POST", path:"/api/example-write"}] };
    plan.scenarios = [{ id:"actions", steps:[
      {id:"open", open:"/", expect:[{selector:"#missing", count:0}, {selector:"#whitespace", text:"alpha beta", normalizeWhitespace:true}]},
      {id:"fill", fill:{selector:"#date", value:"2026-11-25"}, expect:{selector:"#summary"}},
      {id:"hover", hover:"#menu", expect:{selector:"#summary"}},
      {id:"press", press:{selector:"#search", value:"Enter"}, expect:{selector:"#summary"}},
      {id:"click", click:"#button", expect:{selector:"#summary"}}
    ] }];
    write();
    const result = await invoke(["candidate-acceptance", "--args", args]);
    t.eq(result.json?.verdict, "pass", "actions and normalized and zero-count assertions pass");
    const actions = fs.readFileSync(controls, "utf8");
    t.ok(actions.includes('2026-11-25') && actions.includes('hover') && actions.includes('Enter'), "actions reach the browser");
    const opening = plan.scenarios[0].steps[0];
    opening.expect = {selector:"#whitespace", text:" alpha\u00a0  beta "}; opening.maxSeconds = 1; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "fail", "exact text keeps expectation whitespace unless normalization is enabled");
    const last = plan.scenarios[0].steps.at(-1);
    opening.expect.normalizeWhitespace = true;
    last.click = {selector:"#button", popup:true}; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "pass", "opt-in normalization and the same-origin popup pass");
    opening.expect = [{selector:"#missing", count:0}, {selector:"#whitespace", text:"alpha beta", normalizeWhitespace:true}]; delete opening.maxSeconds;
    plan.scenarios[0].steps[0].open = "/external-popup"; write();
    const external = await invoke(["candidate-acceptance", "--args", args]);
    t.eq([external.json?.verdict, external.json?.scenarios?.[0]?.observed?.steps?.at(-1)?.id], ["fail", "click"], "external popup fails at its click step");
    plan.scenarios[0].steps[0].open = "/";
    last.click = {selector:"#button", download:"download-report.csv"}; write();
    const downloaded = await invoke(["candidate-acceptance", "--args", args]);
    t.eq(downloaded.json?.verdict, "pass", "download succeeds");
    t.eq(downloaded.json?.scenarios?.[0]?.downloads?.length, 1, "download has pinned evidence");
    const pin = downloaded.json?.scenarios?.[0]?.downloads?.[0];
    t.ok(pin && path.basename(pin.path) === "download-report.csv" && fs.readFileSync(pin.path, "utf8") === "fixture download" && /^[a-f0-9]{64}$/.test(pin.sha256), "download evidence identifies the saved output and digest");
    plan.scenarios[0].steps[0].open = "/budget-download"; last.maxSeconds = 30;
    plan.scenarios[0].steps.push({id:"after-export", click:"#after", expect:{selector:"#summary"}}); write();
    const budgetDownload = await invoke(["candidate-acceptance", "--args", args]);
    const budgetCalls = fs.readFileSync(controls, "utf8").trim().split('\n').map(line => JSON.parse(line));
    t.eq(budgetDownload.json?.verdict, "pass", "download with a longer deadline succeeds");
    t.ok(budgetCalls.some(row => row.target?.endsWith('/export') && row.fetchTimeout > 15000 && row.fetchTimeout <= 30000), "routed download uses the remaining click budget");
    t.ok(budgetCalls.some(row => row.target?.endsWith('/after-export') && row.fetchTimeout === 15000), "later requests use the default fetch timeout");
    plan.scenarios[0].steps.pop(); delete last.maxSeconds;
    plan.scenarios[0].steps[0].open = "/missing-download"; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.verdict, "fail", "missing download cannot pass");
    plan.scenarios[0].steps[0].open = "/slow-download"; last.maxSeconds = 1; write();
    const slow = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(slow.json?.verdict === "fail" && /download did not complete/i.test(JSON.stringify(slow.json)) && slow.json?.scenarios?.[0]?.observed?.steps?.at(-1)?.id === "click", "download completion respects the click deadline");
    const slowOutput = path.join(f.w.zhome, "flows", slow.json.runId, "acceptance", "actions", "browser");
    t.ok(!fs.existsSync(path.join(slowOutput, "download-report.csv")) && !fs.readdirSync(slowOutput).some(name => name.startsWith('.download-')) && fs.readFileSync(controls, 'utf8').includes('"cancelDownload":true'), "timed-out download is canceled and leaves no output or staging file");
    plan.scenarios[0].steps[0].open = "/failed-download"; write();
    const failedDownload = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(failedDownload.json?.verdict === "fail" && /download failed while saving/i.test(JSON.stringify(failedDownload.json?.scenarios?.[0]?.observed?.steps?.at(-1))) && failedDownload.json?.scenarios?.[0]?.observed?.steps?.at(-1)?.id === "click", "save rejection is reported on the click step");
    plan.scenarios[0].steps[0].open = "/no-event"; write();
    const noDownload = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(noDownload.json?.verdict === "fail" && /did not produce a download/i.test(JSON.stringify(noDownload.json)), "missing download event is reported");
    last.click = {selector:"#button", popup:true}; write();
    const noPopup = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(noPopup.json?.verdict === "fail" && /did not produce a popup/i.test(JSON.stringify(noPopup.json)), "missing popup event is reported");
    delete last.maxSeconds;
    plan.scenarios[0].steps[0].open = "/";
    last.click = "#multiple"; write();
    const multiple = await invoke(["candidate-acceptance", "--args", args]);
    t.eq([multiple.json?.verdict, multiple.json?.scenarios?.[0]?.observed?.steps?.at(-1)?.target?.matches], ["fail", 2], "ambiguous action fails at its locator");
    last.click = "#button"; plan.scenarios[0].steps[0].open = "/writes"; write();
    const writes = await invoke(["candidate-acceptance", "--args", args]);
    const writeControls = fs.readFileSync(controls, "utf8").trim().split('\n').map(line => JSON.parse(line));
    t.eq(writes.json?.verdict, "pass", "fixture continues after routed writes");
    for (const [method, pathname, decision] of [["POST", "/api/example-write", "allowed"], ["PUT", "/api/example-write", "blocked"], ["POST", "/api/other", "blocked"]]) {
      t.ok(writeControls.some(row => row.method === method && row.target && new URL(row.target).pathname === pathname && row[decision] === true && !row[decision === "allowed" ? "blocked" : "allowed"]), `${method} ${pathname} is ${decision}`);
    }
    plan.scenarios[0].steps[0].open = "/";
    last.id = "export-report"; last.click = {selector:"#button", download:"../escape"}; write();
    const invalidDownload = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(invalidDownload.json?.status === "refused" && (invalidDownload.json?.reason ?? "").includes("Scenario actions step export-report:"), "download path refusal identifies scenario and step");
    const originalOpen = plan.scenarios[0].steps[0];
    plan.scenarios[0].steps[0] = {id:"first-input", fill:{selector:"#date", value:"test"}, expect:{selector:"#summary"}}; write();
    const invalidFirst = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(invalidFirst.json?.status === "refused" && (invalidFirst.json?.reason ?? "").includes("Scenario actions step first-input:"), "first action refusal identifies scenario and step");
    plan.scenarios[0].steps[0] = originalOpen;
    plan.scenarios[0].ready = {selector:"#summary", count:-1}; write();
    const invalidReady = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(invalidReady.json?.status === "refused" && (invalidReady.json?.reason ?? "").includes("Scenario actions:"), "readiness refusal identifies scenario");
    delete plan.scenarios[0].ready;
    last.click = {selector:"#button", popup:true, download:"download-report.csv"}; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.status, "refused", "popup and download cannot be combined");
    last.click = "#button"; plan.fixture.allowedWrites = [{method:"POST",path:"/api/../other"}]; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.status, "refused", "non-exact write path is refused");
    plan.fixture.allowedWrites = [{method:"POST",path:"/api/*"}]; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.status, "refused", "wildcard write path is refused");
    plan.fixture.allowedWrites = []; plan.scenarios[0].steps[0].open = "/diagnostics"; write();
    const blocked = await invoke(["candidate-acceptance", "--args", args]);
    t.ok(blocked.json?.scenarios?.[0]?.observed?.network?.some(row => row.kind === "blocked request" && row.method === "POST"), "undeclared write is blocked");
  });

  scenario("flow-candidate-acceptance-fixture", "run managed local fixtures with isolated browser scenarios", async t => {
    const { f, args, write, plan, calls, invoke } = fixture(t, "flow-candidate-acceptance-fixture");
    const script = path.join(f.r, "test/local-fixture.mjs");
    fs.writeFileSync(script, `import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('local'));
server.listen(0, '127.0.0.1', () => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(process.env.ZODCHI_FIXTURE_OUTPUT, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(process.env.ZODCHI_FIXTURE_OUTPUT, 'state.json'), JSON.stringify({cookies: [], origins: [{origin}]}));
  console.log('baseUrl ' + origin);
});`);
    gitOut(f.r, ["add", "--", "test/local-fixture.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Add local fixture"]);
    plan.head = gitOut(f.r, ["rev-parse", "HEAD"]).trim();
    delete plan.baseUrl; delete plan.health;
    plan.fixture = { script: "test/local-fixture.mjs", readyPrefix: "baseUrl ", storageState: "state.json" };
    plan.scenarios[0].steps.push({ id: "final", open: "/final", expect: { selector: "#summary" } });
    plan.review = "Confirm both frames";
    f.answer("visual-review", { verdict: "pass", reason: "Both frames" });
    write();
    const cut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "acceptance receipt browser:first" });
    t.eq(cut.code, 75, "stop after the first browser receipt");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await invoke(["candidate-acceptance", "--resume", id]);
    t.eq([result.code, result.json?.verdict, result.json?.scenarios?.length], [0, "pass", 2], "both managed scenarios pass");
    t.eq(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2, "each scenario launches a browser");
    t.ok(result.json.scenarios.every(s => s.head === plan.head && s.tree === result.json.tree && s.frames.length), "receipts pin checkout and frames");
    t.ok(result.json.scenarios.every(s => s.fixtureStorageState?.sha256), "generated storage state is pinned in each receipt");
    const output = (run, name, attempt = 1) => path.join(f.w.zhome, "flows", run, "acceptance", name, "fixture-attempts", String(attempt), "fixture-output");
    const stopped = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } };
    const pids = ["first", "second"].map(name => Number(fs.readFileSync(path.join(output(id, name), "pid"), "utf8")));
    t.ok(pids.every(stopped), "both fixture processes terminate after use");
    t.eq(f.steps(), ["visual-review"], "visual review runs once after replay");
    const events = fs.readFileSync(path.join(f.w.zhome, "flows", id, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const reviewFrames = events.find(e => e.kind === "intent" && e.step === "visual-review").frames;
    t.ok(result.json.scenarios[0].frames[0].sha256 !== result.json.scenarios[0].frames.at(-1).sha256, "opening and final screenshots differ");
    t.eq(reviewFrames[0], result.json.scenarios[0].frames.at(-1), "visual review receives the final managed frame");
    const gateCut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "fixture recorded before start" });
    t.eq(gateCut.code, 75, "cut before releasing the startup gate");
    const gateId = fs.readdirSync(path.join(f.w.zhome, "flows")).find(value => value !== id);
    t.ok(!fs.existsSync(path.join(output(gateId, "first"), "pid")), "fixture code cannot run before the startup signal");
    t.eq((await invoke(["candidate-acceptance", "--resume", gateId])).json?.verdict, "pass", "resume after the closed gate succeeds");
    const readinessCut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "fixture started before readiness" });
    t.eq(readinessCut.code, 75, "cut fixture startup before readiness");
    const readinessId = fs.readdirSync(path.join(f.w.zhome, "flows")).find(value => ![id, gateId].includes(value));
    const beforeCalls = fs.readFileSync(calls, "utf8").trim().split("\n").length;
    const resumed = await invoke(["candidate-acceptance", "--resume", readinessId]);
    t.eq([resumed.code, resumed.json?.verdict], [0, "pass"], "readiness interruption resumes with a fresh fixture");
    t.eq(fs.readFileSync(calls, "utf8").trim().split("\n").length - beforeCalls, 2, "each browser runs exactly once after startup interruption");
    t.ok(fs.existsSync(output(readinessId, "first", 2)), "retry uses a separate output directory");
    // A cut run must validate its checkout on resume.
    const changedCut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "acceptance receipt browser:first" });
    t.eq(changedCut.code, 75, "create a second interrupted run");
    const ids = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const changedId = ids.find(value => ![id, gateId, readinessId].includes(value));
    fs.appendFileSync(path.join(f.w.zhome, "flows", changedId, "candidate-checkout", "test", "local-fixture.mjs"), "\n// changed checkout\n");
    t.eq((await invoke(["candidate-acceptance", "--resume", changedId])).json?.verdict, "blocked", "changed checkout blocks replay");
    plan.baseUrl = "https://example.test"; write();
    t.eq((await invoke(["candidate-acceptance", "--args", args])).json?.status, "refused", "caller supplied origin is refused");
    delete plan.baseUrl;
    const external = path.join(f.w.dir, "remote-fixture.mjs");
    fs.writeFileSync(external, "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.ZODCHI_FIXTURE_OUTPUT, 'pid'), String(process.pid)); console.log('baseUrl http://example.test:80'); setInterval(() => {}, 1000);");
    plan.fixture.script = external; write();
    const invalid = await invoke(["candidate-acceptance", "--args", args]);
    t.eq(invalid.json?.verdict, "blocked", "remote readiness origin is rejected");
    const invalidPid = Number(fs.readFileSync(path.join(output(invalid.json.runId, "first"), "pid"), "utf8"));
    t.ok(stopped(invalidPid), "fixture terminates after invalid readiness");
    fs.writeFileSync(external, "throw new Error('fixture-private-secret ' + process.cwd());");
    write();
    const callsBeforeException = fs.readFileSync(calls, "utf8");
    const exception = await invoke(["candidate-acceptance", "--args", args]);
    t.eq(exception.json?.verdict, "blocked", "uncaught fixture exception blocks browser startup");
    t.eq(fs.readFileSync(calls, "utf8"), callsBeforeException, "fixture exception never launches the browser");
    const exceptionLog = fs.readFileSync(path.join(output(exception.json.runId, "first"), "..", "fixture.log"), "utf8");
    t.ok(!exceptionLog.includes(external) && !exceptionLog.includes("candidate-checkout") && !exceptionLog.includes("fixture-private-secret"), "fixture log excludes exception paths and secrets");
    fs.copyFileSync(script, external);
    write();
    const stateCut = await invoke(["candidate-acceptance", "--args", args], { ZODCHI_FLOW_CUT: "acceptance receipt browser:first" });
    t.eq(stateCut.code, 75, "absolute pinned fixture produces a browser receipt");
    const stateId = fs.readdirSync(path.join(f.w.zhome, "flows")).find(value => ![id, gateId, readinessId, changedId, invalid.json.runId, exception.json.runId].includes(value));
    fs.appendFileSync(path.join(output(stateId, "first"), "state.json"), " ");
    t.eq((await invoke(["candidate-acceptance", "--resume", stateId])).json?.verdict, "blocked", "changed generated state blocks replay");
  });

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

  scenario("flow-release-acceptance-filters", "enforce release gates and compare a localized amount after applying filters", async t => {
    const { f, args, write, plan, calls, controls, invoke } = fixture(t, "flow-release-acceptance-filters");
    const stalePlan = JSON.stringify({ ...plan, health: { ...plan.health, path: "/stale" } });
    const step = plan.scenarios[0].steps[0];
    step.submit = "#save";
    write();
    const refused = await invoke(["release-acceptance", "--args", args]);
    t.eq([refused.code, refused.json?.status, fs.existsSync(calls)], [2, "refused", false], "unknown actions fail the gate before launch");
    delete step.submit;

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

    fs.writeFileSync(args, stalePlan);
    const stale = await invoke(["release-acceptance", "--args", args]);
    t.eq([stale.code, stale.json?.verdict, stale.json?.scenarios[0]?.observed.steps.length], [2, "fail", 0], "the SHA guard runs before opening the product page");
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
