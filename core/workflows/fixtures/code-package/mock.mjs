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
  for (const [f, t] of Object.entries({ ...BASE_FILES, ...extra })) { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}
const between = (text, re, what) => { const m = text.match(re); if (!m) throw new Error(`the prompt has no ${what}`); return m[1] }
const run = (cmd, cwd) => {
  try { return { exitCode: 0, output: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { exitCode: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` } }
}

// Runs a list of { cmd, pass } as the runner would: each once, to its end, one log each.
function runList(ctx, list, kind) {
  const results = [], logs = [], evidence = []
  let cause = 'none'
  for (const c of list) {
    const r = run(c.cmd, ctx.repo)
    const log = `${ctx.tmp}/logs/${kind}-${++ctx.logN}.log`
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, r.output)
    ctx.ran.push({ kind, cmd: c.cmd, exitCode: r.exitCode })
    results.push(`${c.cmd}: exit ${r.exitCode}, ${r.output.trim().split('\n').pop()}, ${r.exitCode === 0 ? 'pass' : 'fail'}`)
    logs.push(log)
    evidence.push({ command: c.cmd, exitCode: r.exitCode, trace: log })
    if (r.exitCode !== 0) { cause = (ctx.s.flaky || []).includes(c.cmd) ? 'flaky' : 'code'; break }
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
        homeModels: JSON.stringify(TABLE), repoModels: '', account: JSON.stringify(ACCOUNT), git: true,
        head: git(repo, 'rev-parse', 'HEAD').trim(), dirty: [], ignoreExit: 0,
        verifySkill: gitOk(repo, 'cat-file', '-e', 'HEAD:.claude/skills/verify/SKILL.md') === 0,
      }
    }
    if (tag.startsWith('claim ') || tag.startsWith('claim more ')) return { ok: true, conflicts: [], summary: 'claimed (mock)' }
    if (tag.startsWith('close claim ')) return { ok: true, summary: 'closed (mock)' }
    if (opts.agentType === 'zodchi-core:coder') {
      const step = tag.replace(` ${ctx.label}`, '')
      const edits = (s.writes || {})[step]
      if (!edits) throw new Error(`the scenario has no edits for the writer step "${step}"`)
      for (const [f, t] of Object.entries(edits)) {
        if (t === null) fs.rmSync(`${repo}/${f}`, { force: true })
        else { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
      }
      return { done: true, summary: `mock writer: ${step}`, changed: Object.keys(edits).map(f => `${repo}/${f}`), unverified: [] }
    }
    if (tag.startsWith('status ')) {
      const paths = git(repo, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''))
      return { ok: true, summary: 'listed', paths }
    }
    if (tag.startsWith('protect ')) {
      const list = JSON.parse(between(prompt, /Paths to compare, relative to the repository: (\[.*?\])\. /, 'list of paths to compare'))
      const base = between(prompt, /git cat-file -e ([0-9a-f]+):<path>/, 'base commit')
      const paths = list.filter(p => gitOk(repo, 'cat-file', '-e', `${base}:${p}`) === 0 && gitOk(repo, 'diff', '--quiet', base, '--', p) === 1)
      return { ok: true, summary: 'compared', paths }
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
        for (const m of skill.matchAll(/^\d+\. `([^`]+)`/gm)) list.push({ cmd: m[1], pass: 'exit code 0' })
      }
      if (m2) list.push(...JSON.parse(m2[1]))
      return runList(ctx, list, 'verify')
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
      const [, diffFile, from, to] = prompt.match(/Save the change as (\S+) with `git diff ([0-9a-f]+) ([0-9a-f]+) -- <files>`/) || []
      if (!diffFile) throw new Error('the review prompt does not diff a fixed commit against the base')
      fs.writeFileSync(diffFile, git(repo, 'diff', from, to))
      const [, showFrom, focusFile] = prompt.match(/git show ([0-9a-f]+):REVIEW\.md > '([^']+)'/) || []
      if (!showFrom) throw new Error('the review prompt does not save REVIEW.md from a commit')
      fs.rmSync(focusFile, { force: true })
      try { fs.writeFileSync(focusFile, git(repo, 'show', `${showFrom}:REVIEW.md`)) } catch {}
      const call = between(prompt, /`(zodchi run [^`]+)`/, 'gateway command')
      const attached = {}
      for (const m of call.matchAll(/--attach '([^']+)'/g)) if (fs.existsSync(m[1])) attached[slash(m[1])] = fs.readFileSync(m[1], 'utf8')
      const named = (prompt.match(/the review's "commit" field names exactly ([0-9a-f]+)/) || [])[1] || ''
      const n = Number(tag.split(' ')[1])
      const answer = (s.reviews || [])[n - 1] || { verdict: 'approved', findings: [] }
      ctx.reviews.push({ n, diffFrom: from, diffTo: to, attached, named, headAtReview: git(repo, 'rev-parse', 'HEAD').trim() })
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
  const ctx = { s, repo, tmp, label: 'mock-pkg', prompts: [], ran: [], commits: [], reviews: [], logN: 0, base: git(repo, 'rev-parse', 'HEAD').trim() }
  const args = { label: ctx.label, brief, repo, tmp, files: ['src/app.mjs'], checks: s.checks ?? ['node test/app.test.mjs'], ...(s.args || {}) }
  const logs = []
  const result = await runWorkflow(args, fakeAgent(ctx), () => {}, (m) => logs.push(m), null, null, { total: null })
  return { ctx, result, logs }
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
