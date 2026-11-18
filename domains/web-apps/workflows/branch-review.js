export const meta = {
  name: 'branch-review',
  description: 'Independent review of a finished branch before release: the reviewer reads the change in the checkout through the gateway, and an architect reviews it too when it moves boundaries, contracts, storage or authority',
  whenToUse: 'A branch or PR is finished and needs a review by a model that did not write it. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the role table, the limits and the change', model: 'haiku' },
    { title: 'Review', detail: 'checkout review (and architecture review) through the gateway', model: 'haiku' },
  ],
}

// args:
//   label      short name, also the prefix of the gateway keys
//   repo       repository (absolute path), checked out on the branch to review
//   base       the commit or branch the change starts from, e.g. "origin/main"
//   tmp        folder for prompts and reviews (absolute)
//   author     the models that wrote the change, e.g. ["claude/sonnet"] or ["codex/gpt-6.2-sol"]; the reviewer is never one of them
//   brief      optional: path of the brief or PR description the change must meet
//   architecture  true when the change moves module boundaries, contracts, storage or authority
//   models     optional role table entries for this run
const a = args || {}
for (const k of ['label', 'repo', 'base', 'tmp', 'author']) if (!a[k]) throw new Error(`branch-review needs args.${k}`)
const authors = new Set([].concat(a.author))
// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
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

// What a step that meets a gateway job ending "unknown" hands back (never a new key: the request may already have run).
const UNKNOWN_RETURN = "return gateway \"unknown\" with unknownKey set to the active key and infra set to the job's error"
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nShell rule: run every command with bash (Git Bash on Windows, never PowerShell or cmd); the quoting in these commands is for bash. Resume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `For a gateway call it records as submitted, wait on the latest key recorded for that call in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "failed" and \`zodchi job --key <key>\` shows turnRequestedAt and turnStartedAt both null or missing (the request was never sent), submit again under the next suffix of the base key (<base>-r2, then <base>-r3; at most 2 retries in all, those already recorded counted) and record the new key and that evidence in the progress file; ` +
  `if it is final with status "unknown", never submit again and never wait on it: the request may already have run. Write "UNKNOWN: key <key>: <the job's error>" as the last line of the progress file instead of DONE and ${UNKNOWN_RETURN}. ` +
  `After each finished step append one line to it (create the folder if needed). When your whole task is finished, append a last line DONE.`, opts)

