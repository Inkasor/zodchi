export const meta = {
  name: 'code-package',
  description: 'One code package: a gate resolves the role table and refuses overlapping packages, the writer implements, a runner checks, an independent reviewer reviews through the gateway, the writer closes findings; stops after 3 review rounds',
  whenToUse: 'Any code package from a finished brief. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the role table, the subscription limits, open packages and Git state, then claims the files', model: 'haiku' },
    { title: 'Write', detail: 'writer implements the brief (agent mode) or an expert answers and the applier applies it (expert mode)' },
    { title: 'Checks', detail: 'runner runs the checks named in the brief and commits the package files', model: 'haiku' },
    { title: 'Review', detail: 'reviewer (never the author) reviews the change through the gateway', model: 'haiku' },
    { title: 'Close', detail: 'the same writer closes the findings' },
  ],
}

// args:
//   label     short name, also the prefix of gateway keys and the name of the package claim, e.g. "export-csv"
//   brief     path of the brief file: goal, files that may change, what "done" means, checks
//   repo      repository the change is in (absolute path); every command runs from it
//   files     the files the lead expects to change, absolute or relative to repo; the gate refuses to start when
//             another open package claims one of them, and the review attaches these plus every file the writer
//             reports changed
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
if (!/^[\w.-]+$/.test(a.label)) throw new Error('args.label may hold letters, digits, ".", "_" and "-" only')
const mode = a.mode || 'agent'
if (!['agent', 'expert'].includes(mode)) throw new Error('args.mode is "agent" or "expert"')
const rounds = a.rounds || 3

// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// Paths: resolved to absolute form with dot segments removed, then made relative to the repository. rel() keeps the
// case of the name for Git and the file system; key() is its lower-case form, used only to compare and to claim.
const norm = (p) => {
  const s = String(p).replace(/\\/g, '/')
  const lead = /^[A-Za-z]:\//.test(s) ? s.slice(0, 3) : s.startsWith('/') ? '/' : ''
  const parts = []
  for (const seg of s.slice(lead.length).split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (!parts.length) throw new Error(`path ${p} leaves the file system root`); parts.pop() } else parts.push(seg)
  }
  return lead + parts.join('/')
}
const repoKey = norm(a.repo)
function rel(p) {
  const s = String(p).replace(/\\/g, '/')
  const full = norm(/^([A-Za-z]:)?\//.test(s) ? s : `${repoKey}/${s}`)
  if (full.toLowerCase() === repoKey.toLowerCase()) throw new Error(`path ${p} is the repository itself, not a file in it`)
  if (!full.toLowerCase().startsWith(repoKey.toLowerCase() + '/')) throw new Error(`path ${p} is outside the repository ${a.repo}`)
  return full.slice(repoKey.length + 1)
}
const key = (p) => rel(p).toLowerCase()
const abs = (p) => `${repoKey}/${rel(p)}`
const myPaths = [...new Map(a.files.map(f => [key(f), rel(f)])).values()]
const myKeys = myPaths.map(p => p.toLowerCase())

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
    // each open question as one readable line: the question, its options and the recommendation
    questions: { type: 'array', items: { type: 'string' } },
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
    // the verdict field of the review exactly: approved, changes_requested or blocked
    verdict: { type: 'string', enum: ['approved', 'changes_requested', 'blocked', 'missing'] },
    summary: { type: 'string' }, reviewFile: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    blocking: { type: 'number' },
  },
}

const out = { label: a.label, mode, rounds: [] }
const claimsDir = `${repoKey}/.agent-tmp/zodchi/packages`
const claimFile = `${claimsDir}/${a.label}.json`

