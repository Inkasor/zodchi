export const meta = {
  name: 'asset-round',
  description: 'One round of a kit asset: ledger gate, change, fast check, show export, Unity import, frames, rubric, ledger row',
  whenToUse: 'A round of stage 1 or 2 of an asset (see the asset stages in the gamedev-unity README). It refuses to run when the owner has not judged the previous round or the stop rule is reached. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the ledger: method, last verdict, rounds without acceptance', model: 'haiku' },
    { title: 'Apply', detail: 'applier puts a one-pass expert answer into the files', model: 'haiku' },
    { title: 'Change', detail: 'coder implements the change brief', model: 'sonnet' },
    { title: 'Check', detail: 'runner runs the fast check', model: 'haiku' },
    { title: 'Export', detail: 'runner runs the show export in Blender', model: 'haiku' },
    { title: 'Engine', detail: 'runner imports into Unity and captures frames', model: 'haiku' },
    { title: 'Rubric', detail: 'runner asks the Decisions rubric about each frame', model: 'haiku' },
    { title: 'Record', detail: 'runner appends the round to the ledger', model: 'haiku' },
  ],
}

// args:
//   ledger   docs/assets/<asset>.ledger.json (absolute)
//   label    short name of the round, e.g. "spruce-r3"
//   stage    1 (blockout) or 2 (look)
//   tmp      folder for logs and frames of this round (absolute)
//   answer   optional: { file, targets: [paths], backup, protect: [strings] } - a one-pass expert answer (hard package) for the applier
//   change   optional: { brief: path of the change brief, hard: bool, ranCheck: bool } - the coder writes and runs
//            the change; ranCheck: the brief makes the coder run the fast check itself, so the Check phase is skipped
//            when the coder returns evidence: the exact check command, exit code 0 and its log
//   check    optional: { command, cwd } - the FAST check (seconds)
//   export   optional: { command, cwd, out, expect } - the show export (Blender); expect: what must exist
//            afterwards, in words (default: an .fbx in <out>/candidate or <out>/release; a blockout names its own)
//   unity    optional: { project, menus: [menu paths], cameras: [{ menu, file }], generatedScene }
//            generatedScene: path of a scene that the menus rebuild (the look-dev stand); when it is the
//            dirty open scene it is saved before the menus, since nothing in it is hand-made
//   rubric   optional: { role, repo }
//   summary  one line: what this round changes, for the ledger
//   accepted the word an owner verdict starts with when the asset is accepted, default "accepted"
const a = args || {}
for (const k of ['ledger', 'label', 'stage', 'tmp', 'summary']) if (!a[k]) throw new Error(`asset-round needs args.${k}`)
// Every command in these prompts is POSIX shell, run with bash. q() quotes one argument for it: single quotes, with a
// quote inside written as ''' - no expansion of $, backticks or globs.
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

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' }, summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    paths: { type: 'array', items: { type: 'string' } },
  },
}
const CHANGE = {
  ...STEP,
  properties: { ...STEP.properties, checkRun: { type: 'object', properties: { command: { type: 'string' }, exitCode: { type: 'number' }, log: { type: 'string' } } } },
}
// A rubric step also says when a gateway job ended unknown: its key, and nothing was submitted again.
const RUBRIC = { ...STEP, properties: { ...STEP.properties, unknownKey: { type: 'string' } } }
const out = { label: a.label, stoppedAt: null }
const accepted = a.accepted || 'accepted'

