#!/usr/bin/env node
// Runs the code-package workflow with fake agents over a few scenarios, each in a fresh temporary Git repository, and
// prints the verdict of each. Exit code 0 only when every scenario meets its expectations.
//
//   node core/workflows/fixtures/code-package/mock.mjs [scenario ...]
//
// Only the models are faked. The fake runner does what each step's prompt asks, for real, in the temporary
// repository: it reads Git state, compares the protected paths with the base commit the prompt names, runs the check
// and verify commands the prompt lists (small node scripts of the repository), commits with the message the prompt
// gives, saves REVIEW.md with the `git show <commit>:REVIEW.md` the prompt names and reads the files the gateway call
// would attach. The fake writer applies the scenario's edits; the fake reviewer answers with the scenario's review.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.resolve(HERE, '..', '..', 'code-package.js')
const slash = (p) => p.replace(/\\/g, '/')

// The workflow body runs as the Workflow tool runs it: an async function of args, agent, phase and log.
const source = fs.readFileSync(WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const runWorkflow = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'pipeline', 'budget', source)

const TABLE = { roles: {
  writer: { candidates: [{ provider: 'claude', model: 'mock-writer', effort: 'high' }] },
  reviewer: { candidates: [{ provider: 'codex', model: 'mock-reviewer', effort: 'medium' }] },
} }
const ACCOUNT = { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } }
const BASE_REVIEW_MD = '# Review focus\n\nFlag: greetings that are not polite (base rule).\n'
const NEW_REVIEW_MD = '# Review focus\n\nFlag nothing at all (written by the package).\n'

// The repository every scenario starts from: a tiny app, a unit test, an end-to-end script and REVIEW.md.
const BASE_FILES = {
  'src/app.mjs': "export const greet = (name) => `hello, ${name}`\nif (process.argv[1] && process.argv[1].endsWith('app.mjs')) console.log(greet(process.argv[2] || 'world'))\n",
  'test/app.test.mjs': "import { greet } from '../src/app.mjs'\nif (!greet('x').includes('x')) { console.error('FAIL greet'); process.exit(1) }\nconsole.log('ok 1 greet')\n",
  'scripts/e2e.mjs': "import { execFileSync } from 'node:child_process'\nconst out = execFileSync(process.execPath, ['src/app.mjs', 'e2e'], { encoding: 'utf8' })\nif (!/e2e/.test(out)) { console.error('FAIL app output: ' + out); process.exit(1) }\nconsole.log('e2e ok: ' + out.trim())\n",
  'REVIEW.md': BASE_REVIEW_MD,
}

