export const meta = {
  name: 'code-package',
  description: 'One code package: a gate resolves the role table and refuses overlapping packages, the writer implements, a runner runs the cheap checks and then the verify commands or skill, an independent reviewer reviews with the REVIEW.md of the base commit, the writer closes findings; stops after 3 review rounds, or earlier when a round only goes deeper (review boundary)',
  whenToUse: 'Any code package from a finished brief. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the role table, the subscription limits, open packages, Git state and whether .agent-tmp/ is ignored, then claims the files', model: 'haiku' },
    { title: 'Write', detail: 'writer implements the brief (agent mode) or an expert answers and the applier applies it (expert mode)' },
    { title: 'Checks', detail: 'runner runs the cheap checks, then the verify commands or skill, and commits the package files with a Verified line', model: 'haiku' },
    { title: 'Review', detail: 'reviewer (never the author) reviews the change through the gateway, applying REVIEW.md from the base commit', model: 'haiku' },
    { title: 'Close', detail: 'the same writer closes the findings' },
  ],
}

// args:
//   label     short name, also the prefix of gateway keys and the name of the package claim, e.g. "export-csv"
//   brief     path of the brief file: goal, files that may change, what "done" means, checks
//   repo      repository the change is in (absolute path); every command runs from it. It must be a Git work tree:
//             the protected checks and REVIEW.md are read from the base commit
//   files     the files the lead expects to change, absolute or relative to repo; the gate refuses to start when
//             another open package claims one of them, and the review attaches these plus every file the writer
//             reports changed
//   tmp       folder for prompts, logs and reviews of this package (absolute)
//   mode      "agent" (default): the writer edits the files itself. "expert": the writer answers once through
//             the gateway with the edits, and the applier puts them into the files
//   hard      true when the lead marked the package hard: the role hardWriter writes instead of writer
//   checks    the cheap checks (build, lint, fast tests), run from the repo after each write, before verify; each entry
//             is a command string (passes on exit 0) or { cmd, pass } where pass says in words what success is
//   verify    optional: the slow run of the real program, commands like checks. Without it the runner follows the
//             repository's skill .claude/skills/verify/SKILL.md when there is one. What verified the round is verify,
//             else the skill, else the checks; with none of them the result says "not verified by running"
//   protect   optional: more paths (files or folders) whose existing files the package may not change, besides test/,
//             tests/, e2e/, .claude/skills/verify/ and REVIEW.md. New files are allowed; a change to an existing one
//             stops the package before review with the list
//   allowCheckChanges  optional: the protected paths this package may change (a list, or { "<path>": "<reason>" })
//   rounds    review rounds at most, default 3 (the stop rule: without approval the package returns to a human)
//   fixes     how many times a check failure caused by the code goes back to the writer, default 1
//   continuations  fresh writers that may go on after one ran out of context, default 2
//   branch    optional: Git branch for the package; created from the current HEAD when missing
//   commit    default true in a Git repository: the runner commits the package's files after each passing
//             checks run. Nothing is ever pushed
//   models    optional: role table entries that replace the table for this run, e.g. { writer: { candidates: [...] } }
//   The brief may carry a section "## Review boundary" (docs/review-boundary.md): what is important for the package and
//   what is out of scope. The review quotes it; a brief without it gets a note in the result, not a refusal.
//   The owner's file ~/.zodchi/config.json may set "parallel": "shared-branch" (docs/parallel.md): every agent of the run
//   is then told to work in the checkout it was given, create no clones or worktrees and not switch branches.
//   fixIgnore true: when the repository does not ignore .agent-tmp/ and the package calls the gateway, the runner
//             appends ".agent-tmp/" to .gitignore and commits that line on its own before the package starts.
//             Default false: the gate refuses
//   closeShouldFix  true: when the last review approves with nit findings, the same writer closes them and one more
//             short review checks only those (it counts against rounds). Default false: the run ends approved, with
//             those findings in openFindings
//   rerun     steps that threw for an infrastructure failure, as { "<label>": <attempt> } (the error and out.next name
//             both, e.g. { "review 1": 2 }): on resume these steps run again instead of coming back from the journal.
//             A list of labels means attempt 2 for each
//
// result: { label, mode, models, rounds[], write, verdict, approved, openFindings[], verifiedBy, verification, next,
//           stoppedAt, refused, question, questions, conflicts, claimAdded, outsideRepo, claimLeftOpen, protectedChanged,
//           checkChanges, notes, boundary, reviewLedger }
//   verdict       "approved" when no important finding is open, "changes_requested" when one is, "blocked"; the
//                 reviewer's own word stays in rounds[].review.verdict
//   openFindings  always present: every finding of the last review that no later round closed, any severity, as
//                 "<id> <severity> <location>: <problem>" with the severity important, nit or pre-existing
//   verifiedBy    always present: "args.verify", "verify skill" or "checks" when they ran and passed with evidence (every entry has an exit code); "none" otherwise
//   verification  { verifiedBy, evidence[] ({ command, exitCode, log, source }), note, stamp } (the stamp names sources and exit codes, never commands) of the last checks
//   next          what the lead does next when the run ends with something left open
//   notes         always present when something is worth one line (for example: the brief has no Review boundary section)
//   boundary      only with stoppedAt "review went deeper": the important findings of the last round, all new, as
//                 { finding, id, location, problem, decide: "fix | out of scope", ifOutOfScope } where ifOutOfScope is a
//                 proposed REVIEW.md line (what not to flag, why, date) for the lead to complete. REVIEW.md is never edited here
//   reviewLedger  always present: one entry per finding of any review, { id, severity, location, problem, firstRound,
//                 lastRound, status, closedInRound, closedBy }; status "open" (the last review still holds it), "closed" (a
//                 later review no longer reports a finding that was sent to the writer; closedBy "code change" or "answered
//                 without a code change"), "dropped" (a later review no longer reports it, it was not sent to the writer) or
//                 "to sort" (new at a boundary stop: the lead decides fix or out of scope)
const a = args || {}
for (const k of ['label', 'brief', 'repo', 'files', 'tmp']) if (!a[k]) throw new Error(`code-package needs args.${k}`)
if (!/^[\w.-]+$/.test(a.label)) throw new Error('args.label may hold letters, digits, ".", "_" and "-" only')
const mode = a.mode || 'agent'
if (!['agent', 'expert'].includes(mode)) throw new Error('args.mode is "agent" or "expert"')
const rounds = a.rounds || 3

// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One gateway call, worded once for every step that makes one. The shell of a step has its own time limit and the
// worker of a job can end with the shell that started it, so the wait is made of foreground calls of 540 seconds.
// attach: the files the request must carry, listed by the workflow; attachIfExists: files attached only when they exist.
// label: the step's label. A rerun after an infrastructure failure (attempt 2 and on) submits under a base key of its
// own, <key>-a<attempt>: its prompt differs, and the earlier keys end in a final job that gave no usable result. Only an
// earlier job that is still running is waited on instead.
const gatewayCall = ({ role, key: baseKey, label, args, attach = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const n = attempt(label)
  const key = n > 1 ? `${baseKey}-a${n}` : baseKey
  const flags = [...attach, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, base key ${key}. ` +
    (n > 1 ? `This is attempt ${n} after an infrastructure failure; earlier attempts used other keys (${baseKey}${n > 2 ? `, ${baseKey}-a2` : ''}${n > 3 ? ' and on' : ''}, with their -r2 and -r3). ` +
      `Unless the progress file already records a key that starts with ${key}: take the latest key it records for this call; if \`zodchi job --key <that key>\` shows the job not final yet, it is the active key: wait on it as below instead of submitting; if it then dies before its turn (the rule below), the next submission is ${key}, not a suffix of that key. ` +
      `Otherwise (it is final, whatever its status, or there is none) never wait on it or reuse it: submit under ${key}. ` : '') +
    `Run it in the foreground from ${repo}: \`${run}\`. ` +
    (attachIfExists.length ? `Before every submission, retries included, drop the --attach of each optional file that does not exist on disk: ${JSON.stringify(attachIfExists)}; keep every other --attach. ` : '') +
    `The gateway refuses a request over 512 KB (prompt plus attachments). Before every submission, first remove a "Not attached for size" line left by an earlier attempt from the prompt file, then add up the size of the prompt file and of every file you attach. While the sum is over 500 KB and an optional file is still attached${attachIfExists.length ? ` (optional: ${JSON.stringify(attachIfExists)})` : ' (there are none here)'}, drop the largest optional one (never a required one) and add its name to one line at the end of the prompt file, "Not attached for size: <names>"; then count again, the prompt included. If the sum is still over 500 KB with no optional file left, do not submit: report that as the infrastructure failure. ` +
    `Never in the background (no &, nohup or run_in_background), never through Monitor: the worker of the job ends with your shell. ` +
    `The active key is the key of the latest submission: ${key} at first, then ${key}-r2, then ${key}-r3 (at most 2 retries in all). Every wait, \`zodchi job\` and request.json check below names the active key, never an earlier one, also after a resume (the progress file holds the latest key). ` +
    `While it exits 3 (still running), repeat \`zodchi wait --key <active key> --wait-sec 540 --out ${q(out)}\` in the foreground, up to ${totalMin} minutes in all since the first command; ` +
    `never return before the job is final (exit 0 or 2); if the ${totalMin} minutes run out, report failure (ok false; verdict "missing" for a review) and say the job still runs under its active key. ` +
    `A dead job gets a new key: when the job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <active key>\` (it died before its turn started), ` +
    `run the same full command again with --key set to the next key, wait for it the same way, and write each new key into the progress file at once. ` +
    `Any other final status is not retried: report it. ` +
    (attach.length || attachIfExists.length
      ? `After the job is final, read ${repo}/.agent-tmp/gateway/<active key>/request.json: its "prompt" must contain \`<attachment path="...">\` (the path as given to --attach, slash direction aside) for every required attachment: ${JSON.stringify(attach)}` +
        `${attachIfExists.length ? `, and for each of these that exists on disk: ${JSON.stringify(attachIfExists)}` : ''}. ` +
        `If one is missing, put "attachment missing: <path>" into your summary and run the full command again with the next key (counted with the retries), every attachment included, then check that new job's request.json the same way; the result you return is that of the last job, and when an attachment is still missing after the last retry it reports failure the same way.`
      : '')
}

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
// A Windows path (drive letter) is compared without case, as Windows does; any other path keeps its case.
const caseless = /^[A-Za-z]:\//.test(repoKey)
const fold = (p) => caseless ? p.toLowerCase() : p
function rel(p) {
  const s = String(p).replace(/\\/g, '/')
  const full = norm(/^([A-Za-z]:)?\//.test(s) ? s : `${repoKey}/${s}`)
  if (fold(full) === fold(repoKey)) throw new Error(`path ${p} is the repository itself, not a file in it`)
  if (!fold(full).startsWith(fold(repoKey) + '/')) throw new Error(`path ${p} is outside the repository ${a.repo}`)
  return full.slice(repoKey.length + 1)
}
const key = (p) => rel(p).toLowerCase()
const abs = (p) => `${repoKey}/${rel(p)}`
const myPaths = [...new Set(a.files.map(rel))]
const myKeys = [...new Set(myPaths.map(p => p.toLowerCase()))]

// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the
// run is resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
// Resume note: a step that threw runs again on resume. An infrastructure failure (the gateway created no job or
// refused, a review without a verdict) is not a result: the workflow throws, naming the step's label. The journal
// still holds that step's answer, so resume with args.rerun naming the step's label and its attempt number: the
// step's prompt then carries that attempt, its gateway call a base key of its own (<key>-a<attempt>), it runs live,
// and every step after it too. A rerun that fails the same way names the next attempt, so every resume differs from
// the one before. Its progress file ends with an "INFRA:" line, and it goes on from there.
// args.rerun: { "<label>": <attempt> }, attempt 2 for the first rerun; a plain list of labels means attempt 2 for each.
const reruns = Array.isArray(a.rerun) || typeof a.rerun === 'string'
  ? Object.fromEntries([].concat(a.rerun).map(l => [l, 2]))
  : { ...(a.rerun || {}) }
const attempt = (label) => Number(reruns[label]) || 1
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.progress || o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
// Set from the owner's config once the gate has read it; every step prompt then carries it.
let parallelNote = ''
const SHARED_NOTE = 'Parallel packages share this checkout (owner setting): work in the checkout you were given; do not create clones or worktrees and do not switch branches.'
const step = (prompt, opts) => agent(prompt +
  (parallelNote ? '\n\n' + parallelNote : '') +
  (opts && attempt(opts.label) > 1 ? `\n\nThis step runs again after an infrastructure failure, attempt ${attempt(opts.label)}: read its progress file. A key recorded by an earlier attempt is not a submission of this one: the gateway call says when an earlier job is still waited on and which new base key to submit under.` : '') +
  `\n\nShell rule: run every command with bash (Git Bash on Windows, never PowerShell or cmd); the quoting in these commands is for bash. Resume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `Do not redo finished work or overwrite its outputs blindly. For a gateway call it records as submitted, wait on the latest key recorded for that call in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <key>\`, submit again under the next suffix of the base key (<base>-r2, then <base>-r3; at most 2 retries in all, those already recorded counted) and record the new key in the progress file. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
}
// A Git status answer: paths is required, [] for a clean work tree, so a missing list is never read as clean.
const STATUS = { ...STEP, required: ['ok', 'summary', 'paths'] }
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
    // (a lock held, low memory, a missing tool); flaky: it failed without a cause in the change. Only "code" goes
    // back to the writer.
    cause: { type: 'string', enum: ['none', 'code', 'check', 'environment', 'flaky'] },
    logs: { type: 'array', items: { type: 'string' } },
    // one entry per command run: the command, its exit code and the path of its log or trace
    evidence: {
      type: 'array',
      items: { type: 'object', required: ['command', 'exitCode', 'log'], properties: { command: { type: 'string' }, exitCode: { type: 'number' }, log: { type: 'string' } } },
    },
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
// A step that makes a gateway call also says whether the gateway worked at all. infra is "" for a job that reached a
// final status, whatever that status is; anything else is an infrastructure failure, and the workflow throws on it.
// infra is required: a gateway step without it, or without any result, is an infrastructure failure too.
// gateway is a closed choice, so a note written into the free text can never turn a finished job into a failure.
const withInfra = (s) => ({ ...s, required: [...s.required, 'gateway', 'infra'], properties: { ...s.properties, gateway: { type: 'string', enum: ['final', 'failed'] }, infra: { type: 'string' } } })
const infraBad = (r) => !r || r.gateway !== 'final'
const INFRA = `gateway: "final" when the gateway created the job and it reached a final status (any status), and then infra is "". Otherwise gateway is "failed" and infra says what happened, quoting the gateway: ` +
  `it created no job, it refused (for example the repository does not ignore .agent-tmp/, an unknown role, sign-in), every submission died before its turn started, ` +
  `or the wait ran out with the job still running (name its active key). When gateway is "failed", append the line "INFRA: <what happened>" to the progress file as its last line instead of DONE.`
// The severity is the second word of a finding line "<id> <severity> <location>: <problem>": important (blocks), nit or
// pre-existing (do not block). Older words: blocking is important; should_fix, note and minor are nit. Any other word is
// read as important, so an unreadable finding never approves a change.
const SEVERITY = new Map(Object.entries({ important: 'important', blocking: 'important', nit: 'nit', should_fix: 'nit', note: 'nit', minor: 'nit', 'pre-existing': 'pre-existing' }))
const severity = (f) => SEVERITY.get((String(f).trim().split(/\s+/)[1] || '').toLowerCase()) || 'important'
const normFinding = (f) => String(f).trim().replace(/^(\S+\s+)(\S+)/, (m, id, word) => id + (SEVERITY.get(word.toLowerCase()) || word))

const out = { label: a.label, mode, rounds: [], openFindings: [], verifiedBy: 'none' }
// Set by an infrastructure failure: the claim stays open, because the package goes on when the run is resumed.
let keepClaim = false
function infraFail(label, what) {
  keepClaim = true
  out.stoppedAt = `infrastructure at ${label}`
  out.infra = what
  const rerun = { ...reruns, [label]: attempt(label) + 1 }
  out.next = `Fix the cause, then resume this run with args.rerun ${JSON.stringify(rerun)} (attempt ${attempt(label) + 1} of the step ${JSON.stringify(label)}). The claim ${claimFile} stays open meanwhile.`
  throw new Error(`Infrastructure failure at step "${label}", attempt ${attempt(label)}: ${what}. Not a result. Run result so far: ${JSON.stringify(out)}`)
}
// Claims live outside the repository, in the shell's home folder, so that no .gitignore matters: one folder per
// repository, named by its path with every character outside [A-Za-z0-9] replaced by "-" (case folded on Windows).
// $HOME is written for the shell, which expands it: commands name the folder in double quotes.
const claimsDir = `$HOME/.zodchi/packages/${fold(repoKey).replace(/[^A-Za-z0-9]/g, '-')}`
const claimFile = `${claimsDir}/${a.label}.json`

// ---------------------------------------------------------------- Gate
phase('Gate')
const gate = await step(
  `Gather facts for a code package gate; change nothing. Work from ${a.repo}. Return each file's content as a string, exactly as read, or "" when the file does not exist.\n` +
  `- homeModels: the file ~/.zodchi/models.json.\n` +
  `- repoModels: the file ${repoKey}/.zodchi/models.json.\n` +
  `- account: the output of \`zodchi account\` (JSON), or "" when the command fails; put its error into accountError.\n` +
  `- git: true when ${a.repo} is inside a Git work tree. head: \`git rev-parse HEAD\`. ` +
  `dirty: every path \`git status --porcelain -uall\` lists, relative to the repository, without the status letters and quotes (a rename gives both paths); [] when it lists nothing or ${a.repo} is not in a Git work tree.\n` +
  `- ignoreExit: the exit code of \`git -C ${q(a.repo)} check-ignore -v .agent-tmp/gateway/x\` (0: ignored, 1: not, anything else: Git could not check). ignoreLine: its output, exactly as printed ("" when it printed nothing).\n` +
  `- verifySkill: true when \`git cat-file -e HEAD:.claude/skills/verify/SKILL.md\` exits 0. reviewMd: true when \`git cat-file -e HEAD:REVIEW.md\` exits 0.\n` +
  `- config: the file ~/.zodchi/config.json (the owner's settings), "" when it does not exist.\n` +
  `- branch: the output of \`git branch --show-current\` run from ${a.repo} ("" on a detached HEAD or outside a Git work tree).\n` +
  `- boundary: the text of the section of ${a.brief} that starts at the heading line beginning with "## Review boundary" (any case; the heading line itself is not part of the text), up to the next line that begins with "## " or the end of the file, exactly as written; "" when the file has no such heading.`,
  {
    agentType: 'zodchi-core:runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'git', 'dirty', 'ignoreExit', 'verifySkill', 'reviewMd', 'config', 'branch', 'boundary'],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' }, accountError: { type: 'string' },
        config: { type: 'string' }, branch: { type: 'string' }, boundary: { type: 'string' },
        git: { type: 'boolean' }, head: { type: 'string' }, dirty: { type: 'array', items: { type: 'string' } },
        ignoreExit: { type: 'number' }, ignoreLine: { type: 'string' }, verifySkill: { type: 'boolean' }, reviewMd: { type: 'boolean' },
      },
    },
  })
