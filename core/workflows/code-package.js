export const meta = {
  name: 'code-package',
  description: 'One code package: a gate resolves the role table and refuses overlapping packages, the writer implements, a runner runs the cheap checks and then the real thing end to end, an independent reviewer reviews the fixed commit with the REVIEW.md of the base commit, the writer closes findings; stops after 3 review rounds',
  whenToUse: 'Any code package from a finished brief. Args: see the header of the script.',
  phases: [
    { title: 'Gate', detail: 'runner reads the role table, the subscription limits, open packages, Git state and whether .agent-tmp/ is ignored, then claims the files', model: 'haiku' },
    { title: 'Write', detail: 'writer implements the brief (agent mode) or an expert answers and the applier applies it (expert mode)' },
    { title: 'Checks', detail: 'runner runs the cheap checks (build, lint, fast tests), then the end-to-end verification, and commits the package files with a Verified stamp', model: 'haiku' },
    { title: 'Review', detail: 'reviewer (never the author) reviews the commit of the round through the gateway, applying REVIEW.md from the base commit', model: 'haiku' },
    { title: 'Close', detail: 'the same writer closes the findings' },
  ],
}

// args:
//   label     short name, also the prefix of gateway keys and the name of the package claim, e.g. "export-csv"
//   brief     path of the brief file: goal, files that may change, what "done" means, checks
//   repo      repository the change is in (absolute path); every command runs from it. It must be a Git work tree:
//             the review judges a fixed commit and the protected checks compare with the base commit
//   files     the files the lead expects to change, absolute or relative to repo; the gate refuses to start when
//             another open package claims one of them, and the review attaches these plus every file the writer
//             reports changed
//   tmp       folder for prompts, logs and reviews of this package (absolute)
//   mode      "agent" (default): the writer edits the files itself. "expert": the writer answers once through
//             the gateway with the edits, and the applier puts them into the files
//   hard      true when the lead marked the package hard: the role hardWriter writes instead of writer
//   checks    the brief's checks, run from the repo after each write; each entry is a command string (passes on exit 0)
//             or { cmd, pass, e2e } where pass says in words what success is, e.g. "prints usage, any exit code",
//             and e2e: true marks a check that runs the real program end to end. Unmarked checks are the cheap ones
//             (build, lint, fast tests): they run first, and a failure goes back to the writer without the slow run
//   verify    optional: the repository's end-to-end verification, commands like checks. Without it the runner follows
//             the repository's skill .claude/skills/verify/SKILL.md as of the base commit, and without that the e2e
//             checks. When none exists the package is not verified by running: the result carries verifiedBy "none"
//   protect   optional: more paths whose existing files the package may not change (exact paths, folders, or globs
//             with * and **), besides tests and end-to-end scenarios (test/, tests/, e2e/, *.test.*, *_test.*,
//             *.spec.*), REVIEW.md, the verify skill, the files the check and verify commands and the verify skill's
//             commands name, and the package.json scripts they run (npm, pnpm, yarn or bun run against the root
//             package.json, read from the base commit, with their pre and post scripts whether or not they exist yet,
//             and the files those scripts name). New files are allowed; a change to an existing one, or a new pre or post
//             script, stops the package before review with the list. An end-to-end command (args.verify, an e2e check,
//             or the whole verify skill) that the workflow cannot follow to what it runs - it names no file and no
//             package script, changes directory (cd, pushd), or picks another manifest or workspace (--prefix, -C,
//             --dir, --cwd, --filter, --workspace, yarn workspace) - cannot be protected by itself: the gate then
//             refuses unless args.protect names its entry points
//   allowCheckChanges  optional: { "<path>": "<reason>" }: protected paths this package may change, each with the
//             lead's reason (a deleted flaky test, say); the result records them in checkChanges
//   rounds    review rounds at most, default 3 (the stop rule: without approval the package returns to a human)
//   fixes     how many times a check failure caused by the code goes back to the writer, default 1
//   continuations  fresh writers that may go on after one ran out of context, default 2
//   branch    optional: Git branch for the package; created from the current HEAD when missing. An existing branch must
//             point at the current HEAD (the gate reads the base from it); otherwise the gate refuses: switch to it first
//   commit    default true: the runner commits the package's files after each passing checks run, and the review judges
//             that fixed commit. Nothing is ever pushed. false: a preview: nothing is committed (the gate refuses one
//             that would need the .gitignore repair), the review reads the work tree, so it never approves the package;
//             a review that would approve leaves approved and verdict unset and its verdict in preview
//   models    optional: role table entries that replace the table for this run, e.g. { writer: { candidates: [...] } }
//   fixIgnore true: when the repository does not ignore .agent-tmp/ and the package calls the gateway, the runner
//             appends ".agent-tmp/" to .gitignore and commits that line on its own before the package starts.
//             Default false: the gate refuses
//   closeShouldFix  true: when the last review approves with nit findings (should_fix and note are read as nit), the
//             same writer closes them and one more short review checks only those (it counts against rounds). Default
//             false: the run ends approved, with those findings in openFindings. pre-existing findings are never closed
//   rerun     steps that threw for an infrastructure failure, as { "<label>": <attempt> } (the error and out.next name
//             both, e.g. { "review 1": 2 }): on resume these steps run again instead of coming back from the journal.
//             A list of labels means attempt 2 for each
//
// result: { label, mode, models, rounds[], write, verdict, approved, openFindings[], verifiedBy, verification, next,
//           stoppedAt, refused, question, questions, conflicts, claimAdded, outsideRepo, claimLeftOpen, protectedChanged, protectedScripts,
//           checkChanges, flaky, stale, preview }
//   verdict       the effective verdict of the last review that decided the package: "approved" exactly when approved is
//                 true, "changes_requested" when an important finding is open (whatever word the reviewer chose),
//                 "blocked" (also for a changes request that lists no finding); absent when no review decided it, and in
//                 a preview that would approve. The reviewer's own word stays in rounds[].review.verdict
//   openFindings  always present: every finding of the last review that no later round closed, any severity, as
//                 "<id> <severity> <location>: <problem>" with the severity important, nit or pre-existing; [] when
//                 there was no review or it had none
//   verifiedBy    always present: "args.verify", "verify skill" or "checks" when the last checks ran the work as it stands
//                 end to end, one evidence entry per scheduled command that met its pass rule with a trace this run made
//                 (for the skill also a step that drives its flow); "none" otherwise (never reported as verified), also
//                 when a write changed the work after its last verified run, and when the work tree held changes outside
//                 the package at the commit, so the run tested files the commit does not have
//   verification  { verifiedBy, evidence[] ({ command, exitCode, passed, trace, flow }), checks[], note, stamp,
//                 reviewedCommit, review } of the work as it stands; each round keeps its own in rounds[].verification
//   flaky         a check that failed without a cause in the change: { reportedBy, results[], logs[], evidence[] }; the
//                 runner or the writer reports it, and the package stops
//   next          what the lead does next when the run ends with something left open
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
// attach: the files the request must carry, listed by the workflow; keepIfExists: files that must be carried when they
// exist (never dropped for size); attachIfExists: optional files, attached only when they exist and dropped first for size.
// label: the step's label. A rerun after an infrastructure failure (attempt 2 and on) submits under a base key of its
// own, <key>-a<attempt>: its prompt differs, and the earlier keys end in a final job that gave no usable result. Only an
// earlier job that is still running is waited on instead.
const gatewayCall = ({ role, key: baseKey, label, args, attach = [], keepIfExists = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const n = attempt(label)
  const key = n > 1 ? `${baseKey}-a${n}` : baseKey
  const flags = [...attach, ...keepIfExists, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const ifExists = [...keepIfExists, ...attachIfExists]
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, base key ${key}. ` +
    (n > 1 ? `This is attempt ${n} after an infrastructure failure; earlier attempts used other keys (${baseKey}${n > 2 ? `, ${baseKey}-a2` : ''}${n > 3 ? ' and on' : ''}, with their -r2 and -r3). ` +
      `Unless the progress file already records a key that starts with ${key}: take the latest key it records for this call; if \`zodchi job --key <that key>\` shows the job not final yet, it is the active key: wait on it as below instead of submitting; if it then dies before its turn (the rule below), the next submission is ${key}, not a suffix of that key. ` +
      `Otherwise (it is final, whatever its status, or there is none) never wait on it or reuse it: submit under ${key}. ` : '') +
    `Run it in the foreground from ${repo}: \`${run}\`. ` +
    (ifExists.length ? `Before every submission, retries included, drop the --attach of each of these files that does not exist on disk: ${JSON.stringify(ifExists)}; keep every other --attach. ` : '') +
    `The gateway refuses a request over 512 KB (prompt plus attachments). Before every submission, first remove a "Not attached for size" line left by an earlier attempt from the prompt file, then add up the size of the prompt file and of every file you attach. While the sum is over 500 KB and an optional file is still attached${attachIfExists.length ? ` (optional: ${JSON.stringify(attachIfExists)}; no other file is optional)` : ' (there are none here)'}, drop the largest optional one (never another file) and add its name to one line at the end of the prompt file, "Not attached for size: <names>"; then count again, the prompt included. If the sum is still over 500 KB with no optional file left, do not submit: report that as the infrastructure failure. ` +
    `Never in the background (no &, nohup or run_in_background), never through Monitor: the worker of the job ends with your shell. ` +
    `The active key is the key of the latest submission: ${key} at first, then ${key}-r2, then ${key}-r3 (at most 2 retries in all). Every wait, \`zodchi job\` and request.json check below names the active key, never an earlier one, also after a resume (the progress file holds the latest key). ` +
    `While it exits 3 (still running), repeat \`zodchi wait --key <active key> --wait-sec 540 --out ${q(out)}\` in the foreground, up to ${totalMin} minutes in all since the first command; ` +
    `never return before the job is final (exit 0 or 2); if the ${totalMin} minutes run out, report failure (ok false; verdict "missing" for a review) and say the job still runs under its active key. ` +
    `A dead job gets a new key: when the job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <active key>\` (it died before its turn started), ` +
    `run the same full command again with --key set to the next key, wait for it the same way, and write each new key into the progress file at once. ` +
    `Any other final status is not retried: report it. ` +
    (attach.length || ifExists.length
      ? `After the job is final, read ${repo}/.agent-tmp/gateway/<active key>/request.json: its "prompt" must contain \`<attachment path="...">\` (the path as given to --attach, slash direction aside) for every required attachment: ${JSON.stringify(attach)}` +
        `${keepIfExists.length ? `, for each of these that exists on disk: ${JSON.stringify(keepIfExists)}` : ''}` +
        `${attachIfExists.length ? `, and for each optional one that this submission attached (it exists on disk and the prompt file's "Not attached for size" line does not name it): ${JSON.stringify(attachIfExists)}` : ''}. ` +
        `If one is missing, put "attachment missing: <path>" into your summary and run the full command again with the next key (counted with the retries), with the same attachments, then check that new job's request.json the same way; the result you return is that of the last job, and when an attachment is still missing after the last retry it reports failure the same way.`
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
const step = (prompt, opts) => agent(prompt +
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
    // checks the writer ran that failed without a cause in the change: the package stops there, before any runner check
    flaky: {
      type: 'array',
      items: { type: 'object', required: ['command', 'log'], properties: { command: { type: 'string' }, log: { type: 'string' }, why: { type: 'string' } } },
    },
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
    // the end-to-end run: one entry per command, with its exit code, whether it met its pass rule, and where its log,
    // trace or screenshot is
    // and, for a step of the verify skill, whether it drives the flow the skill names (flow true) or only sets up
    evidence: {
      type: 'array',
      items: {
        type: 'object', required: ['command', 'exitCode', 'passed', 'trace'],
        properties: { command: { type: 'string' }, exitCode: { type: 'number' }, passed: { type: 'boolean' }, trace: { type: 'string' }, flow: { type: 'boolean' } },
      },
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
    // the commit the review names as the one it judged, and HEAD read again after the review was final
    commit: { type: 'string' }, headAfter: { type: 'string' },
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
// The severity is the second word of a finding line "<id> <severity> <location>: <problem>". A review says important
// (blocks approval), nit (does not block) or pre-existing (was there before the change; does not block). Older words
// are read as their match: blocking as important, should_fix, note and minor as nit. A word that is none of these is
// read as important, so an unreadable finding never approves a change.
const SEVERITY = new Map(Object.entries({ important: 'important', blocking: 'important', nit: 'nit', should_fix: 'nit', note: 'nit', minor: 'nit', 'pre-existing': 'pre-existing', pre_existing: 'pre-existing', preexisting: 'pre-existing' }))
const severity = (f) => SEVERITY.get((String(f).trim().split(/\s+/)[1] || '').toLowerCase()) || 'important'
const normFinding = (f) => String(f).trim().replace(/^(\S+\s+)(\S+)/, (m, id, word) => id + (SEVERITY.get(word.toLowerCase()) || word))
// Two commit hashes name the same commit when one is a prefix of the other (a short hash), at least 7 characters long.
const sameCommit = (x, y) => {
  const s = String(x || '').trim().toLowerCase(), t = String(y || '').trim().toLowerCase()
  return /^[0-9a-f]{7,64}$/.test(s) && /^[0-9a-f]{7,64}$/.test(t) && (s.startsWith(t) || t.startsWith(s))
}

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
  `- ignoreExit: the exit code of \`git check-ignore -q .agent-tmp/gateway/x\` run from ${a.repo} (0: the gateway's job folder is ignored, 1: it is not, anything else: Git could not check).\n` +
  `- verifySkill: true when \`git cat-file -e HEAD:.claude/skills/verify/SKILL.md\` exits 0 (the repository's verify skill is committed); false otherwise, also outside Git. ` +
  `verifySkillText: the output of \`git show HEAD:.claude/skills/verify/SKILL.md\` exactly, "" when verifySkill is false.\n` +
  `- packageJson: the output of \`git show HEAD:package.json\` exactly, "" when that command fails.\n` +
  `- reviewMd: whether the base commit has REVIEW.md: true when \`git cat-file -e HEAD:REVIEW.md\` exits 0; false only when it fails saying the path does not exist in HEAD; true when it fails any other way (the review then insists on reading it).` +
  (a.branch ? `\n- branchHead: the output of \`git rev-parse --verify --quiet ${q(`refs/heads/${a.branch}`)}\`, "" when it prints nothing (the branch does not exist).` : ''),
  {
    agentType: 'zodchi-core:runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'git', 'dirty', 'ignoreExit', 'verifySkill', 'verifySkillText', 'packageJson', 'reviewMd', ...(a.branch ? ['branchHead'] : [])],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' }, accountError: { type: 'string' },
        git: { type: 'boolean' }, head: { type: 'string' }, dirty: { type: 'array', items: { type: 'string' } },
        ignoreExit: { type: 'number' }, verifySkill: { type: 'boolean' }, verifySkillText: { type: 'string' }, packageJson: { type: 'string' },
        reviewMd: { type: 'boolean' }, branchHead: { type: 'string' },
      },
    },
  })
if (!gate) { out.stoppedAt = 'gate'; return out }
// The dirty list guards the commits and the claim: a gate answer without it is no answer, never a clean work tree.
if (!Array.isArray(gate.dirty)) { out.stoppedAt = 'gate (no dirty list: the Git state is unknown)'; return out }

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

const dirtyOverlap = gate.dirty.filter(f => myKeys.includes(key(f)))
if (dirtyOverlap.length) { out.refused = `Uncommitted changes in package files: ${dirtyOverlap.join(', ')}. Commit or stash them first.`; return out }

// A review judges a fixed commit and the protected checks compare with the base commit: both need Git.
if (!gate.git || !/^[0-9a-f]{7,64}$/i.test(String(gate.head || '').trim())) { out.refused = `${a.repo} is not a Git work tree with a commit: code-package reviews a fixed commit and compares the checks with the base commit, so it needs Git. Run \`git init\` and commit the current state first.`; return out }
const commit = a.commit !== false
const base = String(gate.head).trim()
// Everything below (the base, the protected checks, the verify skill, REVIEW.md) is read from HEAD. A branch that
// already exists elsewhere would make that the wrong starting point, so the package starts only where the branch is.
const branchHead = String(gate.branchHead || '').trim()
if (a.branch && branchHead && !sameCommit(branchHead, base)) { out.refused = `The branch ${a.branch} already exists at ${branchHead}, not at the current HEAD ${base}: the base, the protected checks and REVIEW.md would be read from the wrong commit. Switch to it first (\`git switch ${a.branch}\`), then run again.`; return out }
const baseReviewMd = gate.reviewMd !== false

// The checks: the brief's cheap ones first (build, lint, fast tests), then the end-to-end run. The end-to-end run is
// the repository's own verification when it has one: args.verify, else its verify skill, else the brief's e2e checks.
const asCheck = (c) => typeof c === 'string' ? { cmd: c, pass: 'exit code 0' } : { pass: 'exit code 0', ...c }
const checkList = (a.checks || []).map(asCheck)
const cheapChecks = checkList.filter(c => !c.e2e).map(({ cmd, pass }) => ({ cmd, pass }))
const e2eChecks = checkList.filter(c => c.e2e).map(({ cmd, pass }) => ({ cmd, pass }))
const verifyList = [].concat(a.verify || []).map(asCheck).map(({ cmd, pass }) => ({ cmd, pass }))
const verifySource = verifyList.length ? 'args.verify' : gate.verifySkill === true ? 'verify skill' : e2eChecks.length ? 'checks' : 'none'
// The commands of the end-to-end run the workflow knows by name; a verify skill adds steps of its own.
const e2eCommands = [...verifyList, ...e2eChecks].map(c => String(c.cmd).trim())
const SKILL = '.claude/skills/verify/SKILL.md'
// A check runs once, to its end, and its result is what it said: the same words to the runner and to the writer.
const NO_SKIP = `Never skip a check, add a sleep or a wait to make it pass, or run it again until it passes. ` +
  `A check that fails without a cause in the change (nothing in its output points at the changed code, and the machine is fine) is flaky: report it as flaky with its log; deleting or quarantining a flaky test is the lead's decision, never yours.`

// Protected checks: a change must not be able to edit the checks that judge it. Existing tests and end-to-end
// scenarios, REVIEW.md, the verify skill, the entry points of the check and verify commands and of the verify skill,
// and args.protect. New files are allowed; a change to an existing one stops the package before review unless
// args.allowCheckChanges names it.
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]') + '(/.*)?$', caseless ? 'i' : '')
const protectRules = []
for (const p of [].concat(a.protect || [])) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  try { protectRules.push(globRe(/^([A-Za-z]:)?\//.test(s) && !s.includes('*') ? rel(s) : s)) } catch (e) { throw new Error(`args.protect: ${e.message}`) }
}
// Entry points of a command: each word that looks like a file path in the repository, and each package.json script it
// runs through npm, pnpm, yarn or bun against the root package.json (with its pre and post scripts, also those that do
// not exist yet, so that adding one is a change), read from the base commit, whose words count in turn. A script is
// protected by its name, not the whole package.json: a dependency may still change. A command the workflow cannot
// follow is opaque: it changes directory, or its package manager picks another manifest or workspace, so neither its
// paths nor the root scripts say what it runs.
const pkgScripts = (parse(gate.packageJson, 'package.json at the base commit') || {}).scripts || {}
const hasScript = (s) => Object.prototype.hasOwnProperty.call(pkgScripts, s) && typeof pkgScripts[s] === 'string'
const commandPaths = new Set()
const protectedScripts = new Set()
const ELSEWHERE = /^(--prefix|--dir|--cwd|--filter|--workspace|--workspaces|-C|-F|-w|workspace|workspaces)(=|$)/
function entryPoints(cmd, depth = 0) {
  const r = { found: 0, opaque: false }
  const words = String(cmd).split(/\s+/).map(w => w.replace(/^["'(]+|["');]+$/g, ''))
  words.forEach((t, i) => {
    if (/^(cd|pushd)$/.test(t)) { r.opaque = true; return }
    if (/^(npm|pnpm|yarn|bun)$/.test(t)) {
      const end = words.findIndex((w, j) => j > i && /^(&&|\|\||\||;|--)$/.test(w))
      if (words.slice(i + 1, end < 0 ? undefined : end).some(w => ELSEWHERE.test(w))) { r.opaque = true; return }
      const name = words[['run', 'run-script'].includes(words[i + 1]) ? i + 2 : i + 1]
      if (!name || !hasScript(name)) return
      r.found++
      for (const s of [`pre${name}`, name, `post${name}`]) if (!protectedScripts.has(s)) {
        protectedScripts.add(s)
        if (hasScript(s) && depth < 3 && entryPoints(pkgScripts[s], depth + 1).opaque) r.opaque = true
      }
      return
    }
    if (!t || t.startsWith('-') || !/^[\w.@/\\:-]+$/.test(t) || !(/[\\/]/.test(t) || /\.\w+$/.test(t))) return
    try { commandPaths.add(rel(t).toLowerCase()); r.found++ } catch {}
  })
  return r
}
const followed = (r) => r.found > 0 && !r.opaque
for (const c of cheapChecks) entryPoints(c.cmd)
// An end-to-end command that cannot be followed to what it runs cannot be protected by itself: args.protect must name it.
const unresolved = [...verifyList, ...e2eChecks].filter(c => !followed(entryPoints(c.cmd))).map(c => c.cmd)
if (verifySource === 'verify skill') {
  // The skill's commands are its code spans and code blocks, as of the base commit.
  const spans = [...String(gate.verifySkillText || '').matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map(m => m[1] || m[2])
  const lines = spans.flatMap(s => s.split('\n')).map(line => entryPoints(line))
  if (!lines.some(x => x.found) || lines.some(x => x.opaque)) unresolved.push(`the verify skill ${SKILL}`)
}
if (unresolved.length && !protectRules.length) {
  out.refused = `The end-to-end verification runs ${JSON.stringify(unresolved)}, which name no file of the repository and no package.json script, so a change could edit what they run unseen. ` +
    `Name their entry points (the scripts, configs or scenario folders they run) in args.protect, then run again.`
  return out
}
const isProtected = (r) => {
  const l = r.toLowerCase()
  const parts = l.split('/')
  const name = parts[parts.length - 1]
  return parts.slice(0, -1).some(s => ['test', 'tests', 'e2e'].includes(s)) ||
    /\.test\./.test(name) || /_test\./.test(name) || /\.spec\./.test(name) ||
    l === 'review.md' || l.startsWith('.claude/skills/verify/') || commandPaths.has(l) ||
    protectRules.some(re => re.test(r))
}
const allowed = new Map()
const allowIn = a.allowCheckChanges || {}
for (const [p, reason] of Array.isArray(allowIn) ? allowIn.map(x => [x && x.path, x && x.reason]) : Object.entries(allowIn)) {
  if (!p || typeof reason !== 'string' || !reason.trim()) throw new Error(`args.allowCheckChanges: ${JSON.stringify(p)} needs a reason`)
  allowed.set(key(p), { path: rel(p), reason: reason.trim() })
}
const PROTECT = ` Protected checks: do not change or delete an existing test or end-to-end scenario (test/, tests/, e2e/, *.test.*, *_test.*, *.spec.*), REVIEW.md, ` +
  `the verify skill (.claude/skills/verify/), or a file the checks run${commandPaths.size ? ` (${[...commandPaths].join(', ')})` : ''}` +
  `${protectedScripts.size ? `, or the package.json scripts they run (${[...protectedScripts].join(', ')}, adding one that is missing included; the rest of package.json may change)` : ''}` +
  `${protectRules.length ? `, or these: ${JSON.stringify([].concat(a.protect))}` : ''}; never weaken an assertion. ` +
  `Adding new test files is allowed. A change to an existing protected file stops the package before review` +
  (allowed.size ? `, except these, which the lead allowed: ${JSON.stringify([...allowed.values()])}` : '') + `. ${NO_SKIP}`

// The gateway refuses a job in a repository that does not ignore .agent-tmp/. Found here, before any writing, instead
// of at the first gateway call. Only a package that calls the gateway needs it.
const usesGateway = mode === 'expert' || writer.provider === 'codex' || reviewer.provider === 'codex'
const needIgnore = usesGateway && gate.ignoreExit !== 0
if (needIgnore) {
  if (gate.ignoreExit !== 1) { out.refused = `Git could not check the ignore rules of ${a.repo} (git check-ignore exit ${gate.ignoreExit}); the gateway works only inside a Git repository.`; return out }
  // The repair is a commit, and a preview (args.commit false) commits nothing: the repair is asked for beforehand.
  if (!commit) { out.refused = `${a.repo} does not ignore .agent-tmp/, so the gateway would refuse this package's calls, and a preview (args.commit false) commits nothing, not even that repair. Add ".agent-tmp/" to its .gitignore and commit it first, then run the preview again.`; return out }
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
// The ignore repair changes .gitignore, so the claim holds it too, checked against other open packages like any file.
const claimKeys = needIgnore && !myKeys.includes('.gitignore') ? [...myKeys, '.gitignore'] : myKeys
try {
const claim = await step(
  `Claim files for the package ${a.label} in ${a.repo}. Follow these steps exactly.\n` +
  LOCK + compare(claimKeys) +
  `3. If there is no conflict, write "${claimFile}": ${JSON.stringify({ label: a.label, status: 'open', files: claimKeys, brief: a.brief, base })}, plus "openedAt" with \`date -u +%Y-%m-%dT%H:%M:%SZ\`.\n` +
  UNLOCK +
  (a.branch ? `5. If there was no conflict, switch to the Git branch ${a.branch}: \`git switch ${q(a.branch)}\`, or \`git switch -c ${q(a.branch)}\` when it does not exist.\n` : '') +
  `ok is true when the claim file was written${a.branch ? `, \`git branch --show-current\` prints ${a.branch} and \`git rev-parse HEAD\` prints ${base} (the base the gate read)` : ''}. conflicts: the conflicts found, [] when none.`,
  {
    agentType: 'zodchi-core:runner', label: `claim ${a.label}`,
    schema: { type: 'object', required: ['ok', 'conflicts'], properties: { ok: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
  })
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
      `3. \`git check-ignore -q .agent-tmp/gateway/x\` must exit 0, and \`git show --name-only --format= HEAD\` must list .gitignore only. ok is true only then. summary: the commit hash.`,
      { agentType: 'zodchi-core:runner', schema: STEP, label: `ignore ${a.label}` })
    if (!ignored || !ignored.ok) { out.stoppedAt = `ignore .agent-tmp (${ignored ? ignored.summary : 'no result'})`; return out }
    log(`Committed ".agent-tmp/" in .gitignore: ${ignored.summary}`)
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
  // The writer may run the checks too; a flaky one it meets stops the package the same way as the runner's.
  const WRITER_FLAKY = ` If a check you run fails without a cause in the change, do not run it again or work around it: put it into flaky (command, the path of its log, why you think so) and return; the package stops there for the lead before any further check runs.`
  // Codex answers by a fixed schema without a flaky field: it marks a flaky check in its checks, and the mapping reads it.
  const CODEX_FLAKY = `If a check you run fails without a cause in the change, do not run it again or work around it: put it into checks with its real exit code and a result that starts with "flaky: <the path of its log>: " and says why, and stop with status blocked; the package stops there for the lead before any further check runs.`
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
    const changedSoFar = [], questionsSoFar = [], flakySoFar = []
    for (let c = 0; c <= (a.continuations ?? 2); c++) {
      const o = c ? { ...pinned, label: `${opts.label} (cont ${c})` } : pinned
      try { res = await step(prompt, o) } catch (e) { log(`${o.label}: ${e.message}`); res = null }
      if (res) { changedSoFar.push(...(res.changed || [])); questionsSoFar.push(...(res.questions || [])); flakySoFar.push(...(Array.isArray(res.flaky) ? res.flaky : [])) }
      // A flaky check stops the package: no fresh writer goes on to run it again, whatever more says.
      if (res && (!res.more || flakySoFar.length)) break
    }
    return res && { ...res, changed: [...new Set(changedSoFar)], questions: [...new Set(questionsSoFar)], flaky: flakySoFar }
  }

  // One writing turn by the resolved writer: a Claude coder, a Codex work call, or an expert answer applied by the
  // applier. evidence: files the task refers to (review, logs); a tool-free expert gets them attached.
  // A write changes the work, so an earlier verified run no longer verifies it: the current verification becomes "none"
  // until the next checks pass. The earlier run's evidence stays with its round (rounds[].verification).
  let calls = 0
  async function write(job, tag, phaseName, evidence = []) {
    const n = ++calls
    if (out.verification) {
      out.verifiedBy = 'none'
      out.verification = {
        ...out.verification, verifiedBy: 'none', evidence: [], checks: [], stamp: 'Verified: none', reviewedCommit: null, review: null,
        note: `not verified by running: ${tag} changed the work after its last checks; the evidence of that run stays with its round in rounds[]`,
      }
    }
    const task = `${job} ${COMMITS}${PROTECT}`
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
        `done is true only when every edit row has a line number and the checks are clean. changed: the target files, absolute paths. unverified: rows not applied.${WRITER_FLAKY}`,
        { agentType: 'zodchi-core:applier', schema: WRITE, phase: phaseName, label: `${tag} apply` })
    }
    if (writer.provider === 'codex') {
      const work = await step(
        `Have Codex do this through the gateway. Work from ${a.repo}. Write ${a.tmp}/work-${n}.md: ${task} ${CODEX_FLAKY} ` +
        `Then ` +
        gatewayCall({
          role: 'package-work', key: `${a.label}-work-${n}`, label: tag, totalMin: 60, out: `${a.tmp}/work-${n}.json`,
          args: `--model ${writer.model} --effort ${writer.effort} --prompt ${q(`${a.tmp}/work-${n}.md`)}`,
          attach: [a.brief, ...evidence],
        }) + ` The answer is JSON with status, summary, criteria, questions, changedFiles, checks. Map it exactly: ` +
        `done = (status is "done"); summary = its summary; changed = each entry of changedFiles prefixed with "${repoKey}/"; ` +
        `unverified = every criterion that is not done, as one line each, plus every check with a non-zero exit code; ` +
        `flaky = each entry of its checks whose result starts with "flaky:", as { command: its command, log: the log path its result names, why: the rest of its result }, [] when none; questions = each entry of its questions as one readable line (the question, its options, the recommendation). ` +
        `If the job did not succeed, done is false and summary says the job status. ${INFRA}`,
        { agentType: 'zodchi-core:runner', schema: withInfra(WRITE), phase: phaseName, label: `${tag}` })
      if (infraBad(work)) infraFail(tag, work ? (work.infra || 'gateway: failed') : 'the gateway step returned no result')
      return work
    }
    return continued(task + WRITER_FLAKY + HANDOVER, { agentType: 'zodchi-core:coder', model: writer.model, schema: WRITE, phase: phaseName, label: tag })
  }

  // The claim follows the real change: after every Write and Close, the files the writer reports and the files Git
  // sees changed join the claim and the package. Neither source brings in the job folder .agent-tmp/ or a file already
  // dirty at the gate; a reported file of that second kind stops the run, because committing it would commit somebody
  // else's changes. A file another open package claims stops the run too. Either way the work stays uncommitted for a human.
  const atGate = new Set(gate.dirty.map(f => { try { return key(f) } catch { return '' } }))
  const jobFolder = (r) => /^\.agent-tmp(\/|$)/i.test(r)
  const claimed = new Set(claimKeys)
  // After every write: the claim follows the change, then the protected checks are compared with it.
  async function follow(res, tag, phaseName) {
    return (await followClaim(res, tag, phaseName)) && (await guard(tag, phaseName))
  }
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
    for (const p of st.paths) {
      let r
      try { r = rel(p) } catch { continue }
      if (!atGate.has(r.toLowerCase()) && !jobFolder(r)) found.push(r)
    }
    const extra = [...new Map(found.filter(r => !claimed.has(r.toLowerCase())).map(r => [r.toLowerCase(), r])).values()]
    if (!extra.length) { noteChanged(found); return true }
    const keys = extra.map(r => r.toLowerCase())
    const more = await step(
      `Extend the claim of the package ${a.label} by files its work changed. Follow these steps exactly.\n` +
      LOCK + compare(keys) +
      `3. If there is no conflict, add each of ${JSON.stringify(keys)} that is missing to the "files" list of "${claimFile}"; keep every other field and entry.\n` +
      UNLOCK +
      `ok is true when there was no conflict and "${claimFile}" lists every one of them. conflicts: the conflicts found, [] when none.`,
      {
        agentType: 'zodchi-core:runner', phase: phaseName, label: `claim more ${tag}`,
        schema: { type: 'object', required: ['ok', 'conflicts'], properties: { ok: { type: 'boolean' }, conflicts: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
      })
    if (more && !more.ok && more.conflicts && more.conflicts.length && more.conflicts[0] !== 'lock busy') {
      out.conflicts = more.conflicts
      out.stoppedAt = 'claim conflict'
      out.next = `The work changed files that another open package claims: ${more.conflicts.join('; ')}. This round's work is not committed: it stays in ${a.repo} for a human to settle with that package.`
      return false
    }
    if (!more || !more.ok) { out.stoppedAt = `claim more (${more ? more.summary || (more.conflicts || []).join(', ') : 'no result'})`; return false }
    for (const r of extra) claimed.add(r.toLowerCase())
    noteChanged(found)
    out.claimAdded = [...(out.claimAdded || []), ...extra]
    log(`Claim of ${a.label} extended by ${extra.join(', ')}`)
    return true
  }

  // The package's protected files that existed before it and differ now. Only such a change counts: a new file is
  // allowed. The comparison is with the base commit, never with a list the writer gives. In package.json only the
  // protected scripts count; a change to one of them is reported as a change of package.json.
  const pkgBase = `${a.tmp}/package.base.json`
  const SCRIPT_DIFF = `const fs=require("fs");const s=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8")).scripts||{}}catch(e){return null}};` +
    `const a=s(process.argv[1]),b=s(process.argv[2]);for(const n of JSON.parse(process.argv[3]))if(!a||!b||a[n]!==b[n])console.log(n)`
  async function guard(tag, phaseName) {
    const candidates = [...changed].map(rel).filter(isProtected)
    const scripts = protectedScripts.size && [...changed].some(f => key(f) === 'package.json') ? [...protectedScripts] : []
    if (!candidates.length && !scripts.length) return true
    const res = await step(
      `Compare protected files with the base commit ${base} in ${a.repo}; change nothing.
` +
      (candidates.length
        ? `- Paths to compare, relative to the repository: ${JSON.stringify(candidates)}. For each path: it existed before when \`git cat-file -e ${base}:<path>\` exits 0; such a path differs now when \`git diff --quiet ${base} -- <path>\` exits 1 (changed or deleted). ` +
          `paths: every path that existed before and differs now, exactly as given; [] when none.
`
        : `- paths: [].
`) +
      (scripts.length
        ? `- Package scripts to compare: ${JSON.stringify(scripts)}. Run \`git show ${base}:package.json > ${q(pkgBase)}\`, then \`node -e ${q(SCRIPT_DIFF)} ${q(pkgBase)} package.json ${q(JSON.stringify(scripts))}\`: it prints each of these scripts that differs now (or every one when package.json is gone). scripts: the names it printed; [] when none.
`
        : '') +
      `ok is true when every command ran.`,
      {
        agentType: 'zodchi-core:runner', phase: phaseName, label: `protect ${tag}`,
        schema: scripts.length ? { ...STATUS, required: [...STATUS.required, 'scripts'], properties: { ...STATUS.properties, scripts: { type: 'array', items: { type: 'string' } } } } : STATUS,
      })
    if (!res || !res.ok || !Array.isArray(res.paths) || (scripts.length && !Array.isArray(res.scripts))) { out.stoppedAt = `protected checks after ${tag} (${res ? res.summary || 'no paths or scripts list' : 'no result'})`; return false }
    const changedScripts = scripts.length ? res.scripts.map(String) : []
    if (changedScripts.length) out.protectedScripts = changedScripts
    const hit = [...new Set([...res.paths, ...(changedScripts.length ? ['package.json'] : [])].map(p => { try { return rel(p) } catch { return String(p) } }))]
    const allow = hit.filter(p => allowed.has(p.toLowerCase())).map(p => allowed.get(p.toLowerCase()))
    if (allow.length) out.checkChanges = [...new Map([...(out.checkChanges || []), ...allow].map(x => [x.path.toLowerCase(), x])).values()]
    const bad = hit.filter(p => !allowed.has(p.toLowerCase()))
    if (!bad.length) return true
    out.protectedChanged = bad
    out.stoppedAt = `protected checks changed at ${tag}`
    out.next = `The work changed or deleted existing checks: ${bad.join(', ')}${out.protectedScripts && bad.some(p => p.toLowerCase() === 'package.json') ? ` (package.json scripts ${out.protectedScripts.join(', ')})` : ''}. A change must not edit the checks that judge it, so the package stopped before review; this round's work is not committed and stays in ${a.repo}. ` +
      `If the change to a check is right (a test of behaviour the brief changes on purpose, a flaky test you decided to delete), run again with args.allowCheckChanges {"<path>": "<reason>"}; otherwise have the writer restore them.`
    return false
  }

  // A flaky check stops the package whoever met it first, the runner or the writer, with its log; nothing reruns it.
  const flakyNext = (results) => `A check failed without a cause in the change (flaky): ${JSON.stringify(results)}. Nothing was retried or skipped. ` +
    `Fix the check, or decide to delete or quarantine it: that decision is yours, recorded by running again with args.allowCheckChanges {"<test path>": "<reason>"}.`
  function writerFlaky(res, tag) {
    const list = (res && Array.isArray(res.flaky) ? res.flaky : []).filter(x => x && x.command)
    if (!list.length) return false
    out.flaky = { reportedBy: tag, results: list.map(x => `${x.command}: ${x.why || 'failed without a cause in the change'}`), logs: list.map(x => x.log).filter(Boolean), evidence: [] }
    out.stoppedAt = `checks (flaky, reported by the writer at ${tag})`
    out.next = flakyNext(out.flaky.results)
    return true
  }

  phase('Write')
  out.write = await write(
    `Implement the package described in ${a.brief}. Read it first; it is the whole task. ` +
    `done is true only when everything the brief calls "done" holds and you ran what it tells you to run. changed: every file you changed, absolute paths. unverified: what you could not verify, in the order to check it.`,
    `write ${a.label}`, 'Write')
  if (out.write && !(await follow(out.write, `write ${a.label}`, 'Write'))) return
  if (writerFlaky(out.write, `write ${a.label}`)) return
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
    `"flaky" when it failed without a cause in the change (say in results why you think so, with the log line).`
  // Stage 1, the cheap checks: build, lint, fast tests. A failure here goes back to the writer before the slow run.
  const runCheap = (tag) => cheapChecks.length
    ? step(`Run these checks from ${a.repo}, in order, each to its end, one log per command in ${a.tmp}/logs: ${JSON.stringify(cheapChecks)}. ` +
            `A check passes when its output meets its "pass" rule. ${NO_SKIP} ok is true only when every check passes. ` +
            `results: one line per command with its exit code, the decisive output line and pass/fail. logs: the log paths. ${CAUSE}`,
            { agentType: 'zodchi-core:runner', schema: CHECKS, phase: 'Checks', label: `checks ${tag}` })
    : Promise.resolve({ ok: true, results: [], cause: 'none' })
  // Stage 2, the end-to-end run: the real program, started and driven through a real flow.
  const e2eDir = (tag) => `${a.tmp}/e2e-${String(tag).replace(/[^\w.-]+/g, '-')}`
  const runE2e = (tag) => verifySource === 'none'
    ? Promise.resolve({ ok: true, results: [], cause: 'none', evidence: [] })
    : step(`Run the end-to-end verification of a change from ${a.repo}: the real program, started and driven through a real flow. Evidence folder: ${q(e2eDir(tag))}. ` +
            `First empty it (\`rm -rf ${q(e2eDir(tag))} && mkdir -p ${q(e2eDir(tag))}\`), then write every log, trace and screenshot of this run under it, one log per command.\n` +
            (verifyList.length ? `- Run these commands, in order, each to its end: ${JSON.stringify(verifyList)}.\n` : '') +
            (verifySource === 'verify skill'
              ? `- Follow the repository's verify skill as of the base commit, never the working tree's copy: read it with \`git show ${base}:${SKILL}\`, and do what it says: start the app the way it says and drive the flow it names.\n`
              : '') +
            (e2eChecks.length ? `- ${verifyList.length || verifySource === 'verify skill' ? 'Then run' : 'Run'} these checks, each to its end: ${JSON.stringify(e2eChecks)}.\n` : '') +
            `A command passes when its output meets its "pass" rule (exit code 0 for a step of the skill). ${NO_SKIP} ok is true only when every one passes. ` +
            `results: one line per command with its exit code, the decisive output line and pass/fail. logs: the log paths. ` +
            `evidence: one entry per command you ran, in order, also when a listed command is listed twice: command (a listed command exactly as listed; a step of the skill as you ran it), exitCode (its real exit code), passed (true when it met its pass rule, whatever the exit code), ` +
            `trace (the path of the log, trace or screenshot this run wrote for it under the evidence folder; never empty)` +
            `${verifySource === 'verify skill' ? ', flow (for a step of the skill: true when it drives the flow the skill names, false when it only sets up, builds, starts or stops)' : ''}. ${CAUSE}`,
            { agentType: 'zodchi-core:runner', schema: CHECKS, phase: 'Checks', label: `verify ${tag}` })
  // A trace counts only when it lies under the evidence folder this run emptied first and is a non-empty file there:
  // then this run made it. The files are checked by a step of its own, not taken from the run that reports them.
  const underDir = (t, tag) => { try { return fold(norm(t)).startsWith(fold(norm(e2eDir(tag))) + '/') } catch { return false } }
  async function missingTraces(tag, evidence) {
    const traces = [...new Set(evidence.map(e => String((e && e.trace) || '').trim()).filter(t => underDir(t, tag)))]
    if (!traces.length) return []
    const res = await step(
      `Check that files exist; change nothing. For each of ${JSON.stringify(traces)}, run \`test -s <path>\` (a non-empty file). paths: every path for which it fails, exactly as given; [] when none. ok is true when every command ran.`,
      { agentType: 'zodchi-core:runner', schema: STATUS, phase: 'Checks', label: `evidence ${tag}` })
    return res && res.ok && Array.isArray(res.paths) ? res.paths.map(String) : null
  }
  const runChecks = async (tag) => {
    const cheap = await runCheap(tag)
    if (!cheap || !cheap.ok) return cheap && { ...cheap, stage: 'checks' }
    const e2e = await runE2e(tag)
    if (!e2e) return null
    const evidence = e2e.evidence || []
    return {
      ...e2e, stage: e2e.ok ? 'done' : 'e2e',
      results: [...(cheap.results || []), ...(e2e.results || [])], logs: [...(cheap.logs || []), ...(e2e.logs || [])], evidence,
      tag, missing: e2e.ok && evidence.length ? await missingTraces(tag, evidence) : [],
    }
  }

  async function checked(n) {
    let checks = await runChecks(n)
    for (let f = 1; checks && !checks.ok && checks.cause === 'code' && f <= (a.fixes ?? 1); f++) {
      const fix = await write(
        `The ${checks.stage === 'e2e' ? 'end-to-end run' : 'checks'} of the package ${a.brief} failed after the change. Results: ${JSON.stringify(checks.results)}. Logs: ${JSON.stringify(checks.logs || [])}` +
        `${(checks.evidence || []).length ? `. Evidence: ${JSON.stringify(checks.evidence)}` : ''}. ` +
        `Read the logs and fix the code with the smallest change. done is true when the failing command passes. changed: files changed in this fix.`,
        `fix checks ${n}.${f}`, 'Close', checks.logs || [])
      noteQuestions(fix)
      if (fix && !(await follow(fix, `fix checks ${n}.${f}`, 'Close'))) return 'halted'
      if (writerFlaky(fix, `fix checks ${n}.${f}`)) return 'halted'
      if (!fix || !fix.done) { if (questions.length) out.question = questions.join(' | '); break }
      checks = await runChecks(`${n}.${f}`)
    }
    return checks
  }

  // What verified the round: the end-to-end run with its evidence, or plainly nothing. Never "verified" unless each
  // scheduled invocation of a listed command has an evidence entry of its own (a command listed twice needs two), and,
  // for a verify skill, one more entry that is a step of the skill driving its flow (not setup, not a listed command
  // again); every entry met its pass rule and names a trace this run made (see missingTraces). The exit code is kept as
  // it was, since a pass rule may accept a nonzero one.
  function noteVerification(checks) {
    const evidence = (checks.evidence || []).filter(e => e && e.command)
    const gaps = []
    if (verifySource !== 'none') {
      const pool = evidence.map(e => String(e.command).trim())
      for (const c of e2eCommands) {
        const i = pool.indexOf(c)
        if (i < 0) gaps.push(`no evidence for ${c}${e2eCommands.filter(x => x === c).length > 1 ? ' (each run of it needs its own)' : ''}`)
        else pool[i] = null
      }
      if (verifySource === 'verify skill' && !evidence.some((e, i) => pool[i] !== null && !e2eCommands.includes(pool[i]) && e.flow === true)) gaps.push('no evidence for a step of the verify skill that drives its flow')
      const missing = checks.missing
      if (!Array.isArray(missing)) gaps.push('the traces could not be checked')
      for (const e of evidence) {
        const t = String(e.trace || '').trim()
        if (e.passed !== true) gaps.push(`${e.command} did not meet its pass rule`)
        if (!t) gaps.push(`${e.command} names no trace`)
        else if (!underDir(t, checks.tag)) gaps.push(`${e.command} names a trace outside the evidence folder of this run (${t})`)
        else if (Array.isArray(missing) && missing.some(m => fold(String(m).trim()) === fold(t))) gaps.push(`${e.command}: its trace ${t} was not made (missing or empty)`)
      }
    }
    const ran = verifySource !== 'none' && !gaps.length
    const cheap = cheapChecks.length ? `; checks ${cheapChecks.length} passed` : ''
    out.verifiedBy = ran ? verifySource : 'none'
    out.verification = {
      verifiedBy: out.verifiedBy, evidence, checks: checks.results || [],
      note: ran ? '' : verifySource === 'none'
        ? 'not verified by running: the repository has no args.verify, no verify skill and no e2e check, so only the cheap checks ran'
        : `not verified by running: the evidence of the end-to-end run is incomplete (${gaps.join('; ')})`,
      stamp: `Verified: ${ran ? `e2e ${evidence.map(e => `${e.command} exit ${e.exitCode}`).join(', ')}` : 'none'}${cheap}`.replace(/\s+/g, ' ').trim(),
      reviewedCommit: null, review: null,
    }
  }

  // A path-limited commit: other staged work in the index stays out of it, and the runner verifies that. The message
  // ends with the round's verification stamp, so `git log --grep "Verified: none"` finds the commits nothing ran.
  // Returns the commit the review judges (HEAD after the commit, also when nothing changed), or null on failure.
  async function commitRound(n) {
    if (!commit) return 'none'
    const paths = [...changed].map(rel)
    // The checks ran in the shared work tree; the commit holds only the package paths. The stamp may say verified only
    // when the work tree differs from HEAD in nothing else (the job folder aside), so the commit's tree is the tree the
    // run tested. An uncommitted change of somebody else (a dirty e2e script, say) makes the round "Verified: none".
    const st = await step(
      `List what changed in the work tree of ${a.repo}; change nothing. Run \`git status --porcelain -uall\`. ` +
      `paths: every path it lists, relative to the repository, without the status letters and quotes (a rename gives both paths); [] when it lists nothing. ok is true when the command ran.`,
      { agentType: 'zodchi-core:runner', schema: STATUS, phase: 'Checks', label: `status commit ${n}` })
    if (!st || !st.ok || !Array.isArray(st.paths)) return null
    const mine = new Set(paths.map(p => p.toLowerCase()))
    const others = [...new Set(st.paths.map(p => { try { return rel(p) } catch { return String(p) } }).filter(r => !jobFolder(r) && !mine.has(r.toLowerCase())))]
    if (others.length && out.verifiedBy !== 'none') {
      out.verifiedBy = 'none'
      out.verification = {
        ...out.verification, verifiedBy: 'none', stamp: `Verified: none${cheapChecks.length ? `; checks ${cheapChecks.length} passed` : ''}`,
        note: `not verified by running: the work tree held uncommitted changes outside the package (${others.join(', ')}), so the end-to-end run tested files the commit does not have; its evidence is kept here`,
      }
    }
    const message = `${a.label}: round ${n}\n\n${out.verification.stamp}\n`
    const res = await step(
      `Commit the package's files in ${a.repo}; never push. The package paths, relative to the repository: ${JSON.stringify(paths)}.\n` +
      `1. For each path that exists, or that Git tracks and is now deleted, run \`git add -A -- <path>\`; skip a path that is neither.\n` +
      `2. If \`git diff --cached --quiet -- <those paths>\` says nothing changed, skip to step 5 with summary "nothing to commit".\n` +
      `3. Write the commit message to ${a.tmp}/commit-${n}.msg, byte for byte; it is given here as a JSON string, so write the text it stands for (real line breaks). Commit message, as a JSON string: ${JSON.stringify(message)}\n` +
      `4. Run \`git commit -F ${q(`${a.tmp}/commit-${n}.msg`)} -- <those paths>\` (the paths after -- limit the commit to them; other staged files stay staged and out of it). ` +
      `Then \`git show --name-only --format= HEAD\`: every listed file must be one of the package paths, and \`git log -1 --format=%B\` must end with the line ${JSON.stringify(out.verification.stamp)}.\n` +
      `5. head: the full hash \`git rev-parse HEAD\` prints. ok is true when the checks of step 4 hold (or nothing was to commit). summary: the commit hash or "nothing to commit". paths: the files step 4 listed.`,
      { agentType: 'zodchi-core:runner', schema: { ...STEP, required: [...STEP.required, 'head'], properties: { ...STEP.properties, head: { type: 'string' } } }, phase: 'Checks', label: `commit ${n}` })
    if (!res || !res.ok || !/^[0-9a-f]{7,64}$/i.test(String(res.head || '').trim())) return null
    return String(res.head).trim()
  }

  // Review diffs come from Git, deleted files included. With commits, the diff is the fixed commit under review against
  // the base, and the attached files are that commit's copies, never the work tree's. Without commits (a preview) both
  // come from the work tree.
  const diffHow = (target) => commit
    ? `\`git diff ${base} ${target} -- <files>\` over the package paths below (this includes deleted and new files)`
    : `\`git diff ${base} -- <files>\` over the package paths below (this includes deleted files), plus \`git diff --no-index /dev/null <file>\` for each untracked new one`
  const snapDir = (n) => `${a.tmp}/review-${n}-files`
  const SNAP = (n, target, paths) => `Save the package files as of the commit ${target} under ${q(snapDir(n))}, never from the work tree: run \`rm -rf ${q(snapDir(n))}\`, then for each of ${JSON.stringify(paths)} ` +
    `that \`git cat-file -e ${target}:<path>\` finds, create its folder under ${snapDir(n)} and run \`git show ${target}:<path> > ${snapDir(n)}/<path>\` (a path the commit does not have gets no copy).`
  // REVIEW.md, the owner's written focus for reviews, always as of the base commit: the package cannot change what
  // judges it. It is never dropped for size. Whether the base has one was settled at the gate, apart from this export:
  // when it has one, a failed export stops the review instead of sending it without the owner's rules.
  const focusFile = `${a.tmp}/REVIEW.base.md`
  const FOCUS = baseReviewMd
    ? `Save the repository's REVIEW.md as of the base commit, never the work tree's: run \`git show ${base}:REVIEW.md > ${q(focusFile)}\`. The base commit has a REVIEW.md, so the review needs it: if that command fails, do not call the gateway; return gateway "failed" with infra "REVIEW.md export failed: <the error>".`
    : `The base commit has no REVIEW.md: run \`rm -f ${q(focusFile)}\` and attach none.`
  const SEVERITIES = `Every finding has a severity: "important" (a real defect the change brings in; it blocks approval), "nit" (worth fixing, does not block) or "pre-existing" (it was there before the change; does not block).`

  // focus: the nit findings of an approved review that the writer closed (args.closeShouldFix); the next review
  // checks only those. carried: open findings of an earlier review that a focused review does not look at again; they
  // stay open through focused reviews and go to the next full review, which repeats those that still hold.
  let focus = null
  let carried = []
  for (let n = 1; n <= rounds; n++) {
    const focused = focus
    const checks = await checked(n)
    if (checks === 'halted') return
    if (!checks || !checks.ok) {
      out.rounds.push({ n, checks })
      // An earlier round's run does not verify the work as it stands now.
      out.verifiedBy = 'none'
      if (out.verification) out.verification = { ...out.verification, verifiedBy: 'none', evidence: [], stamp: 'Verified: none', note: `not verified by running: the checks of round ${n} failed; earlier evidence stays with its round in rounds[]` }
      if (checks && checks.cause === 'flaky') {
        out.flaky = { reportedBy: `checks ${n}`, results: checks.results || [], logs: checks.logs || [], evidence: checks.evidence || [] }
        out.next = flakyNext(checks.results || [])
      }
      out.stoppedAt = `checks (${checks ? `${checks.cause}${checks.stage === 'e2e' ? ', end-to-end run' : ''}` : 'no result'})`
      return
    }
    noteVerification(checks)
    const target = await commitRound(n)
    if (!target) { out.stoppedAt = 'commit'; return }
    const fixed = target !== 'none'

    const context = `what the change does and why (from ${a.brief} and this summary: ${JSON.stringify(out.write.summary)}), what is verified and what is not ` +
      `(${JSON.stringify(out.write.unverified || [])}), how the runner verified it (${out.verification.stamp}${out.verification.note ? `: ${out.verification.note}` : ''}; evidence ${JSON.stringify(out.verification.evidence)})` +
      `${outside.length ? `, and the files changed outside the repository, not attached: ${JSON.stringify(outside)}` : ''}${n > 1 ? `, and which findings of the previous review (${a.tmp}/review-${n - 1}.json) were closed and how` : ''}` +
      (focus ? `. This is a short review of the approved change: check only whether these findings of ${a.tmp}/review-${n - 1}.json are closed and whether their fixes break anything: ${JSON.stringify(focus)}; approved when they are closed and nothing broke` : '') +
      (!focus && carried.length ? `. These findings of an earlier review are still open and no later review checked them: ${JSON.stringify(carried)}; repeat in your findings, with the same id, severity and location, each one that still holds` : '') +
      (fixed ? `. The commit under review is ${target} ("${a.label}: round ${n}", or an earlier round's when this round changed nothing), on top of the base ${base}; the review's "commit" field names exactly ${target}; ` +
        `read the changed files as of that commit, never the work tree${reviewer.provider === 'codex' ? ` (the attached files under ${snapDir(n)}/ are that commit's copies, at their repository paths)` : ` (\`git show ${target}:<path>\`)`}`
        : `. Nothing is committed in this run (a preview): the change is the work tree, and the review cannot approve the package`) +
      `. ${SEVERITIES} Apply the repository's REVIEW.md as of the base commit when it is attached as REVIEW.base.md: it says what the owner wants flagged and what not; do not add hypothetical edge cases it and the brief do not ask for`
    const files = [...changed]
    const VERDICT = `verdict: the "verdict" field of the review exactly ("approved", "changes_requested" or "blocked"; "missing" when the review file has none). ` +
      `summary: its summary. findings holds the reviewer's findings only, each as "<id> <severity> <location>: <problem>" with the severity word as the review gives it: an empty array when it has none. blocking: the count of important findings.`
    const STALE = `commit: the "commit" field of the review exactly ("" when it has none). headAfter: the full hash \`git rev-parse HEAD\` prints after the review is final.`
    const review = reviewer.provider === 'codex'
      ? await step(
        `Get an independent review of a finished change through the gateway. Work from ${a.repo}. Write ${a.tmp}/review-${n}.md: ${context}. ` +
        `Save the change as ${a.tmp}/change-${n}.diff with ${diffHow(target)}: ${JSON.stringify(files.map(rel))}. ${fixed ? `${SNAP(n, target, files.map(rel))} ` : ''}${FOCUS} Then ` +
        gatewayCall({
          role: 'code-review', key: `${a.label}-review-${n}`, label: `review ${n}`, totalMin: 55, out: `${a.tmp}/review-${n}.json`,
          args: `--model ${reviewer.model} --effort ${reviewer.effort} --prompt ${q(`${a.tmp}/review-${n}.md`)}`,
          attach: [`${a.tmp}/change-${n}.diff`, a.brief, ...(n > 1 ? [`${a.tmp}/review-${n - 1}.json`] : []), ...(baseReviewMd ? [focusFile] : [])],
          attachIfExists: fixed ? files.map(f => `${snapDir(n)}/${rel(f)}`) : files,
        }) + ` ` +
        `A changed file that does not exist ${fixed ? 'in the commit' : 'now'} is left out of --attach (the diff already carries deletions). ` +
        `${VERDICT} ${STALE} reviewFile: the review file path. Change no code. ${INFRA} ` +
        `A job that reached a final status but left no review with a verdict (verdict "missing") is an infrastructure failure too: infra is "the review has no verdict: <the review file, or the job status>", with the INFRA line in the progress file.`,
        { agentType: 'zodchi-core:runner', schema: withInfra(REVIEW), phase: 'Review', label: `review ${n}` })
      : await step(
        `You are an independent code reviewer; you did not write this change. Work from ${a.repo} and change nothing. Read ${a.brief}, then the change: ${diffHow(target)}, for these paths: ${JSON.stringify(files.map(rel))}. ` +
        (baseReviewMd
          ? `Read the repository's REVIEW.md as of the base commit, never the work tree's (\`git show ${base}:REVIEW.md\`), and apply it; the base commit has one, so a review that could not read it is "blocked". `
          : `The base commit has no REVIEW.md: judge by the brief. `) +
        `Context: ${context}. Look for correctness bugs, broken contracts, missing checks and unsafe operations; style only when it hides a bug. ` +
        `Write the review to ${a.tmp}/review-${n}.json as {"verdict": "approved" | "changes_requested" | "blocked", "summary": ..., "commit": ${fixed ? `"${target}"` : '""'}, "findings": [{"id": "F1", "severity": "important|nit|pre-existing", "location": ..., "problem": ..., "fix": ...}]}; ` +
        `approved only when no important finding is open, blocked when the change cannot be judged. ${VERDICT} ${STALE} reviewFile: the path you wrote.`,
        { model: reviewer.model, schema: REVIEW, phase: 'Review', label: `review ${n}` })
    out.rounds.push({ n, checks, review, commit: fixed ? target : null, verification: out.verification })
    if (!review) infraFail(`review ${n}`, 'the review step returned no result')
    // Only a review through the gateway reports the gateway outcome; a Claude reviewer has no gateway field.
    const viaGateway = reviewer.provider === 'codex'
    if ((viaGateway && infraBad(review)) || review.verdict === 'missing') infraFail(`review ${n}`, (viaGateway && review.gateway !== 'final' && review.infra) || `the review has no verdict (${review.summary || 'no summary'}; ${review.reviewFile || `${a.tmp}/review-${n}.json`})`)
    // A review counts only for the commit it names, and only while the branch still points there.
    if (fixed && (!sameCommit(review.commit, target) || !sameCommit(review.headAfter, target))) {
      out.rounds[out.rounds.length - 1].stale = true
      out.stale = { reviewed: review.commit || '', expected: target, headAfter: review.headAfter || '' }
      out.stoppedAt = `review ${n} stale`
      out.next = `The review is stale and was not counted: it names the commit ${JSON.stringify(review.commit || '')}, the round's commit is ${target}, and HEAD after the review was ${JSON.stringify(review.headAfter || '')}. ` +
        `Something moved the branch or the review named another commit. Put the branch back on ${target} or settle what moved it, then resume this run with args.rerun {"review ${n}": 2}; the claim ${claimFile} stays open meanwhile.`
      keepClaim = true
      return
    }
    // A focused review leaves the carried findings as they were; a full review was given them and repeats those that
    // still hold, so after it they are its own findings.
    if (!focused) carried = []
    const findings = (review.findings || []).map(normFinding)
    out.openFindings = [...carried, ...findings]
    // Only important findings block approval and count against the stop rule; nit and pre-existing ones stay open.
    const important = findings.filter(f => severity(f) === 'important')
    if (review.verdict === 'approved' && important.length) log(`review ${n}: approved with ${important.length} important finding(s); read as changes requested`)
    // The effective verdict: severities decide, not the reviewer's word, which stays in rounds[].review.verdict. The
    // package's verdict is "approved" only together with approved: true. A changes request that lists no finding cannot
    // be closed: it is "blocked", with the reviewer's word kept and the question asked below.
    const effective = review.verdict === 'blocked' || (review.verdict === 'changes_requested' && !findings.length) ? 'blocked' : important.length ? 'changes_requested' : 'approved'
    out.rounds[out.rounds.length - 1].verdict = effective
    if (out.verification) { out.verification.reviewedCommit = fixed ? target : null; out.verification.review = `${reviewer.provider}/${reviewer.model} ${effective}${effective !== review.verdict ? ` (the reviewer said ${review.verdict})` : ''}` }
    if (effective !== 'approved') out.verdict = effective
    if (review.verdict === 'changes_requested' && !findings.length) {
      out.stoppedAt = `review verdict ${review.verdict} without findings`
      out.question = `The reviewer asked for changes but listed no finding: ${review.summary || ''} See ${a.tmp}/review-${n}.json.`
      return
    }
    let task
    if (review.verdict !== 'blocked' && !important.length) {
      const nits = findings.filter(f => severity(f) === 'nit')
      if (!nits.length || !a.closeShouldFix || n === rounds) {
        // A review of the work tree, not of a fixed commit, is a preview: it never approves the package.
        if (!fixed) {
          // This review supersedes an earlier round's verdict, and a preview decides nothing: no verdict stays.
          delete out.verdict
          out.preview = { verdict: 'approved', note: 'args.commit is false: the review read the work tree, not a fixed commit, so the package is not approved' }
          out.stoppedAt = `review ${n} preview`
          out.next = `The preview review found no important finding. The work is not committed; to approve it, run the package again with commits (args.commit not false).`
          return
        }
        out.approved = true
        out.verdict = 'approved'
        claimStatus = 'done'
        if (review.verdict !== 'approved') log(`review ${n}: ${review.verdict} with only nit and pre-existing findings; approved`)
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
    } else if (review.verdict === 'blocked') {
      out.stoppedAt = `review verdict ${review.verdict}`
      out.question = `The reviewer could not approve or ask for changes (${review.verdict}): ${review.summary || ''} See ${a.tmp}/review-${n}.json.`
      return
    } else if (n === rounds) {
      out.stoppedAt = `stop rule: ${rounds} review rounds without approval`
      out.question = `The package has important findings after ${rounds} rounds: ${important.join(' | ')}. Decide: accept as is, change the brief, or mark it hard and start again.`
      return
    } else {
      focus = null
      task = `Close the important findings of the review ${a.tmp}/review-${n}.json for the package ${a.brief}: ${JSON.stringify(important)}. Fix each in the reviewer's sense with the smallest change; ` +
        `a finding you reject, say why instead of changing code. Leave nit and pre-existing findings alone unless a fix above closes them anyway. done is true when every important finding is closed or answered. changed: files changed this round.`
    }

    const fix = await write(task, `close ${n}`, 'Close', [`${a.tmp}/review-${n}.json`])
    noteQuestions(fix)
    if (fix && !(await follow(fix, `close ${n}`, 'Close'))) return
    if (writerFlaky(fix, `close ${n}`)) return
    if (!fix || !fix.done) { out.stoppedAt = 'close'; if (questions.length) out.question = questions.join(' | '); return }
    out.write = { ...out.write, summary: `${out.write.summary} | round ${n} fixes: ${fix.summary}`, unverified: fix.unverified || out.write.unverified }
  }
}
