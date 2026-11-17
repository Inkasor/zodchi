export const meta = {
  name: 'rubric-probe',
  description: 'Probe a Decisions rubric on frames with a known defect and frames known to be sound, and say which questions tell them apart',
  whenToUse: 'After adding or rewording a rubric question. Args: { role, repo, label, tmp, frames: [{ file, note, sound: bool, defects: [question names expected to fail] }] }.',
  phases: [
    { title: 'Ask', detail: 'one Decisions call per frame', model: 'haiku' },
  ],
}

const a = args || {}
for (const k of ['role', 'repo', 'label', 'tmp', 'frames']) if (!a[k]) throw new Error(`rubric-probe needs args.${k}`)
// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the run is
// resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `do not redo finished work or overwrite its outputs blindly, and for a gateway call it records as submitted, wait on that key (zodchi wait --key <key>) instead of submitting again. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

phase('Ask')
const rows = await step(
  `Probe the Decisions rubric "${a.role}" from ${a.repo}. Frames: ${JSON.stringify(a.frames)}. ` +
  `For frame N write its "note" as a one-line prompt file in ${a.tmp}, then run ` +
  `\`zodchi run --role ${a.role} --key ${a.label}-probe-N --prompt <prompt file> --image <file> --paid --out ${a.tmp}/probe-N.json\`. ` +
  `From each output take verdict.questions (name, outcome, agreement). Return one row per question and frame, and the input tokens of all calls together. Judge nothing yourself.`,
  {
    agentType: 'unity-runner', label: `probe ${a.role}`,
    schema: {
      type: 'object', required: ['rows', 'inputTokens'],
      properties: {
        inputTokens: { type: 'number' },
        rows: { type: 'array', items: { type: 'object', required: ['frame', 'question', 'outcome'],
          properties: { frame: { type: 'string' }, question: { type: 'string' }, outcome: { type: 'string' }, agreement: { type: 'number' } } } },
      },
    },
  })
if (!rows) return { stoppedAt: 'ask' }

// A question earns its place when it passes on every sound frame and fails on every frame listed as having its defect.
const byQuestion = {}
for (const r of rows.rows) (byQuestion[r.question] = byQuestion[r.question] || []).push(r)
const verdicts = Object.entries(byQuestion).map(([question, rs]) => {
  const of = (file) => a.frames.find(f => file.endsWith(f.file) || f.file.endsWith(file)) || {}
  const sound = rs.filter(r => of(r.frame).sound)
  const defect = rs.filter(r => (of(r.frame).defects || []).includes(question))
  const passesSound = sound.length > 0 && sound.every(r => r.outcome === 'pass')
  const catches = defect.length > 0 && defect.every(r => r.outcome === 'fail')
  return {
    question,
    verdict: defect.length === 0 ? 'no defect frame for it' : sound.length === 0 ? 'no sound frame' : catches && passesSound ? 'keep' : catches ? 'catches, unsure on sound frames: reword' : 'does not catch: reword or drop',
    answers: rs.map(r => `${r.frame.split(/[\\/]/).pop()}: ${r.outcome} ${r.agreement == null ? '' : r.agreement}`),
  }
})
return { role: a.role, inputTokens: rows.inputTokens, verdicts }