if (!gate) { out.stoppedAt = 'gate'; return out }
// The dirty list guards the commits and the claim: a gate answer without it is no answer, never a clean work tree.
if (!Array.isArray(gate.dirty)) { out.stoppedAt = 'gate (no dirty list: the Git state is unknown)'; return out }

const parse = (text, what) => { if (!text || !text.trim()) return null; try { return JSON.parse(text) } catch { log(`${what} is not JSON; ignored`); return null } }
const table = { ...((parse(gate.homeModels, '~/.zodchi/models.json') || {}).roles || {}), ...((parse(gate.repoModels, '.zodchi/models.json') || {}).roles || {}), ...(a.models || {}) }
const account = parse(gate.account, 'zodchi account')
// The owner's setting for packages that run in parallel in one checkout (docs/parallel.md). Unset by default.
const cfg = parse(gate.config, '~/.zodchi/config.json') || {}
const sharedBranch = cfg.parallel === 'shared-branch'
if (cfg.parallel && !sharedBranch) log(`~/.zodchi/config.json: parallel ${JSON.stringify(cfg.parallel)} is not known; ignored`)
if (sharedBranch) parallelNote = SHARED_NOTE
const currentBranch = String(gate.branch || '').trim()
// The branch the package works on, written into its claim so that another package can see it.
const myBranch = a.branch || currentBranch || '(detached)'
// The review boundary the lead wrote into the brief (docs/review-boundary.md). Without it the run goes on and says so.
const boundaryText = String(gate.boundary || '').trim()
out.reviewLedger = []
if (!boundaryText) out.notes = ['The brief has no "## Review boundary" section: the reviewer judged without a written boundary and may go deeper than the package needs. See docs/review-boundary.md for the section.']
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

if (sharedBranch && a.branch && a.branch !== currentBranch) { out.refused = `args.branch is ${a.branch} but the checkout is on ${currentBranch || 'a detached HEAD'}, and the owner setting parallel "shared-branch" forbids switching branches: switch it yourself before starting, or drop args.branch.`; return out }

const dirtyOverlap = gate.dirty.filter(f => myKeys.includes(key(f)))
if (dirtyOverlap.length) { out.refused = `Uncommitted changes in package files: ${dirtyOverlap.join(', ')}. Commit or stash them first.`; return out }

// The protected checks and REVIEW.md are read from the base commit: both need Git.
if (!gate.git || !/^[0-9a-f]{7,64}$/i.test(String(gate.head || '').trim())) { out.refused = `${a.repo} is not a Git work tree with a commit: code-package reads the protected checks and REVIEW.md from the base commit. Run \`git init\` and commit the current state first.`; return out }
const commit = a.commit !== false
// base, verifySkill and reviewMd describe the branch the package works on: when the claim step switches to args.branch
// (or the ignore repair commits), the body re-reads them there before anything is written
let base = String(gate.head).trim()
let hasVerifySkill = gate.verifySkill === true
let hasReviewMd = gate.reviewMd === true

// Checks: the cheap ones first (args.checks), then the slow run of the real program (args.verify, else the verify skill).
// What verified the round is the slowest of these that ran and passed; with none of them, nothing did.
const asCheck = (c) => typeof c === 'string' ? { cmd: c, pass: 'exit code 0' } : { pass: 'exit code 0', ...c }
const checkList = (a.checks || []).map(asCheck)
const verifyList = [].concat(a.verify || []).map(asCheck)
const pickSource = () => verifyList.length ? 'args.verify' : hasVerifySkill ? 'verify skill' : checkList.length ? 'checks' : 'none'
let verifySource = pickSource()
const NO_SKIP = `Never skip a check, add a sleep or a wait to make it pass, or run it again until it passes. ` +
  `A check that fails without a cause in the change is flaky: report it as flaky with its log; deleting or quarantining a flaky test is the lead's decision.`

// Protected checks: existing files under test/, tests/, e2e/, the verify skill, REVIEW.md and args.protect. New files
// are allowed; a change to an existing one stops the package before review unless args.allowCheckChanges lists it.
const protectKeys = [].concat(a.protect || []).map(key)
const isProtected = (r) => {
  const l = r.toLowerCase()
  return l.split('/').slice(0, -1).some(d => ['test', 'tests', 'e2e'].includes(d)) || l === 'review.md' || l.startsWith('.claude/skills/verify/') ||
    protectKeys.some(p => l === p || l.startsWith(p + '/'))
}
const allowIn = a.allowCheckChanges || []
const allowed = new Set((Array.isArray(allowIn) ? allowIn : Object.keys(allowIn)).map(key))
const PROTECT = ` Protected checks: do not change or delete an existing file under test/, tests/, e2e/ or .claude/skills/verify/, or REVIEW.md` +
  `${protectKeys.length ? `, or under ${JSON.stringify(protectKeys)}` : ''}; adding new test files is allowed. A change to an existing one stops the package before review` +
  `${allowed.size ? `, except ${JSON.stringify([...allowed])}, which the lead allowed` : ''}. ${NO_SKIP}`

// The gateway refuses a job in a repository that does not ignore .agent-tmp/. Found here, before any writing, instead
// of at the first gateway call. Only a package that calls the gateway needs it.
const usesGateway = mode === 'expert' || writer.provider === 'codex' || reviewer.provider === 'codex'
// The printed rule decides: "<file>:<line>:<pattern><TAB>.agent-tmp/gateway/x" proves the folder is ignored, whatever
// exit code the runner reported; a reported exit 0 without that line is not believed either.
const ignoreText = typeof gate.ignoreLine === 'string' ? gate.ignoreLine.trim() : ''
// The tab before the path may come back as spaces in a runner's answer.
const ignoredByLine = /^\S+:\d+:\S.*?[\t ]+\.agent-tmp\/gateway\/x$/.test(ignoreText)
if (ignoredByLine) gate.ignoreExit = 0
else if (gate.ignoreExit === 0) gate.ignoreExit = 1
const needIgnore = usesGateway && gate.ignoreExit !== 0
if (needIgnore) {
  if (gate.ignoreExit !== 1) { out.refused = `Git could not check the ignore rules of ${a.repo} (git check-ignore exit ${gate.ignoreExit}); the gateway works only inside a Git repository.`; return out }
  if (!a.fixIgnore) { out.refused = `${a.repo} does not ignore .agent-tmp/, so the gateway would refuse this package's calls. Add ".agent-tmp/" to its .gitignore and commit it, or run again with args.fixIgnore true.`; return out }
  if (gate.dirty.some(f => key(f) === '.gitignore')) { out.refused = `${a.repo} does not ignore .agent-tmp/ and its .gitignore has uncommitted changes: add ".agent-tmp/" to it by hand.`; return out }
}

