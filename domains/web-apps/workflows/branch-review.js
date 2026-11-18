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
    (attachIfExists.length ? `The gateway refuses a request over 512 KB (prompt plus attachments). Before submitting, add up the sizes of the prompt file and every file you attach; while the sum is over 500 KB, drop the largest remaining optional file from: ${JSON.stringify(attachIfExists)} (never a required one), and append to the prompt file one line "Not attached for size (their changes are in the diff): <names>". If the required files alone are over 500 KB, do not submit: report that as the infrastructure failure. ` : '') +
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

const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nShell rule: run every command with bash (Git Bash on Windows, never PowerShell or cmd); the quoting in these commands is for bash. Resume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `For a gateway call it records as submitted, wait on the latest key recorded for that call in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <key>\`, submit again under the next suffix of the base key (<base>-r2, then <base>-r3; at most 2 retries in all, those already recorded counted) and record the new key in the progress file. ` +
  `After each finished step append one line to it (create the folder if needed). When your whole task is finished, append a last line DONE.`, opts)

phase('Gate')
const gate = await step(
  `Gather facts for a branch review; change nothing. Work from ${a.repo}. Return each file's content as a string, exactly as read, or "" when it does not exist.\n` +
  `- homeModels: ~/.zodchi/models.json. repoModels: ${a.repo}/.zodchi/models.json.\n` +
  `- account: the output of \`zodchi account\`, or "" when it fails.\n` +
  `- head: \`git rev-parse HEAD\`. baseSha: \`git merge-base ${q(a.base)} HEAD\`. files: \`git diff --name-only <baseSha> <head>\` with those two hashes, one path per entry. dirty: true when \`git status --porcelain\` prints anything.`,
  {
    agentType: 'zodchi-core:runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'files', 'head', 'baseSha', 'dirty'],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } }, head: { type: 'string' }, baseSha: { type: 'string' }, dirty: { type: 'boolean' },
      },
    },
  })
if (!gate) return { stoppedAt: 'gate' }
if (!/^[0-9a-f]{40}$/.test(gate.head) || !/^[0-9a-f]{40}$/.test(gate.baseSha)) return { stoppedAt: 'gate', error: `no commit hashes (head ${gate.head}, base ${gate.baseSha})` }
const range = `${gate.baseSha} ${gate.head}`
if (!gate.files.length) return { refused: `No change between ${a.base} and ${gate.head}.` }

const parse = (t) => { if (!t || !t.trim()) return null; try { return JSON.parse(t) } catch { return null } }
const table = { ...((parse(gate.homeModels) || {}).roles || {}), ...((parse(gate.repoModels) || {}).roles || {}), ...(a.models || {}) }
const acc = parse(gate.account)
const used = (w) => (w && typeof w.usedPercent === 'number') ? w.usedPercent : 0
const codexOk = Boolean(acc && acc.connected && acc.ordinaryUsageAllowed !== false && used(acc.primary) < 100 && used(acc.secondary) < 100)
// A branch review reads the checkout, so only gateway (codex) candidates qualify here; a Claude reviewer is a separate session.
const pick = (role) => ((table[role] || {}).candidates || []).find(c => c.provider === 'codex' && codexOk && !authors.has(`${c.provider}/${c.model}`))
const reviewer = pick('reviewer')
const architect = a.architecture ? pick('architect') : null
if (!reviewer) return { refused: `No gateway reviewer available that is not an author (${[...authors].join(', ')}); codex ${codexOk ? 'available' : 'unavailable'}.` }
if (a.architecture && !architect) return { refused: 'No gateway architect available that is not an author.' }
if (gate.dirty) log('The checkout has uncommitted changes: the review reads the recorded head commit only.')

const REVIEW = {
  type: 'object', required: ['verdict', 'findings'],
  properties: { verdict: { type: 'string', enum: ['approved', 'changes_requested', 'blocked', 'missing'] }, summary: { type: 'string' }, reviewFile: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, blocking: { type: 'number' } },
}
const ask = (role, who, tag) => step(
  `Get an independent ${role} through the gateway. Work from ${a.repo}. Write ${a.tmp}/${tag}.md: ` +
  `the change is exactly the commits ${gate.baseSha}..${gate.head} over these files: ${JSON.stringify(gate.files)}. The reviewer reads it in the checkout itself with \`git diff ${range} -- <files>\` and reads files as of that commit with \`git show ${gate.head}:<file>\`, not from the working tree, which may have moved on; plus the consumers around it. ` +
  `${a.brief ? `What it must meet: the attached brief ${a.brief}. ` : ''}${gate.dirty ? 'Uncommitted changes in the checkout are not part of the change. ' : ''}` +
  (role === 'architecture review' ? `First save \`git diff ${range}\` as ${a.tmp}/${tag}.diff (an architect has no checkout). ` : '') +
  `Then ` +
  gatewayCall({
    role: role === 'architecture review' ? 'architecture-review' : 'checkout-review', key: `${a.label}-${tag}`, totalMin: 55, out: `${a.tmp}/${tag}.json`,
    args: `--model ${who.model} --effort ${who.effort} --prompt ${q(`${a.tmp}/${tag}.md`)}`,
    attach: [...(a.brief ? [a.brief] : []), ...(role === 'architecture review' ? [`${a.tmp}/${tag}.diff`] : [])],
  }) + ` ` +
  `verdict: the "verdict" field of the review exactly ("missing" when it has none). summary: its summary. findings: the reviewer's findings only, each as "<id> <severity> <location>: <problem>". blocking: their count. reviewFile: the review file path. Change no code.`,
  { agentType: 'zodchi-core:runner', schema: REVIEW, phase: 'Review', label: tag })

phase('Review')
const [review, arch] = await parallel([
  () => ask('code review', reviewer, 'review'),
  ...(architect ? [() => ask('architecture review', architect, 'architecture')] : []),
])
return {
  label: a.label, base: gate.baseSha, head: gate.head, files: gate.files, models: { reviewer, architect },
  review, architecture: arch || null,
  // Approval is the reviewers' explicit verdict, never an empty findings list.
  approved: Boolean(review && review.verdict === 'approved' && (!architect || (arch && arch.verdict === 'approved'))),
  next: 'Close the findings with the author (code-package with the same brief), then run branch-review again. Release only with an approved review.',
}
