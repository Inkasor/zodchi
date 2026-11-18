export const meta = {
  name: 'rubric-probe',
  description: 'Probe a Decisions rubric on frames with a known defect and frames known to be sound, and say which questions tell them apart',
  whenToUse: 'After adding or rewording a rubric question. Args: { role, repo, label, tmp, frames: [{ file, note, sound: bool, defects: [question names expected to fail] }] }.',
  phases: [
    { title: 'Ask', detail: 'one Decisions call per frame', model: 'haiku' },
  ],
}

const a = args || {}
for (const k of ['role', 'repo', 'label', 'tmp', 'frames']) if (!a[k]) throw new Error(`rubric-probe needs args.${k}`)
// Every command in these prompts is POSIX shell, run with bash. q() quotes one argument for it: single quotes, with a
// quote inside written as ''' - no expansion of $, backticks or globs.
// norm() makes a frame path comparable: slash direction and edges only. Frames are matched by this exact identity, never by a suffix.
const norm = (s) => String(s).trim().replace(/[\\]/g, '/')
const frameOf = (file) => a.frames.find(f => norm(f.file) === norm(file))
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One gateway call, worded once for every step that makes one. The shell of a step has its own time limit and the
// worker of a job can end with the shell that started it, so the wait is made of foreground calls of 540 seconds.
// attach: the files the request must carry, listed by the workflow; attachIfExists: files attached only when they exist.
const gatewayCall = ({ role, key, args, attach = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const flags = [...attach, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, base key ${key}. Run it in the foreground from ${repo}: \`${run}\`. ` +
    (attachIfExists.length ? `Before every submission, retries included, drop the --attach of each optional file that does not exist on disk: ${JSON.stringify(attachIfExists)}; keep every other --attach. ` : '') +
    `The gateway refuses a request over 512 KB (prompt plus attachments). Before every submission, first remove a "Not attached for size" line left by an earlier attempt from the prompt file, then add up the size of the prompt file and of every file you attach. While the sum is over 500 KB and an optional file is still attached${attachIfExists.length ? ` (optional: ${JSON.stringify(attachIfExists)})` : ' (there are none here)'}, drop the largest optional one (never a required one) and add its name to one line at the end of the prompt file, "Not attached for size: <names>"; then count again, the prompt included. If the sum is still over 500 KB with no optional file left, do not submit: report that as the infrastructure failure. ` +
    `Never in the background (no &, nohup or run_in_background), never through Monitor: the worker of the job ends with your shell. ` +
    `The active key is the key of the latest submission: ${key} at first, then ${key}-r2, then ${key}-r3 (at most 2 retries in all). Every wait, \`zodchi job\` and request.json check below names the active key, never an earlier one, also after a resume (the progress file holds the latest key). ` +
    `While it exits 3 (still running), repeat \`zodchi wait --key <active key> --wait-sec 540 --out ${q(out)}\` in the foreground, up to ${totalMin} minutes in all since the first command; ` +
    `never return before the job is final (exit 0 or 2); if the ${totalMin} minutes run out, report failure (ok false; verdict "missing" for a review) and say the job still runs under its active key. ` +
    `A job gets a new key only with evidence that the request was never sent: it is final with status "failed" and \`zodchi job --key <active key>\` shows turnRequestedAt and turnStartedAt both null or missing (the gateway never asked for the model turn). ` +
    `Then run the same full command again with --key set to the next key, wait for it the same way, and write each new key into the progress file at once, with that evidence (the two fields and the job's error). ` +
    `A job that is final with status "unknown" never gets a new key and is never waited on again: the request may already have run and used the subscription. Stop at once: ` +
    `write the line "UNKNOWN: key <active key>: <the job's error>" to the progress file as its last line instead of DONE, and ${UNKNOWN_RETURN}. ` +
    `Any other final status, a "failed" job whose turnRequestedAt is set included, is not retried: report it. ` +
    (attach.length || attachIfExists.length
      ? `After the job is final, read ${repo}/.agent-tmp/gateway/<active key>/request.json: its "prompt" must contain \`<attachment path="...">\` (the path as given to --attach, slash direction aside) for every required attachment: ${JSON.stringify(attach)}` +
        `${attachIfExists.length ? `, and for each of these that exists on disk: ${JSON.stringify(attachIfExists)}` : ''}. ` +
        `If one is missing, put "attachment missing: <path>" into your summary and run the full command again with the next key (counted with the retries), every attachment included, then check that new job's request.json the same way; the result you return is that of the last job, and when an attachment is still missing after the last retry it reports failure the same way.`
      : '')
}

// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the run is
// resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
// What a step that meets a gateway job ending "unknown" hands back (never a new key: the request may already have run).
const UNKNOWN_RETURN = "return ok false with unknownKey set to the active key and summary \"UNKNOWN: key <active key>: <the job's error>\""
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `do not redo finished work or overwrite its outputs blindly. For a gateway call it records as submitted, wait on the latest key recorded for that call in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "failed" and \`zodchi job --key <key>\` shows turnRequestedAt and turnStartedAt both null or missing (the request was never sent), submit again under the next suffix of the base key (<base>-r2, then <base>-r3; at most 2 retries in all, those already recorded counted) and record the new key and that evidence in the progress file; ` +
  `if it is final with status "unknown", never submit again and never wait on it: the request may already have run. Write "UNKNOWN: key <key>: <the job's error>" as the last line of the progress file instead of DONE and ${UNKNOWN_RETURN}. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

// Which plugin copy ran. A workflow script cannot see its own file, so one cheap runner step runs the "plugin" command of the gate helper
// (core/scripts/gate.mjs), which the bootstrap below finds in the plugin copy the session loaded (never in a checkout), and the result names
// that copy. The bootstrap is the same text in every workflow that runs the helper (the e2e suite checks they are equal).
const GATE_API = 1
const GATE_BOOT = 'const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\"),cp=require(\"child_process\");const [repo,...rest]=process.argv.slice(1);const out=(o,c)=>{fs.writeSync(1,JSON.stringify(o)+\"\\n\");process.exit(c)};const rd=f=>{try{return JSON.parse(fs.readFileSync(f,\"utf8\"))}catch(e){return null}};const eq=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();const tried=[];let root=\"\",via=\"\";const has=d=>{const ok=fs.existsSync(path.join(d,\"scripts\",\"gate.mjs\"));tried.push(d+(ok?\"\":\" (no scripts/gate.mjs)\"));return ok};for(const [name,env] of [[\"ZODCHI_PLUGIN_ROOT\",process.env.ZODCHI_PLUGIN_ROOT],[\"CLAUDE_PLUGIN_ROOT\",process.env.CLAUDE_PLUGIN_ROOT]]){if(!root&&env){const m=rd(path.join(env,\".claude-plugin\",\"plugin.json\"));if(m&&m.name===\"zodchi-core\"&&has(env)){root=env;via=name}}}if(!root){const reg=rd(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),\".claude\"),\"plugins\",\"installed_plugins.json\"));const list=(reg&&reg.plugins&&reg.plugins[\"zodchi-core@zodchi\"])||[];for(const e of [...list.filter(e=>e.projectPath&&eq(e.projectPath,repo)),...list.filter(e=>!e.projectPath)]){if(e.installPath&&has(e.installPath)){root=e.installPath;via=\"installed_plugins.json, scope \"+e.scope;break}}}if(!root)out({ok:false,api:0,error:\"the registered zodchi-core plugin copy has no scripts/gate.mjs (not installed, or an older copy than this workflow): update the plugin; a checkout is never used instead\",tried},4);const r=cp.spawnSync(process.execPath,[path.join(root,\"scripts\",\"gate.mjs\"),...rest],{stdio:\"inherit\",env:{...process.env,ZODCHI_GATE_VIA:via}});process.exit(r.status===null?5:r.status)'
const helperRun = (command, spec) => `${a.pluginRoot ? `ZODCHI_PLUGIN_ROOT=${q(a.pluginRoot)} ` : ''}node -e ${q(GATE_BOOT)} -- ${q(a.repo || a.tmp)} ${command} ${q(JSON.stringify({ api: GATE_API, ...spec }))}`
const HELPER_ANSWER = { type: 'object', required: ['exitCode', 'stdout'], properties: { exitCode: { type: 'number' }, stdout: { type: 'string' }, error: { type: 'string' } } }
const HELPER_NEXT = 'Update the zodchi-core plugin (rerun the installer, then reload plugins in Claude Code) so that the copy this workflow runs from has scripts/gate.mjs, or pass args.pluginRoot, the folder of a zodchi-core copy that has it. Nothing was changed.'
// The helper's answer: the one JSON line of its stdout and the exit code the runner saw, both of which must say it worked.
function readHelper(r, what) {
  if (!r) return { error: `${what}: the runner returned no result` }
  const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  let facts = null
  try { facts = JSON.parse(line) } catch {}
  if (!facts || typeof facts !== 'object') return { error: `${what} printed no JSON line (exit ${r.exitCode}${r.error ? `: ${r.error}` : ''})` }
  if (r.exitCode !== 0 || facts.ok !== true) return { error: `${what}: ${facts.error || 'it reported a failure'} (exit ${r.exitCode})${Array.isArray(facts.tried) ? `; looked in ${JSON.stringify(facts.tried)}` : ''}` }
  if (facts.api !== GATE_API) return { error: `${what}: api ${facts.api}, this workflow needs ${GATE_API}` }
  if (!facts.plugin || !facts.plugin.root) return { error: `${what}: it did not name its plugin copy` }
  return { facts }
}

const copyRead = readHelper(await agent(
  `Run ONE command and return what it printed; change nothing and run nothing else. Run every command with bash (Git Bash on Windows, never PowerShell or cmd). In the foreground, once:
${helperRun('plugin', {})}
` +
  `Do not change, split or rerun it with other options. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label: 'plugin copy', schema: HELPER_ANSWER }), 'the plugin copy helper')