const git = (repo, ...argv) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const gitOk = (repo, ...argv) => { try { git(repo, ...argv); return 0 } catch (e) { return e.status ?? 1 } }
function makeRepo(extra = {}) {
  const repo = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'code-package-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'mock')
  git(repo, 'config', 'user.name', 'mock')
  git(repo, 'config', 'core.autocrlf', 'false')
  for (const [f, t] of Object.entries({ ...BASE_FILES, ...extra })) if (t !== null) { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}
const between = (text, re, what) => { const m = text.match(re); if (!m) throw new Error(`the prompt has no ${what}`); return m[1] }
const run = (cmd, cwd) => {
  try { return { exitCode: 0, output: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { exitCode: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` } }
}

// Runs a list of { cmd, pass } as the runner would: each once, to its end, one log each. A pass rule that says "any
// exit code" accepts a nonzero exit; every other rule wants exit code 0.
function runList(ctx, list, kind, dir = `${ctx.tmp}/logs`) {
  const results = [], logs = [], evidence = []
  let cause = 'none'
  for (const c of list) {
    const r = run(c.cmd, ctx.repo)
    const log = `${dir}/${kind}-${++ctx.logN}.log`
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, r.output)
    const passed = r.exitCode === 0 || /any exit code/.test(c.pass || '')
    ctx.ran.push({ kind, cmd: c.cmd, exitCode: r.exitCode })
    results.push(`${c.cmd}: exit ${r.exitCode}, ${r.output.trim().split('\n').pop()}, ${passed ? 'pass' : 'fail'}`)
    logs.push(log)
    evidence.push({ command: c.cmd, exitCode: r.exitCode, passed, trace: log, ...('flow' in c ? { flow: c.flow } : {}) })
    if (!passed) { cause = (ctx.s.flaky || []).includes(c.cmd) ? 'flaky' : 'code'; break }
  }
  return { ok: cause === 'none', results, logs, cause, evidence }
}

function fakeAgent(ctx) {
  const { repo, tmp, s } = ctx
  return async (prompt, opts = {}) => {
    const label = opts.label || ''
    ctx.prompts.push({ label, prompt, opts })
    const tag = label.replace(/ \(cont \d+\)$/, '')
    if (tag.startsWith('gate ')) {
      return {
        homeModels: JSON.stringify(TABLE), repoModels: '', account: JSON.stringify(ACCOUNT), git: !s.notGit,
        head: s.notGit ? '' : git(repo, 'rev-parse', 'HEAD').trim(), ignoreExit: s.ignoreExit ?? 0,
        dirty: s.notGit ? [] : git(repo, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')),
        reviewMd: gitOk(repo, 'cat-file', '-e', 'HEAD:REVIEW.md') === 0,
        ...(ctx.args.branch ? { branchHead: gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${ctx.args.branch}`) === 0 ? git(repo, 'rev-parse', `refs/heads/${ctx.args.branch}`).trim() : '' } : {}),
        verifySkill: gitOk(repo, 'cat-file', '-e', 'HEAD:.claude/skills/verify/SKILL.md') === 0,
        verifySkillText: gitOk(repo, 'cat-file', '-e', 'HEAD:.claude/skills/verify/SKILL.md') === 0 ? git(repo, 'show', 'HEAD:.claude/skills/verify/SKILL.md') : '',
        packageJson: gitOk(repo, 'cat-file', '-e', 'HEAD:package.json') === 0 ? git(repo, 'show', 'HEAD:package.json') : '',
      }
    }
    if (tag.startsWith('claim ') || tag.startsWith('claim more ')) return { ok: true, conflicts: [], summary: 'claimed (mock)' }
    if (tag.startsWith('close claim ')) return { ok: true, summary: 'closed (mock)' }
    if (opts.agentType === 'zodchi-core:coder') {
      const step = tag.replace(` ${ctx.label}`, '')
      const edits = (s.writes || {})[step]
      if (!edits) throw new Error(`the scenario has no edits for the writer step "${step}"`)
      if (s.writerMore && tag !== label) throw new Error(`a fresh writer went on after ${tag}`)
      for (const [f, t] of Object.entries(edits)) {
        if (t === null) fs.rmSync(`${repo}/${f}`, { force: true })
        else { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
      }
      const flaky = ((s.writerFlaky || {})[step] || []).map(command => {
        const log = `${tmp}/logs/writer-${++ctx.logN}.log`
        fs.mkdirSync(path.dirname(log), { recursive: true })
        fs.writeFileSync(log, run(command, repo).output)
        ctx.ran.push({ kind: 'writer', cmd: command })
        return { command, log, why: 'connection reset by the test server, nothing in the change' }
      })
      return { done: !s.writerMore, summary: `mock writer: ${step}`, changed: Object.keys(edits).map(f => `${repo}/${f}`), unverified: [], ...(s.writerMore ? { more: true } : {}), ...(flaky.length ? { flaky } : {}) }
    }
    if (tag.startsWith('status ')) {
      const paths = git(repo, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''))
      return { ok: true, summary: 'listed', paths }
    }
    if (tag.startsWith('protect ')) {
      const base = between(prompt, /with the base commit ([0-9a-f]+) in /, 'base commit')
      const m = prompt.match(/Paths to compare, relative to the repository: (\[.*?\])\. /)
      const list = m ? JSON.parse(m[1]) : []
      const paths = list.filter(p => gitOk(repo, 'cat-file', '-e', `${base}:${p}`) === 0 && gitOk(repo, 'diff', '--quiet', base, '--', p) === 1)
      const sm = prompt.match(/Package scripts to compare: (\[.*?\])\. /)
      if (!sm) return { ok: true, summary: 'compared', paths }
      // What the prompt's node -e command prints: each named script that differs between the base and the work tree.
      const scriptsOf = (text) => { try { return JSON.parse(text).scripts || {} } catch { return null } }
      const was = scriptsOf(git(repo, 'show', `${base}:package.json`))
      const now = fs.existsSync(`${repo}/package.json`) ? scriptsOf(fs.readFileSync(`${repo}/package.json`, 'utf8')) : null
      const scripts = JSON.parse(sm[1]).filter(n => !was || !now || was[n] !== now[n])
      ctx.scriptsCompared = JSON.parse(sm[1])
      return { ok: true, summary: 'compared', paths, scripts }
    }
    if (tag.startsWith('evidence ')) {
      const list = JSON.parse(between(prompt, /For each of (\[.*?\]), run `test -s/, 'trace list'))
      ctx.traceChecks.push(list)
      return { ok: true, summary: 'checked', paths: list.filter(p => !(fs.existsSync(p) && fs.statSync(p).size > 0)) }
    }
    if (tag.startsWith('checks ')) {
      const list = JSON.parse(between(prompt, /one log per command in \S+: (\[\{"cmd".*?\}\])\. /, 'list of checks'))
      return runList(ctx, list, 'checks')
    }
    if (tag.startsWith('verify ')) {
      const list = []
      const m1 = prompt.match(/Run these commands, in order, each to its end: (\[.*?\])\.\n/)
      const m2 = prompt.match(/these checks, each to its end: (\[.*?\])\.\n/)
      if (m1) list.push(...JSON.parse(m1[1]))
      if (/verify skill/.test(prompt)) {
        const base = between(prompt, /`git show ([0-9a-f]+):\.claude\/skills\/verify\/SKILL\.md`/, 'skill as of the base commit')
        const skill = git(repo, 'show', `${base}:.claude/skills/verify/SKILL.md`)
        ctx.skillRead = skill
        // A step marked "(setup)" only prepares; the others drive the flow.
        for (const m of skill.matchAll(/^\d+\. `([^`]+)`(.*)$/gm)) list.push({ cmd: m[1], pass: 'exit code 0', flow: !/\(setup\)/.test(m[2]) })
      }
      if (m2) list.push(...JSON.parse(m2[1]))
      // The evidence folder of this run: emptied first, every log of the run under it.
      const dir = between(prompt, /Evidence folder: '([^']+)'/, 'evidence folder')
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      ctx.e2eDirs.push(dir)
      const res = runList(ctx, list, 'verify', dir)
      // A runner that reports less than it ran: one entry missing, entries without a trace, or a trace it never made.
      if (s.evidenceTamper === 'drop') res.evidence.pop()
      if (s.evidenceTamper === 'blank') for (const e of res.evidence) e.trace = ''
      if (s.evidenceTamper === 'ghost') res.evidence[0].trace = `${dir}/trace-never-written.zip`
      if (s.evidenceTamper === 'elsewhere') { const old = `${ctx.tmp}/old-run.log`; fs.writeFileSync(old, 'e2e ok: from an earlier run\n'); res.evidence[0].trace = old }
      return res
    }
    if (tag.startsWith('commit ')) {
      const paths = JSON.parse(between(prompt, /The package paths, relative to the repository: (\[.*?\])\.\n/, 'package paths'))
      const message = JSON.parse(between(prompt, /Commit message, as a JSON string: ("(?:[^"\\]|\\.)*")/, 'commit message'))
      const msgFile = between(prompt, /git commit -F '([^']+)'/, 'message file')
      const add = paths.filter(p => fs.existsSync(`${repo}/${p}`) || gitOk(repo, 'ls-files', '--error-unmatch', '--', p) === 0)
      if (add.length) git(repo, 'add', '-A', '--', ...add)
      let summary = 'nothing to commit', listed = []
      if (gitOk(repo, 'diff', '--cached', '--quiet', '--', ...add) !== 0) {
        fs.writeFileSync(msgFile, message)
        git(repo, 'commit', '-q', '-F', msgFile, '--', ...add)
        listed = git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
        summary = git(repo, 'rev-parse', 'HEAD').trim()
      }
      ctx.commits.push(message)
      return { ok: listed.every(f => paths.includes(f)), summary, paths: listed, head: git(repo, 'rev-parse', 'HEAD').trim() }
    }
    if (tag.startsWith('review ')) {
      // What the runner does for a gateway review: the diff of the fixed commit, REVIEW.md as of the base commit,
      // then the call; the fake gateway "receives" every attachment that exists, as the gateway would.
      // A fixed commit against the base; in a preview (args.commit false) the work tree against the base.
      const [, diffFile, from, to] = prompt.match(/Save the change as (\S+) with `git diff ([0-9a-f]+) (?:([0-9a-f]+) )?-- <files>`/) || []
      if (!diffFile) throw new Error('the review prompt does not diff the change against the base')
      if (!to && !(s.args && s.args.commit === false)) throw new Error('the review diffs the work tree although the run commits')
      fs.writeFileSync(diffFile, to ? git(repo, 'diff', from, to) : git(repo, 'diff', from))
      const [, showFrom, focusFile] = prompt.match(/git show ([0-9a-f]+):REVIEW\.md > '([^']+)'/) || []
      if (!showFrom && !/The base commit has no REVIEW\.md: run `rm -f '([^']+)'`/.test(prompt)) throw new Error('the review prompt neither saves REVIEW.md from a commit nor says the base has none')
      if (showFrom) {
        // The export fails (a full disk, say): the step must not send the review without the owner's rules.
        if (s.focusExportFails) {
          if (!/if that command fails, do not call the gateway/.test(prompt)) throw new Error('the review prompt lets a failed REVIEW.md export through')
          return { verdict: 'missing', findings: [], summary: 'not sent', gateway: 'failed', infra: 'REVIEW.md export failed: No space left on device' }
        }
        fs.writeFileSync(focusFile, git(repo, 'show', `${showFrom}:REVIEW.md`))
      }
      // Somebody edits a package file in the work tree after the commit: the review must not see it.
      if (s.dirtyBeforeReview) for (const [f, t] of Object.entries(s.dirtyBeforeReview)) fs.writeFileSync(`${repo}/${f}`, t)
      // The package files as of the commit under review, at their repository paths under the snapshot folder.
      const snap = prompt.match(/Save the package files as of the commit ([0-9a-f]+) under '([^']+)', never from the work tree: run `rm -rf '[^']+'`, then for each of (\[.*?\]) /)
      if (snap) {
        const [, commitOf, dir, list] = snap
        fs.rmSync(dir, { recursive: true, force: true })
        for (const p of JSON.parse(list)) if (gitOk(repo, 'cat-file', '-e', `${commitOf}:${p}`) === 0) {
          fs.mkdirSync(path.dirname(`${dir}/${p}`), { recursive: true })
          fs.writeFileSync(`${dir}/${p}`, git(repo, 'show', `${commitOf}:${p}`))
        }
      }
      const call = between(prompt, /`(zodchi run [^`]+)`/, 'gateway command')
      const attached = {}
      for (const m of call.matchAll(/--attach '([^']+)'/g)) if (fs.existsSync(m[1])) attached[slash(m[1])] = fs.readFileSync(m[1], 'utf8')
      const named = (prompt.match(/the review's "commit" field names exactly ([0-9a-f]+)/) || [])[1] || ''
      const n = Number(tag.split(' ')[1])
      const answer = (s.reviews || [])[n - 1] || { verdict: 'approved', findings: [] }
      ctx.reviews.push({ n, diffFrom: from, diffTo: to, attached, named, snapshot: snap ? snap[2] : '', call, headAtReview: git(repo, 'rev-parse', 'HEAD').trim() })
      if (s.moveBranchDuringReview) { fs.writeFileSync(`${repo}/other.txt`, 'someone else\n'); git(repo, 'add', 'other.txt'); git(repo, 'commit', '-q', '-m', 'someone else') }
      const outFile = between(call, /--out '([^']+)'/, 'review output file')
      const commit = answer.commit ?? named
      fs.writeFileSync(outFile, JSON.stringify({ verdict: answer.verdict, summary: 'mock review', commit, findings: answer.findings, notVerified: [] }, null, 2))
      return {
        verdict: answer.verdict, summary: 'mock review', reviewFile: outFile,
        findings: answer.findings.map(f => `${f.id} ${f.severity} ${f.location}: ${f.problem}`),
        blocking: answer.findings.filter(f => ['important', 'blocking'].includes(f.severity)).length,
        commit, headAfter: git(repo, 'rev-parse', 'HEAD').trim(), gateway: 'final', infra: '',
      }
    }
    throw new Error(`the fake agent has no answer for the step "${label}"`)
  }
}