// ---------------------------------------------------------------- Gate
phase('Gate')
const gate = await step(
  `Gather facts for a code package gate; change nothing. Work from ${a.repo}. Return each file's content as a string, exactly as read, or "" when the file does not exist.\n` +
  `- homeModels: the file ~/.zodchi/models.json.\n` +
  `- repoModels: the file ${repoKey}/.zodchi/models.json.\n` +
  `- account: the output of \`zodchi account\` (JSON), or "" when the command fails; put its error into accountError.\n` +
  `- git: true when ${a.repo} is inside a Git work tree. head: \`git rev-parse HEAD\`. ` +
  `dirty: the paths \`git status --porcelain\` lists (path only, relative to the repository).`,
  {
    agentType: 'runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'git'],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' }, accountError: { type: 'string' },
        git: { type: 'boolean' }, head: { type: 'string' }, dirty: { type: 'array', items: { type: 'string' } },
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

const dirtyOverlap = (gate.dirty || []).filter(f => myKeys.includes(key(f)))
if (dirtyOverlap.length) { out.refused = `Uncommitted changes in package files: ${dirtyOverlap.join(', ')}. Commit or stash them first.`; return out }

const git = Boolean(gate.git)
const commit = git && a.commit !== false
const base = gate.head

// Claiming happens under a lock folder (mkdir is atomic), so two packages started at once cannot both pass. From the
// claim on, whatever happens, the claim is closed at the end and the closing is checked; only a refusal for
// conflicts, which writes no claim, skips that.
let claimStatus = 'stopped'
let claimWritten = true
try {
const claim = await step(
  `Claim files for the package ${a.label} in ${a.repo}. Follow these steps exactly.\n` +
  `1. Lock: run \`mkdir ${q(claimsDir + '/.lock')}\` (create ${claimsDir} first if it is missing). If the lock folder already exists, wait 10 seconds and try again, ` +
  `for at most 2 minutes; a lock folder older than 10 minutes is stale: remove it and try again. If you cannot take the lock, return ok false with conflicts ["lock busy"].\n` +
  `2. Read every *.json file in ${claimsDir}. For each one whose "status" is "open" and whose "label" is not "${a.label}", compare its "files" list with this list, ` +
  `entry by entry, as exact strings: ${JSON.stringify(myKeys)}. Every equal pair is a conflict "<its label>: <file>".\n` +
  `3. If there is no conflict, write ${claimFile}: ${JSON.stringify({ label: a.label, status: 'open', files: myKeys, brief: a.brief, base })}, plus "openedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`.\n` +
  `4. Always remove the lock folder (\`rmdir ${q(claimsDir + '/.lock')}\`), whatever happened above.\n` +
  (git && a.branch ? `5. If there was no conflict, switch to the Git branch ${a.branch}: \`git switch ${q(a.branch)}\`, or \`git switch -c ${q(a.branch)}\` when it does not exist.\n` : '') +
  `ok is true when the claim file was written${git && a.branch ? ` and \`git branch --show-current\` prints ${a.branch}` : ''}. conflicts: the conflicts found, [] when none.`,
  {
    agentType: 'runner', label: `claim ${a.label}`,
    schema: { type: 'object', required: ['ok', 'conflicts'], properties: { ok: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
  })
if (claim && claim.conflicts && claim.conflicts.length && claim.conflicts[0] !== 'lock busy' && !claim.ok) {
  claimWritten = false
  out.refused = `Open packages claim the same files: ${claim.conflicts.join('; ')}. Finish them, or close a stale one (status "closed" in ${claimsDir}/<label>.json).`
  return out
}
  if (!claim || !claim.ok) { out.stoppedAt = `claim (${claim ? claim.summary || claim.conflicts.join(', ') : 'no result'})`; return out }
  await body()
  return out
} finally {
  if (claimWritten) {
  const closed = await step(
    `If ${claimFile} exists, set its "status" to "${claimStatus}" and add "closedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`; keep every other field. ` +
    `ok is true when the file does not exist, or when it parses and its status is "${claimStatus}".`,
    { agentType: 'runner', schema: STEP, label: `close claim ${a.label}` }).catch(() => null)
  if (!closed || !closed.ok) out.claimLeftOpen = `${claimFile}: set "status" to "closed" by hand`
  }
}