// Claiming happens under a lock folder (mkdir is atomic), so two packages started at once cannot both pass. From the
// claim on, whatever happens, the claim is closed at the end and the closing is checked; only a refusal for
// conflicts, which writes no claim, skips that, and an infrastructure failure, after which the run is resumed.
let claimStatus = 'stopped'
let claimWritten = true
// The lock and the comparison with other open claims, worded once for the claim and for every later extension of it.
const LOCK = `1. Lock: run \`mkdir "${claimsDir}/.lock"\` (create "${claimsDir}" with \`mkdir -p\` first if it is missing; $HOME is the shell's home folder, so keep the path in double quotes). If the lock folder already exists, wait 10 seconds and try again, ` +
  `for at most 2 minutes; a lock folder older than 10 minutes is stale: remove it and try again. If you cannot take the lock, return ok false with conflicts ["lock busy"].\n`
const compare = (list) => `2. Read every *.json file in "${claimsDir}". For each one whose "status" is "open" and whose "label" is not "${a.label}", compare its "files" list with this list, ` +
  `entry by entry, as exact strings: ${JSON.stringify(list)}. Every equal pair is a conflict "<its label>: <file>".\n`
const UNLOCK = `4. Always remove the lock folder (\`rmdir "${claimsDir}/.lock"\`), whatever happened above.\n`
// Git commands of this package may meet an index.lock that a command of another package in the same checkout holds for a moment.
const LOCKWAIT = `If a Git command fails with an error that names index.lock (another package's Git command holds it), wait 3 seconds and run the same command again, at most 10 times in all; ` +
  `never delete, move or overwrite the lock file or anything else in .git. If it is still held after the last try, stop with ok false and the summary "index.lock held".`
