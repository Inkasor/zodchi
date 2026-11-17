export const meta = {
  name: 'code-package',
  description: 'One code package: a gate resolves the role table and refuses overlapping packages, the writer implements, a runner checks, an independent reviewer reviews through the gateway, the writer closes findings; stops after 3 review rounds',
  whenToUse: 'Any code package from a finished brief. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the role table, the subscription limits, open packages and Git state', model: 'haiku' },
    { title: 'Write', detail: 'writer implements the brief (agent mode) or an expert answers and the applier applies it (expert mode)' },
    { title: 'Checks', detail: 'runner runs the checks named in the brief', model: 'haiku' },
    { title: 'Review', detail: 'reviewer (never the author) reviews the change through the gateway', model: 'haiku' },
    { title: 'Close', detail: 'the same writer closes the findings' },
  ],
}

// args:
//   label     short name, also the prefix of gateway keys and the name of the package claim, e.g. "export-csv"
//   brief     path of the brief file: goal, files that may change, what "done" means, checks
//   repo      repository the change is in (absolute path); every command runs from it
//   files     the files the lead expects to change; the gate refuses to start when another open package
//             claims one of them, and the review attaches these plus every file the writer reports changed
//   tmp       folder for prompts, logs and reviews of this package (absolute)
//   mode      "agent" (default): the writer edits the files itself. "expert": the writer answers once through
//             the gateway with the edits, and the applier puts them into the files
//   hard      true when the lead marked the package hard: the role hardWriter writes instead of writer
//   checks    run from the repo after each write; each entry is a command string (passes on exit 0)
//             or { cmd, pass } where pass says in words what success is, e.g. "prints usage, any exit code"
//   rounds    review rounds at most, default 3 (the stop rule: without approval the package returns to a human)
//   fixes     how many times a check failure caused by the code goes back to the writer, default 1
//   continuations  fresh writers that may go on after one ran out of context, default 2
//   branch    optional: Git branch for the package; created from the current HEAD when missing
//   commit    default true in a Git repository: the runner commits the package's files after each passing
//             checks run. Nothing is ever pushed
//   models    optional: role table entries that replace the table for this run, e.g. { writer: { candidates: [...] } }
const a = args || {}
for (const k of ['label', 'brief', 'repo', 'files', 'tmp']) if (!a[k]) throw new Error(`code-package needs args.${k}`)
const mode = a.mode || 'agent'
if (!['agent', 'expert'].includes(mode)) throw new Error('args.mode is "agent" or "expert"')
const rounds = a.rounds || 3

// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the
// run is resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.progress || o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `Do not redo finished work or overwrite its outputs blindly, and for a gateway call it records as submitted, wait on that key (zodchi wait --key <key>) instead of submitting again. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
}
const WRITE = {
  type: 'object', required: ['done', 'summary', 'changed'],
  properties: {
    done: { type: 'boolean' }, summary: { type: 'string' },
    changed: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
    // true: the agent stopped at a clean point with work left (its context was running out); a fresh agent goes on
    more: { type: 'boolean' },
  },
}
const CHECKS = {
  type: 'object', required: ['ok', 'results'],
  properties: {
    ok: { type: 'boolean' }, results: { type: 'array', items: { type: 'string' } },
    // code: the change is wrong; check: the command or its pass rule is wrong; environment: the machine
    // (a lock held, low memory, a missing tool). Only "code" goes back to the writer.
    cause: { type: 'string', enum: ['none', 'code', 'check', 'environment'] },
    logs: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW = {
  type: 'object', required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string' }, reviewFile: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    blocking: { type: 'number' },
  },
}

const out = { label: a.label, mode, rounds: [] }
const claimFile = `${a.repo}/.agent-tmp/zodchi/packages/${a.label}.json`

// ---------------------------------------------------------------- Gate
phase('Gate')
const gate = await step(
  `Gather facts for a code package gate; change nothing. Work from ${a.repo}. Return each file's content as a string, exactly as read, or "" when the file does not exist.\n` +
  `- homeModels: the file ~/.zodchi/models.json.\n` +
  `- repoModels: the file ${a.repo}/.zodchi/models.json.\n` +
  `- account: the output of \`zodchi account\` (JSON), or "" when the command fails; put its error into accountError.\n` +
  `- packages: the content of every *.json file in ${a.repo}/.agent-tmp/zodchi/packages/, one string per file.\n` +
  `- git: true when ${a.repo} is inside a Git work tree. head: \`git rev-parse HEAD\`. branch: \`git branch --show-current\`. ` +
  `dirty: the paths \`git status --porcelain\` lists (path only).`,
  {
    agentType: 'runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'packages', 'git'],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' }, accountError: { type: 'string' },
        packages: { type: 'array', items: { type: 'string' } },
        git: { type: 'boolean' }, head: { type: 'string' }, branch: { type: 'string' }, dirty: { type: 'array', items: { type: 'string' } },
      },
    },
  })