if (copyRead.error) return { stoppedAt: `plugin copy (${copyRead.error})`, next: HELPER_NEXT }
const pluginCopy = { path: copyRead.facts.plugin.root, commit: copyRead.facts.plugin.commit || 'unknown', version: copyRead.facts.plugin.version || '', via: copyRead.facts.plugin.via || '' }

phase('Ask')
const rows = await step(
  `Probe the Decisions rubric "${a.role}" from ${a.repo}. Frames: ${JSON.stringify(a.frames)}. ` +
  `For frame N write its "note" as a one-line prompt file in ${a.tmp}, then run ` +
  gatewayCall({ role: a.role, key: `${a.label}-probe-N`, totalMin: 20, out: `${a.tmp}/probe-N.json`, args: `--prompt <prompt file> --image <file> --paid` }) + ` ` +
  `From each output take verdict.questions (name, outcome, agreement). Return ok true with one row per question and frame, each row's "frame" being exactly the <file> string given for that frame in the Frames list (not a shortened or resolved path), and the input tokens of all calls together. ` +
  `If the job of a frame ends unknown, ask no further frame and return ok false with unknownKey set. If any frame's call fails, times out or has no verdict.questions, return ok false, rows [], inputTokens 0 and summary naming the frame and the job status. Judge nothing yourself.`,
  {
    agentType: 'zodchi-gamedev-unity:unity-runner', label: `probe ${a.role}`,
    schema: {
      type: 'object', required: ['ok', 'rows', 'inputTokens'],
      properties: {
        ok: { type: 'boolean' }, summary: { type: 'string' }, unknownKey: { type: 'string' },
        inputTokens: { type: 'number' },
        rows: { type: 'array', items: { type: 'object', required: ['frame', 'question', 'outcome'],
          properties: { frame: { type: 'string' }, question: { type: 'string' }, outcome: { type: 'string' }, agreement: { type: 'number' } } } },
      },
    },
  })