// The ignore repair changes .gitignore, so the claim holds it too, checked against other open packages like any file.
const claimKeys = needIgnore && !myKeys.includes('.gitignore') ? [...myKeys, '.gitignore'] : myKeys
try {
const claim = await step(
  `Claim files for the package ${a.label} in ${a.repo}. Follow these steps exactly.\n` +
  LOCK + compare(claimKeys) +
  `2b. Branch: for each of those open claims (label not "${a.label}") that has a "branch" field different from ${JSON.stringify(myBranch)} (exact string), add "<its label>: <its branch>" to branchConflicts. ` +
  `A package may not start on another branch while another open package of this repository works on its own: switching would pull the branch from under it. A claim without a "branch" field is not a branch conflict.\n` +
  `3. If there is no conflict and no branch conflict, write "${claimFile}": ${JSON.stringify({ label: a.label, status: 'open', files: claimKeys, branch: myBranch, brief: a.brief, base })}, plus "openedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`.\n` +
  UNLOCK +
  (a.branch && !sharedBranch ? `5. If the claim file was written, switch to the Git branch ${a.branch}: \`git switch ${q(a.branch)}\`, or \`git switch -c ${q(a.branch)}\` when it does not exist.\n` : '') +
  `ok is true when the claim file was written${a.branch && !sharedBranch ? ` and \`git branch --show-current\` prints ${a.branch}` : ''}. conflicts: the file conflicts found, [] when none. branchConflicts: the branch conflicts found, [] when none.`,
  {
    agentType: 'zodchi-core:runner', label: `claim ${a.label}`,
    schema: { type: 'object', required: ['ok', 'conflicts'], properties: { ok: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'string' } }, branchConflicts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
  })
if (claim && !claim.ok && Array.isArray(claim.branchConflicts) && claim.branchConflicts.length) {
  claimWritten = false
  out.refused = `Another open package of this repository works on a different branch (${claim.branchConflicts.join('; ')}) and this one would work on ${myBranch}; switching would pull the branch from under it. ` +
    `Start this package on the same branch, finish the other one first, or run it in a worktree or clone (docs/parallel.md).`
  return out
}
if (claim && claim.conflicts && claim.conflicts.length && claim.conflicts[0] !== 'lock busy' && !claim.ok) {
  claimWritten = false
  out.refused = `Open packages claim the same files: ${claim.conflicts.join('; ')}. Finish them, or close a stale one (status "closed" in ${claimsDir}/<label>.json).`
  return out
}
  if (!claim || !claim.ok) { out.stoppedAt = `claim (${claim ? claim.summary || claim.conflicts.join(', ') : 'no result'})`; return out }
  if (needIgnore) {
    const ignored = await step(
      `Make ${a.repo} ignore the zodchi job folders, in a commit of its own; never push.\n` +
      `1. Append the line \`.agent-tmp/\` to ${repoKey}/.gitignore (create the file when it is missing; when its last line has no line break, add one first, with the line endings the file already uses).\n` +
      `2. Run \`git add -- .gitignore\`, then \`git commit -m "Ignore .agent-tmp (zodchi job folders)" -- .gitignore\`.\n` +
      `3. \`git check-ignore -q .agent-tmp/gateway/x\` must exit 0, and \`git show --name-only --format= HEAD\` must list .gitignore only. ok is true only then. summary: the commit hash. ${LOCKWAIT}`,
      { agentType: 'zodchi-core:runner', schema: STEP, label: `ignore ${a.label}` })
    if (!ignored || !ignored.ok) { out.stoppedAt = `ignore .agent-tmp (${ignored ? ignored.summary : 'no result'})`; return out }
    log(`Committed ".agent-tmp/" in .gitignore: ${ignored.summary}`)
  }
  if (a.branch || needIgnore) {
    // The gate read HEAD and the files before the switch to args.branch and before the ignore commit: read them again on the branch the package works on.
    const now = await step(
      `Read the state of the branch the package works on in ${a.repo}; change nothing. head: \`git rev-parse HEAD\`. branch: \`git branch --show-current\`. ` +
      `verifySkill: true when \`git cat-file -e HEAD:.claude/skills/verify/SKILL.md\` exits 0. reviewMd: true when \`git cat-file -e HEAD:REVIEW.md\` exits 0. ok is true when the commands ran${a.branch ? ` and branch is ${a.branch}` : ''}.`,
      {
        agentType: 'zodchi-core:runner', label: `base ${a.label}`,
        schema: { type: 'object', required: ['ok', 'head', 'verifySkill', 'reviewMd'], properties: { ok: { type: 'boolean' }, head: { type: 'string' }, branch: { type: 'string' }, verifySkill: { type: 'boolean' }, reviewMd: { type: 'boolean' }, summary: { type: 'string' } } },
      })
    if (!now || !now.ok || !/^[0-9a-f]{7,64}$/i.test(String(now.head || '').trim())) { out.stoppedAt = `base (${now ? now.summary || 'no head' : 'no result'})`; return out }
    base = String(now.head).trim()
    hasVerifySkill = now.verifySkill === true
    hasReviewMd = now.reviewMd === true
    verifySource = pickSource()
  }
  await body()
  if (out.openFindings.length && !out.next) out.next = `The last review left ${out.openFindings.length} finding(s) open (openFindings): close them with the writer, or decide on them.`
  return out
} finally {
  if (claimWritten && !keepClaim) {
  const closed = await step(
    `If "${claimFile}" exists ($HOME is the shell's home folder: keep the path in double quotes), set its "status" to "${claimStatus}" and add "closedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`; keep every other field. ` +
    `ok is true when the file does not exist, or when it parses and its status is "${claimStatus}".`,
    { agentType: 'zodchi-core:runner', schema: STEP, label: `close claim ${a.label}` }).catch(() => null)
  if (!closed || !closed.ok) out.claimLeftOpen = `${claimFile}: set "status" to "closed" by hand`
  }
}

async function body() {
  const changed = new Set(myPaths.map(abs))
  const questions = []
  const noteQuestions = (res) => { for (const x of (res && res.questions) || []) if (!questions.includes(x)) questions.push(x); if (questions.length) out.questions = questions }
  // A file the writer reports outside the repository (a smoke test, say) cannot be diffed, attached or committed:
  // it is recorded in out.outsideRepo and named in the review prompt instead of failing the package.
  const outside = []
  const noteChanged = (list) => (list || []).forEach(f => {
    let inside = true
    try { rel(f) } catch { inside = false }
    if (inside) { changed.add(abs(f)); return }
    let shown = String(f).replace(/\\/g, '/')
    try { shown = norm(shown) } catch {}
    if (!outside.includes(shown)) outside.push(shown)
    out.outsideRepo = outside
  })
  const HANDOVER = ` If your context is running out before the task is done, stop at a clean point (files consistent, the progress file says what is done and what remains, precisely enough for a stranger), and return done false with more true; a fresh agent will go on.`
  // One truth about commits, in every prompt that touches the writer's commit state.
  const COMMITS = commit
    ? `The runner commits the package files after passing checks as "${a.label}: round N"; the writer never commits.`
    : `Nothing is committed in this run; the writer never commits.`

  // A long package can outgrow one agent's context. The agent may hand over (more: true) at a clean point, or it may
  // end without a result; either way a fresh agent goes on from the same progress file, up to a.continuations times.
  async function continued(prompt, opts) {
    const pinned = { ...opts, progress: opts.label }
    let res = null
    const changedSoFar = [], questionsSoFar = []
    for (let c = 0; c <= (a.continuations ?? 2); c++) {
      const o = c ? { ...pinned, label: `${opts.label} (cont ${c})` } : pinned
      try { res = await step(prompt, o) } catch (e) { log(`${o.label}: ${e.message}`); res = null }
      if (res) { changedSoFar.push(...(res.changed || [])); questionsSoFar.push(...(res.questions || [])) }
      if (res && !res.more) break
    }
    return res && { ...res, changed: [...new Set(changedSoFar)], questions: [...new Set(questionsSoFar)] }
  }

  // One writing turn by the resolved writer: a Claude coder, a Codex work call, or an expert answer applied by the
  // applier. evidence: files the task refers to (review, logs); a tool-free expert gets them attached.
  let calls = 0
  async function write(job, tag, phaseName, evidence = []) {
    const n = ++calls
    const task = `${job} ${COMMITS}${sharedBranch ? ` ${SHARED_NOTE}` : ''}${PROTECT}`
    if (mode === 'expert') {
      const ask = await step(
        `Ask an expert for the code through the gateway. Work from ${a.repo}. Write ${a.tmp}/expert-${n}.md: ${task} ` +
        `The expert has no tools: everything it needs is attached. Then ` +
        gatewayCall({
          role: 'code-patch', key: `${a.label}-expert-${n}`, label: `${tag} ask`, totalMin: 55, out: `${a.tmp}/expert-${n}.answer.md`,
          args: `--model ${writer.model} --effort ${writer.effort} --prompt ${q(`${a.tmp}/expert-${n}.md`)}`,
          attach: [a.brief], attachIfExists: [...evidence, ...changed],
        }) + ` ` +
        `ok is true when the job succeeded and the answer file exists. paths: the answer file. ${INFRA}`,
        { agentType: 'zodchi-core:runner', schema: withInfra(STEP), phase: phaseName, label: `${tag} ask` })
      if (infraBad(ask)) infraFail(`${tag} ask`, ask ? (ask.infra || 'gateway: failed') : 'the gateway step returned no result')
      if (!ask.ok) return null
      return step(
        `Apply one expert answer. Answer file: ${a.tmp}/expert-${n}.answer.md. Target files: the ones the answer names, relative to ${a.repo}. ` +
        `Ledger of edits: ${a.tmp}/apply-${n}.md. Backup folder: ${a.tmp}/backup-${n}. Syntax checks after applying: the one that fits each target's language. ` +
        `done is true only when every edit row has a line number and the checks are clean. changed: the target files, absolute paths. unverified: rows not applied.`,
        { agentType: 'zodchi-core:applier', schema: WRITE, phase: phaseName, label: `${tag} apply` })
    }
    if (writer.provider === 'codex') {
      const work = await step(
        `Have Codex do this through the gateway. Work from ${a.repo}. Write ${a.tmp}/work-${n}.md: ${task} ` +
        `Then ` +
        gatewayCall({
          role: 'package-work', key: `${a.label}-work-${n}`, label: tag, totalMin: 60, out: `${a.tmp}/work-${n}.json`,
          args: `--model ${writer.model} --effort ${writer.effort} --prompt ${q(`${a.tmp}/work-${n}.md`)}`,
          attach: [a.brief, ...evidence],
        }) + ` The answer is JSON with status, summary, criteria, questions, changedFiles, checks. Map it exactly: ` +
        `done = (status is "done"); summary = its summary; changed = each entry of changedFiles prefixed with "${repoKey}/"; ` +
        `unverified = every criterion that is not done, as one line each, plus every check with a non-zero exit code; questions = each entry of its questions as one readable line (the question, its options, the recommendation). ` +
        `If the job did not succeed, done is false and summary says the job status. ${INFRA}`,
        { agentType: 'zodchi-core:runner', schema: withInfra(WRITE), phase: phaseName, label: `${tag}` })
      if (infraBad(work)) infraFail(tag, work ? (work.infra || 'gateway: failed') : 'the gateway step returned no result')
      return work
    }
    return continued(task + HANDOVER, { agentType: 'zodchi-core:coder', model: writer.model, schema: WRITE, phase: phaseName, label: tag })
  }

  // The claim follows the real change: after every Write and Close, the files the writer reports and the files Git
  // sees changed join the claim and the package. Neither source brings in the job folder .agent-tmp/ or a file already
  // dirty at the gate; a reported file of that second kind stops the run, because committing it would commit somebody
  // else's changes. A reported file another open package claims stops the run too. Either way the work stays uncommitted for a human.
  // Several packages may share one checkout: a file that only Git's status lists (the writer did not report it) and that
  // another open package claims is that package's work, not ours: it stays out of the claim and out of every commit.
  const atGate = new Set(gate.dirty.map(f => { try { return key(f) } catch { return '' } }))
  const jobFolder = (r) => /^\.agent-tmp(\/|$)/i.test(r)
  const claimed = new Set(claimKeys)
  const foreign = new Set()
  const uniqueNew = (list) => [...new Map(list.filter(r => !claimed.has(r.toLowerCase())).map(r => [r.toLowerCase(), r])).values()]
  async function followClaim(res, tag, phaseName) {
    const found = []
    for (const f of res.changed || []) {
      let r
      try { r = rel(f) } catch { noteChanged([f]); continue }
      if (!jobFolder(r)) found.push(r)
    }
    const touched = found.filter(r => atGate.has(r.toLowerCase()))
    if (touched.length) {
      out.stoppedAt = `dirty file changed at ${tag}`
      out.next = `The work changed files that had uncommitted changes before the package started: ${touched.join(', ')}. This round's work is not committed: it stays in ${a.repo} for a human to separate from the earlier changes.`
      return false
    }
    const st = await step(
      `List what changed in the work tree of ${a.repo}; change nothing. Run \`git status --porcelain -uall\`. ` +
      `paths: every path it lists, relative to the repository, without the status letters and quotes (a rename gives both paths); [] when it lists nothing. ok is true when the command ran.`,
      { agentType: 'zodchi-core:runner', schema: STATUS, phase: phaseName, label: `status ${tag}` })
    // A missing list is not a clean work tree: unreported files would escape the claim and the review.
    if (!st || !st.ok || !Array.isArray(st.paths)) { out.stoppedAt = `git status after ${tag}${st && st.ok ? ' (no paths list)' : ''}`; return false }
    const reported = found.slice()
    const seen = []
    for (const p of st.paths) {
      let r
      try { r = rel(p) } catch { continue }
      if (!atGate.has(r.toLowerCase()) && !jobFolder(r) && !foreign.has(r.toLowerCase())) seen.push(r)
    }
    const hard = uniqueNew(reported)
    const hardKeys = hard.map(r => r.toLowerCase())
    const soft = uniqueNew(seen).filter(r => !hardKeys.includes(r.toLowerCase()))
    if (!hard.length && !soft.length) { noteChanged([...reported, ...seen]); return true }
    const hardList = JSON.stringify(hardKeys), softList = JSON.stringify(soft.map(r => r.toLowerCase()))
    const more = await step(
      `Extend the claim of the package ${a.label} by files its work changed. Follow these steps exactly.\n` +
      LOCK +
      `2. Read every *.json file in "${claimsDir}". For each one whose "status" is "open" and whose "label" is not "${a.label}", compare its "files" list with these two lists, entry by entry, as exact strings. ` +
      `hard: ${hardList} (files the writer reported as changed). soft: ${softList} (files Git shows changed that the writer did not report). ` +
      `Every hard file that another package lists is a conflict "<its label>: <file>". Every soft file that another package lists is that package's own work in the shared checkout: it is not ours and never a conflict; list it in others.\n` +
      `3. If there is no conflict, add each hard file and each soft file that is not in others to the "files" list of "${claimFile}" when it is missing; keep every other field and entry.\n` +
      UNLOCK +
      `ok is true when there was no conflict and "${claimFile}" lists every hard file and every soft file that is not in others. conflicts: the conflicts found, [] when none. others: the soft files another package lists, [] when none.`,
      {
        agentType: 'zodchi-core:runner', phase: phaseName, label: `claim more ${tag}`,
        schema: { type: 'object', required: ['ok', 'conflicts', 'others'], properties: { ok: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'string' } }, others: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
      })
    if (more && !more.ok && more.conflicts && more.conflicts.length && more.conflicts[0] !== 'lock busy') {
      out.conflicts = more.conflicts
      out.stoppedAt = 'claim conflict'
      out.next = `The work changed files that another open package claims: ${more.conflicts.join('; ')}. This round's work is not committed: it stays in ${a.repo} for a human to settle with that package.`
      return false
    }
    if (!more || !more.ok) { out.stoppedAt = `claim more (${more ? more.summary || (more.conflicts || []).join(', ') : 'no result'})`; return false }
    // An answer without the others list cannot tell which soft files are another package's: nothing is recorded or committed.
    if (!Array.isArray(more.others)) { out.stoppedAt = 'claim more (the answer has no others list)'; return false }
    // Only a soft file the runner names is another package's; the match is by the lower-case path, as claims are kept.
    const others = new Set(more.others.map(o => String(o).toLowerCase()).filter(o => soft.some(r => r.toLowerCase() === o)))
    for (const o of others) foreign.add(o)
    const mine = [...hard, ...soft.filter(r => !others.has(r.toLowerCase()))]
    for (const r of mine) claimed.add(r.toLowerCase())
    noteChanged([...reported, ...seen.filter(r => !others.has(r.toLowerCase()))])
    if (mine.length) {
      out.claimAdded = [...(out.claimAdded || []), ...mine]
      log(`Claim of ${a.label} extended by ${mine.join(', ')}`)
    }
    if (others.size) log(`Left out of ${a.label}: ${[...others].join(', ')} (claimed by another open package, changed in the shared checkout)`)
    return true
  }

  // After every write: the claim follows the change, then the protected checks are compared with the base commit.
  async function follow(res, tag, phaseName) {
    return (await followClaim(res, tag, phaseName)) && (await guard(tag, phaseName))
  }
  const GUARD = { type: 'object', required: ['ok', 'summary', 'results'], properties: { ok: { type: 'boolean' }, summary: { type: 'string' },
    results: { type: 'array', items: { type: 'object', required: ['path', 'existedExit', 'diffExit'], properties: { path: { type: 'string' }, existedExit: { type: 'number' }, diffExit: { type: 'number' } } } } } }
  async function guard(tag, phaseName) {
    const candidates = [...changed].map(rel).filter(isProtected)
    if (!candidates.length) return true
    const res = await step(
      `Compare files with the base commit ${base} in ${a.repo}; change nothing. Paths, relative to the repository: ${JSON.stringify(candidates)}. ` +
      `For each path: it existed before when \`git cat-file -e ${base}:<path>\` exits 0; it differs now when \`git diff --quiet ${base} -- <path>\` exits 1 (changed or deleted). ` +
      `results: one entry per path, in the order given: { path (exactly as given), existedExit (the exit code of git cat-file -e), diffExit (the exit code of git diff --quiet) }. Report the exit codes only; do not judge. ok is true when every command ran.`,
      { agentType: 'zodchi-core:runner', schema: GUARD, phase: phaseName, label: `protect ${tag}` })
    const rows = res && res.ok && Array.isArray(res.results) ? res.results.filter(r => r && candidates.includes(String(r.path))) : null
    if (!rows || rows.length !== candidates.length) { out.stoppedAt = `protected checks after ${tag} (${res ? res.summary || 'no exit codes for every path' : 'no result'})`; return false }
    // existed before (exit 0) and differs now (exit 1): the decision is the workflow's, from the exit codes
    const hit = rows.filter(r => r.existedExit === 0 && r.diffExit === 1).map(r => String(r.path))
    const isAllowed = (p) => { try { return allowed.has(key(p)) } catch { return false } }
    const ok = hit.filter(isAllowed)
    if (ok.length) out.checkChanges = [...new Set([...(out.checkChanges || []), ...ok])]
    const bad = hit.filter(p => !isAllowed(p))
    if (!bad.length) return true
    out.protectedChanged = bad
    out.stoppedAt = `protected checks changed at ${tag}`
    out.next = `The work changed or deleted existing checks: ${bad.join(', ')}. A change must not edit the checks that judge it, so the package stopped before review; this round's work is not committed and stays in ${a.repo}. ` +
      `If the change is right (a test of behaviour the brief changes on purpose, a flaky test you decided to delete), run again with args.allowCheckChanges listing those paths; otherwise have the writer restore them.`
    return false
  }

  phase('Write')
  out.write = await write(
    `Implement the package described in ${a.brief}. Read it first; it is the whole task. ` +
    `done is true only when everything the brief calls "done" holds and you ran what it tells you to run. changed: every file you changed, absolute paths. unverified: what you could not verify, in the order to check it; a flaky check as "flaky: <command>: <its log>".`,
    `write ${a.label}`, 'Write')
  if (out.write && !(await follow(out.write, `write ${a.label}`, 'Write'))) return
  if (!out.write || !out.write.done) {
    out.stoppedAt = 'write'
    noteQuestions(out.write)
    if (questions.length) out.question = questions.join(' | ')
    return
  }
  noteQuestions(out.write)

  const CAUSE = `cause: "none" when ok; otherwise the first failure's cause - "code" when the changed code is wrong (traceback, compile error, failed assertion, a gate of the change), ` +
    `"check" when the command or its pass rule is wrong although the code works, ` +
    `"environment" when the machine stopped it (a lock held by another process, memory, a missing tool), ` +
    `"flaky" when it failed without a cause in the change (say why in results, with the log line).`
  const REPORT = `results: one line per command with its exit code, the decisive output line and pass/fail. logs: the log paths. ` +
    `evidence: one entry per command you ran: command, exitCode (its real exit code), log (the path of its log, trace or screenshot). ${NO_SKIP} ${CAUSE}`
  const runList = (what, tag, label) => step(
    `Run ${what} from ${a.repo}, in order, each to its end, one log per command in ${a.tmp}/logs. A command passes when its output meets its "pass" rule (exit code 0 for a step of a skill). ` +
    `ok is true only when every one passes. ${REPORT}`,
    { agentType: 'zodchi-core:runner', schema: CHECKS, phase: 'Checks', label: `${label} ${tag}` })
  // The cheap checks first; a failure there goes back to the writer without the slow run.
  const runChecks = async (tag) => {
    const cheap = checkList.length ? await runList(`these checks: ${JSON.stringify(checkList)}`, tag, 'checks') : { ok: true, results: [], evidence: [], cause: 'none' }
    const withSource = (r, source) => r && { ...r, evidence: (r.evidence || []).map(e => ({ ...e, source })) }
    if (!cheap || !cheap.ok || verifySource === 'checks' || verifySource === 'none') return withSource(cheap, 'checks')
    const slow = await runList(verifyList.length
      ? `these verify commands, the real program end to end: ${JSON.stringify(verifyList)}`
      : `the repository's verify skill: read .claude/skills/verify/SKILL.md, start the app the way it says and drive the flow it names, running its commands`, tag, 'verify')
    return slow && { ...slow, results: [...(cheap.results || []), ...(slow.results || [])], logs: [...(cheap.logs || []), ...(slow.logs || [])], evidence: [...withSource(cheap, 'checks').evidence, ...withSource(slow, verifySource).evidence] }
  }

  async function checked(n) {
    let checks = await runChecks(n)
    for (let f = 1; checks && !checks.ok && checks.cause === 'code' && f <= (a.fixes ?? 1); f++) {
      const fix = await write(
        `The checks of the package ${a.brief} failed after the change. Results: ${JSON.stringify(checks.results)}. Logs: ${JSON.stringify(checks.logs || [])}. ` +
        `Read the logs and fix the code with the smallest change. done is true when the failing command passes. changed: files changed in this fix.`,
        `fix checks ${n}.${f}`, 'Close', checks.logs || [])
      noteQuestions(fix)
      if (fix && !(await follow(fix, `fix checks ${n}.${f}`, 'Close'))) return 'halted'
      if (!fix || !fix.done) { if (questions.length) out.question = questions.join(' | '); break }
      checks = await runChecks(`${n}.${f}`)
    }
    return checks
  }

  // A path-limited commit: other staged work in the index stays out of it, and the runner verifies that. Its message
  // ends with how the round was verified, so `git log --grep "Verified: none"` finds the commits nothing ran.
  let commitNote = ''
  async function commitRound(n) {
    if (!commit) return true
    const paths = [...changed].map(rel)
    const res = await step(
      `Commit the package's files in ${a.repo}; never push. The package paths, relative to the repository: ${JSON.stringify(paths)}.\n` +
      `1. For each path that exists, or that Git tracks and is now deleted, run \`git add -A -- <path>\`; skip a path that is neither.\n` +
      `2. If \`git diff --cached --quiet -- <those paths>\` says nothing changed, return ok true with summary "nothing to commit".\n` +
      `3. Otherwise run \`git commit -m ${q(`${a.label}: round ${n}`)} -m ${q(out.verification.stamp)} -- <those paths>\` (the paths after -- limit the commit to them; other staged files stay staged and out of it).\n` +
      `4. Run \`git show --name-only --format= HEAD\`: every listed file must be one of the package paths. ok is true only then. summary: the commit hash. paths: the listed files.\n` +
      `Other packages may share this checkout: never commit with -a, never \`git add\` a path that is not listed above, and leave every other file, staged or not, as it is. ${LOCKWAIT}`,
      { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Checks', label: `commit ${n}` })
    commitNote = res && !res.ok ? res.summary || '' : ''
    return Boolean(res && res.ok)
  }

  // Review diffs come from Git, deleted files included; only attachments of current files need the file to exist.
  const diffHow = `\`git diff ${base} -- <files>\` over the package paths below (this includes deleted files), plus \`git diff --no-index /dev/null <file>\` for each untracked new one`
  // REVIEW.md, the owner's written focus for reviews, always as of the base commit: the package cannot change what judges it.
  const focusFile = `${a.tmp}/REVIEW.base.md`
  const FOCUS = hasReviewMd
    ? `REVIEW.md as of the base commit is attached as REVIEW.base.md: apply it, it says what the owner wants flagged and what not`
    : `The base commit has no REVIEW.md: judge by the brief`
  // The review boundary the lead wrote into the brief, quoted next to REVIEW.md (docs/review-boundary.md).
  const BOUNDARY = boundaryText
    ? `The brief's "Review boundary" section, written by the lead, says what is important for this package and what is out of scope; apply it. Quoted exactly: ${JSON.stringify(boundaryText)}. ` +
      `A point outside it is at most a "nit" or "pre-existing" finding, never "important"; do not go deeper than the boundary draws the line`
    : `The brief has no "Review boundary" section: judge by the brief, and call a point "important" only when a normal run of the change meets it`
  const SEVERITIES = `Every finding has a severity: "important" (a real defect the change brings in; it blocks approval), "nit" (worth fixing, does not block) or "pre-existing" (it was there before the change; does not block).`

  // focus: the nit findings of an approved review that the writer closed (args.closeShouldFix); the next review
  // checks only those. carried: open findings of an earlier review that a focused review does not look at again; they
  // stay open through focused reviews and go to the next full review, which repeats those that still hold.
  let focus = null
  let carried = []

  // The review ledger and the boundary rule (docs/review-boundary.md). A finding is "<id> <severity> <location>: <problem>";
  // it is the same finding in another round when its id and location are the same (the line number after the file is
  // dropped: a fix moves lines). A round from the second on that brings only important findings no earlier round had,
  // while every earlier important one is closed, only goes deeper: the run stops there instead of spending another round.
  const parseFinding = (f) => {
    const m = String(f).trim().match(/^(\S+)\s+(\S+)\s+([\s\S]*)$/)
    if (!m) return { id: String(f).trim(), severity: severity(f), location: '', problem: '' }
    const i = m[3].indexOf(': ')
    const location = (i >= 0 ? m[3].slice(0, i) : m[3].split(/\s+/)[0]).trim()
    return { id: m[1], severity: severity(f), location, problem: (i >= 0 ? m[3].slice(i + 2) : m[3].slice(location.length)).trim() }
  }
  const locKey = (l) => l.toLowerCase().replace(/\\/g, '/').replace(/(:\d+(-\d+)?)+$/, '').replace(/#l\d+(-l?\d+)?$/, '').trim()
  const findingKey = (p) => `${p.id.toLowerCase()}|${locKey(p.location)}`
  const ledger = new Map()
  // The highest number among the ids of every round so far: a new id goes above it, so it never matches a closed finding.
  const maxLedgerId = () => [...ledger.values()].reduce((m, e) => Math.max(m, Number((String(e.id).match(/(\d+)$/) || [])[1]) || 0), 0)
  // What the writer was sent after the last review, and whether its answer changed any file.
  let lastClose = { sent: new Set(), changed: false }
  const today = (() => { try { return new Date().toISOString().slice(0, 10) } catch { return '<date>' } })()
  // judged: the review approved or requested changes with findings; a blocked review, or one with no verdict, could not
  // judge the package, so it closes nothing.
  const updateLedger = (n, parsed, focusKeys, judged) => {
    const now = new Set(parsed.map(findingKey))
    for (const p of parsed) {
      const e = ledger.get(findingKey(p))
      if (e) {
        Object.assign(e, { severity: p.severity, problem: p.problem || e.problem, lastRound: n, status: 'open' })
        delete e.closedInRound; delete e.closedBy
      } else {
        const ne = { id: p.id, severity: p.severity, location: p.location, problem: p.problem, firstRound: n, lastRound: n, status: 'open' }
        ledger.set(findingKey(p), ne)
        out.reviewLedger.push(ne)
      }
    }
    // A full review looks at everything; a focused one only at the findings it was asked about.
    if (!judged) return
    for (const [k, e] of ledger) {
      if (e.status !== 'open' || now.has(k) || e.firstRound >= n || (focusKeys && !focusKeys.has(k))) continue
      e.closedInRound = n
      if (lastClose.sent.has(k)) { e.status = 'closed'; e.closedBy = lastClose.changed ? 'code change' : 'answered without a code change' }
      else { e.status = 'dropped'; e.closedBy = 'not reported by a later review' }
    }
  }
  const proposedLine = (p) => `- Do not flag: ${p.problem || p.id} (${p.location || 'no location'}). Why: <one sentence: it is out of the review boundary of the package ${a.label}, because ...>. Added ${today}.`

  for (let n = 1; n <= rounds; n++) {
    const focused = focus
    const checks = await checked(n)
    if (checks === 'halted') return
    if (!checks || !checks.ok) {
      out.rounds.push({ n, checks })
      out.verifiedBy = 'none'
      out.verification = { verifiedBy: 'none', evidence: (checks && checks.evidence) || [], note: `not verified by running: the checks of round ${n} failed`, stamp: 'Verified: none' }
      if (checks && checks.cause === 'flaky') out.next = `A check failed without a cause in the change (flaky): ${JSON.stringify(checks.results || [])}, logs ${JSON.stringify(checks.logs || [])}. Nothing was retried or skipped. Fix the check, or decide to delete or quarantine it (args.allowCheckChanges).`
      out.stoppedAt = `checks (${checks ? checks.cause : 'no result'})`
      return
    }
    // A positive Verified line needs receipts: evidence that is not empty, every entry with an exit code. The public stamp
    // names only the source and the exit codes; the commands stay in verification.evidence and the reviewer's context.
    const evidence = checks.evidence || []
    const receipts = evidence.length > 0 && evidence.every(e => e && typeof e.exitCode === 'number')
    const source = receipts ? verifySource : 'none'
    const parts = []
    for (const e of evidence) if (receipts && !parts.some(p => p.source === e.source)) parts.push({ source: e.source, codes: [...new Set(evidence.filter(x => x.source === e.source).map(x => x.exitCode))] })
    out.verifiedBy = source
    out.verification = {
      verifiedBy: source, evidence,
      note: source !== 'none' ? '' : verifySource === 'none' ? 'not verified by running: no args.verify, no verify skill and no checks' : 'not verified by running: the runner reported no evidence with an exit code for every command',
      stamp: source === 'none' ? 'Verified: none' : `Verified: ${parts.map(p => `${p.source} exit ${p.codes.join('/')}`).join('; ')}`,
    }
    if (!(await commitRound(n))) { out.stoppedAt = commitNote ? `commit (${commitNote})` : 'commit'; return }

    const context = `what the change does and why (from ${a.brief} and this summary: ${JSON.stringify(out.write.summary)}), what is verified and what is not ` +
      `(${JSON.stringify(out.write.unverified || [])}), how the runner verified it (${out.verification.stamp}${out.verification.note ? `: ${out.verification.note}` : ''}${evidence.length ? `; commands: ${evidence.map(e => `${e.command} exit ${e.exitCode}`).join(', ')}` : ''})` +
      `${outside.length ? `, and the files changed outside the repository, not attached: ${JSON.stringify(outside)}` : ''}${n > 1 ? `, and which findings of the previous review (${a.tmp}/review-${n - 1}.json) were closed and how` : ''}` +
      (focus ? `. This is a short review of the approved change: check only whether these findings of ${a.tmp}/review-${n - 1}.json are closed and whether their fixes break anything: ${JSON.stringify(focus)}; approved when they are closed and nothing broke` : '') +
      (!focus && carried.length ? `. These findings of an earlier review are still open and no later review checked them: ${JSON.stringify(carried)}; repeat in your findings, with the same id, severity and location, each one that still holds` : '') +
      (commit ? `. The round's commit exists: "${a.label}: round ${n}" (a round that changed nothing has none); the package's commits sit on top of ${base}; commits of other packages in a shared checkout may lie between them, judge only the package paths` : '') +
      (n > 1 ? `. Keep the id of a finding of an earlier review that still holds (same id, same location), and give every new finding an id never used in any earlier round: number it on after F${maxLedgerId()}. Ids used so far, with their locations: ${JSON.stringify([...ledger.values()].map(e => `${e.id} ${e.location}`))}` : '') +
      `. ${SEVERITIES} ${FOCUS}. ${BOUNDARY}`
    const files = [...changed]
    const VERDICT = `verdict: the "verdict" field of the review exactly ("approved", "changes_requested" or "blocked"; "missing" when the review file has none). ` +
      `summary: its summary. findings holds the reviewer's findings only, each as "<id> <severity> <location>: <problem>": an empty array when it has none. blocking: the count of important findings.`
    const review = reviewer.provider === 'codex'
      ? await step(
        `Get an independent review of a finished change through the gateway. Work from ${a.repo}. Write ${a.tmp}/review-${n}.md: ${context}. ` +
        `Save the change as ${a.tmp}/change-${n}.diff with ${diffHow}: ${JSON.stringify(files.map(rel))}. ` +
        (hasReviewMd ? `Save REVIEW.md as of the base commit: \`git show ${base}:REVIEW.md > ${q(focusFile)}\`; if that fails, do not call the gateway: return gateway "failed" with infra "REVIEW.md export failed: <the error>". ` : '') +
        `Then ` +
        gatewayCall({
          role: 'code-review', key: `${a.label}-review-${n}`, label: `review ${n}`, totalMin: 55, out: `${a.tmp}/review-${n}.json`,
          args: `--model ${reviewer.model} --effort ${reviewer.effort} --prompt ${q(`${a.tmp}/review-${n}.md`)}`,
          attach: [`${a.tmp}/change-${n}.diff`, a.brief, ...(n > 1 ? [`${a.tmp}/review-${n - 1}.json`] : []), ...(hasReviewMd ? [focusFile] : [])],
          attachIfExists: files,
        }) + ` ` +
        `A changed file that does not exist now is left out of --attach (the diff already carries deletions). ` +
        `${VERDICT} reviewFile: the review file path. Change no code. ${INFRA} ` +
        `A job that reached a final status but left no review with a verdict (verdict "missing") is an infrastructure failure too: infra is "the review has no verdict: <the review file, or the job status>", with the INFRA line in the progress file.`,
        { agentType: 'zodchi-core:runner', schema: withInfra(REVIEW), phase: 'Review', label: `review ${n}` })
      : await step(
        `You are an independent code reviewer; you did not write this change. Work from ${a.repo} and change nothing. Read ${a.brief}, then the change: ${diffHow}, for these paths: ${JSON.stringify(files.map(rel))}. ` +
        (hasReviewMd ? `Read the repository's REVIEW.md as of the base commit, never the work tree's: \`git show ${base}:REVIEW.md\`. ` : '') +
        `Context: ${context}. Look for correctness bugs, broken contracts, missing checks and unsafe operations; style only when it hides a bug. ` +
        `Write the review to ${a.tmp}/review-${n}.json as {"verdict": "approved" | "changes_requested" | "blocked", "summary": ..., "findings": [{"id": "F1", "severity": "important|nit|pre-existing", "location": ..., "problem": ..., "fix": ...}]}; ` +
        `approved only when no important finding is open, blocked when the change cannot be judged. ${VERDICT} reviewFile: the path you wrote.`,
        { model: reviewer.model, schema: REVIEW, phase: 'Review', label: `review ${n}` })
    out.rounds.push({ n, checks, review, verification: out.verification })
    if (!review) infraFail(`review ${n}`, 'the review step returned no result')
    // Only a review through the gateway reports the gateway outcome; a Claude reviewer has no gateway field.
    const viaGateway = reviewer.provider === 'codex'
    if ((viaGateway && infraBad(review)) || review.verdict === 'missing') infraFail(`review ${n}`, (viaGateway && review.gateway !== 'final' && review.infra) || `the review has no verdict (${review.summary || 'no summary'}; ${review.reviewFile || `${a.tmp}/review-${n}.json`})`)
    // A focused review leaves the carried findings as they were; a full review was given them and repeats those that
    // still hold, so after it they are its own findings.
    if (!focused) carried = []
    const findings = (review.findings || []).map(normFinding)
    out.openFindings = [...carried, ...findings]
    // Only important findings block approval and count against the stop rule; the reviewer's word does not decide.
    const important = findings.filter(f => severity(f) === 'important')
    const nits = findings.filter(f => severity(f) === 'nit')
    const parsed = findings.map(parseFinding)
    const seenBefore = new Set(ledger.keys())
    const judged = review.verdict === 'approved' || (review.verdict === 'changes_requested' && findings.length > 0)
    updateLedger(n, parsed, focused && new Set(focused.map(f => findingKey(parseFinding(f)))), judged)
    out.verdict = review.verdict === 'blocked' || (review.verdict === 'changes_requested' && !findings.length) ? 'blocked' : important.length ? 'changes_requested' : 'approved'
    out.rounds[out.rounds.length - 1].verdict = out.verdict
    let task
    if (out.verdict === 'approved') {
      if (!nits.length || !a.closeShouldFix || n === rounds) {
        out.approved = true
        claimStatus = 'done'
        if (out.openFindings.length) out.next = `Approved with ${out.openFindings.length} open finding(s) in openFindings` +
          (!nits.length ? ' (none is nit): read them and decide.'
            : a.closeShouldFix ? `; the ${rounds} review rounds are used up, so the nit ones stay open: close them in a new package or by hand.`
            : '; the nit ones were not closed: run again with closeShouldFix true, or close them by hand.')
        return
      }
      focus = nits
      carried = out.openFindings.filter(f => !nits.includes(f))
      task = `Close these nit findings of the approved review ${a.tmp}/review-${n}.json for the package ${a.brief}: ${JSON.stringify(nits)}. Fix each in the reviewer's sense with the smallest change; ` +
        `a finding you reject, say why instead of changing code. Leave every other finding alone. done is true when each of them is closed or answered. changed: files changed this round.`
    } else if (out.verdict === 'blocked') {
      out.stoppedAt = `review verdict ${review.verdict}${findings.length ? '' : ' without findings'}`
      out.question = `The reviewer could not approve or name what to change (${review.verdict}): ${review.summary || ''} See ${a.tmp}/review-${n}.json.`
      return
    } else if (n >= 2 && !parsed.filter(p => p.severity === 'important').some(p => seenBefore.has(findingKey(p))) &&
      ![...ledger.values()].some(e => e.severity === 'important' && e.firstRound < n && e.status === 'open')) {
      // Every important finding of this round is new and every earlier important one is closed: the review only goes deeper.
      const fresh = parsed.filter(p => p.severity === 'important')
      for (const p of fresh) ledger.get(findingKey(p)).status = 'to sort'
      out.stoppedAt = 'review went deeper'
      out.boundary = fresh.map(p => ({
        finding: `${p.id} ${p.severity} ${p.location}: ${p.problem}`, id: p.id, location: p.location, problem: p.problem,
        decide: 'fix | out of scope', ifOutOfScope: proposedLine(p),
      }))
      out.question = `Round ${n} found ${fresh.length} new important finding(s) and no earlier important one is open: the review only goes deeper, so no further round was spent. ` +
        `Sort each into "fix" or "out of scope" (boundary); the findings are in ${a.tmp}/review-${n}.json. For an out-of-scope one, add its ifOutOfScope line, completed, to REVIEW.md by hand: this workflow never edits REVIEW.md.`
      out.next = `Read boundary: a finding to fix goes to a new package or to the writer; an out-of-scope one gets its proposed REVIEW.md line (what not to flag, why, date), so the next review leaves it alone. ` +
        `The commits of rounds 1 to ${n} are in place; the last round's findings were not given to the writer.`
      return
    } else if (n === rounds) {
      out.stoppedAt = `stop rule: ${rounds} review rounds without approval`
      out.question = `The package has important findings after ${rounds} rounds: ${important.join(' | ')}. Decide: accept as is, change the brief, or mark it hard and start again.`
      return
    } else {
      focus = null
      task = `Close the important findings of the review ${a.tmp}/review-${n}.json for the package ${a.brief}: ${JSON.stringify(important)}. Fix each in the reviewer's sense with the smallest change; ` +
        `a finding you reject, say why instead of changing code. Leave nit and pre-existing findings alone. done is true when every important finding is closed or answered. changed: files changed this round.`
    }

    const fix = await write(task, `close ${n}`, 'Close', [`${a.tmp}/review-${n}.json`])
    noteQuestions(fix)
    if (fix && !(await follow(fix, `close ${n}`, 'Close'))) return
    lastClose = { sent: new Set((focus ? nits : important).map(f => findingKey(parseFinding(f)))), changed: Boolean(fix && (fix.changed || []).length) }
    if (!fix || !fix.done) { out.stoppedAt = 'close'; if (questions.length) out.question = questions.join(' | '); return }
    out.write = { ...out.write, summary: `${out.write.summary} | round ${n} fixes: ${fix.summary}`, unverified: fix.unverified || out.write.unverified }
  }
}