if (!gate) { out.stoppedAt = 'gate'; return out }

const parse = (text, what) => { if (!text || !text.trim()) return null; try { return JSON.parse(text) } catch { log(`${what} is not JSON; ignored`); return null } }
const table = { ...((parse(gate.homeModels, '~/.zodchi/models.json') || {}).roles || {}), ...((parse(gate.repoModels, '.zodchi/models.json') || {}).roles || {}), ...(a.models || {}) }
const account = parse(gate.account, 'zodchi account')
const used = (w) => (w && typeof w.usedPercent === 'number') ? w.usedPercent : 0
const codexOk = Boolean(account && account.connected && account.ordinaryUsageAllowed !== false && used(account.primary) < 100 && used(account.secondary) < 100)
if (!codexOk) log(`Codex candidates skipped: ${account ? 'the subscription has no limit left or is not connected' : `zodchi account failed (${gate.accountError || 'no output'})`}`)
const available = (c) => c.provider === 'claude' || (c.provider === 'codex' && codexOk)
const resolve = (role, exclude) => {
  const r = table[role]
  if (!r || !Array.isArray(r.candidates)) throw new Error(`Role ${role} is not in the role table (~/.zodchi/models.json, .zodchi/models.json or args.models)`)
  const pick = r.candidates.find(c => available(c) && !(exclude && c.provider === exclude.provider && c.model === exclude.model))
  if (!pick) return null
  if (pick !== r.candidates[0]) log(`Role ${role}: ${r.candidates[0].provider}/${r.candidates[0].model} is not available, took ${pick.provider}/${pick.model}`)
  return pick
}
const writerRole = mode === 'expert' ? 'expertWriter' : a.hard ? 'hardWriter' : 'writer'
const writer = resolve(writerRole)
const reviewer = resolve('reviewer', writer) // the reviewer is never the author
out.models = { [writerRole]: writer, reviewer }
if (!writer || !reviewer) { out.refused = `No available candidate for ${!writer ? writerRole : 'reviewer'} (the reviewer may not be the writer's model).`; return out }

// Another open package on the same files means merge conflicts later: refuse now and name it.
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const mine = new Set(a.files.map(norm))
const blockers = gate.packages.map(t => parse(t, 'a package claim')).filter(p => p && p.status === 'open' && p.label !== a.label)
  .map(p => ({ label: p.label, overlap: (p.files || []).filter(f => mine.has(norm(f))) })).filter(p => p.overlap.length)
if (blockers.length) { out.refused = `Open packages claim the same files: ${blockers.map(b => `${b.label} (${b.overlap.join(', ')})`).join('; ')}. Finish or close them first (status "closed" in ${a.repo}/.agent-tmp/zodchi/packages/<label>.json).`; return out }
const dirtyOverlap = (gate.dirty || []).filter(f => mine.has(norm(f)))
if (dirtyOverlap.length) { out.refused = `Uncommitted changes in package files: ${dirtyOverlap.join(', ')}. Commit or stash them first.`; return out }

