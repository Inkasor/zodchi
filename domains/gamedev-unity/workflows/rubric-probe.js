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
// Every command in these prompts is POSIX shell, run with bash. q() quotes one argument for it: single quotes, with a
// quote inside written as ''' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One gateway call, worded once for every step that makes one. The shell of a step has its own time limit and the
// worker of a job can end with the shell that started it, so the wait is made of foreground calls of 540 seconds.
// attach: the files the request must carry, listed by the workflow; attachIfExists: files attached only when they exist.
const gatewayCall = ({ role, key, args, attach = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const flags = [...attach, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, key ${key}. Run it in the foreground from ${repo}: \`${run}\`. ` +
    `Never in the background (no &, nohup or run_in_background), never through Monitor: the worker of the job ends with your shell. ` +
    `While it exits 3 (still running), repeat \`zodchi wait --key ${key} --wait-sec 540 --out ${q(out)}\` in the foreground, up to ${totalMin} minutes in all since the first command; ` +
    `never return before the job is final (exit 0 or 2); if the ${totalMin} minutes run out, report failure (ok false; verdict "missing" for a review) and say the job still runs under ${key}. ` +
    `A dead job gets a new key: when the job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key ${key}\` (it died before its turn started), ` +
    `run the same full command again with the key ${key}-r2 (then ${key}-r3; at most 2 retries in all), wait for it the same way, and write each new key into the progress file at once. ` +
    `Any other final status is not retried: report it. ` +
    (attach.length || attachIfExists.length
      ? `After the job is final, read ${repo}/.agent-tmp/gateway/${key}/request.json: its "prompt" must contain \`<attachment path="...">\` (the path as given to --attach, slash direction aside) for every required attachment: ${JSON.stringify(attach)}` +
        `${attachIfExists.length ? `, and for each of these that exists on disk: ${JSON.stringify(attachIfExists)}` : ''}. ` +
        `If one is missing, put "attachment missing: <path>" into your summary and run the full command above again under the next key (${key}-r2, ${key}-r3, counted with the retries), every attachment included; the result you return is that of the last job, and when an attachment is still missing after the last retry it reports failure the same way.`
      : '')
}

// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the run is
// resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `do not redo finished work or overwrite its outputs blindly. For a gateway call it records as submitted, wait on that key in the foreground (zodchi wait --key <key> --wait-sec 540 --out <file>, repeated while it exits 3) instead of submitting again; ` +
  `if that job is final with status "unknown", or "failed" with no turnStartedAt in \`zodchi job --key <key>\`, submit again with the next key suffix (<key>-r2, <key>-r3; at most 2 retries) and record the new key in the progress file. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

phase('Ask')
const rows = await step(
  `Probe the Decisions rubric "${a.role}" from ${a.repo}. Frames: ${JSON.stringify(a.frames)}. ` +
  `For frame N write its "note" as a one-line prompt file in ${a.tmp}, then run ` +
  gatewayCall({ role: a.role, key: `${a.label}-probe-N`, totalMin: 20, out: `${a.tmp}/probe-N.json`, args: `--prompt <prompt file> --image <file> --paid` }) + ` ` +
  `From each output take verdict.questions (name, outcome, agreement). Return one row per question and frame, and the input tokens of all calls together. Judge nothing yourself.`,
  {
    agentType: 'zodchi-gamedev-unity:unity-runner', label: `probe ${a.role}`,
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
