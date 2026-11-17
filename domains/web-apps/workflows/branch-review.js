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
//   author     the models that wrote the change, e.g. ["claude/sonnet"] or ["codex/gpt-6.1-sol"]; the reviewer is never one of them
//   brief      optional: path of the brief or PR description the change must meet
//   architecture  true when the change moves module boundaries, contracts, storage or authority
//   models     optional role table entries for this run
const a = args || {}
for (const k of ['label', 'repo', 'base', 'tmp', 'author']) if (!a[k]) throw new Error(`branch-review needs args.${k}`)
const authors = new Set([].concat(a.author))

const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `For a gateway call it records as submitted, wait on that key (zodchi wait --key <key>) instead of submitting again. ` +
  `After each finished step append one line to it (create the folder if needed). When your whole task is finished, append a last line DONE.`, opts)

phase('Gate')
const gate = await step(
  `Gather facts for a branch review; change nothing. Work from ${a.repo}. Return each file's content as a string, exactly as read, or "" when it does not exist.\n` +
  `- homeModels: ~/.zodchi/models.json. repoModels: ${a.repo}/.zodchi/models.json.\n` +
  `- account: the output of \`zodchi account\`, or "" when it fails.\n` +
  `- files: \`git diff --name-only ${a.base}...HEAD\`, one path per entry. head: \`git rev-parse HEAD\`. dirty: true when \`git status --porcelain\` prints anything.`,
  {
    agentType: 'runner', label: `gate ${a.label}`,
    schema: {
      type: 'object', required: ['homeModels', 'repoModels', 'account', 'files', 'head', 'dirty'],
      properties: {
        homeModels: { type: 'string' }, repoModels: { type: 'string' }, account: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } }, head: { type: 'string' }, dirty: { type: 'boolean' },
      },
    },
  })
if (!gate) return { stoppedAt: 'gate' }
if (!gate.files.length) return { refused: `No change between ${a.base} and HEAD.` }

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
if (gate.dirty) log('The checkout has uncommitted changes: the review reads committed HEAD only; say so in the prompt.')

const REVIEW = {
  type: 'object', required: ['verdict', 'findings'],
  properties: { verdict: { type: 'string' }, reviewFile: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, blocking: { type: 'number' } },
}
const ask = (role, who, tag) => step(
  `Get an independent ${role} through the gateway. Work from ${a.repo}. Write ${a.tmp}/${tag}.md: ` +
  `the change is ${a.base}...${gate.head} over these files: ${JSON.stringify(gate.files)}; the reviewer reads it in the checkout itself (git diff ${a.base}...HEAD -- <files>) and the consumers around it. ` +
  `${a.brief ? `What it must meet: the attached brief ${a.brief}. ` : ''}${gate.dirty ? 'Uncommitted changes in the checkout are not part of the change. ' : ''}` +
  `Then run \`zodchi run --role ${role === 'architecture review' ? 'architecture-review' : 'checkout-review'} --model ${who.model} --effort ${who.effort} --key ${a.label}-${tag} --prompt ${a.tmp}/${tag}.md ` +
  `${a.brief ? `--attach ${a.brief} ` : ''}${role === 'architecture review' ? `--attach ${a.tmp}/${tag}.diff ` : ''}--wait-sec 3300 --out ${a.tmp}/${tag}.json\`` +
  (role === 'architecture review' ? `, after saving \`git diff ${a.base}...HEAD\` as ${a.tmp}/${tag}.diff (an architect has no checkout)` : '') + `. ` +
  `Return the verdict, each finding as "<id> <severity> <location>: <problem>", the count of blocking findings, and the review file path. findings holds the reviewer's findings only. Change no code.`,
  { agentType: 'runner', schema: REVIEW, phase: 'Review', label: tag })

phase('Review')
const [review, arch] = await parallel([
  () => ask('code review', reviewer, 'review'),
  ...(architect ? [() => ask('architecture review', architect, 'architecture')] : []),
])
const real = (r) => r ? r.findings.filter(f => /^\s*F\d+/.test(f)) : []
return {
  label: a.label, head: gate.head, files: gate.files, models: { reviewer, architect },
  review, architecture: arch || null,
  approved: Boolean(review && !real(review).length && (!architect || (arch && !real(arch).length))),
  next: 'Close the findings with the author (code-package with the same brief), then run branch-review again. Release only with an approved review.',
}
