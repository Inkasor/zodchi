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
// norm() makes a frame path comparable: slash direction and edges only. Frames are matched by this exact identity, never by a suffix.
const norm = (s) => String(s).trim().replace(/[\\]/g, '/')
const frameOf = (file) => a.frames.find(f => norm(f.file) === norm(file))
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// One gateway call, worded once for every step that makes one. The shell of a step has its own time limit and the
// worker of a job can end with the shell that started it, so the wait is made of foreground calls of 540 seconds.
// attach: the files the request must carry, listed by the workflow; attachIfExists: files attached only when they exist.
const gatewayCall = ({ role, key, args, attach = [], attachIfExists = [], out, totalMin, repo = a.repo }) => {
  const flags = [...attach, ...attachIfExists].map(f => `--attach ${q(f)}`).join(' ')
  const run = `zodchi run --role ${role} --key ${key} ${args}${flags ? ' ' + flags : ''} --wait-sec 540 --out ${q(out)}`
  return `Gateway call, base key ${key}. Run it in the foreground from ${repo}: \`${run}\`. ` +
    (attachIfExists.length ? `Before every submission, retries included, drop the --attach of each optional file that does not exist on disk: ${JSON.stringify(attachIfExists)}; keep every other --attach. ` : '') +
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

phase('Ask')
const rows = await step(
  `Probe the Decisions rubric "${a.role}" from ${a.repo}. Frames: ${JSON.stringify(a.frames)}. ` +
  `For frame N write its "note" as a one-line prompt file in ${a.tmp}, then run ` +
  gatewayCall({ role: a.role, key: `${a.label}-probe-N`, totalMin: 20, out: `${a.tmp}/probe-N.json`, args: `--prompt <prompt file> --image <file> --paid` }) + ` ` +
  `From each output take verdict.questions (name, outcome, agreement). Return ok true with one row per question and frame, each row's "frame" being exactly the <file> string given for that frame in the Frames list (not a shortened or resolved path), and the input tokens of all calls together. ` +
  `If any frame's call fails, times out or has no verdict.questions, return ok false, rows [], inputTokens 0 and summary naming the frame and the job status. Judge nothing yourself.`,
  {
    agentType: 'zodchi-gamedev-unity:unity-runner', label: `probe ${a.role}`,
    schema: {
      type: 'object', required: ['ok', 'rows', 'inputTokens'],
      properties: {
        ok: { type: 'boolean' }, summary: { type: 'string' },
        inputTokens: { type: 'number' },
        rows: { type: 'array', items: { type: 'object', required: ['frame', 'question', 'outcome'],
          properties: { frame: { type: 'string' }, question: { type: 'string' }, outcome: { type: 'string' }, agreement: { type: 'number' } } } },
      },
    },
  })
if (!rows || !rows.ok) return { stoppedAt: 'ask', error: rows ? rows.summary || 'a frame call failed' : 'the step returned nothing' }
// Every frame needs at least one row: a frame without rows is a call that did not come back whole.
const unknown = rows.rows.filter(r => !frameOf(r.frame))
if (unknown.length) return { stoppedAt: 'ask', error: `rows for frames not in the input (the frame must be the exact supplied path): ${[...new Set(unknown.map(r => r.frame))].join(', ')}` }
const missing = a.frames.filter(f => !rows.rows.some(r => norm(r.frame) === norm(f.file)))
if (missing.length) return { stoppedAt: 'ask', error: `no rows for frames: ${missing.map(f => f.file).join(', ')}` }

// A question earns its place when it passes on every sound frame and fails on every frame listed as having its defect.
const byQuestion = {}
for (const r of rows.rows) (byQuestion[r.question] = byQuestion[r.question] || []).push(r)
const verdicts = Object.entries(byQuestion).map(([question, rs]) => {
  const of = (file) => frameOf(file) || {}
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