// The gate helper (core/scripts/gate.mjs) is looked up in the plugin copy the session loaded, never in a checkout: the bootstrap below
// (the same text in every workflow that uses the helper; the e2e suite checks they are equal) takes the copy from $ZODCHI_PLUGIN_ROOT,
// $CLAUDE_PLUGIN_ROOT or the install Claude Code's registration names for zodchi-core, and runs scripts/gate.mjs there.
// It prints one line of JSON; its exit code is 0 when that line is the answer, 3 when the copy's api differs from GATE_API, 4 when no copy
// has the helper. The workflow reads the line and decides.
const GATE_API = 1
const GATE_BOOT = 'const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\"),cp=require(\"child_process\");const [repo,...rest]=process.argv.slice(1);const out=(o,c)=>{fs.writeSync(1,JSON.stringify(o)+\"\\n\");process.exit(c)};const rd=f=>{try{return JSON.parse(fs.readFileSync(f,\"utf8\"))}catch(e){return null}};const eq=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();const tried=[];let root=\"\",via=\"\";const has=d=>{const ok=fs.existsSync(path.join(d,\"scripts\",\"gate.mjs\"));tried.push(d+(ok?\"\":\" (no scripts/gate.mjs)\"));return ok};for(const [name,env] of [[\"ZODCHI_PLUGIN_ROOT\",process.env.ZODCHI_PLUGIN_ROOT],[\"CLAUDE_PLUGIN_ROOT\",process.env.CLAUDE_PLUGIN_ROOT]]){if(!root&&env){const m=rd(path.join(env,\".claude-plugin\",\"plugin.json\"));if(m&&m.name===\"zodchi-core\"&&has(env)){root=env;via=name}}}if(!root){const reg=rd(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),\".claude\"),\"plugins\",\"installed_plugins.json\"));const list=(reg&&reg.plugins&&reg.plugins[\"zodchi-core@zodchi\"])||[];for(const e of [...list.filter(e=>e.projectPath&&eq(e.projectPath,repo)),...list.filter(e=>!e.projectPath)]){if(e.installPath&&has(e.installPath)){root=e.installPath;via=\"installed_plugins.json, scope \"+e.scope;break}}}if(!root)out({ok:false,api:0,error:\"the registered zodchi-core plugin copy has no scripts/gate.mjs (not installed, or an older copy than this workflow): update the plugin; a checkout is never used instead\",tried},4);const r=cp.spawnSync(process.execPath,[path.join(root,\"scripts\",\"gate.mjs\"),...rest],{stdio:\"inherit\",env:{...process.env,ZODCHI_GATE_VIA:via}});process.exit(r.status===null?5:r.status)'
const helperRun = (command, spec) => `${a.pluginRoot ? `ZODCHI_PLUGIN_ROOT=${q(a.pluginRoot)} ` : ''}node -e ${q(GATE_BOOT)} -- ${q((a.rubric && a.rubric.repo) || a.tmp)} ${command} ${q(JSON.stringify({ api: GATE_API, ...spec }))}`
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