const git = Boolean(gate.git)
const commit = git && a.commit !== false
const base = gate.head
const prep = await step(
  `Prepare the package ${a.label} in ${a.repo}. ` +
  (git && a.branch ? `Switch to the Git branch ${a.branch}: \`git switch ${a.branch}\`, or \`git switch -c ${a.branch}\` when it does not exist. ` : '') +
  `Write the claim file ${claimFile} (create the folder): ${JSON.stringify({ label: a.label, status: 'open', files: a.files, brief: a.brief, base })}, plus a field "openedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`. ` +
  `ok is true when the claim file exists${git && a.branch ? ` and \`git branch --show-current\` prints ${a.branch}` : ''}.`,
  { agentType: 'runner', schema: STEP, label: `prepare ${a.label}` })
if (!prep || !prep.ok) { out.stoppedAt = 'prepare'; return out }

async function finish(status) {
  await step(`Set "status" to "${status}" in ${claimFile} and add "closedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`; keep every other field. ok is true when the file parses.`,
    { agentType: 'runner', schema: STEP, label: `close claim ${a.label}` })
  return out
}

// ---------------------------------------------------------------- Write
const changed = new Set(a.files)
const noteChanged = (list) => (list || []).forEach(f => changed.add(f))
const HANDOVER = ` If your context is running out before the task is done, stop at a clean point (files consistent, the progress file says what is done and what remains, precisely enough for a stranger), and return done false with more true; a fresh agent will go on.`
const BEFORE = git ? '' : ` Before your first edit of a file, copy it to ${a.tmp}/before/ keeping its file name, so the review can diff it.`

// A long package can outgrow one agent's context. The agent may hand over (more: true) at a clean point, or it may
// end without a result; either way a fresh agent goes on from the same progress file, up to a.continuations times.
async function continued(prompt, opts) {
  const pinned = { ...opts, progress: opts.label }
  let res = null
  const changedSoFar = []
  for (let c = 0; c <= (a.continuations ?? 2); c++) {
    const o = c ? { ...pinned, label: `${opts.label} (cont ${c})` } : pinned
    try { res = await step(prompt, o) } catch (e) { log(`${o.label}: ${e.message}`); res = null }
    if (res) changedSoFar.push(...(res.changed || []))
    if (res && !res.more) break
  }
  return res && { ...res, changed: [...new Set(changedSoFar)] }
}

// One writing turn by the resolved writer: a Claude coder, a Codex work call, or an expert answer applied by the applier.
let calls = 0
async function write(task, tag, phaseName) {
  const n = ++calls
  if (mode === 'expert') {
    const ask = await step(
      `Ask an expert for the code through the gateway. Work from ${a.repo}. Write ${a.tmp}/expert-${n}.md: ${task} ` +
      `Then run \`zodchi run --role code-patch --model ${writer.model} --effort ${writer.effort} --key ${a.label}-expert-${n} --prompt ${a.tmp}/expert-${n}.md --attach ${a.brief} ` +
      `${[...changed].map(f => `--attach "${f}"`).join(' ')} --wait-sec 3300 --out ${a.tmp}/expert-${n}.answer.md\`; leave out of --attach any file that does not exist. ` +
      `ok is true when the job succeeded and the answer file exists. paths: the answer file.`,
      { agentType: 'runner', schema: STEP, phase: phaseName, label: `${tag} ask` })
    if (!ask || !ask.ok) return null
    const applied = await step(
      `Apply one expert answer. Answer file: ${a.tmp}/expert-${n}.answer.md. Target files: the ones the answer names, inside ${a.repo}. ` +
      `Ledger of edits: ${a.tmp}/apply-${n}.md. Backup folder: ${a.tmp}/backup-${n}. Syntax checks after applying: the one that fits each target's language. ` +
      `done is true only when every edit row has a line number and the checks are clean. changed: the target files, absolute paths. unverified: rows not applied.`,
      { agentType: 'applier', schema: WRITE, phase: phaseName, label: `${tag} apply` })
    return applied
  }
  if (writer.provider === 'codex') {
    return step(
      `Have Codex do this through the gateway. Work from ${a.repo}. Write ${a.tmp}/work-${n}.md: ${task} ` +
      `Then run \`zodchi run --role package-work --model ${writer.model} --effort ${writer.effort} --key ${a.label}-work-${n} --prompt ${a.tmp}/work-${n}.md --attach ${a.brief} --wait-sec 3600 --out ${a.tmp}/work-${n}.json\`. ` +
      `From the answer take: done (it says the task is done), summary, changed (absolute paths), unverified. If the job did not succeed, done is false and summary says why.`,
      { agentType: 'runner', schema: WRITE, phase: phaseName, label: `${tag}` })
  }
  return continued(task + BEFORE + HANDOVER, { agentType: 'coder', model: writer.model, schema: WRITE, phase: phaseName, label: tag })
}