// A paid call that ended unknown may already have run: it is not asked again, the person decides.
if (rows && rows.unknownKey) return { pluginCopy, stoppedAt: 'ask (unknown outcome)', unknown: { key: rows.unknownKey, reason: rows.summary || 'the gateway job ended unknown' }, next: `The Decisions call with the key ${rows.unknownKey} may already have run and used the subscription; it was not asked again. Look at it first (zodchi job --key ${rows.unknownKey}), then decide: take its result, or pay once more by running the probe again under a new label.` }
if (!rows || !rows.ok) return { pluginCopy, stoppedAt: 'ask', error: rows ? rows.summary || 'a frame call failed' : 'the step returned nothing' }
// Every frame needs at least one row: a frame without rows is a call that did not come back whole.
const unknown = rows.rows.filter(r => !frameOf(r.frame))
if (unknown.length) return { pluginCopy, stoppedAt: 'ask', error: `rows for frames not in the input (the frame must be the exact supplied path): ${[...new Set(unknown.map(r => r.frame))].join(', ')}` }
const missing = a.frames.filter(f => !rows.rows.some(r => norm(r.frame) === norm(f.file)))
if (missing.length) return { pluginCopy, stoppedAt: 'ask', error: `no rows for frames: ${missing.map(f => f.file).join(', ')}` }

// The matrix must be whole: every question named by any row or by a frame's defects has an answer on every frame. A frame
// that was asked a question the others were not, or a question missing on one frame, is an incomplete probe: it is
// reported as such and never reaches a verdict (a partial matrix could pass every sound frame it has and read "keep").
const questions = [...new Set([...rows.rows.map(r => r.question), ...a.frames.flatMap(f => f.defects || [])])]
const unanswered = questions.flatMap(question => a.frames
  .filter(f => !rows.rows.some(r => r.question === question && norm(r.frame) === norm(f.file)))
  .map(f => `${question} @ ${f.file}`))
if (unanswered.length) return { pluginCopy, stoppedAt: 'ask', incomplete: true, error: `the matrix is incomplete, no verdict: no answer for (question @ frame) ${unanswered.join('; ')}` }

// A question earns its place when it passes on every sound frame and fails on every frame listed as having its defect.
const byQuestion = {}
for (const r of rows.rows) (byQuestion[r.question] = byQuestion[r.question] || []).push(r)
const verdicts = Object.entries(byQuestion).map(([question, rs]) => {
  const of = (file) => frameOf(file) || {}
  const sound = rs.filter(r => of(r.frame).sound)
  const defect = rs.filter(r => (of(r.frame).defects || []).includes(question))
  const passesSound = sound.length > 0 && sound.every(r => r.outcome === 'pass')
  const catches = defect.length > 0 && defect.every(r => r.outcome === 'fail')
  return {
    question,
    verdict: defect.length === 0 ? 'no defect frame for it' : sound.length === 0 ? 'no sound frame' : catches && passesSound ? 'keep' : catches ? 'catches, unsure on sound frames: reword' : 'does not catch: reword or drop',
    answers: rs.map(r => `${r.frame.split(/[\\/]/).pop()}: ${r.outcome} ${r.agreement == null ? '' : r.agreement}`),
  }
})
return { pluginCopy, role: a.role, inputTokens: rows.inputTokens, verdicts }
