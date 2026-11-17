export const meta = {
  name: 'ops-script',
  description: 'Gate a script that a human will run with sudo: one checked snapshot, static checks and a run without root in check mode on it, and only then the exact command for the human, which runs that same snapshot',
  whenToUse: 'Before asking a human to type a sudo password for a script. Args: see the header of the script.',
  phases: [
    { title: 'Snapshot', detail: 'one fresh local copy of the script and its files, with the SHA-256 of every file', model: 'haiku' },
    { title: 'Static', detail: 'bash -n and shellcheck, or py_compile, on the snapshot', model: 'haiku' },
    { title: 'Dry run', detail: 'the snapshot runs without root with its check flag, locally or on the host', model: 'haiku' },
    { title: 'Fix', detail: 'the writer fixes what the checks found' },
  ],
}

// args:
//   script    path of the script (absolute, local)
//   tmp       folder for the snapshot and the logs: absolute, "/" separators only (a drive letter and "/" on Windows), no ".", "..",
//             "//", trailing "/", backslash or quote - it is used verbatim in the commands
//   check     the command that runs the copy in check mode, with {copy} for the copy's path,
//             default "{copy} --check" ("python3 {copy} --check" for .py). It must touch nothing: the script's
//             check mode reads, validates and prints what it would do
//   remote    optional "user@host": the snapshot is uploaded once into a folder made by `mktemp -d /tmp/ops-XXXXXXXX` on the
//             host, the check runs there as that user, never sudo, and the folder is kept: the human's command runs from it
//   files     optional list of companion files the script needs next to itself (absolute, local), e.g. a payload it
//             installs and checks by SHA-256. They go into the snapshot under their own names, next to the script
//   sudo      the command the human will run, with {script} for the installed path, e.g. "sudo {script} --apply"
//   nopass    true only when that step needs no password (`sudo -n` works): then the final output also offers the
//             `!` form of Claude Code. Without it the command is for the human's own terminal (a sudo password needs
//             a TTY, which `!` does not have: "sudo: a terminal is required"); remote commands use `ssh -t`
//   fixes     how many times a failure goes back to the writer, default 2; 0 to only report
//   writer    optional Claude model for fixes, default "sonnet"
//   repo      repository of the script, for the writer to read its AGENTS.md
//
// One snapshot. Every attempt first makes a fresh folder {tmp}/snap.XXXXXXXX (mktemp -d) and copies the script and its
// companions into it; the runner reports the folder and the SHA-256 of every file in it. The static checks, the dry run
// and the command for the human use only these copies, never the originals. Locally the human's command runs the snapshot
// itself; remotely the snapshot is uploaded once to /tmp/ops-XXXXXXXX, the dry run runs there, and the human's command
// runs from that same folder after `sha256sum -c` against the hashes the snapshot step reported. A failed check goes to
// the writer, and the next attempt makes a new snapshot of the fixed files.
// State is per invocation: logs and progress files live in {tmp}/run-<snapshot suffix>/, never in a folder shared by
// invocations that use the same tmp.
const a = args || {}
for (const k of ['script', 'tmp', 'sudo']) if (!a[k]) throw new Error(`ops-script needs args.${k}`)
// Every command in these prompts is POSIX shell, run with bash (Git Bash on Windows). q() quotes one argument for it:
// single quotes, with a quote inside written as '\'' - no expansion of $, backticks or globs.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const py = /\.py$/i.test(a.script)
const check = a.check || (py ? 'python3 {copy} --check' : '{copy} --check')
// The base name. A backslash is a separator only in a Windows drive path (a drive letter, then backslashes); in a POSIX path it is a
// character of the file name and stays in it.
const isDrive = (p) => /^[A-Za-z]:[\\/]/.test(String(p))
const base = (p) => (isDrive(p) ? String(p).replace(/\\/g, '/') : String(p)).split('/').pop()
const name = base(a.script)
const files = Array.isArray(a.files) ? a.files : (a.files ? [a.files] : [])
const names = files.map(base)
const LIST = '.ops-sha256' // the hash list the workflow writes into the remote folder
for (const n of [name, ...names]) {
  if (!n || n === '.' || n === '..' || /[\r\n]/.test(n)) throw new Error(`ops-script: bad file name ${JSON.stringify(n)}`)
  if (n === LIST) throw new Error(`ops-script: a file may not be named ${LIST}`)
}
// A remote command is assembled from these names, so with args.remote they must be plain.
if (a.remote) for (const n of [name, ...names]) if (!/^[\w.-]+$/.test(n)) throw new Error(`ops-script: with args.remote a file name must match [\\w.-]+, got ${n}`)
if (new Set([name, ...names]).size !== names.length + 1) throw new Error('ops-script: the script and its files must have different names')
// Every path is absolute (a drive with "/" or a leading "/"). args.tmp is used verbatim twice - in the mktemp template
// and in the command for the human - so it must already be in plain form: "/" separators only, no ".", ".." or empty
// segments, no trailing "/", no quote. Then the reported folder is compared as an exact string, with no normalization
// that could name a different place than the one mktemp used.
const absPath = (p) => /^([A-Za-z]:\/|\/)/.test(String(p))
// The script and its files may use Windows backslashes only after a drive letter; a leading backslash is not absolute.
const inputAbs = (p) => /^([A-Za-z]:[\\/]|\/)/.test(String(p))
for (const p of [a.script, ...files]) if (!inputAbs(p)) throw new Error(`ops-script: paths must be absolute, got ${p}`)
const tmpPlain = (t) => absPath(t) && !/['\\]/.test(t) && !/\/\/|\/$/.test(t) && !t.split('/').some(seg => seg === '.' || seg === '..')
if (!tmpPlain(String(a.tmp))) throw new Error(`ops-script: args.tmp must be a plain absolute path with "/" only (no ".", "..", "//", trailing "/", backslash or quote), got ${a.tmp}`)
// The local snapshot is made fresh by mktemp -d from the template {tmp}/snap.XXXXXXXX; the runner reports the path it
// printed. It must be that template with 8 letters or digits in place of the X's, exactly; it is then the folder.
const stagingDir = (d) => (typeof d === 'string' && d.startsWith(`${a.tmp}/snap.`) && /^[A-Za-z0-9]{8}$/.test(d.slice(`${a.tmp}/snap.`.length))) ? d : null
// The remote folder is made by `mktemp -d /tmp/ops-XXXXXXXX` on the host: a fixed base, 8 letters or digits, never $HOME.
const remoteDir = (d) => (typeof d === 'string' && /^\/tmp\/ops-[A-Za-z0-9]{8}$/.test(d)) ? d : null

const STEP = {
  type: 'object', required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' }, summary: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    logs: { type: 'array', items: { type: 'string' } },
    dir: { type: 'string' },
    files: { type: 'array', items: { type: 'object', required: ['name', 'sha256'], properties: { name: { type: 'string' }, sha256: { type: 'string' } } } },
  },
}