// The gate helper (core/scripts/gate.mjs) is looked up in the plugin copy the session loaded, never in a checkout: the bootstrap below
// (the same text in every workflow that uses the helper; the e2e suite checks they are equal) takes the copy from $ZODCHI_PLUGIN_ROOT,
// $CLAUDE_PLUGIN_ROOT or the install Claude Code's registration names for zodchi-core, and runs scripts/gate.mjs there.
// It prints one line of JSON; its exit code is 0 when that line is the answer, 3 when the copy's api differs from GATE_API, 4 when no copy
// has the helper. The workflow reads the line and decides.
const GATE_API = 1
const GATE_BOOT = 'const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\"),cp=require(\"child_process\");const project=process.argv[1]||\"\";const rest=process.argv.slice(2);const out=(o,c)=>{fs.writeSync(1,JSON.stringify(o)+\"\\n\");process.exit(c)};const rd=f=>{try{return JSON.parse(fs.readFileSync(f,\"utf8\"))}catch(e){return null}};const nm=p=>{const s=path.resolve(p).split(path.sep).join(\"/\");return process.platform===\"linux\"?s:s.toLowerCase()};const pre=n=>n.endsWith(\"/\")?n:n+\"/\";const tried=[];let root=\"\",via=\"\";const fail=(why)=>out({ok:false,api:0,error:why,tried},4);for(const name of [\"ZODCHI_PLUGIN_ROOT\",\"CLAUDE_PLUGIN_ROOT\"]){const env=process.env[name];if(root||!env)continue;const m=rd(path.join(env,\".claude-plugin\",\"plugin.json\"));if(m&&m.name===\"zodchi-core\"){root=env;via=name}else if(name===\"ZODCHI_PLUGIN_ROOT\"){tried.push(env+\" (no zodchi-core manifest)\");fail(\"ZODCHI_PLUGIN_ROOT names no zodchi-core plugin copy: a checkout or another folder is never used instead\")}}if(!root){const reg=rd(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),\".claude\"),\"plugins\",\"installed_plugins.json\"));const list=(reg&&reg.plugins&&reg.plugins[\"zodchi-core@zodchi\"])||[];const here=pre(nm(project));const own=list.filter(e=>e.projectPath&&here.startsWith(pre(nm(e.projectPath)))).sort((a,b)=>nm(b.projectPath).length-nm(a.projectPath).length);const e=own[0]||list.find(e=>!e.projectPath);if(e&&e.installPath){root=e.installPath;via=\"installed_plugins.json, scope \"+e.scope}}if(!root)fail(\"no zodchi-core plugin copy is registered for the project this session runs in (not installed): update the plugin; a checkout is never used instead\");const ok=fs.existsSync(path.join(root,\"scripts\",\"gate.mjs\"));tried.push(root+(ok?\"\":\" (no scripts/gate.mjs)\"));if(!ok)fail(\"the zodchi-core plugin copy this session loaded (\"+root+\") has no scripts/gate.mjs (an older copy than this workflow): update the plugin; no other copy is tried and a checkout is never used\");const r=cp.spawnSync(process.execPath,[path.join(root,\"scripts\",\"gate.mjs\"),...rest],{stdio:\"inherit\",env:{...process.env,ZODCHI_GATE_VIA:via}});process.exit(r.status===null?5:r.status)'
// The folder the runner starts in is the project the session runs in: it says which registered plugin copy the session loaded (the Windows form of the path on Git Bash).
const SESSION_PROJECT = '"$(pwd -W 2>/dev/null || pwd)"'
const helperRun = (command, spec) => `${a.pluginRoot ? `ZODCHI_PLUGIN_ROOT=${q(a.pluginRoot)} ` : ''}node -e ${q(GATE_BOOT)} -- ${SESSION_PROJECT} ${command} ${q(JSON.stringify({ api: GATE_API, ...spec }))}`
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
const gateAnswer = await step(
  `Run ONE command and return what it printed; change nothing and run nothing else. In the foreground, once:\n${helperRun('branch-review', { repo: a.repo, base: a.base, want: ['reviewer', 'architect'] })}\n` +
  `Do not change, split or rerun it with other options. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label: `gate ${a.label}`, schema: HELPER_ANSWER })
const gateRead = readHelper(gateAnswer, 'the gate helper')
if (gateRead.error) return { stoppedAt: `gate (${gateRead.error})`, next: HELPER_NEXT }
const gate = gateRead.facts
// Which plugin copy the helper came from: named in every result.
const pluginCopy = { path: gate.plugin.root, commit: gate.plugin.commit || 'unknown', version: gate.plugin.version || '', via: gate.plugin.via || '' }
if (!/^[0-9a-f]{40}$/.test(gate.head) || !/^[0-9a-f]{40}$/.test(gate.baseSha)) return { stoppedAt: 'gate', error: `no commit hashes (head ${gate.head}, base ${gate.baseSha}${gate.baseError ? `: ${gate.baseError}` : ''})`, pluginCopy }
const range = `${gate.baseSha} ${gate.head}`
if (!gate.files.length) return { refused: `No change between ${a.base} and ${gate.head}.`, pluginCopy }

for (const e of gate.modelsErrors || []) log(`${e}; ignored`)
const table = { ...(gate.roles || {}), ...(a.models || {}) }
const acc = gate.account && typeof gate.account === 'object' ? gate.account : null
const used = (w) => (w && typeof w.usedPercent === 'number') ? w.usedPercent : 0
const codexOk = Boolean(acc && acc.connected && acc.ordinaryUsageAllowed !== false && used(acc.primary) < 100 && used(acc.secondary) < 100)
if (!codexOk) log(`Codex candidates are not available: ${acc ? 'the subscription has no limit left or is not connected' : `the quota is unknown, zodchi account gave no answer (${gate.accountError || 'no output'})`}`)
// A branch review reads the checkout, so only gateway (codex) candidates qualify here; a Claude reviewer is a separate session.
const pick = (role) => ((table[role] || {}).candidates || []).find(c => c.provider === 'codex' && codexOk && !authors.has(`${c.provider}/${c.model}`))
const reviewer = pick('reviewer')
const architect = a.architecture ? pick('architect') : null
if (!reviewer) return { refused: `No gateway reviewer available that is not an author (${[...authors].join(', ')}); codex ${codexOk ? 'available' : 'unavailable'}.` }
if (a.architecture && !architect) return { refused: 'No gateway architect available that is not an author.' }
if (gate.dirty) log('The checkout has uncommitted changes: the review reads the recorded head commit only.')

const REVIEW = {
  type: 'object', required: ['verdict', 'findings', 'gateway', 'infra'],
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested', 'blocked', 'missing'] }, summary: { type: 'string' }, reviewFile: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } }, blocking: { type: 'number' },
    // gateway: "final" when the job reached a final status other than unknown (infra is then ""); "unknown": the job ended unknown, its
    // key is unknownKey and nothing is submitted again; "failed": no usable job, infra says what happened
    gateway: { type: 'string', enum: ['final', 'failed', 'unknown'] }, infra: { type: 'string' }, unknownKey: { type: 'string' },
  },
}
// The change under review is the range baseSha..head, saved as a diff and attached for both reviewers: the checkout may have moved
// on (another head, uncommitted work), and neither the range nor the files are read from it but by commit.
const ask = (role, who, tag) => step(
  `Get an independent ${role} through the gateway. Work from ${a.repo}. Write ${a.tmp}/${tag}.md: ` +
  `the change is exactly the commits ${gate.baseSha}..${gate.head} over these files: ${JSON.stringify(gate.files)}; the attached diff ${a.tmp}/${tag}.diff is that change and nothing else. ` +
  `Files are read as of the commit with \`git show ${gate.head}:<file>\` (and the consumers around them), never from the working tree, which may have moved on and is not part of the change. ` +
  `${a.brief ? `What it must meet: the attached brief ${a.brief}. ` : ''}${gate.dirty ? 'Uncommitted changes in the checkout are not part of the change. ' : ''}` +
  `Say in the file that a required input that cannot be read (a file of the range, the brief) makes the verdict "blocked", naming it. ` +
  `First save \`git diff ${range} -- <the files above>\` as ${a.tmp}/${tag}.diff. ` +
  `Then ` +
  gatewayCall({
    role: role === 'architecture review' ? 'architecture-review' : 'checkout-review', key: `${a.label}-${tag}`, totalMin: 55, out: `${a.tmp}/${tag}.json`,
    args: `--model ${who.model} --effort ${who.effort} --prompt ${q(`${a.tmp}/${tag}.md`)}`,
    attach: [...(a.brief ? [a.brief] : []), `${a.tmp}/${tag}.diff`],
  }) + ` ` +
  `verdict: the "verdict" field of the review exactly ("missing" when it has none). summary: its summary. findings: the reviewer's findings only, each as "<id> <severity> <location>: <problem>". blocking: the count of the important ones only. reviewFile: the review file path. Change no code. ` +
  `gateway: "final" when the job reached a final status other than "unknown", and then infra is "". "unknown" when it ended unknown (unknownKey: the active key, infra: the job's error; nothing is submitted again). Otherwise "failed", infra saying what happened.`,
  { agentType: 'zodchi-core:runner', schema: REVIEW, phase: 'Review', label: tag })