phase('Gate')
// The ledger is read by the helper, which applies the rules of the gate (stage 2 reads "lookMethod" where stage 1 reads "method"); the
// runner returns what it printed.
const gateAnswer = await step(
  `Run ONE command and return what it printed; change nothing and run nothing else. In the foreground, once:\n${helperRun('ledger', { file: a.ledger, stage: a.stage, accepted })}\n` +
  `Do not change, split or rerun it with other options. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label: `gate ${a.label}`, schema: HELPER_ANSWER })
const gateRead = readHelper(gateAnswer, 'the gate helper')
if (gateRead.error) { out.stoppedAt = `gate (${gateRead.error})`; out.next = HELPER_NEXT; return out }
const { plugin, ...gate } = gateRead.facts
// Which plugin copy the helper came from: named in every result.
out.pluginCopy = { path: plugin.root, commit: plugin.commit || 'unknown', version: plugin.version || '', via: plugin.via || '' }
out.gate = gate
if (!gate.hasMethod) { out.refused = 'No method in the ledger: stage 0 (method-question and the owner\'s choice) comes first.'; return out }
if (gate.lastRound > 0 && !gate.lastVerdict) { out.refused = `The owner has not given a verdict on round ${gate.lastRound}: show it to them before another round.`; return out }
if (!gate.accepted && gate.roundsSinceMethod >= 3) { out.refused = `Stop rule: ${gate.roundsSinceMethod} rounds since the method was chosen without "${accepted}". A new method-question and the owner's choice reopen the asset.`; return out }
const n = gate.lastRound + 1
const stop = async (at) => { out.stoppedAt = at; await record(false); return out }

async function record(reachedEngine) {
  phase('Record')
  const row = {
    n, label: a.label, stage: a.stage, change: a.summary, startedAt: gate.startedAt,
    stoppedAt: out.stoppedAt, frames: (out.engine && out.engine.paths) || [],
    rubric: out.rubric ? { ok: out.rubric.ok, notPassed: out.rubric.failures || [] } : null,
    owner: null,
  }
  out.recorded = await step(
    `Append one round to the "rounds" array of the ledger ${a.ledger} (JSON; keep every other field and the file's formatting style, 1-space indent). ` +
    `The row, as given, plus two fields you add: "finishedAt" = \`date -u +%Y-%m-%dT%H:%M:%SZ\` now, and "minutes" = whole minutes between startedAt and finishedAt. Row: ${JSON.stringify(row)}. ` +
    `Leave "owner" null: only the lead writes the owner's verdict. Then read the file back and confirm it parses. ok is true when it does and the last round has n = ${n}.`,
    { agentType: 'zodchi-gamedev-unity:unity-runner', schema: STEP, label: `record ${a.label}` })
  out.reachedEngine = reachedEngine
}

if (a.answer) {
  phase('Apply')
  out.apply = await step(
    `Apply one expert answer. Answer file: ${a.answer.file}. Target files: ${a.answer.targets.join(', ')}. Ledger of edits: ${a.tmp}/apply-ledger.md. Backup folder: ${a.answer.backup}. ` +
    `These must survive every edit; stop at the row that would remove one: ${JSON.stringify(a.answer.protect || [])}. ` +
    `Checks after applying: python -m pyflakes on each Python target and \`file\` on each target against its backup. ` +
    `The success flag of this step is "ok" (the field of the result), not "done": it is true only when every edit row has a line number and the checks are clean. failures: rows not applied.`,
    { agentType: 'zodchi-core:applier', schema: STEP, label: `apply ${a.label}` })
  if (!out.apply || !out.apply.ok) return stop('apply')
}

if (a.change) {
  phase('Change')
  out.change = await step(
    `Implement the change described in ${a.change.brief}; it is the whole task. Round ${a.label}, stage ${a.stage} of the asset (before acceptance only triangles, texture memory and frame time gate). ` +
    `ok is true when what the brief calls done holds. paths: files changed. failures: what is unverified.` +
    (a.change.ranCheck && a.check ? ` After the change run the fast check yourself from ${a.check.cwd}: \`${a.check.command}\`, output to ${a.tmp}/logs/check-by-coder.log; checkRun: that command as you ran it, its exit code and the log path.` : ''),
    { agentType: 'zodchi-core:coder', model: a.change.hard ? 'opus' : 'sonnet', schema: CHANGE, label: `change ${a.label}` })
  if (!out.change || !out.change.ok) return stop('change')
}

// The coder's own check counts only with evidence: the same command, exit code 0, a log.
const coderChecked = Boolean(a.check && out.change && out.change.checkRun && out.change.checkRun.exitCode === 0 &&
  out.change.checkRun.log && String(out.change.checkRun.command).trim() === String(a.check.command).trim())
if (a.check && !coderChecked) {
  phase('Check')
  out.check = await step(
    `Run the fast check of round ${a.label}, once, from ${a.check.cwd}: \`${a.check.command}\`; output to ${a.tmp}/logs/check.log. ` +
    `ok is true when it exits 0. summary: its result line. failures: failure lines grouped by kind with the worst value against the limit (at most 15).`,
    { agentType: 'zodchi-gamedev-unity:unity-runner', schema: STEP, label: `check ${a.label}` })
  if (!out.check || !out.check.ok) return stop('check')
}

if (a.export) {
  phase('Export')
  out.export = await step(
    `Run the show export of round ${a.label}, once, from ${a.export.cwd}: \`${a.export.command}\`. It starts Blender; give the command up to 40 minutes. When the kit's launcher waits for a shared Blender turn itself, do not wait or kill anything yourself; otherwise follow your one-Blender rule. ` +
    `Your log: ${a.tmp}/logs/export.log. ok is true when it exits 0 and ${a.export.expect || `${a.export.out}/candidate or ${a.export.out}/release holds an .fbx`}. paths: files written. failures: last error lines.`,
    { agentType: 'zodchi-gamedev-unity:unity-runner', schema: STEP, label: `export ${a.label}` })
  if (!out.export || !out.export.ok) return stop('export')
}

if (a.unity) {
  phase('Engine')
  const cams = (a.unity.cameras || []).map(c => `menu "${c.menu}" then capture the game view to ${a.tmp}/${c.file} (1280x720)`).join('; ')
  out.engine = await step(
    `Unity Editor operations for round ${a.label}, project ${a.unity.project}. Open the Editor on the project when none has it open, and wait for ready. ` +
    `${a.unity.generatedScene ? `If the open scene is ${a.unity.generatedScene} and it is dirty, save it (the menus rebuild it; nothing in it is hand-made). ` : ''}` +
    `A dirty scene other than that one, or Play mode you did not start, belongs to someone else: stop with ok false and say so. ` +
    `First AssetDatabase.Refresh, wait for ready, confirm the Console has no compile errors. Then these menus in order, waiting for ready after each: ${JSON.stringify(a.unity.menus)}. ` +
    `Then for each camera: ${cams}. Stay out of Play mode; save no other scene. ` +
    `ok is true when the Console has no errors after the menus and every capture exists. paths: the capture files only. failures: Console errors.`,
    { agentType: 'zodchi-gamedev-unity:unity-runner', schema: STEP, label: `engine ${a.label}` })
  if (!out.engine || !out.engine.ok) return stop('engine')
}

if (a.rubric && out.engine && (out.engine.paths || []).length) {
  phase('Rubric')
  out.rubric = await step(
    `Ask the Decisions rubric "${a.rubric.role}" about each frame: ${JSON.stringify(out.engine.paths)}. From ${a.rubric.repo}, for frame N write a one-line prompt file in ${a.tmp} naming its camera and "${a.label}", then run ` +
    `for each frame, ` + gatewayCall({ role: a.rubric.role, key: `${a.label}-rubric-N`, totalMin: 20, out: `${a.tmp}/rubric-N.json`, args: `--prompt <prompt file> --image <frame> --paid`, repo: a.rubric.repo }) + ` ` +
    `If the job of a frame ends unknown, ask no further frame. ok is true only when every frame's verdict.outcome is "pass". summary: outcome per frame and total input tokens. failures: "<frame>: <question> <outcome> <agreement>" for every question that is not pass.`,
    { agentType: 'zodchi-gamedev-unity:unity-runner', schema: RUBRIC, label: `rubric ${a.label}` })
  // A paid call that ended unknown may already have run: the remaining frames are not asked and nothing is submitted again.
  if (out.rubric && out.rubric.unknownKey) {
    out.unknown = { step: 'rubric', key: out.rubric.unknownKey, reason: out.rubric.summary || 'the gateway job ended unknown' }
    out.next = `The Decisions call with the key ${out.rubric.unknownKey} may already have run and used the subscription; it was not asked again. Look at it first (zodchi job --key ${out.rubric.unknownKey}), then decide: take its result, or pay once more with a new label.`
    return stop(`unknown outcome at rubric (key ${out.rubric.unknownKey})`)
  }
}

await record(Boolean(out.engine))
out.next = 'Show the frames to the owner and write their verdict into the "owner" field of this round: the next round will not start without it.'
return out