// The snapshot as the workflow accepts it: the folder in exact mktemp shape and exactly one lower-case SHA-256 per
// expected file. Everything else is derived from it: the run folder (state of this invocation) and the hash list.
function takeSnapshot(r) {
  if (!r || !r.ok) return null
  const dir = stagingDir(r.dir)
  const got = Array.isArray(r.files) ? r.files : []
  const want = [name, ...names]
  if (!dir || got.length !== want.length) return null
  const sums = []
  for (const n of want) {
    const f = got.find(x => x && x.name === n)
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256)) return null
    sums.push({ name: n, sha256: f.sha256 })
  }
  const suffix = dir.slice(`${a.tmp}/snap.`.length)
  return { dir, suffix, run: `${a.tmp}/run-${suffix}`, sums }
}
// A line of a sha256sum list. A name with a backslash is written the way GNU sha256sum reads it: the line starts with a
// backslash and each backslash of the name is doubled.
const sumLine = (s) => /\\/.test(s.name) ? `\\${s.sha256}  ${s.name.replace(/\\/g, '\\\\')}` : `${s.sha256}  ${s.name}`
// A shell command that prints the list, one quoted line per file.
const printList = (snap) => `printf '%s\\n' ${snap.sums.map(s => q(sumLine(s))).join(' ')}`
// Local: cd into the snapshot, then the folder is checked against the list read from the pipe. The cd is not in a subshell,
// so whatever follows with && runs in the snapshot too (a script that reads ./payload reads the checked copy).
const verifyLocal = (snap) => `cd ${q(snap.dir)} && ${printList(snap)} | sha256sum -c -`
// The same list piped into the check on the host: the accepted hashes, never a list file the check could have rewritten.
const verifyRemote = (snap, dir) => `cd ${dir} && ${printList(snap)} | sha256sum -c -`
const D = '<DIR>' // the remote folder, until the runner has made it