async function runScenario(name, s) {
  const repo = makeRepo(s.repoFiles)
  const tmp = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'code-package-tmp-')))
  const brief = `${tmp}/brief.md`
  fs.writeFileSync(brief, `# Brief: ${name}\n\nChange the greeting.\n`)
  const ctx = { s, repo, tmp, label: 'mock-pkg', prompts: [], ran: [], commits: [], reviews: [], traceChecks: [], e2eDirs: [], logN: 0, base: git(repo, 'rev-parse', 'HEAD').trim() }
  const args = { label: ctx.label, brief, repo, tmp, files: ['src/app.mjs'], checks: s.checks ?? ['node test/app.test.mjs'], ...(s.args || {}) }
  ctx.args = args
  // Repository state before the run: another branch, or uncommitted changes of somebody else.
  if (s.setup) s.setup(repo)
  const logs = []
  let result, error
  try { result = await runWorkflow(args, fakeAgent(ctx), () => {}, (m) => logs.push(m), null, null, { total: null }) }
  catch (e) { if (!s.throws) throw e; error = e; result = {} }
  return { ctx, result, logs, error }
}

const labels = (ctx) => ctx.prompts.map(p => p.label)
const has = (ctx, prefix) => labels(ctx).some(l => l.startsWith(prefix))
const lastMessage = (ctx) => ctx.commits[ctx.commits.length - 1] || ''

