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
//   tmp       folder for the copy and the logs: absolute, "/" separators only (E:/x on Windows), no ".", "..",
//             "//", trailing "/", backslash or quote - it is used verbatim in the commands
//   check     the command that runs the copy in check mode, with {copy} for the copy's path,
//             default "{copy} --check" ("python3 {copy} --check" for .py). It must touch nothing: the script's
//             check mode reads, validates and prints what it would do
//   remote    optional "user@host": the copy goes there (scp into a folder made by mktemp -d under /tmp) and the check
//             runs there as that user, never sudo
//   files     optional list of companion files the script needs next to itself (absolute, local), e.g. a payload it
//             installs and checks by SHA-256. The dry run copies them next to the script copy under their own names;
//             the static checks also cover the ones that are scripts (.py, .sh, .bash); the local final command runs
//             the checked copy (a fresh folder {tmp}/copy.XXXXXXXX made by mktemp -d) with them next to it, so what
//             was checked is what runs
//   sudo      the command the human will run, with {script} for the installed path, e.g. "sudo {script} --apply"
//   nopass    true only when that step needs no password (`sudo -n` works): then the final output also offers the
//             `!` form of Claude Code. Without it the command is for the human's own terminal (a sudo password needs
//             a TTY, which `!` does not have: "sudo: a terminal is required"); remote commands use `ssh -t`
//   fixes     how many times a failure goes back to the writer, default 2; 0 to only report
//   writer    optional Claude model for fixes, default "sonnet"
//   repo      repository of the script, for the writer to read its AGENTS.md
const a = args || {}
for (const k of ['script', 'tmp', 'sudo']) if (!a[k]) throw new Error(`ops-script needs args.${k}`)
// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const py = /\.py$/i.test(a.script)
const check = a.check || (py ? 'python3 {copy} --check' : '{copy} --check')
const base = (p) => p.replace(/\\/g, '/').split('/').pop()
const name = base(a.script)
const files = Array.isArray(a.files) ? a.files : (a.files ? [a.files] : [])
const names = files.map(base)
// A remote command is assembled from these names without quoting, so they must be plain.
if (a.remote) for (const n of [name, ...names]) if (!/^[\w.-]+$/.test(n)) throw new Error(`ops-script: with args.remote a file name must match [\\w.-]+, got ${n}`)
if (new Set([name, ...names]).size !== names.length + 1) throw new Error('ops-script: the script and its files must have different names')
// Every path is absolute (a drive with "/" or a leading "/"). args.tmp is used verbatim twice - in the mktemp template
// and in the command for the human - so it must already be in plain form: "/" separators only, no ".", ".." or empty
// segments, no trailing "/", no quote. Then the reported folder is compared as an exact string, with no normalization
// that could name a different place than the one mktemp used.
const absPath = (p) => /^([A-Za-z]:\/|\/)/.test(String(p))
for (const p of [a.script, ...files]) if (!absPath(String(p).split(String.fromCharCode(92)).join('/'))) throw new Error(`ops-script: paths must be absolute, got ${p}`)
const tmpPlain = (t) => absPath(t) && !/['\\]/.test(t) && !/\/\/|\/$/.test(t) && !t.split('/').some(seg => seg === '.' || seg === '..')
if (!tmpPlain(String(a.tmp))) throw new Error(`ops-script: args.tmp must be a plain absolute path with "/" only (no ".", "..", "//", trailing "/", backslash or quote), got ${a.tmp}`)
// The local staging folder is made fresh by mktemp -d from the template {tmp}/copy.XXXXXXXX; the runner reports the path
// it printed. It must be that template with 8 letters or digits in place of the X's, exactly; it is then the folder.
const stagingDir = (d) => (typeof d === 'string' && d.startsWith(`${a.tmp}/copy.`) && /^[A-Za-z0-9]{8}$/.test(d.slice(`${a.tmp}/copy.`.length))) ? d : null

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' }, summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    logs: { type: 'array', items: { type: 'string' } },
    dir: { type: 'string' },
  },
}