const shellRule = `\n\nShell rule: run every command with bash (Git Bash on Windows, never PowerShell or cmd); the quoting in these commands is for bash.`
const snapshotStep = (n) => agent(
  `Make ONE snapshot of a script and its companion files; change nothing else. ` +
  `Make sure ${q(a.tmp)} exists (\`mkdir -p\`), then run \`mktemp -d ${q(`${a.tmp}/snap.`)}XXXXXXXX\` (the folder must be created, never reused or emptied; stop and report if that fails) and keep the path it prints as SNAP. ` +
  `Create the folders SNAP-SUFFIX-based \`${a.tmp}/run-SUFFIX/logs\` and \`${a.tmp}/run-SUFFIX/progress\` with mkdir -p, where SUFFIX is the 8 characters after "snap." in SNAP. ` +
  `Copy into SNAP, under exactly these names, one \`cp -- <source> SNAP/<name>\` each (quote every argument as shown; a source is used exactly as written: a missing source is a failure, stop and report it${[a.script, ...files].some(isDrive) ? `; only for a Windows drive path (${[a.script, ...files].filter(isDrive).map(q).join(' ')}) that bash does not find, use the same path with "/" instead of backslashes` : ''}): ` +
  `${[a.script, ...files].map((p, i) => `${q(p)} -> ${q([name, ...names][i])}`).join('; ')}. ` +
  `Make the script copy executable. Then compute the SHA-256 of every file in SNAP FROM THE COPIES: \`cd SNAP && sha256sum -- ${[name, ...names].map(q).join(' ')}\`. ` +
  `Write nothing else into SNAP (no list, no logs). Return dir = SNAP (exactly the path mktemp printed) and files = one entry {name, sha256} per file, the name as given above and the hash in lower-case hex. ` +
  `ok is true when the folder is made, all copies are there and hashed. If this step is cut off and restarted, make a new folder; unfinished ones are ignored.` + shellRule,
  { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Snapshot', label: `snapshot ${n}` })

const staticCheck = (snap, tag) => {
  const at = (n) => `${snap.dir}/${n}`
  return step(
    `Static checks of the snapshot copy ${at(name)}; change nothing, and do not touch any other path. Logs to ${snap.run}/logs/static-${tag}.log. ` +
    (py
      ? `Run \`PYTHONPYCACHEPREFIX=${q(`${snap.run}/pycache`)} python3 -m py_compile ${q(at(name))}\` (or the same with \`python\` where python3 is missing). `
      : `Run \`bash -n ${q(at(name))}\`, then \`shellcheck ${q(at(name))}\` when shellcheck is installed (say so when it is not; that is not a failure). `) +
    (files.length
      ? `Its companion files in the snapshot are checked the same way where they are scripts (.py with py_compile and the same PYTHONPYCACHEPREFIX, so no file is written into the snapshot; .sh or .bash with bash -n and shellcheck); any other file is data and is only checked to exist: ${names.map(n => q(at(n))).join(' ')}. `
      : '') +
    `ok is true when no command reports an error (shellcheck warnings count as failures, notes and style do not). failures: each problem as "<line>: <message>".`,
    { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Static', label: `static ${tag}` }, snap.run)
}

// Remote command lines, each ready to run on the local machine; <DIR> is replaced by the folder mktemp made on the host.
// The remote command is built as plain text and quoted once for the local shell: the remote shell sees it whole.
const ssh = (r) => `ssh ${q(a.remote)} ${q(r)}`
function dryRun(snap, tag) {
  const all = [name, ...names]
  if (a.remote) {
    const sums = printList(snap)
    const copy = q(`${D}/${name}`)
    const run = `export PYTHONDONTWRITEBYTECODE=1; cd ${D} && ${check.split('{copy}').join(copy)}`
    return step(
      `Dry run of a sudo script without root, on the host ${a.remote}, from the snapshot in ${snap.dir}; use only these local copies, never the original files. ` +
      `1. Make a new folder on the host with \`ssh ${q(a.remote)} 'mktemp -d /tmp/ops-XXXXXXXX'\` (it must be created, never reused; stop and report if that fails) and keep the path it prints as DIR; it must be /tmp/ops- and 8 letters or digits. In every command below replace the text ${D} by that exact path (and nothing else). ` +
      `2. Upload the snapshot once: \`cd ${q(snap.dir)} && scp -- ${all.map(q).join(' ')} ${q(a.remote)}:${D}/\` (from inside the snapshot folder, so a drive letter is not read as a host). ` +
      `3. Write the hash list on the host and check it, and make the script executable: \`${ssh(`cd ${D} && ${sums} > ${LIST} && sha256sum -c ${LIST} && chmod u+x -- ${q(name)}`)}\`; every file must be OK. ` +
      `4. Run the check as that user, never sudo: \`${ssh(run)}\`. ` +
      `5. Check the hashes again against the accepted list, piped in (not the list file in the folder): \`${ssh(verifyRemote(snap, D))}\`; if any file changed, ok is false (the check mode must not change the files). ` +
      `Do NOT delete the folder: the human runs the final command from it. Return it as dir. ` +
      `Log to ${snap.run}/logs/dry-${tag}.log. ok is true when the check exits 0, its output shows no error and the hashes still match. ` +
      `A failure that only says root is required means the script has no real check mode: report it as a failure with that reason. ` +
      `failures: the decisive error lines. summary: what the script said it would do.`,
      { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Dry run', label: `dry ${tag}` }, snap.run)
  }
  const cmd = check.split('{copy}').join(q(`${snap.dir}/${name}`))
  return step(
    `Dry run of a sudo script without root, locally, in the snapshot ${snap.dir}; the script and its files already lie there, run them where they are and never use the original files. ` +
    `1. Verify the snapshot: \`${verifyLocal(snap)}\`; every file must be OK. ` +
    `2. Run \`cd ${q(snap.dir)} && ${cmd}\` (from inside the snapshot folder) as the current user with the environment variable PYTHONDONTWRITEBYTECODE=1 set. Never use sudo. ` +
    `3. Verify the snapshot again with the command of step 1; if any file changed, ok is false (the check mode must not change the files). ` +
    `Leave the snapshot folder in place: the human runs the command from it. Log to ${snap.run}/logs/dry-${tag}.log. ok is true when the check exits 0, its output shows no error and the hashes still match. ` +
    `A failure that only says root is required means the script has no real check mode: report it as a failure with that reason. ` +
    `failures: the decisive error lines. summary: what the script said it would do.`,
    { agentType: 'zodchi-core:runner', schema: STEP, phase: 'Dry run', label: `dry ${tag}` }, snap.run)
}

// Resume rule, as in every zodchi workflow. The progress files belong to the invocation: they live in its run folder.
const progressFile = (run, o) => `${run}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
function step(prompt, opts, run) {
  return agent(prompt +
    shellRule + ` Resume rule: this run may have been cut off and restarted. If ${progressFile(run, opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
    `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
    `After each finished step append one line to it (create the folder if needed): what is done and what comes next. When your whole task is finished, append a last line DONE.`, opts)
}

// The final text for the human. A sudo password needs a TTY: Claude Code's `!` has none, so the command is for the
// human's own terminal, with `ssh -t` when remote. Only a step that needs no password may be offered with `!`.
// Both commands check the SHA-256 of every file against the list the snapshot step reported before they run sudo.
function forHuman(snap, rdir) {
  let cmd, steps
  if (a.remote) {
    // One remote command, text built here: cd into the folder mktemp made, write the list, check it, run the sudo command with
    // {script} replaced by the quoted path. It is quoted once for the local shell, so the remote shell sees it whole.
    const r = `cd ${q(rdir)} && ${printList(snap)} > ${LIST} && sha256sum -c ${LIST} && ` + a.sudo.split('{script}').join(q(`${rdir}/${name}`))
    cmd = `ssh -t ${q(a.remote)} ${q(r)}`
    steps = `It runs from ${rdir} on ${a.remote}, the folder the check ran in; it first checks the SHA-256 of every file against the snapshot and stops when one differs. Do not edit that folder.\n`
  } else {
    // In a subshell: the cd to the snapshot holds for the check and for sudo, and the human's own directory is left alone.
    cmd = `(${verifyLocal(snap)} && ` + a.sudo.split('{script}').join(q(`${snap.dir}/${name}`)) + ')'
    steps = `It runs the snapshot that was checked in ${q(snap.dir)}${files.length ? `, where the script and ${names.map(q).join(' ')} lie together` : ''}, from inside that folder, after checking the SHA-256 of every file there; do not edit that folder before you run it.\n`
  }
  const bang = a.nopass && !a.remote
  return `Checks passed. ` + (bang
    ? `This step needs no password (sudo -n works), so run it in your terminal, or in Claude Code as \`! ${cmd}\`.\n`
    : `Run in your own terminal (not with \`!\` in Claude Code): sudo asks for a password and the \`!\` of Claude Code has no terminal for it ("sudo: a terminal is required").\n`) + steps + cmd
}

const out = { script: a.script, attempts: [] }
const maxFix = a.fixes ?? 2
for (let n = 0; n <= maxFix; n++) {
  const made = await snapshotStep(n)
  if (!made) { out.stoppedAt = 'no result from the runner'; return out }
  const snap = takeSnapshot(made)
  if (!snap) { out.stoppedAt = `the runner did not report the snapshot as asked: the fresh folder ${a.tmp}/snap.XXXXXXXX and one SHA-256 for each file (got ${JSON.stringify(made.dir)}, ${JSON.stringify(made.summary)})`; return out }
  const st = await staticCheck(snap, n)
  const dry = st && st.ok ? await dryRun(snap, n) : null
  out.attempts.push({ n, snapshot: { dir: snap.dir, files: snap.sums }, static: st, dry })
  if (st && st.ok && dry && dry.ok) {
    const rdir = a.remote ? remoteDir(dry.dir) : null
    if (a.remote && !rdir) { out.stoppedAt = `the runner did not report the remote folder as /tmp/ops-XXXXXXXX (got ${JSON.stringify(dry.dir)})`; return out }
    out.ready = true
    out.snapshot = { dir: snap.dir, files: snap.sums, remote: rdir || undefined }
    out.forHuman = forHuman(snap, rdir)
    out.wouldDo = dry.summary
    return out
  }
  if (!st || (st.ok && !dry)) { out.stoppedAt = 'no result from the runner'; return out }
  if (n === maxFix) break
  phase('Fix')
  const failures = st.ok ? dry.failures : st.failures
  const fix = await step(
    `Fix the script ${a.script}${a.repo ? ` (repository ${a.repo}; read its AGENTS.md first)` : ''}${files.length ? ` and, where the fault is there, its companion files ${files.join(' ')}` : ''}. ${st.ok ? 'Its dry run without root failed' : 'Its static checks failed'}: ${JSON.stringify(failures || [])}. ` +
    `The checks ran on a snapshot copy in ${snap.dir}; change the original files, not the snapshot: the next attempt makes a new snapshot. ` +
    `Logs: ${JSON.stringify((st.ok ? dry.logs : st.logs) || [])}. Fix with the smallest change. If the script has no check mode that runs without root, add one: ` +
    `the check flag validates inputs and prints what the script would do, and touches nothing. Do not run it with sudo. ok is true when the change is made.`,
    { agentType: 'zodchi-core:coder', model: a.writer || 'sonnet', schema: STEP, phase: 'Fix', label: `fix ${n}` }, snap.run)
  if (!fix || !fix.ok) { out.stoppedAt = 'fix'; return out }
}
out.ready = false
out.forHuman = 'Do not run it with sudo yet: the checks still fail. See attempts.'
return out