phase('Write')
out.write = await write(
  `Implement the package described in ${a.brief}. Read it first; it is the whole task. ` +
  `done is true only when everything the brief calls "done" holds and you ran what it tells you to run. changed: every file you changed, absolute paths. unverified: what you could not verify, in the order to check it.`,
  `write ${a.label}`, 'Write')
if (!out.write || !out.write.done) { out.stoppedAt = 'write'; return finish('stopped') }
noteChanged(out.write.changed)

// ---------------------------------------------------------------- Checks
const checkList = (a.checks || []).map(c => typeof c === 'string' ? { cmd: c, pass: 'exit code 0' } : { pass: 'exit code 0', ...c })
const runChecks = (tag) => checkList.length
  ? step(`Run these checks from ${a.repo}, in order, each to its end, one log per command in ${a.tmp}/logs: ${JSON.stringify(checkList)}. ` +
          `A check passes when its output meets its "pass" rule. ok is true only when every check passes. ` +
          `results: one line per command with its exit code, the decisive output line and pass/fail. logs: the log paths. ` +
          `cause: "none" when ok; otherwise the first failure's cause - "code" when the changed code is wrong (traceback, compile error, failed assertion, a gate of the change), ` +
          `"check" when the command or its pass rule is wrong although the code works, ` +
          `"environment" when the machine stopped it (a lock held by another process, memory, a missing tool).`,
          { agentType: 'runner', schema: CHECKS, phase: 'Checks', label: `checks ${tag}` })
  : Promise.resolve({ ok: true, results: [], cause: 'none' })

async function checked(n) {
  let checks = await runChecks(n)
  for (let f = 1; checks && !checks.ok && checks.cause === 'code' && f <= (a.fixes ?? 1); f++) {
    const fix = await write(
      `The checks of the package ${a.brief} failed after the change. Results: ${JSON.stringify(checks.results)}. Logs: ${JSON.stringify(checks.logs || [])}. ` +
      `Read the logs and fix the code with the smallest change. done is true when the failing command passes. changed: files changed in this fix.`,
      `fix checks ${n}.${f}`, 'Close')
    if (!fix || !fix.done) break
    noteChanged(fix.changed)
    checks = await runChecks(`${n}.${f}`)
  }
  return checks
}

async function commitRound(n) {
  if (!commit) return true
  const res = await step(
    `Commit the package's files in ${a.repo}. Stage only these paths, each that exists or was deleted: ${JSON.stringify([...changed])} (\`git add -A -- <path>\`). ` +
    `Then \`git commit -m "${a.label}: round ${n}"\` when anything is staged; nothing staged is fine. Never push. ok is true when the commit exists or nothing was staged. summary: the commit hash or "nothing to commit".`,
    { agentType: 'runner', schema: STEP, phase: 'Checks', label: `commit ${n}` })
  return Boolean(res && res.ok)
}

// ---------------------------------------------------------------- Review rounds
const diffHow = git
  ? `\`git diff ${base} -- <files>\` over the files below (new untracked files: \`git diff --no-index /dev/null <file>\`)`
  : `\`git diff --no-index ${a.tmp}/before/<name> <file>\` for every file with a copy in ${a.tmp}/before/, and \`git diff --no-index /dev/null <file>\` for new files`