const staticCheck = (tag) => step(
  `Static checks of ${a.script}; change nothing. Logs to ${a.tmp}/logs/static-${tag}.log. ` +
  (py
    ? `Run \`python3 -m py_compile ${q(a.script)}\` (or \`python -m py_compile\` where python3 is missing). `
    : `Run \`bash -n ${q(a.script)}\`, then \`shellcheck ${q(a.script)}\` when shellcheck is installed (say so when it is not; that is not a failure). `) +
  (files.length
    ? `Its companion files are checked the same way where they are scripts (.py with py_compile; .sh or .bash with bash -n and shellcheck); any other file is data and is only checked to exist: ${files.map(q).join(' ')}. `
    : '') +
  `ok is true when no command reports an error (shellcheck warnings count as failures, notes and style do not). failures: each problem as "<line>: <message>".`,
  { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Static', label: `static ${tag}` })

const dryRun = (tag) => {
  // Remote: the folder is made by `mktemp -d` (exclusive, unpredictable, mode 700) and its returned path, DIR, is
  // used for the copy, the run and the cleanup; a fixed name could be shared with another run or pre-created by someone.
  const dir = 'DIR'
  const copy = `${dir}/${name}`
  // Locally the whole copy path is single-quoted (DIR is replaced inside the quotes; tmp holds no quote, see above);
  // remotely the names are plain and the command is quoted once more for the remote shell.
  const cmd = check.split('{copy}').join(a.remote ? copy : q(copy))
  const all = [a.script, ...files]
  return step(
    `Dry run of a sudo script without root. ` +
    (a.remote
      ? `Make a new folder on ${a.remote} with \`ssh ${q(a.remote)} 'mktemp -d /tmp/ops-XXXXXXXX'\` (it must be created, never reused; stop and report if that fails) and keep the path it prints as DIR; use that exact path everywhere below, never a name you chose. Copy ${all.map(q).join(' ')} into DIR with scp under their own names so the companion files lie next to the script, make the script executable (\`ssh ${q(a.remote)} "chmod u+x DIR/${name}"\`), then run the command \`${cmd}\` with DIR replaced by that path, as \`ssh ${q(a.remote)} '<that command, quoted once more for the remote shell>'\`, as that user. Never use sudo. Remove DIR afterwards (\`ssh ${q(a.remote)} "rm -rf DIR"\`, only that path). `
      : `Make a new folder with \`mktemp -d ${q(`${a.tmp}/copy.`)}XXXXXXXX\` (it must be created, never reused or emptied; stop and report if that fails) and keep the path it prints as DIR; use that exact path everywhere below and return it as dir. Copy ${all.map(q).join(' ')} into DIR under their own names so the companion files lie next to the script copy, make the script copy executable, then run \`${cmd}\` with DIR replaced by that path inside the quotes, as the current user. Never use sudo. Leave DIR in place: the human runs the command from it. `) +
    `Log to ${a.tmp}/logs/dry-${tag}.log. ok is true when it exits 0 and its output shows no error. ` +
    `A failure that only says root is required means the script has no real check mode: report it as a failure with that reason. ` +
    `failures: the decisive error lines. summary: what the script said it would do.`,
    { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Dry run', label: `dry ${tag}` })
}

// Resume rule, as in every zodchi workflow.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
function step(prompt, opts) {
  return agent(prompt +
    `\n\nShell rule: run every command with bash (Git Bash on Windows, never PowerShell or cmd); the quoting in these commands is for bash. Resume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
    `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
    `After each finished step append one line to it (create the folder if needed): what is done and what comes next. When your whole task is finished, append a last line DONE.`, opts)
}

// The final text for the human. A sudo password needs a TTY: Claude Code's `!` has none, so the command is for the
// human's own terminal, with `ssh -t` when remote. Only a step that needs no password may be offered with `!`.
function forHuman(dir) {
  const all = [a.script, ...files]
  let cmd, steps = ''
  if (a.remote) {
    // The folder is made by `mktemp -d` on the host (exclusive, unpredictable, mode 700) and its printed path is kept in $d,
    // so the upload, the chmod and the sudo command all use that one path: a fixed folder could be shared with another run,
    // or pre-created (even as a symlink) by someone, and the human would then run something that was not checked.
    // The command is the sudo text with {script} replaced by "$d"/<name>, every other part single-quoted for the remote shell.
    cmd = `ssh -t ${q(a.remote)} ` + a.sudo.split('{script}').map(q).join(`"$d"'/${name}'`)
    steps = `1. In ONE terminal window (it keeps $d), make a new folder on the host, copy the script${files.length ? ' and its files' : ''} into it and make the script executable:\n` +
      `   d=$(ssh ${q(a.remote)} 'mktemp -d "$HOME/ops-run.XXXXXXXX"') && [ -n "$d" ] && scp ${all.map(q).join(' ')} ${q(a.remote)}:"$d"/ && ssh ${q(a.remote)} 'chmod u+x "'"$d"'/${name}"'\n2. Run it, in the same window:\n`
  } else {
    // Local: the command runs the checked copy, not the original. The dry run left the script and its companions in
    // <tmp>/copy exactly as it ran them, so what was checked is what runs (the original path would run a script
    // whose companions were never the checked ones).
    cmd = a.sudo.split('{script}').join(q(`${dir}/${name}`))
    steps = `It runs the copy that was checked in ${q(dir)}${files.length ? `, where the script and ${names.map(q).join(' ')} lie together` : ''}; do not edit that folder before you run it.\n`
  }
  const bang = a.nopass && !a.remote
  return `Checks passed. ` + (bang
    ? `This step needs no password (sudo -n works), so run it in your terminal, or in Claude Code as \`! ${cmd}\`.\n`
    : `Run in your own terminal (not with \`!\` in Claude Code): sudo asks for a password and the \`!\` of Claude Code has no terminal for it ("sudo: a terminal is required").\n`) + steps + cmd
}

const out = { script: a.script, attempts: [] }
for (let n = 0; n <= (a.fixes ?? 2); n++) {
  const st = await staticCheck(n)
  const dry = st && st.ok ? await dryRun(n) : null
  out.attempts.push({ n, static: st, dry })
  if (st && st.ok && dry && dry.ok) {
    const staged = a.remote ? null : stagingDir(dry.dir)
    if (!a.remote && !staged) { out.stoppedAt = `the runner did not report the fresh staging folder it made (got ${JSON.stringify(dry.dir)})`; return out }
    out.ready = true
    out.forHuman = forHuman(staged)
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
    { agentType: 'zodchi-core:coder', model: a.writer || 'sonnet', schema: STEP, phase: 'Fix', label: `fix ${n}` })
  if (!fix || !fix.ok) { out.stoppedAt = 'fix'; return out }
}
out.ready = false
out.forHuman = 'Do not run it with sudo yet: the checks still fail. See attempts.'
return out