phase('Review')
const [review, arch] = await parallel([
  () => ask('code review', reviewer, 'review'),
  ...(architect ? [() => ask('architecture review', architect, 'architecture')] : []),
])
const result = {
  label: a.label, base: gate.baseSha, head: gate.head, files: gate.files, models: { reviewer, architect },
  review, architecture: arch || null, pluginCopy,
}
// A review whose gateway job ended unknown may already have run: it is not asked again, the person decides.
const unknownOnes = [['review', review], ['architecture', arch]].filter(([, r]) => r && r.gateway === 'unknown')
if (unknownOnes.length) {
  return {
    ...result, approved: false, stoppedAt: `unknown outcome at ${unknownOnes.map(([t]) => t).join(', ')}`,
    unknown: unknownOnes.map(([tag, r]) => ({ step: tag, key: r.unknownKey || '(not named: read the progress file of the step)', reason: r.infra || 'the gateway job ended unknown' })),
    next: 'The model call of the step above may already have run and used the subscription; it was not asked again. Look at it first (`zodchi job --key <key>` and its output file), then decide: take its result, or pay for it once more by running branch-review again under a new label (the same label would reuse the key of the job that ended unknown).',
  }
}
const infraOnes = [['review', review], ['architecture', arch]].filter(([tag, r]) => (tag === 'review' || architect) && (!r || r.gateway !== 'final'))
if (infraOnes.length) return { ...result, approved: false, stoppedAt: `infrastructure at ${infraOnes.map(([t]) => t).join(', ')}`, next: 'The gateway gave no usable review (see infra of each); fix the cause and run again.' }
return {
  ...result,
  // Approval is the reviewers' explicit verdict, never an empty findings list.
  approved: Boolean(review && review.verdict === 'approved' && (!architect || (arch && arch.verdict === 'approved'))),
  next: 'Close the findings with the author (code-package with the same brief), then run branch-review again. Release only with an approved review.',
}