for (let n = 1; n <= rounds; n++) {
  const checks = await checked(n)
  if (!checks || !checks.ok) {
    out.rounds.push({ n, checks })
    out.stoppedAt = `checks (${checks ? checks.cause : 'no result'})`
    return finish('stopped')
  }
  if (!(await commitRound(n))) { out.stoppedAt = 'commit'; return finish('stopped') }

  const context = `what the change does and why (from ${a.brief} and this summary: ${JSON.stringify(out.write.summary)}), what is verified and what is not ` +
    `(${JSON.stringify(out.write.unverified || [])})${n > 1 ? `, and which findings of the previous review (${a.tmp}/review-${n - 1}.json) were closed and how` : ''}`
  const files = [...changed]
  const review = reviewer.provider === 'codex'
    ? await step(
      `Get an independent review of a finished change through the gateway. Work from ${a.repo}. Write ${a.tmp}/review-${n}.md: ${context}. ` +
      `Save the change as ${a.tmp}/change-${n}.diff with ${diffHow}; skip files that do not exist. Then run ` +
      `\`zodchi run --role code-review --model ${reviewer.model} --effort ${reviewer.effort} --key ${a.label}-review-${n} --prompt ${a.tmp}/review-${n}.md --attach ${a.tmp}/change-${n}.diff --attach ${a.brief} ` +
      `${n > 1 ? `--attach ${a.tmp}/review-${n - 1}.json ` : ''}${files.map(f => `--attach "${f}"`).join(' ')} --wait-sec 3300 --out ${a.tmp}/review-${n}.json\`. ` +
      `Leave out of --attach any of those files that does not exist. ` +
      `Return the verdict, each finding as "<id> <severity> <location>: <problem>", the count of blocking findings, and the review file path. ` +
      `findings holds the reviewer's findings only: an empty array when it has none (put notes such as "not verified" into verdict, never into findings). Change no code.`,
      { agentType: 'runner', schema: REVIEW, phase: 'Review', label: `review ${n}` })
    : await step(
      `You are an independent code reviewer; you did not write this change. Work from ${a.repo} and change nothing. Read ${a.brief}, then the change: ${diffHow}, for these files: ${JSON.stringify(files)}. ` +
      `Context: ${context}. Look for correctness bugs, broken contracts, missing checks and unsafe operations; style only when it hides a bug. ` +
      `Write the review to ${a.tmp}/review-${n}.json as {"verdict": ..., "findings": [{"id": "F1", "severity": "blocking|major|minor", "location": ..., "problem": ..., "fix": ...}]}. ` +
      `Return the verdict, each finding as "<id> <severity> <location>: <problem>", the count of blocking findings, and reviewFile.`,
      { model: reviewer.model, schema: REVIEW, phase: 'Review', label: `review ${n}` })
  out.rounds.push({ n, checks, review })
  if (!review) { out.stoppedAt = 'review'; return finish('stopped') }
  // A runner may still put a "No findings" note into the list; only lines that start with a finding id count.
  const real = review.findings.filter(f => /^\s*F\d+/.test(f))
  if (!real.length) { out.verdict = review.verdict; out.approved = true; return finish('done') }
  if (n === rounds) {
    out.verdict = review.verdict
    out.stoppedAt = `stop rule: ${rounds} review rounds without approval`
    out.question = `The package has findings after ${rounds} rounds: ${real.join(' | ')}. Decide: accept as is, change the brief, or mark it hard and start again.`
    return finish('stopped')
  }

  const fix = await write(
    `Close the findings of the review ${a.tmp}/review-${n}.json for the package ${a.brief}. Fix each finding in the reviewer's sense with the smallest change; ` +
    `a finding you reject, say why instead of changing code. done is true when every finding is closed or answered. changed: files changed this round.`,
    `close ${n}`, 'Close')
  if (!fix || !fix.done) { out.stoppedAt = 'close'; return finish('stopped') }
  noteChanged(fix.changed)
  out.write = { ...out.write, summary: `${out.write.summary} | round ${n} fixes: ${fix.summary}`, unverified: fix.unverified || out.write.unverified }
}
return finish('stopped')
