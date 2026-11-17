export const meta = {
  name: 'ops-script',
  description: 'Gate a script that a human will run with sudo: static checks, then a run without root on a copy in check mode, and only then the exact command for the human',
  whenToUse: 'Before asking a human to type a sudo password for a script. Args: see the header of the script.',
  phases: [
    { title: 'Static', detail: 'bash -n and shellcheck, or py_compile', model: 'haiku' },
    { title: 'Dry run', detail: 'the script runs without root on a copy with its check flag', model: 'haiku' },
    { title: 'Fix', detail: 'the writer fixes what the checks found' },
  ],
}

// args:
//   script    path of the script (absolute, local)
//   tmp       folder for the copy and the logs (absolute)
//   check     the command that runs the copy in check mode, with {copy} for the copy's path,
//             default "{copy} --check" ("python3 {copy} --check" for .py). It must touch nothing: the script's
//             check mode reads, validates and prints what it would do
//   remote    optional "user@host": the copy goes there (scp to /tmp) and the check runs there as that user, never sudo
//   sudo      the command the human will run, with {script} for the installed path, e.g. "sudo {script} --apply"
//   fixes     how many times a failure goes back to the writer, default 2; 0 to only report
//   writer    optional Claude model for fixes, default "sonnet"
//   repo      repository of the script, for the writer to read its AGENTS.md
const a = args || {}
for (const k of ['script', 'tmp', 'sudo']) if (!a[k]) throw new Error(`ops-script needs args.${k}`)
const py = /\.py$/i.test(a.script)
const check = a.check || (py ? 'python3 {copy} --check' : '{copy} --check')
const name = a.script.replace(/\\/g, '/').split('/').pop()

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' }, summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    logs: { type: 'array', items: { type: 'string' } },
  },
}

const staticCheck = (tag) => step(
  `Static checks of ${a.script}; change nothing. Logs to ${a.tmp}/logs/static-${tag}.log. ` +
  (py
    ? `Run \`python3 -m py_compile ${a.script}\` (or \`python -m py_compile\` where python3 is missing). `
    : `Run \`bash -n ${a.script}\`, then \`shellcheck ${a.script}\` when shellcheck is installed (say so when it is not; that is not a failure). `) +
  `ok is true when no command reports an error (shellcheck warnings count as failures, notes and style do not). failures: each problem as "<line>: <message>".`,
  { agentType: 'runner', schema: STEP, phase: 'Static', label: `static ${tag}` })

const dryRun = (tag) => {
  const copy = a.remote ? `/tmp/${tag}-${name}` : `${a.tmp}/copy/${name}`
  const cmd = check.replace('{copy}', copy)
  return step(
    `Dry run of a sudo script without root. ` +
    (a.remote
      ? `Copy ${a.script} to ${a.remote}:${copy} with scp, make it executable, then run \`ssh ${a.remote} '${cmd}'\` as that user. Never use sudo. Remove the copy afterwards. `
      : `Copy ${a.script} to ${copy}, make it executable, then run \`${cmd}\` as the current user. Never use sudo. `) +
    `Log to ${a.tmp}/logs/dry-${tag}.log. ok is true when it exits 0 and its output shows no error. ` +
    `A failure that only says root is required means the script has no real check mode: report it as a failure with that reason. ` +
    `failures: the decisive error lines. summary: what the script said it would do.`,
    { agentType: 'runner', schema: STEP, phase: 'Dry run', label: `dry ${tag}` })
}

// Resume rule, as in every zodchi workflow.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
function step(prompt, opts) {
  return agent(prompt +
    `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
    `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
    `After each finished step append one line to it (create the folder if needed): what is done and what comes next. When your whole task is finished, append a last line DONE.`, opts)
}

const out = { script: a.script, attempts: [] }
for (let n = 0; n <= (a.fixes ?? 2); n++) {
  const st = await staticCheck(n)
  const dry = st && st.ok ? await dryRun(n) : null
  out.attempts.push({ n, static: st, dry })
  if (st && st.ok && dry && dry.ok) {
    out.ready = true
    out.forHuman = `Checks passed. Run: ${a.sudo.replace('{script}', a.script)}`
    out.wouldDo = dry.summary
    return out
  }
  if (!st || (st.ok && !dry)) { out.stoppedAt = 'no result from the runner'; return out }
  if (n === (a.fixes ?? 2)) break
  phase('Fix')
  const failures = st.ok ? dry.failures : st.failures
  const fix = await step(
    `Fix the script ${a.script}${a.repo ? ` (repository ${a.repo}; read its AGENTS.md first)` : ''}. ${st.ok ? 'Its dry run without root failed' : 'Its static checks failed'}: ${JSON.stringify(failures || [])}. ` +
    `Logs: ${JSON.stringify((st.ok ? dry.logs : st.logs) || [])}. Fix with the smallest change. If the script has no check mode that runs without root, add one: ` +
    `the check flag validates inputs and prints what the script would do, and touches nothing. Do not run it with sudo. ok is true when the change is made.`,
    { agentType: 'coder', model: a.writer || 'sonnet', schema: STEP, phase: 'Fix', label: `fix ${n}` })
  if (!fix || !fix.ok) { out.stoppedAt = 'fix'; return out }
}
out.ready = false
out.forHuman = 'Do not run it with sudo yet: the checks still fail. See attempts.'
return out