const SCENARIOS = {
  // A passing end-to-end run is reported with its evidence; the cheap check ran first; the commit carries the stamp.
  'e2e-pass': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'good day'), 'test/greet-polite.test.mjs': "console.log('ok new test')\n" } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt}`)
      if (r.verifiedBy !== 'args.verify') bad.push(`verifiedBy ${r.verifiedBy}`)
      const ev = (r.verification && r.verification.evidence) || []
      if (!(ev.length === 1 && ev[0].command === 'node scripts/e2e.mjs' && ev[0].exitCode === 0 && fs.existsSync(ev[0].trace) && /e2e ok/.test(fs.readFileSync(ev[0].trace, 'utf8')))) bad.push(`evidence ${JSON.stringify(ev)}`)
      const order = ctx.ran.map(x => x.kind).join(',')
      if (order !== 'checks,verify') bad.push(`run order ${order}, expected the cheap check before the end-to-end run`)
      if (!/\n\nVerified: e2e node scripts\/e2e\.mjs exit 0; checks 1 passed\n$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (!/Verified: e2e node scripts\/e2e\.mjs exit 0/.test(git(ctx.repo, 'log', '-1', '--format=%B'))) bad.push('the commit in Git has no Verified line')
      const head = git(ctx.repo, 'rev-parse', 'HEAD').trim()
      if (r.verification.reviewedCommit !== head || ctx.reviews[0].diffTo !== head || ctx.reviews[0].named !== head) bad.push(`reviewed ${r.verification.reviewedCommit}, diff to ${ctx.reviews[0].diffTo}, named ${ctx.reviews[0].named}, HEAD ${head}`)
      if (ctx.reviews[0].diffFrom !== ctx.base) bad.push('the review diff does not start at the base commit')
      if (!(ctx.traceChecks.length === 1 && ctx.traceChecks[0][0] === ev[0].trace && ev[0].trace.startsWith(ctx.e2eDirs[0] + '/'))) bad.push(`the trace was not checked apart from the run: ${JSON.stringify(ctx.traceChecks)}`)
      if (r.verdict !== 'approved') bad.push(`verdict ${r.verdict}`)
      if (r.protectedChanged) bad.push(`a new test file was refused: ${r.protectedChanged}`)
      const w = ctx.prompts.find(p => p.label.startsWith('write '))
      if (!/Protected checks: do not change or delete an existing test/.test(w.prompt) || !/Never skip a check/.test(w.prompt)) bad.push('the writer was not told the check rules up front')
      return bad
    },
  },
  // The repository has no way to run the change: verifiedBy "none", said plainly, also in the commit stamp.
  'no-run': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hi') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'none') bad.push(`verifiedBy ${r.verifiedBy}`)
      if (!/not verified by running/.test((r.verification && r.verification.note) || '')) bad.push(`note ${JSON.stringify(r.verification && r.verification.note)}`)
      if (has(ctx, 'verify ')) bad.push('an end-to-end step ran although there is nothing to run')
      if (!/\nVerified: none; checks 1 passed\n$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (!git(ctx.repo, 'log', '--grep', 'Verified: none', '--format=%H').trim()) bad.push('git log --grep "Verified: none" finds nothing')
      if (!/Verified: none/.test(ctx.prompts.find(p => p.label.startsWith('review ')).prompt)) bad.push('the reviewer was not told the change is not verified by running')
      return bad
    },
  },
  // The repository's verify skill as of the base commit is the end-to-end run when args.verify is absent.
  'verify-skill': {
    repoFiles: { '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: run the app once\n---\n\n1. `node scripts/e2e.mjs`\n' },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'verify skill') bad.push(`verifiedBy ${r.verifiedBy}`)
      if (!ctx.skillRead) bad.push('the skill was not read from the base commit')
      if (!/Verified: e2e node scripts\/e2e\.mjs exit 0/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      return bad
    },
  },
  // A diff that edits an existing test stops before review (and before the checks), with the path listed.
  'edits-test': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'yo'), 'test/app.test.mjs': "console.log('ok 1 greet (assertion removed)')\n" } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(r.protectedChanged) !== JSON.stringify(['test/app.test.mjs'])) bad.push(`protectedChanged ${JSON.stringify(r.protectedChanged)}`)
      if (!/^protected checks changed/.test(r.stoppedAt || '')) bad.push(`stoppedAt ${r.stoppedAt}`)
      if (has(ctx, 'review ') || has(ctx, 'checks ') || has(ctx, 'commit ')) bad.push(`steps ran after the stop: ${labels(ctx).join(', ')}`)
      if (r.approved) bad.push('approved')
      if (r.verifiedBy !== 'none') bad.push(`verifiedBy ${r.verifiedBy}`)
      if (git(ctx.repo, 'rev-parse', 'HEAD').trim() !== ctx.base) bad.push('the work was committed')
      return bad
    },
  },
  // A review with only nit and pre-existing findings approves, whatever its verdict word; old severities are read too.
  'nits-approve': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hullo') } },
    reviews: [{ verdict: 'changes_requested', findings: [
      { id: 'F1', severity: 'nit', location: 'src/app.mjs:1', problem: 'name the default' },
      { id: 'F2', severity: 'pre-existing', location: 'src/app.mjs:2', problem: 'argv check was there before' },
      { id: 'F3', severity: 'should_fix', location: 'src/app.mjs:1', problem: 'old word, read as nit' },
      { id: 'F4', severity: 'note', location: 'src/app.mjs:1', problem: 'old word, read as nit' },
    ] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt} ${r.question || ''}`)
      if (ctx.reviews.length !== 1 || labels(ctx).some(l => /^close \d/.test(l))) bad.push(`steps: ${labels(ctx).join(', ')}`)
      const sev = r.openFindings.map(f => f.split(' ')[1]).join(',')
      if (sev !== 'nit,pre-existing,nit,nit') bad.push(`openFindings ${JSON.stringify(r.openFindings)}`)
      if (r.verdict !== 'approved' || r.rounds[0].verdict !== 'approved') bad.push(`verdict ${r.verdict}, round verdict ${r.rounds[0].verdict}: the effective verdict is not approved`)
      if (r.rounds[0].review.verdict !== 'changes_requested') bad.push(`the reviewer's own word is lost: ${r.rounds[0].review.verdict}`)
      return bad
    },
  },
  // An important finding (or the old word blocking) blocks; the writer closes it and the second review approves.
  'important-blocks': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hiya') }, 'close 1': { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hello there') } },
    reviews: [
      { verdict: 'approved', findings: [{ id: 'F1', severity: 'blocking', location: 'src/app.mjs:1', problem: 'impolite greeting' }, { id: 'F2', severity: 'nit', location: 'src/app.mjs:2', problem: 'minor' }] },
      { verdict: 'approved', findings: [] },
    ],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved || ctx.reviews.length !== 2) bad.push(`approved ${r.approved} after ${ctx.reviews.length} review(s): ${r.stoppedAt}`)
      const close = ctx.prompts.find(p => p.label.startsWith('close 1'))
      if (!close || !/F1 important/.test(close.prompt) || /F2 nit src/.test(close.prompt.split('Leave nit')[0])) bad.push('the close task is not the important finding only')
      if (ctx.commits.length !== 2 || !ctx.commits.every(m => /\nVerified: none; checks 1 passed\n$/.test(m))) bad.push(`commit messages ${JSON.stringify(ctx.commits)}`)
      if (ctx.reviews[1].diffTo !== git(ctx.repo, 'rev-parse', 'HEAD').trim()) bad.push('the second review did not judge the second commit')
      if (r.verdict !== 'approved' || r.rounds[0].verdict !== 'changes_requested' || r.rounds[0].review.verdict !== 'approved') bad.push(`verdicts: package ${r.verdict}, round 1 ${r.rounds[0].verdict} (reviewer ${r.rounds[0].review.verdict})`)
      return bad
    },
  },
  // REVIEW.md is attached from the base commit even when the package changes it (an allowed check change).
  'review-md-base': {
    args: { allowCheckChanges: { 'REVIEW.md': 'the owner asked for the new rule' } },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'greetings'), 'REVIEW.md': NEW_REVIEW_MD } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      const att = ctx.reviews[0] ? ctx.reviews[0].attached : {}
      const focus = Object.entries(att).find(([p]) => p.endsWith('/REVIEW.base.md'))
      if (!focus) bad.push(`REVIEW.base.md was not attached: ${Object.keys(att).join(', ')}`)
      else if (focus[1] !== BASE_REVIEW_MD) bad.push(`the attached REVIEW.md is not the base one: ${JSON.stringify(focus[1])}`)
      if (fs.readFileSync(`${ctx.repo}/REVIEW.md`, 'utf8') !== NEW_REVIEW_MD) bad.push('the package change to REVIEW.md is not in the work tree')
      if (JSON.stringify(r.checkChanges) !== JSON.stringify([{ path: 'REVIEW.md', reason: 'the owner asked for the new rule' }])) bad.push(`checkChanges ${JSON.stringify(r.checkChanges)}`)
      // REVIEW.base.md is required whenever it exists: never in the list of files that may be dropped for size.
      const review = ctx.prompts.find(p => p.label === 'review 1').prompt
      const optional = (review.match(/\(optional: (\[.*?\]); no other file is optional\)/) || [])[1]
      if (!optional || /REVIEW\.base\.md/.test(optional)) bad.push(`REVIEW.base.md may be dropped for size: optional ${optional}`)
      if (!/for every required attachment: \[[^\]]*REVIEW\.base\.md/.test(review)) bad.push('the request check does not require REVIEW.base.md, which the base commit has')
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt}`)
      return bad
    },
  },
  // A cheap check that fails goes back to the writer without the slow run; the end-to-end run comes after the fix.
  'cheap-first': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: {
      write: { 'src/app.mjs': "export const greet = () => 'oops'\nconsole.log(greet())\n" },
      'fix checks 1.1': { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'salut') },
    },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      const steps = labels(ctx).filter(l => /^(checks|verify|fix checks) /.test(l)).join(', ')
      if (steps !== 'checks 1, fix checks 1.1, checks 1.1, verify 1.1') bad.push(`steps ${steps}`)
      if (!r.approved || r.verifiedBy !== 'args.verify') bad.push(`approved ${r.approved}, verifiedBy ${r.verifiedBy}, stoppedAt ${r.stoppedAt}`)
      return bad
    },
  },
  // A check that fails without a cause in the change is reported as flaky, run once, and stops the package.
  'flaky': {
    args: { verify: ['node scripts/e2e.mjs'] },
    repoFiles: { 'scripts/e2e.mjs': "console.error('connection reset by the test server'); process.exit(1)\n" },
    flaky: ['node scripts/e2e.mjs'],
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'howdy') } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/^checks \(flaky/.test(r.stoppedAt || '')) bad.push(`stoppedAt ${r.stoppedAt}`)
      if (!r.flaky || !r.flaky.logs.length) bad.push(`flaky ${JSON.stringify(r.flaky)}`)
      if (ctx.ran.filter(x => x.kind === 'verify').length !== 1) bad.push('the flaky check was run more than once')
      if (has(ctx, 'fix checks') || has(ctx, 'review ') || has(ctx, 'commit ')) bad.push(`steps ran after the flaky failure: ${labels(ctx).join(', ')}`)
      if (r.verifiedBy !== 'none') bad.push(`verifiedBy ${r.verifiedBy}`)
      return bad
    },
  },
  // A verify skill that runs a script: the script is protected although no command of the arguments names it.
  'skill-edits-e2e': {
    repoFiles: { '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: run the app once\n---\n\n1. `node scripts/e2e.mjs`\n' },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey'), 'scripts/e2e.mjs': "console.log('e2e ok: always')\n" } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(r.protectedChanged) !== JSON.stringify(['scripts/e2e.mjs'])) bad.push(`protectedChanged ${JSON.stringify(r.protectedChanged)}`)
      if (has(ctx, 'verify ') || has(ctx, 'review ') || has(ctx, 'commit ')) bad.push(`steps ran after the stop: ${labels(ctx).join(', ')}`)
      if (r.verifiedBy !== 'none' || r.approved) bad.push(`verifiedBy ${r.verifiedBy}, approved ${r.approved}`)
      return bad
    },
  },
  // `npm run e2e`: the package.json script it runs is protected by name, and so is the file that script names.
  'npm-script-edit': {
    repoFiles: { 'package.json': JSON.stringify({ name: 'app', private: true, scripts: { e2e: 'node scripts/e2e.mjs' } }, null, 2) + '\n' },
    args: { verify: ['npm run e2e'] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey'), 'package.json': JSON.stringify({ name: 'app', private: true, scripts: { e2e: 'node -e 0' } }, null, 2) + '\n' } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(r.protectedChanged) !== JSON.stringify(['package.json']) || JSON.stringify(r.protectedScripts) !== JSON.stringify(['e2e'])) bad.push(`protectedChanged ${JSON.stringify(r.protectedChanged)}, scripts ${JSON.stringify(r.protectedScripts)}`)
      if (has(ctx, 'verify ') || has(ctx, 'review ')) bad.push(`steps ran after the stop: ${labels(ctx).join(', ')}`)
      if (!/scripts\/e2e\.mjs/.test(ctx.prompts.find(p => p.label.startsWith('write ')).prompt)) bad.push('the file the script runs is not protected')
      return bad
    },
  },
  // The rest of package.json may change: a new field leaves the protected script alone, and the run goes on.
  'npm-other-change': {
    repoFiles: { 'package.json': JSON.stringify({ name: 'app', private: true, scripts: { e2e: 'node scripts/e2e.mjs' } }, null, 2) + '\n' },
    args: { verify: ['npm run e2e'] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey'), 'package.json': JSON.stringify({ name: 'app', private: true, description: 'greets', scripts: { e2e: 'node scripts/e2e.mjs' } }, null, 2) + '\n' } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(ctx.scriptsCompared) !== JSON.stringify(['pree2e', 'e2e', 'poste2e'])) bad.push(`scripts compared ${JSON.stringify(ctx.scriptsCompared)}`)
      if (!r.approved || r.verifiedBy !== 'args.verify' || r.protectedChanged) bad.push(`approved ${r.approved}, verifiedBy ${r.verifiedBy}, protectedChanged ${JSON.stringify(r.protectedChanged)}, stoppedAt ${r.stoppedAt}`)
      return bad
    },
  },
  // A verify skill that names no file and no script cannot be protected: the gate refuses until args.protect names it.
  'skill-unresolved': {
    repoFiles: { '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: run the app once\n---\n\n1. Start the app with `make serve` and open it.\n' },
    writes: {},
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/args\.protect/.test(r.refused || '')) bad.push(`refused ${JSON.stringify(r.refused)}`)
      if (labels(ctx).join(',') !== 'gate mock-pkg') bad.push(`steps: ${labels(ctx).join(', ')}`)
      return bad
    },
  },
  // The review reads the commit, not the work tree: a later edit in the work tree never reaches the reviewer.
  'review-reads-commit': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'bonjour') } },
    dirtyBeforeReview: { 'src/app.mjs': "export const greet = () => 'tampered after the commit'\n" },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      const rv = ctx.reviews[0]
      const committed = git(ctx.repo, 'show', 'HEAD:src/app.mjs')
      const copy = rv && rv.attached[`${rv.snapshot}/src/app.mjs`]
      if (copy !== committed) bad.push(`the attached src/app.mjs is not the commit's: ${JSON.stringify(copy)}`)
      if (rv && Object.values(rv.attached).some(t => /tampered/.test(t))) bad.push('the work tree edit reached the reviewer')
      if (rv && rv.call.includes(`--attach '${ctx.repo}/src/app.mjs'`)) bad.push('the work tree file is attached')
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt}`)
      return bad
    },
  },
  // A runner that leaves out the evidence of one command does not certify the run.
  'evidence-missing': {
    args: { verify: ['node scripts/e2e.mjs', 'node scripts/e2e.mjs again'] },
    evidenceTamper: 'drop',
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'none' || !/no evidence for node scripts\/e2e\.mjs again/.test(r.verification.note)) bad.push(`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`)
      if (!/\nVerified: none; checks 1 passed\n$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      return bad
    },
  },
  // Evidence without a trace does not certify the run either.
  'evidence-blank-trace': {
    args: { verify: ['node scripts/e2e.mjs'] },
    evidenceTamper: 'blank',
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ result: r }) => (r.verifiedBy !== 'none' || !/names no trace/.test(r.verification.note)) ? [`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`] : [],
  },
  // A command whose pass rule accepts a nonzero exit verifies the run, and its real exit code is kept.
  'pass-rule-nonzero': {
    repoFiles: { 'scripts/usage.mjs': "console.log('usage: app <name>')\nprocess.exit(2)\n" },
    args: { verify: [{ cmd: 'node scripts/usage.mjs', pass: 'prints usage, any exit code' }] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'args.verify') bad.push(`verifiedBy ${r.verifiedBy}: ${r.verification && r.verification.note}`)
      if (!/\nVerified: e2e node scripts\/usage\.mjs exit 2; checks 1 passed\n$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      return bad
    },
  },
  // "approved" with an important finding at the round limit: the package stops, and its verdict says so.
  'approved-important-at-limit': {
    args: { rounds: 1 },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'oi') } },
    reviews: [{ verdict: 'approved', findings: [{ id: 'F1', severity: 'important', location: 'src/app.mjs:1', problem: 'impolite greeting' }] }],
    expect: ({ result: r }) => {
      const bad = []
      if (r.approved || r.verdict !== 'changes_requested' || !/^stop rule/.test(r.stoppedAt || '')) bad.push(`approved ${r.approved}, verdict ${r.verdict}, stoppedAt ${r.stoppedAt}`)
      if (r.rounds[0].review.verdict !== 'approved') bad.push(`the reviewer's own word is lost: ${r.rounds[0].review.verdict}`)
      return bad
    },
  },
  // A close write after a verified round: the package stops on the guard, and the current work is not verified; the
  // round keeps the evidence of its own run.
  'close-after-verified': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: {
      write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hiya') },
      'close 1': { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hello there'), 'test/app.test.mjs': "console.log('ok 1 greet (assertion removed)')\n" },
    },
    reviews: [{ verdict: 'changes_requested', findings: [{ id: 'F1', severity: 'important', location: 'src/app.mjs:1', problem: 'impolite greeting' }] }],
    expect: ({ result: r }) => {
      const bad = []
      if (!/^protected checks changed at close 1/.test(r.stoppedAt || '')) bad.push(`stoppedAt ${r.stoppedAt}`)
      if (r.verifiedBy !== 'none' || r.verification.verifiedBy !== 'none' || r.verification.evidence.length || !/close 1 changed the work/.test(r.verification.note)) bad.push(`current verification ${JSON.stringify(r.verification)}`)
      if (!r.rounds[0].verification || r.rounds[0].verification.verifiedBy !== 'args.verify') bad.push(`round 1 lost its evidence: ${JSON.stringify(r.rounds[0].verification)}`)
      return bad
    },
  },
  // The writer meets a flaky check first: the package stops with its log before any runner check.
  'writer-flaky': {
    args: { verify: ['node scripts/e2e.mjs'] },
    repoFiles: { 'scripts/e2e.mjs': "console.error('connection reset by the test server'); process.exit(1)\n" },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'howdy') } },
    writerFlaky: { write: ['node scripts/e2e.mjs'] },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/^checks \(flaky, reported by the writer/.test(r.stoppedAt || '')) bad.push(`stoppedAt ${r.stoppedAt}`)
      if (!r.flaky || r.flaky.reportedBy !== 'write mock-pkg' || r.flaky.logs.length !== 1 || !fs.existsSync(r.flaky.logs[0])) bad.push(`flaky ${JSON.stringify(r.flaky)}`)
      if (has(ctx, 'checks ') || has(ctx, 'verify ') || has(ctx, 'review ') || has(ctx, 'commit ')) bad.push(`steps ran after the flaky report: ${labels(ctx).join(', ')}`)
      if (ctx.ran.length !== 1) bad.push(`the flaky check ran ${ctx.ran.length} times`)
      return bad
    },
  },
  // Without commits the review reads the work tree: a preview, never an approval.
  'no-commit-preview': {
    args: { commit: false },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'ahoy') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.approved || r.verdict || !r.preview || r.preview.verdict !== 'approved') bad.push(`approved ${r.approved}, verdict ${r.verdict}, preview ${JSON.stringify(r.preview)}`)
      if (has(ctx, 'commit ')) bad.push('a commit ran')
      return bad
    },
  },
  // Outside Git there is no base commit to review against or to protect the checks with: the gate refuses.
  'outside-git': {
    notGit: true,
    writes: {},
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/needs Git/.test(r.refused || '')) bad.push(`refused ${JSON.stringify(r.refused)}`)
      if (labels(ctx).join(',') !== 'gate mock-pkg') bad.push(`steps: ${labels(ctx).join(', ')}`)
      return bad
    },
  },
  // The branch moves while the review runs: the review is stale, not counted, and the package stops.
  'stale-review': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'aloha') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    moveBranchDuringReview: true,
    expect: ({ result: r }) => {
      const bad = []
      if (r.approved || r.verdict) bad.push(`counted: approved ${r.approved}, verdict ${r.verdict}`)
      if (r.stoppedAt !== 'review 1 stale' || !r.stale) bad.push(`stoppedAt ${r.stoppedAt}`)
      return bad
    },
  },
  // A pre or post script that did not exist at the base and is added now changes how `npm run e2e` runs: it stops.
  'npm-hook-added': {
    repoFiles: { 'package.json': JSON.stringify({ name: 'app', private: true, scripts: { e2e: 'node scripts/e2e.mjs' } }, null, 2) + '\n' },
    args: { verify: ['npm run e2e'] },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey'), 'package.json': JSON.stringify({ name: 'app', private: true, scripts: { pree2e: 'node -e 0', e2e: 'node scripts/e2e.mjs' } }, null, 2) + '\n' } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(r.protectedChanged) !== JSON.stringify(['package.json']) || JSON.stringify(r.protectedScripts) !== JSON.stringify(['pree2e'])) bad.push(`protectedChanged ${JSON.stringify(r.protectedChanged)}, scripts ${JSON.stringify(r.protectedScripts)}`)
      if (has(ctx, 'verify ') || has(ctx, 'review ')) bad.push(`steps ran after the stop: ${labels(ctx).join(', ')}`)
      return bad
    },
  },
  // A package manager pointed at another manifest cannot be followed from the root package.json: the gate refuses.
  'npm-prefix-unresolved': {
    repoFiles: { 'apps/web/package.json': JSON.stringify({ name: 'web', private: true, scripts: { e2e: 'node ../../scripts/e2e.mjs' } }, null, 2) + '\n' },
    args: { verify: ['npm --prefix apps/web run e2e'] },
    writes: {},
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/args\.protect/.test(r.refused || '') || !/--prefix apps\/web/.test(r.refused || '')) bad.push(`refused ${JSON.stringify(r.refused)}`)
      if (labels(ctx).join(',') !== 'gate mock-pkg') bad.push(`steps: ${labels(ctx).join(', ')}`)
      return bad
    },
  },
  // The base has REVIEW.md but saving it fails: the review is not sent without it; the run stops as an infrastructure failure.
  'review-md-export-fails': {
    focusExportFails: true,
    throws: true,
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    expect: ({ ctx, error }) => {
      const bad = []
      if (!error || !/Infrastructure failure at step "review 1"/.test(error.message) || !/REVIEW\.md export failed/.test(error.message)) bad.push(`error ${error && error.message}`)
      if (ctx.reviews.length) bad.push('a review was received')
      return bad
    },
  },
  // A base without REVIEW.md: nothing to attach, and the review goes on.
  'no-review-md': {
    repoFiles: { 'REVIEW.md': null },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt}`)
      if (ctx.reviews[0] && Object.keys(ctx.reviews[0].attached).some(p => p.endsWith('/REVIEW.base.md'))) bad.push('a REVIEW.base.md was attached')
      return bad
    },
  },
  // A command listed twice needs two evidence entries: one entry does not cover both runs.
  'evidence-duplicate': {
    args: { verify: ['node scripts/e2e.mjs', 'node scripts/e2e.mjs'] },
    evidenceTamper: 'drop',
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ result: r }) => (r.verifiedBy !== 'none' || !/no evidence for node scripts\/e2e\.mjs \(each run of it needs its own\)/.test(r.verification.note)) ? [`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`] : [],
  },
  // A trace the run names but never wrote does not certify the run.
  'evidence-ghost-trace': {
    args: { verify: ['node scripts/e2e.mjs'] },
    evidenceTamper: 'ghost',
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ result: r }) => (r.verifiedBy !== 'none' || !/trace-never-written\.zip was not made/.test(r.verification.note)) ? [`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`] : [],
  },
  // A trace from outside this run's emptied evidence folder (an earlier run's log, say) does not certify it either.
  'evidence-old-trace': {
    args: { verify: ['node scripts/e2e.mjs'] },
    evidenceTamper: 'elsewhere',
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ result: r }) => (r.verifiedBy !== 'none' || !/outside the evidence folder of this run/.test(r.verification.note)) ? [`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`] : [],
  },
  // A verify skill whose evidence shows only setup, no step that drives the flow, is not a verified run.
  'skill-setup-only': {
    repoFiles: { '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: run the app once\n---\n\n1. `node scripts/e2e.mjs` (setup)\n' },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ result: r }) => (r.verifiedBy !== 'none' || !/drives its flow/.test(r.verification.note)) ? [`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`] : [],
  },
  // "changes_requested" with no finding cannot be closed: the effective verdict is blocked; the reviewer's word is kept.
  'changes-requested-empty': {
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'changes_requested', findings: [] }],
    expect: ({ result: r }) => {
      const bad = []
      if (r.approved || r.verdict !== 'blocked' || r.rounds[0].verdict !== 'blocked' || !/without findings/.test(r.stoppedAt || '') || !r.question) bad.push(`approved ${r.approved}, verdict ${r.verdict}, round ${r.rounds[0].verdict}, stoppedAt ${r.stoppedAt}, question ${r.question}`)
      if (r.rounds[0].review.verdict !== 'changes_requested') bad.push(`the reviewer's own word is lost: ${r.rounds[0].review.verdict}`)
      return bad
    },
  },
  // A preview whose first review asked for changes and whose second would approve: no verdict is left from round 1.
  'preview-two-rounds': {
    args: { commit: false },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hiya') }, 'close 1': { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hello there') } },
    reviews: [
      { verdict: 'changes_requested', findings: [{ id: 'F1', severity: 'important', location: 'src/app.mjs:1', problem: 'impolite greeting' }] },
      { verdict: 'approved', findings: [] },
    ],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (ctx.reviews.length !== 2 || r.approved || 'verdict' in r || !r.preview || r.preview.verdict !== 'approved') bad.push(`reviews ${ctx.reviews.length}, approved ${r.approved}, verdict ${r.verdict}, preview ${JSON.stringify(r.preview)}`)
      if (r.rounds[0].verdict !== 'changes_requested') bad.push(`round 1 verdict ${r.rounds[0].verdict}`)
      return bad
    },
  },
  // The writer reports a flaky check and says it has more to do: no fresh writer goes on to run it again.
  'writer-flaky-more': {
    args: { verify: ['node scripts/e2e.mjs'] },
    repoFiles: { 'scripts/e2e.mjs': "console.error('connection reset by the test server'); process.exit(1)\n" },
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'howdy') } },
    writerFlaky: { write: ['node scripts/e2e.mjs'] },
    writerMore: true,
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (labels(ctx).some(l => / \(cont \d+\)$/.test(l))) bad.push(`a continuation ran: ${labels(ctx).join(', ')}`)
      if (!/^checks \(flaky, reported by the writer/.test(r.stoppedAt || '') || !r.flaky || r.flaky.logs.length !== 1) bad.push(`stoppedAt ${r.stoppedAt}, flaky ${JSON.stringify(r.flaky)}`)
      if (ctx.ran.length !== 1) bad.push(`the flaky check ran ${ctx.ran.length} times`)
      return bad
    },
  },
  // A preview commits nothing, so it refuses the .gitignore repair instead of committing it.
  'preview-fix-ignore': {
    args: { commit: false, fixIgnore: true },
    ignoreExit: 1,
    writes: {},
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/preview \(args\.commit false\) commits nothing/.test(r.refused || '')) bad.push(`refused ${JSON.stringify(r.refused)}`)
      if (labels(ctx).join(',') !== 'gate mock-pkg') bad.push(`steps: ${labels(ctx).join(', ')}`)
      if (git(ctx.repo, 'rev-parse', 'HEAD').trim() !== ctx.base) bad.push('something was committed')
      return bad
    },
  },
  // An e2e script already dirty before the package, outside its paths: the run tests it, the commit does not have it,
  // so the commit is not stamped verified.
  'dirty-e2e-input': {
    args: { verify: ['node scripts/e2e.mjs'] },
    setup: (repo) => fs.writeFileSync(`${repo}/scripts/e2e.mjs`, "console.log('e2e ok: always (uncommitted edit of somebody else)')\n"),
    writes: { write: { 'src/app.mjs': BASE_FILES['src/app.mjs'].replace('hello', 'hey') } },
    reviews: [{ verdict: 'approved', findings: [] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'none' || !/outside the package \(scripts\/e2e\.mjs\)/.test(r.verification.note)) bad.push(`verifiedBy ${r.verifiedBy}, note ${r.verification.note}`)
      if (!/\nVerified: none; checks 1 passed\n$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (git(ctx.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).join(',') !== 'src/app.mjs') bad.push('the commit holds more than the package file')
      if (!r.verification.evidence.length) bad.push('the evidence of the run was dropped')
      return bad
    },
  },
  // The package branch exists at another commit with another e2e entry point: the gate refuses instead of reading
  // the base, the checks and REVIEW.md from the wrong commit.
  'branch-elsewhere': {
    args: { branch: 'other', verify: ['node scripts/e2e.mjs'] },
    setup: (repo) => {
      git(repo, 'switch', '-q', '-c', 'other')
      fs.writeFileSync(`${repo}/scripts/e2e-other.mjs`, "console.log('e2e ok: other')\n")
      git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'other entry point')
      git(repo, 'switch', '-q', 'main')
    },
    writes: {},
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!/branch other already exists at [0-9a-f]+, not at the current HEAD/.test(r.refused || '')) bad.push(`refused ${JSON.stringify(r.refused)}`)
      if (labels(ctx).join(',') !== 'gate mock-pkg') bad.push(`steps: ${labels(ctx).join(', ')}`)
      return bad
    },
  },
}

const wanted = process.argv.slice(2)
let failed = 0
for (const [name, s] of Object.entries(SCENARIOS).filter(([n]) => !wanted.length || wanted.includes(n))) {
  let bad, res
  try { res = await runScenario(name, s); bad = s.expect(res) }
  catch (e) { bad = [`threw: ${e.stack || e.message}`] }
  const r = res ? res.result : {}
  const verdict = `approved=${Boolean(r.approved)} verifiedBy=${r.verifiedBy} stoppedAt=${r.stoppedAt || '-'}`
  if (bad.length) { failed++; console.log(`FAIL ${name}: ${verdict}\n  - ${bad.join('\n  - ')}${res ? `\n  kept: ${res.ctx.repo} ${res.ctx.tmp}` : ''}`) }
  else {
    console.log(`PASS ${name}: ${verdict}`)
    for (const d of [res.ctx.repo, res.ctx.tmp]) fs.rmSync(d, { recursive: true, force: true })
  }
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
