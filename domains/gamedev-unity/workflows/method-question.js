export const meta = {
  name: 'method-question',
  description: 'Before a new kind of asset: how the thing really looks and works, how games usually build it, and what follows for our model',
  whenToUse: 'The first build of a new kind of asset, and the stop rule. Args: { label, context, tmp, realLife: [questions], games: [questions] }.',
  phases: [
    { title: 'Real life', detail: 'researchers ask how the thing is built in the real world', model: 'haiku' },
    { title: 'Games', detail: 'researchers ask how real-time games usually build it', model: 'haiku' },
    { title: 'Fold', detail: 'one options sheet, every statement marked documented or inferred', model: 'haiku' },
  ],
}

// args:
//   label     short name, also the prefix of the gateway keys
//   context   what the asset is, the camera, the budget, the target look and what is wrong with the present model
//   tmp       folder for questions, answers and the sheet (absolute)
//   realLife  questions about the real thing: structure, proportions, numbers
//   games     questions about how games build it: constructions, budgets, tricks
const a = args || {}
for (const k of ['label', 'context', 'tmp']) if (!a[k]) throw new Error(`method-question needs args.${k}`)
// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the run is
// resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `do not redo finished work or overwrite its outputs blindly. For a gateway call it records as submitted, wait on the latest key recorded for that call in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <key>\`, submit again under the next suffix of the base key (<base>-r2, then <base>-r3; at most 2 retries in all, those already recorded counted) and record the new key in the progress file. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)
const sides = [
  ...(a.realLife || []).map((q, i) => ({ side: 'real life', phase: 'Real life', q, id: `real-${i}` })),
  ...(a.games || []).map((q, i) => ({ side: 'games', phase: 'Games', q, id: `games-${i}` })),
]
if (!sides.length) throw new Error('method-question needs at least one question in args.realLife or args.games')
if (!(a.realLife || []).length || !(a.games || []).length) log('Only one side was asked: the sheet will say which side is missing.')

const FOUND = {
  type: 'object', required: ['ok', 'answerFile'],
  properties: {
    ok: { type: 'boolean' }, answerFile: { type: 'string' },
    numbers: { type: 'array', items: { type: 'string' } },
    notFound: { type: 'array', items: { type: 'string' } },
  },
}

const found = (await parallel(sides.map(s => () => step(
  `Ask. Side: ${s.side}. Folder: ${a.tmp}. Question file: ${a.tmp}/question-${s.id}.md. Answer file: ${a.tmp}/answer-${s.id}.json. Gateway key: ${a.label}-${s.id}.\n` +
  `Context: ${a.context}\nQuestion: ${s.q}\n` +
  `ok is true when the job ended with an answer.`,
  { agentType: 'zodchi-core:researcher', schema: FOUND, phase: s.phase, label: s.id })
  .then(r => r && { ...r, side: s.side })))).filter(Boolean).filter(r => r.ok)

if (!found.length) return { label: a.label, stoppedAt: 'research' }

phase('Fold')
const sheet = await step(
  `Fold. Answer files: ${JSON.stringify(found.map(f => ({ side: f.side, file: f.answerFile })))}. Output: ${a.tmp}/options.md.\n` +
  `Context: ${a.context}`,
  {
    agentType: 'zodchi-core:researcher', label: 'fold',
    schema: {
      type: 'object', required: ['file', 'realFacts', 'constructions', 'follows', 'unsettled'],
      properties: {
        file: { type: 'string' },
        realFacts: { type: 'array', items: { type: 'string' } },
        constructions: { type: 'array', items: { type: 'string' } },
        follows: { type: 'array', items: { type: 'string' } },
        unsettled: { type: 'array', items: { type: 'string' } },
      },
    },
  })
return { label: a.label, answers: found.map(f => f.answerFile), ...sheet }