async function body() {
  const changed = new Set(myPaths.map(abs))
  const questions = []
  const noteQuestions = (res) => { for (const x of (res && res.questions) || []) if (!questions.includes(x)) questions.push(x); if (questions.length) out.questions = questions }
  const noteChanged = (list) => (list || []).forEach(f => changed.add(abs(f)))
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

  // One writing turn by the resolved writer: a Claude coder, a Codex work call, or an expert answer applied by the
  // applier. evidence: files the task refers to (review, logs); a tool-free expert gets them attached.
  let calls = 0
  async function write(task, tag, phaseName, evidence = []) {
    const n = ++calls
    if (mode === 'expert') {
      const attach = [a.brief, ...evidence, ...changed].map(f => `--attach ${q(f)}`).join(' ')
      const ask = await step(
        `Ask an expert for the code through the gateway. Work from ${a.repo}. Write ${a.tmp}/expert-${n}.md: ${task} ` +
        `The expert has no tools: everything it needs is attached. Then run \`zodchi run --role code-patch --model ${writer.model} --effort ${writer.effort} --key ${a.label}-expert-${n} ` +
        `--prompt ${q(`${a.tmp}/expert-${n}.md`)} ${attach} --wait-sec 3300 --out ${q(`${a.tmp}/expert-${n}.answer.md`)}\`; leave out of --attach any file that does not exist. ` +
        `ok is true when the job succeeded and the answer file exists. paths: the answer file.`,
        { agentType: 'runner', schema: STEP, phase: phaseName, label: `${tag} ask` })
      if (!ask || !ask.ok) return null
      return step(
        `Apply one expert answer. Answer file: ${a.tmp}/expert-${n}.answer.md. Target files: the ones the answer names, relative to ${a.repo}. ` +
        `Ledger of edits: ${a.tmp}/apply-${n}.md. Backup folder: ${a.tmp}/backup-${n}. Syntax checks after applying: the one that fits each target's language. ` +
        `done is true only when every edit row has a line number and the checks are clean. changed: the target files, absolute paths. unverified: rows not applied.`,
        { agentType: 'applier', schema: WRITE, phase: phaseName, label: `${tag} apply` })
    }
    if (writer.provider === 'codex') {
      const attach = [a.brief, ...evidence].map(f => `--attach ${q(f)}`).join(' ')
      return step(
        `Have Codex do this through the gateway. Work from ${a.repo}. Write ${a.tmp}/work-${n}.md: ${task} ` +
        `Then run \`zodchi run --role package-work --model ${writer.model} --effort ${writer.effort} --key ${a.label}-work-${n} --prompt ${q(`${a.tmp}/work-${n}.md`)} ${attach} ` +
        `--wait-sec 3600 --out ${q(`${a.tmp}/work-${n}.json`)}\`. The answer is JSON with status, summary, criteria, questions, changedFiles, checks. Map it exactly: ` +
        `done = (status is "done"); summary = its summary; changed = each entry of changedFiles prefixed with "${repoKey}/"; ` +
        `unverified = every criterion that is not done, as one line each, plus every check with a non-zero exit code; questions = each entry of its questions as one readable line (the question, its options, the recommendation). ` +
        `If the job did not succeed, done is false and summary says the job status.`,
        { agentType: 'runner', schema: WRITE, phase: phaseName, label: `${tag}` })
    }
    return continued(task + BEFORE + HANDOVER, { agentType: 'coder', model: writer.model, schema: WRITE, phase: phaseName, label: tag })
  }

  phase('Write')
  out.write = await write(
    `Implement the package described in ${a.brief}. Read it first; it is the whole task. ` +
    `done is true only when everything the brief calls "done" holds and you ran what it tells you to run. changed: every file you changed, absolute paths. unverified: what you could not verify, in the order to check it.`,
    `write ${a.label}`, 'Write')
  if (!out.write || !out.write.done) {
    out.stoppedAt = 'write'
    noteQuestions(out.write)
    if (questions.length) out.question = questions.join(' | ')
    return
  }
  noteQuestions(out.write)
  noteChanged(out.write.changed)

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
        `fix checks ${n}.${f}`, 'Close', checks.logs || [])
      noteQuestions(fix)
      if (!fix || !fix.done) break
      noteChanged(fix.changed)
      checks = await runChecks(`${n}.${f}`)
    }
    return checks
  }

  // A path-limited commit: other staged work in the index stays out of it, and the runner verifies that.
  async function commitRound(n) {
    if (!commit) return true
    const paths = [...changed].map(rel)
    const res = await step(
      `Commit the package's files in ${a.repo}; never push. The package paths, relative to the repository: ${JSON.stringify(paths)}.\n` +
      `1. For each path that exists, or that Git tracks and is now deleted, run \`git add -A -- <path>\`; skip a path that is neither.\n` +
      `2. If \`git diff --cached --quiet -- <those paths>\` says nothing changed, return ok true with summary "nothing to commit".\n` +
      `3. Otherwise run \`git commit -m "${a.label}: round ${n}" -- <those paths>\` (the paths after -- limit the commit to them; other staged files stay staged and out of it).\n` +
      `4. Run \`git show --name-only --format= HEAD\`: every listed file must be one of the package paths. ok is true only then. summary: the commit hash. paths: the listed files.`,
      { agentType: 'runner', schema: STEP, phase: 'Checks', label: `commit ${n}` })
    return Boolean(res && res.ok)
  }

  // Review diffs come from Git, deleted files included; only attachments of current files need the file to exist.
  const diffHow = git
    ? `\`git diff ${base} -- <files>\` over the package paths below (this includes deleted files), plus \`git diff --no-index /dev/null <file>\` for each untracked new one`
    : `\`git diff --no-index ${a.tmp}/before/<name> <file>\` for every file with a copy in ${a.tmp}/before/ (a deleted file: diff its copy against /dev/null), and \`git diff --no-index /dev/null <file>\` for new files`

  for (let n = 1; n <= rounds; n++) {
    const checks = await checked(n)
    if (!checks || !checks.ok) {
      out.rounds.push({ n, checks })
      out.stoppedAt = `checks (${checks ? checks.cause : 'no result'})`
      return
    }
    if (!(await commitRound(n))) { out.stoppedAt = 'commit'; return }

    const context = `what the change does and why (from ${a.brief} and this summary: ${JSON.stringify(out.write.summary)}), what is verified and what is not ` +
      `(${JSON.stringify(out.write.unverified || [])})${n > 1 ? `, and which findings of the previous review (${a.tmp}/review-${n - 1}.json) were closed and how` : ''}`
    const files = [...changed]
    const VERDICT = `verdict: the "verdict" field of the review exactly ("approved", "changes_requested" or "blocked"; "missing" when the review file has none). ` +
      `summary: its summary. findings holds the reviewer's findings only, each as "<id> <severity> <location>: <problem>": an empty array when it has none. blocking: the count of blocking findings.`
    const review = reviewer.provider === 'codex'
      ? await step(
        `Get an independent review of a finished change through the gateway. Work from ${a.repo}. Write ${a.tmp}/review-${n}.md: ${context}. ` +
        `Save the change as ${a.tmp}/change-${n}.diff with ${diffHow}: ${JSON.stringify(files.map(rel))}. Then run ` +
        `\`zodchi run --role code-review --model ${reviewer.model} --effort ${reviewer.effort} --key ${a.label}-review-${n} --prompt ${q(`${a.tmp}/review-${n}.md`)} ` +
        `--attach ${q(`${a.tmp}/change-${n}.diff`)} --attach ${q(a.brief)} ${n > 1 ? `--attach ${q(`${a.tmp}/review-${n - 1}.json`)} ` : ''}` +
        `${files.map(f => `--attach ${q(f)}`).join(' ')} --wait-sec 3300 --out ${q(`${a.tmp}/review-${n}.json`)}\`. ` +
        `Leave out of --attach any current file that does not exist (the diff already carries deletions). ` +
        `${VERDICT} reviewFile: the review file path. Change no code.`,
        { agentType: 'runner', schema: REVIEW, phase: 'Review', label: `review ${n}` })
      : await step(
        `You are an independent code reviewer; you did not write this change. Work from ${a.repo} and change nothing. Read ${a.brief}, then the change: ${diffHow}, for these paths: ${JSON.stringify(files.map(rel))}. ` +
        `Context: ${context}. Look for correctness bugs, broken contracts, missing checks and unsafe operations; style only when it hides a bug. ` +
        `Write the review to ${a.tmp}/review-${n}.json as {"verdict": "approved" | "changes_requested" | "blocked", "summary": ..., "findings": [{"id": "F1", "severity": "blocking|should_fix|minor", "location": ..., "problem": ..., "fix": ...}]}; ` +
        `approved only when no blocking finding is open, blocked when the change cannot be judged. ${VERDICT} reviewFile: the path you wrote.`,
        { model: reviewer.model, schema: REVIEW, phase: 'Review', label: `review ${n}` })
    out.rounds.push({ n, checks, review })
    if (!review) { out.stoppedAt = 'review'; return }
    out.verdict = review.verdict
    if (review.verdict === 'approved') { out.approved = true; claimStatus = 'done'; return }
    if (review.verdict !== 'changes_requested') {
      out.stoppedAt = `review verdict ${review.verdict}`
      out.question = `The reviewer could not approve or ask for changes (${review.verdict}): ${review.summary || ''} See ${a.tmp}/review-${n}.json.`
      return
    }
    if (n === rounds) {
      out.stoppedAt = `stop rule: ${rounds} review rounds without approval`
      out.question = `The package has findings after ${rounds} rounds: ${review.findings.join(' | ')}. Decide: accept as is, change the brief, or mark it hard and start again.`
      return
    }

    const fix = await write(
      `Close the findings of the review ${a.tmp}/review-${n}.json for the package ${a.brief}. Fix each finding in the reviewer's sense with the smallest change; ` +
      `a finding you reject, say why instead of changing code. done is true when every finding is closed or answered. changed: files changed this round.`,
      `close ${n}`, 'Close', [`${a.tmp}/review-${n}.json`])
    noteQuestions(fix)
    if (!fix || !fix.done) { out.stoppedAt = 'close'; if (questions.length) out.question = questions.join(' | '); return }
    noteChanged(fix.changed)
    out.write = { ...out.write, summary: `${out.write.summary} | round ${n} fixes: ${fix.summary}`, unverified: fix.unverified || out.write.unverified }
  }
}
