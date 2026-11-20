export const meta = {
  name: 'code-package',
  description: 'One code package: a gate resolves the role table and refuses overlapping packages, the writer implements, a runner runs the cheap checks and then the verify commands or skill, an independent reviewer reviews with the REVIEW.md of the base commit, the writer closes findings; stops after 3 review rounds, or earlier when a round only goes deeper (review boundary)',
  whenToUse: 'Any code package from a finished brief. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'one helper command of the loaded plugin copy prints the role table, the subscription limits, open packages, Git state and whether .agent-tmp/ is ignored (a stale claim of a finished package is closed); the runner returns its output, then the helper compares and writes the claim under the claims lock', model: 'haiku' },
    { title: 'Write', detail: 'writer implements the brief (agent mode) or an expert answers and the applier applies it (expert mode)' },
    { title: 'Checks', detail: 'runner runs the cheap checks, then the verify commands or skill, and commits the package files with a Verified line', model: 'haiku' },
    { title: 'Review', detail: 'reviewer (never the author) reviews the change through the gateway, applying REVIEW.md from the base commit', model: 'haiku' },
    { title: 'Close', detail: 'the same writer closes the findings' },
  ],
}

// args:
//   label     short name, also the prefix of gateway keys (<label>-<base7>-<run>-<kind>-<n>, with the package base commit and an id of the run in it: a new run of a used
//             label never meets the keys of an earlier run) and the name of the package claim, e.g. "export-csv"
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
//             A list of labels means attempt 2 for each. A step that stopped as an unknown outcome (a gateway job that
//             ended "unknown": the request may already have run) is named the same way, and running it again is the
//             person's decision to pay once more: the workflow never submits again by itself after "unknown"
//   pluginRoot  optional: the folder of the zodchi-core plugin copy to take the gate helper (scripts/gate.mjs) from. Without it
//             the helper is looked up, in this order, in $ZODCHI_PLUGIN_ROOT, $CLAUDE_PLUGIN_ROOT, and the install that
//             Claude Code's registration (installed_plugins.json) names for zodchi-core; never in a checkout. A copy
//             without the helper stops the run at the gate with the places it looked at
//
// result: { label, mode, models, rounds[], write, verdict, approved, openFindings[], verifiedBy, verification, next,
//           stoppedAt, refused, question, questions, conflicts, claimAdded, outsideRepo, claimLeftOpen, protectedChanged,
//           checkChanges, notes, boundary, reviewLedger, pluginCopy, workflow, choice, effort, closedClaims, unknown }
//   pluginCopy    always present once the gate ran: { path, commit, version, via }, the plugin copy the helper came from
//   workflow      always present once the gate ran: { build, copyBuild, copyCommit }, this script's build stamp next to the stamp of the code-package.js of the plugin
//                 copy and the copy's commit; a script that is not the copy's own is refused at the gate (out.refused says what to do)
//   choice        which candidate each role took and why: ["writer: claude/sonnet (effort high), the first candidate", ...]
//   effort        the effort handed to each Claude step of the run ({ writer, reviewer }); a Codex step carries it in its command
//   closedClaims  the stale claims of other packages the gate closed (a finished package's claim that was left open), each
//                 { label, reason }; also named in notes
//   unknown       only with stoppedAt "unknown outcome at <step>": { step, key, reason }; next says what the person decides
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
// A gateway key is <label>-<base7>-<run8>-<kind>-<n>, with -a<attempt> and -r<retry> after it: at most 34 characters beside the label
// (kind up to 6, n and attempt up to 2 digits). The gateway refuses a key over 96 characters, so a longer label is refused here, before anything starts.
const MAX_LABEL = 60
if (a.label.length > MAX_LABEL) throw new Error(`args.label is ${a.label.length} characters long, over the ${MAX_LABEL} the gateway keys allow (a key is the label plus about 34 characters and the gateway accepts 96): give the package a shorter label`)
const mode = a.mode || 'agent'
if (!['agent', 'expert'].includes(mode)) throw new Error('args.mode is "agent" or "expert"')
const rounds = a.rounds || 3
// The key budget above counts at most 2 digits for a round number and for an attempt number: both are bounded, so no accepted input builds a key over the limit.
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 99) throw new Error(`args.rounds is ${JSON.stringify(a.rounds)}: a whole number from 1 to 99 (a gateway key holds the round number in 2 digits)`)

// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One gateway call, worded once for every step that makes one. The shell of a step has its own time limit and the
// worker of a job can end with the shell that started it, so the wait is made of foreground calls of 540 seconds.
// attach: the files the request must carry, listed by the workflow; attachIfExists: files attached only when they exist.
// label: the step's label. A rerun after an infrastructure failure (attempt 2 and on) submits under a base key of its
// own, <key>-a<attempt>: its prompt differs, and the earlier keys end in a final job that gave no usable result. Only an
// earlier job that is still running is waited on instead.
// The key prefix of this run (<label>-<base7>-<run8>-), set once the gate has allocated the run id; a gateway call carries it so a progress file
// left by an earlier run of the same label and tmp folder is not mistaken for this run's submission.
let runKeyPrefix = ''
const gatewayCall = ({ role, key: baseKey, label, args, attach = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const n = attempt(label)
  const key = n > 1 ? `${baseKey}-a${n}` : baseKey
  const flags = [...attach, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, base key ${key}. ` +
    (runKeyPrefix ? `Keys of this run all start with ${runKeyPrefix}; count only those. A key without it, its retries and any "UNKNOWN:" line that names it belong to an earlier run of this label: leave them out of every wait, reuse and retry count. ` : '') +
    (n > 1 ? `This is attempt ${n} after an infrastructure failure; earlier attempts used other keys (${baseKey}${n > 2 ? `, ${baseKey}-a2` : ''}${n > 3 ? ' and on' : ''}, with their -r2 and -r3). ` +
      `First look in the progress file for a submission of this attempt: a key that starts with ${key} (${key}, ${key}-r2, ${key}-r3). If there is one, the latest of them is the active key: wait on it as below and do not run the submit command. ` +
      `If there is none, take the latest key ${runKeyPrefix ? `of this run (it starts with ${runKeyPrefix}) ` : ''}that the progress file records for this call: if \`zodchi job --key <that key>\` shows the job not final yet, it is the active key: wait on it as below and do not run the submit command; if it then dies before its turn (the rule below), the next submission is ${key}, not a suffix of that key. ` +
      `If that job is final with status "unknown", it never gets a new key, here or in any attempt: do not run the submit command; stop as the "unknown" rule below says, with that key as the active key. ` +
      `If it is final with status "failed" and \`zodchi job --key <that key>\` shows turnRequestedAt and turnStartedAt both null or missing (the request was never sent), or there is none, that key is finished: run the submit command under ${key}. Any other final status, a failed job with either of the two fields set included, is not submitted over: report it as the last rule below says. `
      : `First look in the progress file for a submission of this call${runKeyPrefix ? ' by this run' : ''}: if it records ${key}, ${key}-r2 or ${key}-r3, the latest of them is the active key: wait on it as below and do not run the submit command. Only with none, submit under ${key}. `) +
    `The submit command (run it in the foreground from ${repo}, and only when that check found no submission): \`${run}\`. ` +
    `zodchi attaches files only: an --attach path that is a folder is replaced, before the first submission, by one --attach per file under it (all levels, in name order); everything below about attachments then counts those files. ` +
    (attachIfExists.length ? `Before every submission, retries included, drop the --attach of each optional file that does not exist on disk: ${JSON.stringify(attachIfExists)}; keep every other --attach. ` : '') +
    `The gateway refuses a request over 512 KB (prompt plus attachments). Before every submission, first remove a "Not attached for size" line left by an earlier attempt from the prompt file, then add up the size of the prompt file and of every file you attach. While the sum is over 500 KB and an optional file is still attached${attachIfExists.length ? ` (optional: ${JSON.stringify(attachIfExists)})` : ' (there are none here)'}, drop the largest optional one (required files stay: the request is useless without them) and add its name to one line at the end of the prompt file, "Not attached for size: <names>"; then count again, the prompt included. If the sum is still over 500 KB with no optional file left, do not submit: report that as the infrastructure failure. ` +
    `Never start it in the background (no &, nohup, run_in_background or Monitor): the worker of the job ends with your shell, and a dead worker can leave a paid job with an unknown outcome. ` +
    `The active key is the key of the latest submission: ${key} at first, then ${key}-r2, then ${key}-r3 (at most 2 retries in all). Every wait, \`zodchi job\` and request.json check below uses the active key, after a resume too (the progress file holds the latest key). ` +
    `Wait in the foreground with \`zodchi wait --key <active key> --wait-sec 540 --out ${q(out)}\`, repeated while it exits 3 (still running), until the job is final (exit 0 or 2) or ${totalMin} minutes have passed since the first command, whichever comes first. ` +
    `If the time runs out, report failure and say the job still runs under its active key. Do not return earlier: nobody else waits on the job. ` +
    `In this workflow's result that failure is ok false (verdict "missing" for a review). ` +
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
// The claim step comes back from the journal like any other finished step, so a resumed run never runs it again; the claim the stopped run closed
// ("stopped") is opened again by the helper at its first live call (claim-more), and the base the claim recorded is the package's base.
// args.rerun: { "<label>": <attempt> }, attempt 2 for the first rerun; a plain list of labels means attempt 2 for each.
const reruns = Array.isArray(a.rerun) || typeof a.rerun === 'string'
  ? Object.fromEntries([].concat(a.rerun).map(l => [l, 2]))
  : { ...(a.rerun || {}) }
const attempt = (label) => Number(reruns[label]) || 1
for (const [l, v] of Object.entries(reruns)) if (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 99) throw new Error(`args.rerun names attempt ${JSON.stringify(v)} for ${JSON.stringify(l)}: a whole number from 1 to 99 (a gateway key holds the attempt number in 2 digits)`)
// What a step that meets a gateway job ending "unknown" hands back (never a new key: the request may already have run).
const UNKNOWN_RETURN = "return gateway \"unknown\" with unknownKey set to the active key and infra set to the job's error"
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.progress || o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
// Set from the owner's config once the gate has read it; every step prompt then carries it.
let parallelNote = ''
const SHARED_NOTE = 'Parallel packages share this checkout (owner setting): work in the checkout you were given; do not create clones or worktrees and do not switch branches.'
const step = (prompt, opts) => agent(prompt +
  (parallelNote ? '\n\n' + parallelNote : '') +
  (opts && attempt(opts.label) > 1 ? `\n\nThis step runs again after an infrastructure failure, attempt ${attempt(opts.label)}: read its progress file; what an earlier attempt recorded there may be unfinished work of this step.` : '') +
  `\n\nShell rule: run every command with bash (Git Bash on Windows): the quoting in these commands is written for bash, and PowerShell or cmd would read it differently. Resume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `Do not redo finished work or overwrite its outputs blindly. ` +
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
    cause: { type: 'string', enum: ['none', 'code', 'check', 'environment', 'flaky', 'other'] },
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
const withInfra = (s) => ({ ...s, required: [...s.required, 'gateway', 'infra'], properties: { ...s.properties, gateway: { type: 'string', enum: ['final', 'failed', 'unknown'] }, infra: { type: 'string' }, unknownKey: { type: 'string' } } })
const infraBad = (r) => !r || r.gateway !== 'final'
const INFRA = `gateway: "final" when the gateway created the job and it reached a final status other than "unknown" (any other status), and then infra is "". A job that is final with status "unknown" is gateway "unknown": unknownKey is its key, infra the job's error, and nothing is submitted again. Otherwise gateway is "failed" and infra says what happened, quoting the gateway: ` +
  `it created no job, it refused (for example the repository does not ignore .agent-tmp/, an unknown role, sign-in), every submission died before its turn started, ` +
  `or the wait ran out with the job still running (name its active key). When gateway is "failed", append the line "INFRA: <what happened>" to the progress file as its last line instead of DONE; when it is "unknown", the line "UNKNOWN: key <key>: <the job's error>".`
// The severity is the second word of a finding line "<id> <severity> <location>: <problem>": important (blocks), nit or
// pre-existing (do not block). Older words: blocking is important; should_fix, note and minor are nit. Any other word is
// read as important, so an unreadable finding never approves a change.
const SEVERITY = new Map(Object.entries({ important: 'important', blocking: 'important', nit: 'nit', should_fix: 'nit', note: 'nit', minor: 'nit', 'pre-existing': 'pre-existing' }))
const severity = (f) => SEVERITY.get((String(f).trim().split(/\s+/)[1] || '').toLowerCase()) || 'important'
const normFinding = (f) => String(f).trim().replace(/^(\S+\s+)(\S+)/, (m, id, word) => id + (SEVERITY.get(word.toLowerCase()) || word))

const out = { label: a.label, mode, rounds: [], openFindings: [], verifiedBy: 'none' }
// Set by an infrastructure failure: the claim stays open, because the package goes on when the run is resumed.
let keepClaim = false
// A gateway job that ended "unknown" may already have run and used the subscription: the workflow never submits it again under
// a new key. The run stops with the key, the reason and the decision that belongs to the person; the claim stays open.
function unknownStop(label, r) {
  keepClaim = true
  const key = String((r && r.unknownKey) || '').trim() || '(the runner did not name the key: read the progress file of the step)'
  const reason = String((r && r.infra) || '').trim() || 'the gateway job ended unknown'
  out.stoppedAt = `unknown outcome at ${label}`
  out.unknown = { step: label, key, reason }
  const rerun = { ...reruns, [label]: attempt(label) + 1 }
  out.next = `The model call of the step ${JSON.stringify(label)} may already have run and used the subscription (${reason}); it was not asked again. Look at it first: \`zodchi job --key ${key}\`, and the output file of the step if there is one. ` +
    `Then decide: take its result and finish the step by hand, or pay for the call once more by resuming this run with args.rerun ${JSON.stringify(rerun)}. The claim ${claimFile} stays open meanwhile.`
  const stop = new Error(`Unknown outcome at step "${label}", key ${key}: ${reason}`)
  stop.unknownStop = true
  throw stop
}
// One place for the gateway steps: "unknown" stops with its key, anything else that is not final is an infrastructure failure.
function gatewayStop(label, r, fallback) {
  if (r && r.gateway === 'unknown') unknownStop(label, r)
  infraFail(label, r ? (r.infra || 'gateway: failed') : fallback)
}
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
// $HOME is written for the shell, which expands it: commands name the folder in double quotes. The claim helper keeps claims in the same
// folder (it reads the shell's $HOME too). Once it has confirmed the claim, both name the file it reports, so that the later steps mark and
// close the very file it wrote; before that no step marks or closes any claim file.
const claimsName = fold(repoKey).replace(/[^A-Za-z0-9]/g, '-')
let claimsDir = `$HOME/.zodchi/packages/${claimsName}`
let claimFile = `${claimsDir}/${a.label}.json`

// ---------------------------------------------------------------- Gate
// The gate helper (core/scripts/gate.mjs) is looked up in the plugin copy the session loaded, never in a checkout: the bootstrap below
// (the same text in every workflow that uses the helper; the e2e suite checks they are equal) takes the copy from $ZODCHI_PLUGIN_ROOT,
// $CLAUDE_PLUGIN_ROOT or the install Claude Code's registration names for zodchi-core for the project the session runs in (the folder the runner
// starts in, the most specific project install first, else the user install), and runs scripts/gate.mjs there. It picks ONE copy and never
// falls through to another: a copy without the helper is a stop.
// It prints one line of JSON; its exit code is 0 when that line is the answer, 3 when the copy's api differs from GATE_API, 4 when the copy
// the session loaded has no helper. The workflow reads the line and decides.
const GATE_API = 1
// The stamp of this script (see "The workflow build" in core/scripts/gate.mjs): the first 16 hex digits of the SHA-256 of this file with this
// line's stamp emptied. The gate sends it to the helper, which stamps the code-package.js of its own plugin copy; a script that is not the copy's
// own is refused at the gate. After every edit of this file: `node core/scripts/gate.mjs workflow-build core/workflows/code-package.js --write`.
const WORKFLOW_BUILD = 'd6a635053e44ab44'
const GATE_BOOT = 'const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\"),cp=require(\"child_process\");const project=process.argv[1]||\"\";const rest=process.argv.slice(2);const out=(o,c)=>{fs.writeSync(1,JSON.stringify(o)+\"\\n\");process.exit(c)};const rd=f=>{try{return JSON.parse(fs.readFileSync(f,\"utf8\"))}catch(e){return null}};const nm=p=>{const s=path.resolve(p).split(path.sep).join(\"/\");return process.platform===\"linux\"?s:s.toLowerCase()};const pre=n=>n.endsWith(\"/\")?n:n+\"/\";const tried=[];let root=\"\",via=\"\";const fail=(why)=>out({ok:false,api:0,error:why,tried},4);for(const name of [\"ZODCHI_PLUGIN_ROOT\",\"CLAUDE_PLUGIN_ROOT\"]){const env=process.env[name];if(root||!env)continue;const m=rd(path.join(env,\".claude-plugin\",\"plugin.json\"));if(m&&m.name===\"zodchi-core\"){root=env;via=name}else if(name===\"ZODCHI_PLUGIN_ROOT\"){tried.push(env+\" (no zodchi-core manifest)\");fail(\"ZODCHI_PLUGIN_ROOT names no zodchi-core plugin copy: a checkout or another folder is never used instead\")}}if(!root){const reg=rd(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),\".claude\"),\"plugins\",\"installed_plugins.json\"));const list=(reg&&reg.plugins&&reg.plugins[\"zodchi-core@zodchi\"])||[];const here=pre(nm(project));const own=list.filter(e=>e.projectPath&&here.startsWith(pre(nm(e.projectPath)))).sort((a,b)=>nm(b.projectPath).length-nm(a.projectPath).length);const e=own[0]||list.find(e=>!e.projectPath);if(e&&e.installPath){root=e.installPath;via=\"installed_plugins.json, scope \"+e.scope}}if(!root)fail(\"no zodchi-core plugin copy is registered for the project this session runs in (not installed): update the plugin; a checkout is never used instead\");const ok=fs.existsSync(path.join(root,\"scripts\",\"gate.mjs\"));tried.push(root+(ok?\"\":\" (no scripts/gate.mjs)\"));if(!ok)fail(\"the zodchi-core plugin copy this session loaded (\"+root+\") has no scripts/gate.mjs (an older copy than this workflow): update the plugin; no other copy is tried and a checkout is never used\");const r=cp.spawnSync(process.execPath,[path.join(root,\"scripts\",\"gate.mjs\"),...rest],{stdio:\"inherit\",env:{...process.env,ZODCHI_GATE_VIA:via}});process.exit(r.status===null?5:r.status)'
// The folder the runner starts in is the project the session runs in: it says which registered plugin copy the session loaded (the Windows form of the path on Git Bash).
const SESSION_PROJECT = '"$(pwd -W 2>/dev/null || pwd)"'
// The spec goes to the helper as "b64:" and the base64 of its UTF-8 JSON text (when it is short enough, see B64_MAX): no quote, backslash or brace for a runner to "repair" when it
// retypes the command. The sandbox may have no Buffer or btoa, so the encoder is plain code (the same text in every workflow that sends a spec).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const b64 = (text) => {
  const bytes = []
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  let res = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    res += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=')
  }
  return res
}
// Base64 is a third longer than the bytes it carries, and Cyrillic is two bytes a letter in UTF-8 (about 2.7 times the characters of the plain JSON).
// A long spec must not make a command line longer than the plain JSON of before (Windows refuses about 32000 characters), so the b64: argument
// is sent only up to B64_MAX characters (prefix included); a longer spec goes as plain JSON, exactly as it always did.
const B64_MAX = 12000
const specArg = (spec) => {
  const json = JSON.stringify({ api: GATE_API, ...spec })
  const arg = 'b64:' + b64(json)
  if (arg.length > B64_MAX) return json
  return arg
}
// A helper copy older than this workflow reads plain JSON only: it answers a b64: spec with exit 2 and "the spec is not JSON: Unexpected token 'b'..." (the spec
// starts with the b of b64:). Only the first helper call of the run (the gate: short, and always sent as b64:) is read that way: once a helper answered
// a b64: spec, the copy reads b64:, and the same text later is a command the runner damaged (e.g. a dropped colon), which is retried or reported as
// such. It is a stop that names the cause (stale marks it); there is no plain-JSON fallback.
let helperReadsB64 = false
const OLD_HELPER = /^the spec is not JSON: Unexpected token '?b'?(,| in JSON at position 0)/
const oldHelperStop = (what, r, facts) => !helperReadsB64 && r.exitCode === 2 && OLD_HELPER.test(String(facts.error || ''))
  ? `${what}: the zodchi-core copy ${a.pluginRoot ? `at ${a.pluginRoot}` : 'this session loaded'} is older than this workflow (it does not read b64: specs): rerun the installer, reload plugins, or pass args.pluginRoot of a current copy`
  : ''
const helperRun = (command, spec) => `${a.pluginRoot ? `ZODCHI_PLUGIN_ROOT=${q(a.pluginRoot)} ` : ''}node -e ${q(GATE_BOOT)} -- ${SESSION_PROJECT} ${command} ${q(specArg(spec))}`
const HELPER_ANSWER = { type: 'object', required: ['exitCode', 'stdout'], properties: { exitCode: { type: 'number' }, stdout: { type: 'string' }, error: { type: 'string' } } }
const HELPER_NEXT = 'Update the zodchi-core plugin (rerun the installer, then reload plugins in Claude Code) so that the copy this workflow runs from has scripts/gate.mjs, or pass args.pluginRoot, the folder of a zodchi-core copy that has it. Nothing was claimed or changed.'
// The helper's answer: the one JSON line of its stdout and the exit code the runner saw, both of which must say it worked.
function readHelper(r, what) {
  if (!r) return { error: `${what}: the runner returned no result` }
  const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  let facts = null
  try { facts = JSON.parse(line) } catch {}
  if (!facts || typeof facts !== 'object') return { error: `${what} printed no JSON line (exit ${r.exitCode}${r.error ? `: ${r.error}` : ''})` }
  const stale = oldHelperStop(what, r, facts)
  if (stale) return { error: stale, stale: true }
  if (r.exitCode !== 0 || facts.ok !== true) return { error: `${what}: ${facts.error || 'it reported a failure'} (exit ${r.exitCode})${Array.isArray(facts.tried) ? `; looked in ${JSON.stringify(facts.tried)}` : ''}` }
  if (facts.api !== GATE_API) return { error: `${what}: api ${facts.api}, this workflow needs ${GATE_API}` }
  if (!facts.plugin || !facts.plugin.root) return { error: `${what}: it did not name its plugin copy` }
  helperReadsB64 = true
  return { facts }
}
// The effort of a candidate reaches its Claude step as agent()'s effort; a Codex step carries it in its gateway command. out.effort says what was handed over.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const effortOf = (c) => { const e = String((c && c.effort) || '').toLowerCase(); return EFFORTS.includes(e) ? { effort: e } : {} }
const writerRole = mode === 'expert' ? 'expertWriter' : a.hard ? 'hardWriter' : 'writer'

// ---------------------------------------------------------------- Gate
phase('Gate')
// The gate's facts come from one small script of the plugin copy the session loaded (core/scripts/gate.mjs), which prints
// them as one line of JSON; the runner only runs the command and returns the printed line and the exit code. What the
// workflow decides from (Git state, dirty list, ignore rule, role table, account, claims) is what the script printed.
const gateRun = helperRun('code-package', { repo: a.repo, brief: a.brief, label: a.label, claimsKey: claimsName, want: [writerRole, 'reviewer'], workflow: { name: 'code-package', build: WORKFLOW_BUILD } })
const gateAnswer = await step(
  `Run ONE command and return what it printed; change nothing and run nothing else. In the foreground, once:\n${gateRun}\n` +
  `Do not change, split or rerun it with other options. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label: `gate ${a.label}`, schema: HELPER_ANSWER })
const gateRead = readHelper(gateAnswer, 'the gate helper')
if (gateRead.error) { out.stoppedAt = `gate (${gateRead.error})`; out.next = HELPER_NEXT; return out }
const gate = gateRead.facts
// The gate answer must carry the Git state: a missing list is no answer, never a clean work tree.
if (!Array.isArray(gate.dirty)) { out.stoppedAt = `gate (no dirty list: the Git state is unknown${gate.dirtyError ? `; ${gate.dirtyError}` : ''})`; return out }
out.pluginCopy = { path: gate.plugin.root, commit: gate.plugin.commit || 'unknown', version: gate.plugin.version || '', via: gate.plugin.via || '' }
// The script that runs must be the one of the plugin copy whose helper it talks to: a workflow started from a checkout (scriptPath) that is changed
// on its branch is newer than the copy, and its commands meet a helper that does not know them. The helper stamps the copy's own code-package.js;
// an older copy that does not report the stamp is a mismatch too.
const wf = gate.workflow && typeof gate.workflow === 'object' ? gate.workflow : null
out.workflow = { build: WORKFLOW_BUILD, copyBuild: wf ? String(wf.copyBuild || '') : '', copyCommit: out.pluginCopy.commit }
if (!wf || wf.match !== true) {
  out.refused = `This workflow (code-package, build ${WORKFLOW_BUILD}) is not the one of the zodchi-core copy it talks to (${out.pluginCopy.path}, commit ${out.pluginCopy.commit}; ` +
    (wf ? (wf.copyBuild ? `the code-package.js of the copy is build ${wf.copyBuild}` : 'the copy has no code-package.js') : 'the copy reports no workflow build: it is older than this workflow') +
    `). A workflow started from a checkout that is changed on its branch, or an old copy, sends commands the helper does not know. ` +
    `Take the workflow from the copy: pass scriptPath ${out.pluginCopy.path}/workflows/code-package.js, or save \`git show main:core/workflows/code-package.js\` outside the checkout and start that; or run the installer (node install/install.mjs), reload plugins and start again. Nothing was claimed or changed.`
  out.next = out.refused
  return out
}
// The id of this run, allocated by the helper at the gate (the gate answer comes back from the journal on a resume, so it is the same for the run and new for a new run).
if (!/^[0-9a-f]{8}$/.test(String(gate.runId || ''))) { out.stoppedAt = `gate (no run id: the helper of the copy ${out.pluginCopy.path} did not allocate one)`; return out }
const note = (text) => { out.notes = out.notes || []; out.notes.push(text) }
for (const e of gate.modelsErrors || []) log(`${e}; ignored`)
if (gate.configError) log(`~/.zodchi/config.json: ${gate.configError}; ignored`)
// A stale claim the gate closed (a package finished outside code-package leaves its claim open): said in the result.
const claimFacts = gate.claims || {}
if ((claimFacts.closed || []).length) {
  out.closedClaims = claimFacts.closed
  for (const c of claimFacts.closed) note(`The gate closed the open claim of ${c.label}: ${c.reason}.`)
}
for (const n of claimFacts.notes || []) note(`Claims: ${n}`)

const table = { ...(gate.roles || {}), ...(a.models || {}) }
const account = gate.account && typeof gate.account === 'object' ? gate.account : null
// The owner's setting for packages that run in parallel in one checkout (docs/parallel.md). Unset by default.
const cfg = gate.config || {}
const sharedBranch = cfg.parallel === 'shared-branch'
if (cfg.parallel && !sharedBranch) log(`~/.zodchi/config.json: parallel ${JSON.stringify(cfg.parallel)} is not known; ignored`)
if (sharedBranch) parallelNote = SHARED_NOTE
const currentBranch = String(gate.branch || '').trim()
// The branch the package works on, written into its claim so that another package can see it.
const myBranch = a.branch || currentBranch || '(detached)'
// The review boundary the lead wrote into the brief (docs/review-boundary.md). Without it the run goes on and says so.
const boundaryText = String(gate.boundary || '').trim()
out.reviewLedger = []
if (!boundaryText) note('The brief has no "## Review boundary" section: the reviewer judged without a written boundary and may go deeper than the package needs. See docs/review-boundary.md for the section.')
const used = (w) => (w && typeof w.usedPercent === 'number') ? w.usedPercent : 0
const codexOk = Boolean(account && account.connected && account.ordinaryUsageAllowed !== false && used(account.primary) < 100 && used(account.secondary) < 100)
if (!codexOk) log(`Codex candidates skipped: ${account ? 'the subscription has no limit left or is not connected' : `zodchi account failed (${gate.accountError || 'no output'})`}`)
const available = (c) => c.provider === 'claude' || (c.provider === 'codex' && codexOk)
// Which candidate each role took and why goes into the result (out.choice); the quota is said to be unknown when zodchi account gave nothing.
out.choice = []
const resolve = (role, exclude) => {
  const r = table[role]
  if (!r || !Array.isArray(r.candidates)) throw new Error(`Role ${role} is not in the role table (~/.zodchi/models.json, .zodchi/models.json or args.models)`)
  const pick = r.candidates.find(c => available(c) && !(exclude && c.provider === exclude.provider && c.model === exclude.model))
  if (!pick) return null
  const name = (c) => `${c.provider}/${c.model}${c.effort ? ` (effort ${c.effort})` : ''}`
  const skipped = r.candidates.slice(0, r.candidates.indexOf(pick)).map(c => `${name(c)}: ${c.provider === 'codex' && !codexOk ? (account ? 'no limit left or not connected' : 'the quota is unknown: zodchi account gave no answer') : 'the author of the change'}`)
  out.choice.push(`${role}: ${name(pick)}, ${skipped.length ? `after skipping ${skipped.join('; ')}` : 'the first candidate'}`)
  if (pick !== r.candidates[0]) log(`Role ${role}: ${r.candidates[0].provider}/${r.candidates[0].model} is not available, took ${pick.provider}/${pick.model}`)
  return pick
}
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
// The files of the package's earlier rounds (a package that goes on), read from Git between the recorded base and HEAD; body() adds them to the package.
const earlierPaths = []

// Checks: the cheap ones first (args.checks), then the slow run of the real program (args.verify, else the verify skill).
// What verified the round is the slowest of these that ran and passed; with none of them, nothing did.
const asCheck = (c) => typeof c === 'string' ? { cmd: c, pass: 'exit code 0' } : { pass: 'exit code 0', ...c }
const checkList = (a.checks || []).map(asCheck)
const verifyList = [].concat(a.verify || []).map(asCheck)
const pickSource = () => verifyList.length ? 'args.verify' : hasVerifySkill ? 'verify skill' : checkList.length ? 'checks' : 'none'
let verifySource = pickSource()
const NO_SKIP = `Run each check as written and report what it gives. Do not skip it, add a sleep or a wait, or rerun it unchanged hoping for a pass: that hides the cause. Running it again after you changed the code is the normal loop. ` +
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

// Claims are compared and written by the gate helper (core/scripts/gate.mjs claim and claim-more), never by a model: it reads every
// claim under the claims lock (mkdir is atomic, so two packages started at once cannot both pass), compares the lists of paths and writes
// the claim atomically. The runner only runs its command and returns the printed line and the exit code; the workflow decides from that
// line. From the moment the helper confirms the claim (ok, and the claim file it wrote or reused), whatever happens, the claim is closed at
// the end and the closing is checked; an infrastructure failure, after which the run is resumed, marks it instead. Before that confirmation
// (a refusal, a busy lock, an answer that cannot be read) no claim file is marked or closed.
let claimStatus = 'stopped'
let claimWritten = false
// The same folder as claimsDir, for the helper: it resolves "~/" to the shell's $HOME itself (no shell expands it inside the spec).
const claimsSpecDir = `~/.zodchi/packages/${claimsName}`
const helperStep = (command, spec, label, phaseName) => step(
  `Run ONE command and return what it printed; change nothing and run nothing else. In the foreground, once:\n${helperRun(command, spec)}\n` +
  `Do not change, split or rerun it with other options: the command itself reads and writes the claims folder and its lock, so leave them to it. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label, schema: HELPER_ANSWER, ...(phaseName ? { phase: phaseName } : {}) })
// The answer of a claim command: its one JSON line with exit code 0, from this workflow's api and a named plugin copy. Unlike readHelper,
// a line with ok false is an answer (conflicts, a busy lock); only an unreadable answer is an error.
function readClaimHelper(r, what) {
  if (!r) return { error: `${what}: the runner returned no result` }
  const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  let facts = null
  try { facts = JSON.parse(line) } catch {}
  if (!facts || typeof facts !== 'object') return { error: `${what} printed no JSON line (exit ${r.exitCode}${r.error ? `: ${r.error}` : ''})` }
  const stale = oldHelperStop(what, r, facts)
  if (stale) return { error: stale, stale: true }
  if (r.exitCode !== 0) return { error: `${what}: ${facts.error || 'it reported a failure'} (exit ${r.exitCode})${Array.isArray(facts.tried) ? `; looked in ${JSON.stringify(facts.tried)}` : ''}` }
  if (facts.api !== GATE_API) return { error: `${what}: api ${facts.api}, this workflow needs ${GATE_API}` }
  if (!facts.plugin || !facts.plugin.root) return { error: `${what}: it did not name its plugin copy` }
  helperReadsB64 = true
  if (typeof facts.ok !== 'boolean' || !Array.isArray(facts.conflicts)) return { error: `${what}: its answer has no ok or no conflicts list` }
  return { facts }
}
// Git commands of this package may meet an index.lock that a command of another package in the same checkout holds for a moment.
const LOCKWAIT = `If a Git command fails with an error that names index.lock (another package's Git command holds it), wait 3 seconds and run the same command again, at most 10 times in all; ` +
  `never delete, move or overwrite the lock file or anything else in .git: the lock belongs to the command that holds it, and removing it can corrupt the index. If it is still held after the last try, stop with ok false and the summary "index.lock held".`
// The ignore repair changes .gitignore, so the claim holds it too, checked against other open packages like any file.
const claimKeys = needIgnore && !myKeys.includes('.gitignore') ? [...myKeys, '.gitignore'] : myKeys
try {
// With the repository, the helper also records in the claim what `git status` lists before the package starts (atGate), which claim-more
// later leaves alone.
// The helper compares claimKeys with every other open claim (a conflict "<label>: <file>"), and the branch with theirs (a branch conflict
// "<label>: <branch>": a package may not start on another branch while another open package of this repository works on its own, since
// switching would pull the branch from under it); without either it writes the claim, or reuses this label's open claim on a resume.
const claimRead = readClaimHelper(await helperStep('claim',
  { dir: claimsSpecDir, label: a.label, files: claimKeys, branch: myBranch, brief: a.brief, tmp: a.tmp, base, repo: repoKey }, `claim ${a.label}`), 'the claim helper')
const claim = claimRead.facts
// Open claims in the claims folder under Node's home folder, which a build of this workflow used, when that is not the folder the helper keeps
// claims in (the shell's $HOME): they would go unseen, so nothing is claimed until a person closes or moves them.
if (claim && !claim.ok && Array.isArray(claim.legacyClaims) && claim.legacyClaims.length) {
  out.refused = `Open claims lie in ${claim.legacyDir}, under Node's home folder, which is not the folder the claims are kept in (${String(claim.file || '').replace(/\/[^/]+$/, '')}, under the shell's $HOME): ${claim.legacyClaims.join('; ')}. ` +
    `Finish them or close them (status "closed"), or move the open ones into that folder, then start again.`
  return out
}
if (claim && !claim.ok && Array.isArray(claim.branchConflicts) && claim.branchConflicts.length) {
  out.refused = `Another open package of this repository works on a different branch (${claim.branchConflicts.join('; ')}) and this one would work on ${myBranch}; switching would pull the branch from under it. ` +
    `Start this package on the same branch, finish the other one first, or run it in a worktree or clone (docs/parallel.md).`
  return out
}
if (claim && !claim.ok && claim.conflicts.length && claim.conflicts[0] !== 'lock busy') {
  out.refused = `Open packages claim the same files: ${claim.conflicts.join('; ')}. Finish them, or close a stale one (status "closed" in ${claimsDir}/<label>.json).`
  return out
}
  // A readable answer with ok false (a busy lock, an error the helper names) wrote nothing. An answer that cannot be read, or a success
  // without the absolute claim file, leaves unknown whether the helper wrote or changed the claim: no claim file is guessed, marked or
  // closed; the person looks at the folder first.
  const confirmed = claim && claim.ok && typeof claim.file === 'string' && /^([A-Za-z]:)?\//.test(claim.file) && claim.file.endsWith(`/${a.label}.json`)
  if (claim && !claim.ok) { out.stoppedAt = `claim (${claim.error || claim.conflicts.join(', ') || 'the helper wrote no claim'})`; return out }
  if (!confirmed) {
    const why = claim ? 'the helper reported success without its claim file' : claimRead.error
    out.stoppedAt = `claim (${why})`
    out.claimUnknown = `Whether the claim helper wrote or changed the claim of ${a.label} is unknown (${why}). Look at "${claimsDir}/${a.label}.json" ($HOME is the shell's home folder): ` +
      `if this run wrote it (its "tmp" is ${a.tmp} and no other run of ${a.label} is open), set its "status" to "closed", then start again.`
    out.next = out.claimUnknown
    return out
  }
  claimWritten = true
  claimFile = claim.file
  claimsDir = claim.file.replace(/\/[^/]+$/, '')
  // A claim this label's earlier run left (open, or closed "stopped" and opened again by the helper) is the claim of the package that goes on: the base commit it
  // recorded is the package's base, whatever HEAD is now (the earlier rounds' commits are on top of it), and its files are the package's files.
  const adoptBase = claim.reused === true && /^[0-9a-f]{7,64}$/i.test(String(claim.base || '').trim()) ? String(claim.base).trim() : ''
  const claimedKeys = new Set((Array.isArray(claim.files) ? claim.files : []).map(f => { try { return key(f) } catch { return '' } }))
  const sentBase = base
  if (claim.reopened) note(`The claim of ${a.label} had been closed "stopped" by the earlier run and was opened again; the package goes on from its recorded base ${adoptBase || '(not recorded)'}.`)
  if (claim.reused) log(`Claim of ${a.label}: its open claim from an earlier run is reused (${claim.file})${typeof claim.branchWas === 'string' ? `; its branch ${claim.branchWas || '(none)'} is now ${myBranch}` : ''}`)
  if (a.branch && !sharedBranch) {
    // The switch to args.branch, once the claim is written: a step of its own, so that the claim step only runs the helper.
    const sw = await step(
      `Switch the Git work tree ${a.repo} to the branch ${a.branch}: \`git switch ${q(a.branch)}\`, or \`git switch -c ${q(a.branch)}\` when it does not exist. ${LOCKWAIT} ` +
      `ok is true when \`git branch --show-current\` then prints ${a.branch}.`,
      { agentType: 'zodchi-core:runner', schema: STEP, label: `switch ${a.label}` })
    if (!sw || !sw.ok) { out.stoppedAt = `switch to ${a.branch} (${sw ? sw.summary : 'no result'})`; return out }
  }
  if (needIgnore) {
    const ignored = await step(
      `Make ${a.repo} ignore the zodchi job folders, in a commit of its own, and do not push (publishing is the lead's decision).\n` +
      `1. Append the line \`.agent-tmp/\` to ${repoKey}/.gitignore (create the file when it is missing; when its last line has no line break, add one first, with the line endings the file already uses).\n` +
      `2. Run \`git add -- .gitignore\`, then \`git commit -m "Ignore .agent-tmp (zodchi job folders)" -- .gitignore\`.\n` +
      `3. \`git check-ignore -q .agent-tmp/gateway/x\` must exit 0, and \`git show --name-only --format= HEAD\` must list .gitignore only. ok is true only then. summary: the commit hash. ${LOCKWAIT}`,
      { agentType: 'zodchi-core:runner', schema: STEP, label: `ignore ${a.label}` })
    if (!ignored || !ignored.ok) { out.stoppedAt = `ignore .agent-tmp (${ignored ? ignored.summary : 'no result'})`; return out }
    log(`Committed ".agent-tmp/" in .gitignore: ${ignored.summary}`)
  }
  if (a.branch || needIgnore || adoptBase) {
    // The gate read HEAD and the files before the switch to args.branch and before the ignore commit: read them again on the branch the package works on.
    // A package that goes on takes the base its claim recorded, never HEAD: the earlier rounds' commits lie between them, and the review covers base..HEAD.
    const at = adoptBase || 'HEAD'
    const now = await step(
      `Read the state of the branch the package works on in ${a.repo}; change nothing. head: \`git rev-parse HEAD\`. branch: \`git branch --show-current\`. ` +
      `verifySkill: true when \`git cat-file -e ${at}:.claude/skills/verify/SKILL.md\` exits 0. reviewMd: true when \`git cat-file -e ${at}:REVIEW.md\` exits 0. ` +
      (adoptBase ? `ancestor: true when \`git merge-base --is-ancestor ${adoptBase} HEAD\` exits 0 (the base commit the package recorded is part of this branch). ` +
        `paths: every path \`git -c core.quotepath=off diff --name-only --no-renames ${adoptBase} HEAD\` lists, relative to the repository, one entry each ([] when none). ` : '') +
      `ok is true when the commands ran${a.branch ? ` and branch is ${a.branch}` : ''}.`,
      {
        agentType: 'zodchi-core:runner', label: `base ${a.label}`,
        schema: { type: 'object', required: ['ok', 'head', 'verifySkill', 'reviewMd'], properties: { ok: { type: 'boolean' }, head: { type: 'string' }, branch: { type: 'string' }, verifySkill: { type: 'boolean' }, reviewMd: { type: 'boolean' }, ancestor: { type: 'boolean' }, paths: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
      })
    if (!now || !now.ok || !/^[0-9a-f]{7,64}$/i.test(String(now.head || '').trim())) { out.stoppedAt = `base (${now ? now.summary || 'no head' : 'no result'})`; return out }
    base = String(now.head).trim()
    if (adoptBase) {
      if (now.ancestor === true) {
        // The list of the files the package committed before is the review's input: a missing or non-array list is no "none" (only [] is), and nothing is written or reviewed on a guess.
        if (!Array.isArray(now.paths)) infraFail(`base ${a.label}`, `the base step did not return "paths" as a list for ${adoptBase}..HEAD (got ${now.paths === undefined ? 'nothing' : typeof now.paths}); the files the package committed before cannot be known`)
        base = adoptBase
        // The files the package changed since its base: what Git lists between the base and HEAD, narrowed to the files the claim lists (another package's
        // commits may lie in between in a shared checkout), in the case Git spells them.
        for (const f of now.paths) { try { const r = rel(f); if (claimedKeys.has(r.toLowerCase()) && !/^\.agent-tmp(\/|$)/i.test(r)) earlierPaths.push(r) } catch {} }
      } else {
        // A base that is not on the branch (it was rebased, reset): HEAD is no stand-in, the review would miss the package's earlier commits and the claim would lose its base.
        // Nothing is changed: the claim keeps its recorded base, and the person names the commit the package began at on the branch now.
        out.stoppedAt = `base (the base ${adoptBase} that the claim of ${a.label} recorded is not part of the branch ${now.branch || myBranch} now; the claim still records it)`
        out.next = `The package ${a.label} goes on from the base its claim recorded, ${adoptBase}, but that commit is not an ancestor of HEAD (the branch was rebased or reset). No work was done and the recorded base in the claim is unchanged. ` +
          `Find the commit the package began at on the branch now (the parent of its first commit), set "base" of the claim ${claimFile} to it, and start the package again; or give the package another label.`
        return out
      }
    }
    hasVerifySkill = now.verifySkill === true
    hasReviewMd = now.reviewMd === true
    verifySource = pickSource()
  }
  // The base the claim records must be the one the package works from: read after a switch or an ignore commit it differs from the HEAD the gate saw.
  const recordedBase = claim.reused === true && claim.base ? String(claim.base).trim() : sentBase
  if (base !== recordedBase) {
    const rb = readClaimHelper(await helperStep('claim-base', { dir: claimsSpecDir, label: a.label, base, tmp: a.tmp }, `claim base ${a.label}`), 'the claim-base helper')
    // A transient failure is no answer about the claim: an unreadable answer, a helper exit that is not a refusal, the claims lock busy or not taken. It is an infrastructure
    // failure like the others (the claim stays open; resume with args.rerun for this step asks the helper again, because its journaled answer would replay the failure).
    // An old helper copy (stale) and a refusal the helper answered (no open claim of the label, a base that is not a hash, files another package claims) stop the run as before.
    const claimBaseTransient = rb.facts ? (!rb.facts.ok && (rb.facts.conflicts.includes('lock busy') || /^lock: /i.test(String(rb.facts.error || '')))) : !rb.stale
    if (claimBaseTransient) infraFail(`claim base ${a.label}`, rb.facts ? `the claim-base helper: ${rb.facts.error || 'the claims lock is busy'}` : rb.error)
    if (!rb.facts || !rb.facts.ok) { out.stoppedAt = `claim base (${rb.facts ? rb.facts.error || rb.facts.conflicts.join(', ') || 'the helper recorded nothing' : rb.error})`; return out }
  }
  try { await body() } catch (e) { if (e && e.unknownStop) return out; throw e }
  if (out.openFindings.length && !out.next) out.next = `The last review left ${out.openFindings.length} finding(s) open (openFindings): close them with the writer, or decide on them.`
  return out
} finally {
  if (claimWritten && keepClaim) {
    // The package waits for a person (an unknown outcome, an infrastructure failure): its claim says so, and the gate of another package
    // never closes a claim marked "awaiting", however old it is.
    const marked = await step(
      `If "${claimFile}" exists ($HOME is the shell's home folder: keep the path in double quotes), add the field "awaiting" with this value, a string: ${JSON.stringify(String(out.stoppedAt || 'stopped'))}; keep every other field and its "status". Change the file in place: make no backup or other copy of it in "${claimsDir}". ` +
      `ok is true when the file does not exist, or when it parses and its "awaiting" is that string.`,
      { agentType: 'zodchi-core:runner', schema: STEP, label: `await claim ${a.label}` }).catch(() => null)
    if (!marked || !marked.ok) out.claimNotMarked = `${claimFile}: add "awaiting" by hand, or another package's gate may close it`
  }
  if (claimWritten && !keepClaim) {
  const closed = await step(
    `If "${claimFile}" exists ($HOME is the shell's home folder: keep the path in double quotes), set its "status" to "${claimStatus}" and add "closedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`; keep every other field. Change the file in place: make no backup or other copy of it in "${claimsDir}". ` +
    `ok is true when the file does not exist, or when it parses and its status is "${claimStatus}".`,
    { agentType: 'zodchi-core:runner', schema: STEP, label: `close claim ${a.label}` }).catch(() => null)
  if (!closed || !closed.ok) out.claimLeftOpen = `${claimFile}: set "status" to "closed" by hand`
  }
}

async function body() {
  const changed = new Set([...myPaths, ...earlierPaths].map(abs))
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
  // Where the writer's own output goes: a stray folder in the repository (a logs/ at its root) failed the repository's own checks.
  const LOGS = `Logs, scratch files, notes and command outputs go only under ${a.tmp} (for example ${a.tmp}/logs), because a stray file in the repository can fail its own checks. Create no file or folder in ${a.repo} except the files of the change.`
  // One truth about commits, in every prompt that touches the writer's commit state.
  const COMMITS = commit
    ? `The runner commits the package files after passing checks as "${a.label}: round N", so the writer leaves committing to it and every commit holds checked code.`
    : `Nothing is committed in this run, so the writer does not commit.`

  // Every gateway key of this run is built from the label, the package base commit (short hash) and the id of the run the gate allocated. Two runs of one label never share a key
  // (the gateway refuses a key it knows for another request, or hands back the old job), even at the same base and HEAD; a resume of the same run gets the same keys
  // (the gate and claim answers come back from the journal, and so do the run id and the base).
  const runPart = `${base.slice(0, 7)}-${gate.runId}`
  runKeyPrefix = `${a.label}-${runPart}-`
  const gwKey = (kind, n) => `${a.label}-${runPart}-${kind}-${n}`

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
    const task = `${job} ${COMMITS}${sharedBranch ? ` ${SHARED_NOTE}` : ''}${PROTECT} ${LOGS}`
    if (mode === 'expert') {
      const ask = await step(
        `Ask an expert for the code through the gateway. Work from ${a.repo}. Write ${a.tmp}/expert-${n}.md: ${task} ` +
        `The expert has no tools: everything it needs is attached. Then ` +
        gatewayCall({
          role: 'code-patch', key: gwKey('expert', n), label: `${tag} ask`, totalMin: 55, out: `${a.tmp}/expert-${n}.answer.md`,
          args: `--model ${writer.model} --effort ${writer.effort} --prompt ${q(`${a.tmp}/expert-${n}.md`)}`,
          attach: [a.brief], attachIfExists: [...evidence, ...changed],
        }) + ` ` +
        `ok is true when the job succeeded and the answer file exists. paths: the answer file. ${INFRA}`,
        { agentType: 'zodchi-core:runner', schema: withInfra(STEP), phase: phaseName, label: `${tag} ask` })
      if (infraBad(ask)) gatewayStop(`${tag} ask`, ask, 'the gateway step returned no result')
      if (!ask.ok) return null
      return step(
        `Apply one expert answer. Answer file: ${a.tmp}/expert-${n}.answer.md. Target files: the ones the answer names, relative to ${a.repo}. ` +
        `Ledger of edits: ${a.tmp}/apply-${n}.md. Backup folder: ${a.tmp}/backup-${n}. Syntax checks after applying: the one that fits each target's language. ` +
        `The success flag of this step is "done" (the field of the result), not "ok": it is true only when every edit row has a line number and the checks are clean. changed: the target files, absolute paths. unverified: rows not applied.`,
        { agentType: 'zodchi-core:applier', schema: WRITE, phase: phaseName, label: `${tag} apply` })
    }
    if (writer.provider === 'codex') {
      const work = await step(
        `Have Codex do this through the gateway. Work from ${a.repo}. Write ${a.tmp}/work-${n}.md: ${task} ` +
        `Then ` +
        gatewayCall({
          role: 'package-work', key: gwKey('work', n), label: tag, totalMin: 60, out: `${a.tmp}/work-${n}.json`,
          args: `--model ${writer.model} --effort ${writer.effort} --prompt ${q(`${a.tmp}/work-${n}.md`)}`,
          attach: [a.brief, ...evidence],
        }) + ` The answer is JSON with status, summary, criteria, questions, changedFiles, checks. Map it exactly: ` +
        `done = (status is "done"); summary = its summary; changed = each entry of changedFiles prefixed with "${repoKey}/"; ` +
        `unverified = every criterion that is not done, as one line each, plus every check with a non-zero exit code; questions = each entry of its questions as one readable line (the question, its options, the recommendation). ` +
        `If the job did not succeed, done is false and summary says the job status. ${INFRA}`,
        { agentType: 'zodchi-core:runner', schema: withInfra(WRITE), phase: phaseName, label: `${tag}` })
      if (infraBad(work)) gatewayStop(tag, work, 'the gateway step returned no result')
      return work
    }
    out.effort = { ...out.effort, writer: effortOf(writer).effort || 'the agent default' }
    return continued(task + HANDOVER, { agentType: 'zodchi-core:coder', model: writer.model, ...effortOf(writer), schema: WRITE, phase: phaseName, label: tag })
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
    // A first look at the work tree only decides whether the claim needs the helper at all: nothing new (every file reported or listed is
    // claimed already) is the common case of a later round, and the claim is left as it is.
    const st = await step(
      `List what changed in the work tree of ${a.repo}; change nothing. Run \`git status --porcelain -uall\`. ` +
      `paths: every path it lists, relative to the repository, without the status letters and quotes (a rename gives both paths); [] when it lists nothing. ok is true when the command ran.`,
      { agentType: 'zodchi-core:runner', schema: STATUS, phase: phaseName, label: `status ${tag}` })
    // A missing list is not a clean work tree: unreported files would escape the claim and the review.
    if (!st || !st.ok || !Array.isArray(st.paths)) { out.stoppedAt = `git status after ${tag}${st && st.ok ? ' (no paths list)' : ''}`; return false }
    const listed = []
    for (const p of st.paths) {
      let r
      try { r = rel(p) } catch { continue }
      if (!atGate.has(r.toLowerCase()) && !jobFolder(r) && !foreign.has(r.toLowerCase())) listed.push(r)
    }
    if (!uniqueNew([...found, ...listed]).length) { noteChanged([...found, ...listed]); return true }
    // Something is new: the helper runs `git status --porcelain -uall` in the repository itself and compares what it lists with the open
    // claims under the lock. The command names no file, so it stays short however many files a round changes, and the list it decides from
    // is Git's, not the runner's retelling above. changed: the files Git lists that are this package's (not dirty before it started, not the
    // job folder, in no other open claim); the ones the claim lacked are added. others: the files Git lists that another open package
    // claims, its own work in the shared checkout; owners names the package of each.
    const moreRead = readClaimHelper(await helperStep('claim-more', { dir: claimsSpecDir, label: a.label, repo: repoKey }, `claim more ${tag}`, phaseName), 'the claim-more helper')
    const more = moreRead.facts
    // A missing list is not a clean work tree: unreported files would escape the claim and the review.
    if (more && !more.ok && more.gitError) { out.stoppedAt = `git status after ${tag} (${more.error || 'it failed'})`; return false }
    if (!more || !more.ok) { out.stoppedAt = `claim more (${more ? more.error || more.conflicts.join(', ') || 'the helper added nothing' : moreRead.error})`; return false }
    // An answer without the others, the changed or the added list cannot tell which files are another package's: nothing is recorded or committed.
    for (const k of ['others', 'changed', 'added']) if (!Array.isArray(more[k])) { out.stoppedAt = `claim more (the answer has no ${k} list)`; return false }
    // A file the writer reported that another open package claims is a conflict: the work stays uncommitted for a human.
    const otherKeys = new Map(more.others.map((o, i) => [String(o).toLowerCase(), Array.isArray(more.owners) && more.owners[i] ? String(more.owners[i]) : `another package: ${o}`]))
    const clash = [...new Set(found.map(r => r.toLowerCase()))].filter(k => otherKeys.has(k))
    if (clash.length) {
      out.conflicts = clash.map(k => otherKeys.get(k))
      out.stoppedAt = 'claim conflict'
      out.next = `The work changed files that another open package claims: ${out.conflicts.join('; ')}. This round's work is not committed: it stays in ${a.repo} for a human to settle with that package.`
      return false
    }
    for (const k of otherKeys.keys()) foreign.add(k)
    const seen = []
    for (const p of more.changed) {
      let r
      try { r = rel(p) } catch { continue }
      if (!atGate.has(r.toLowerCase()) && !jobFolder(r) && !foreign.has(r.toLowerCase())) seen.push(r)
    }
    const mine = uniqueNew([...found, ...seen])
    for (const r of mine) claimed.add(r.toLowerCase())
    noteChanged([...found, ...seen])
    // What the helper added to the claim, in the case the files have (a file the claim already listed, on a resume, is ours but not added).
    const addedKeys = new Set(more.added.map(f => String(f).toLowerCase()))
    const added = mine.filter(r => addedKeys.has(r.toLowerCase()))
    if (added.length) {
      out.claimAdded = [...(out.claimAdded || []), ...added]
      log(`Claim of ${a.label} extended by ${added.join(', ')}`)
    }
    if (otherKeys.size) log(`Left out of ${a.label}: ${more.others.join(', ')} (claimed by another open package, changed in the shared checkout)`)
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
    `"flaky" when it failed without a cause in the change (say why in results, with the log line), ` +
    `"other" when every failing line names only files that another open package claims: read every claim file ${claimsDir}/<label>.json whose "status" is "open" and whose "label" is not "${a.label}" and compare its "files" with the files the failing lines name (another package's unfinished work in the shared checkout; list those files and their package in results).`
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

  // Another package's unfinished work in a shared checkout can fail this package's checks. That is not ours to fix:
  // wait for it and run the checks again, a bounded number of times, then stop and say whom we wait for.
  async function settleOthers(checks, n) {
    for (let w = 1; checks && !checks.ok && checks.cause === 'other' && w <= (a.otherWaits ?? 3); w++) {
      await step(`Wait 4 minutes in the foreground (one \`sleep 240\` with a shell timeout of 300000 ms); change nothing. ok is true when the wait ended.`,
        { agentType: 'zodchi-core:runner', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, phase: 'Checks', label: `wait for others ${n}.${w}` })
      checks = await runChecks(`${n}.w${w}`)
    }
    return checks
  }

  async function checked(n) {
    let checks = await settleOthers(await runChecks(n), n)
    for (let f = 1; checks && !checks.ok && checks.cause === 'code' && f <= (a.fixes ?? 1); f++) {
      const fix = await write(
        `The checks of the package ${a.brief} failed after the change. Results: ${JSON.stringify(checks.results)}. Logs: ${JSON.stringify(checks.logs || [])}. ` +
        `Read the logs and fix the code with the smallest change. Files that another open package claims (the claim files ${claimsDir}/<label>.json with "status" "open" and another "label") belong to that package: leave them as they are; if the failure is in one of them, change nothing and say so. done is true when the failing command passes. changed: files changed in this fix.`,
        `fix checks ${n}.${f}`, 'Close', checks.logs || [])
      noteQuestions(fix)
      if (fix && !(await follow(fix, `fix checks ${n}.${f}`, 'Close'))) return 'halted'
      if (!fix || !fix.done) { if (questions.length) out.question = questions.join(' | '); break }
      checks = await settleOthers(await runChecks(`${n}.${f}`), `${n}.${f}`)
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
      `Commit the package's files in ${a.repo}, and do not push (publishing is the lead's decision). The package paths, relative to the repository: ${JSON.stringify(paths)}.\n` +
      `1. Narrow the package paths to "those paths": keep a path that exists in the work tree, or that \`git ls-files -- <path>\` prints (the index), or for which \`git cat-file -e HEAD:<path>\` exits 0 (tracked and now deleted). ` +
      `Drop every other path (the old side of a rename, or a file deleted in an earlier round of a continuation, already committed): \`git commit\` rejects a pathspec that matches nothing. For each of those paths run \`git add -A -- <path>\`, except a path that is gone from the work tree and that \`git ls-files -- <path>\` no longer prints (its deletion is already staged): run no \`git add\` for it, because \`git add -A\` fails on it with "pathspec did not match any files"; it stays in "those paths", and the commit below takes the staged deletion. If those paths are none, return ok true with summary "nothing to commit".\n` +
      `2. Staging can remove the index entry of a path that was only an abandoned addition, and \`git commit\` rejects a pathspec that matches nothing: narrow "those paths" once more, dropping every path that \`git ls-files -- <path>\` no longer prints and for which \`git cat-file -e HEAD:<path>\` fails. "Those paths" below are this second list. If it is empty, return ok true with summary "nothing to commit".\n` +
      `   If \`git diff --cached --quiet -- <those paths>\` says nothing changed, return ok true with summary "nothing to commit".\n` +
      `3. Otherwise run \`git commit -m ${q(`${a.label}: round ${n}`)} -m ${q(out.verification.stamp)} -- <those paths>\` (the paths after -- limit the commit to them; other staged files stay staged and out of it).\n` +
      `4. Run \`git show --name-only --format= HEAD\`: every listed file must be one of the package paths. ok is true only then. summary: the commit hash. paths: the listed files.\n` +
      `Other packages share this checkout and may have files staged: never commit with -a and never \`git add\` a path that is not listed above, or their work lands in this package's commit; leave every other file, staged or not, as it is. ${LOCKWAIT}`,
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
      `A point outside it is at most a "nit" or "pre-existing" finding; do not go deeper than the boundary draws the line`
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
      if (checks && checks.cause === 'other') out.next = `The checks still fail in another open package's unfinished files after waiting: ${JSON.stringify(checks.results || [])}. This package's work is committed up to the last round; run it again (resume) when that package has finished.`
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
      (n > 1 ? `. Keep the id of a finding of an earlier review that still holds (same id, same location), and give every new finding a fresh id, numbered on after F${maxLedgerId()}, so it cannot be mistaken for a closed one. Ids used so far, with their locations: ${JSON.stringify([...ledger.values()].map(e => `${e.id} ${e.location}`))}` : '') +
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
          role: 'code-review', key: gwKey('review', n), label: `review ${n}`, totalMin: 55, out: `${a.tmp}/review-${n}.json`,
          args: `--model ${reviewer.model} --effort ${reviewer.effort} --prompt ${q(`${a.tmp}/review-${n}.md`)}`,
          attach: [`${a.tmp}/change-${n}.diff`, a.brief, ...(n > 1 ? [`${a.tmp}/review-${n - 1}.json`] : []), ...(hasReviewMd ? [focusFile] : [])],
          attachIfExists: files,
        }) + ` ` +
        `A changed file that does not exist now is left out of --attach (the diff already carries deletions). ` +
        `${VERDICT} reviewFile: the review file path. Change no code. ${INFRA} ` +
        `A job that reached a final status but left no review with a verdict (verdict "missing") is an infrastructure failure too: infra is "the review has no verdict: <the review file, or the job status>", with the INFRA line in the progress file.`,
        { agentType: 'zodchi-core:runner', schema: withInfra(REVIEW), phase: 'Review', label: `review ${n}` })
      : (out.effort = { ...out.effort, reviewer: effortOf(reviewer).effort || 'the agent default' }, await step(
        `You are an independent code reviewer; you did not write this change. Work from ${a.repo} and change nothing. Read ${a.brief}, then the change: ${diffHow}, for these paths: ${JSON.stringify(files.map(rel))}. ` +
        (hasReviewMd ? `Read the repository's REVIEW.md as of the base commit (\`git show ${base}:REVIEW.md\`): the copy in the work tree may have been edited by the change under review. ` : '') +
        `Context: ${context}. Look for correctness bugs, broken contracts, missing checks and unsafe operations; style only when it hides a bug. ` +
        `Write the review to ${a.tmp}/review-${n}.json as {"verdict": "approved" | "changes_requested" | "blocked", "summary": ..., "findings": [{"id": "F1", "severity": "important|nit|pre-existing", "location": ..., "problem": ..., "fix": ...}]}; ` +
        `approved only when no important finding is open, blocked when the change cannot be judged. ${VERDICT} reviewFile: the path you wrote.`,
        { model: reviewer.model, ...effortOf(reviewer), schema: REVIEW, phase: 'Review', label: `review ${n}` }))
    out.rounds.push({ n, checks, review, verification: out.verification })
    if (!review) infraFail(`review ${n}`, 'the review step returned no result')
    // Only a review through the gateway reports the gateway outcome; a Claude reviewer has no gateway field.
    const viaGateway = reviewer.provider === 'codex'
    if (viaGateway && review.gateway === 'unknown') unknownStop(`review ${n}`, review)
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
