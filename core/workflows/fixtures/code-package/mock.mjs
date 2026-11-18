#!/usr/bin/env node
// Runs the code-package workflow with fake agents over a few scenarios, each in a fresh temporary Git repository, and
// prints the verdict of each. Exit code 0 only when every scenario meets its expectations.
//
//   node core/workflows/fixtures/code-package/mock.mjs [scenario ...]
//
// Only the models are faked. The fake runner does what each step's prompt asks, for real, in the temporary
// repository: it reads Git state, compares the protected paths with the base commit, runs the check and verify commands
// the prompt lists, commits with the message the prompt gives and saves REVIEW.md with the `git show` the prompt names.
// The fake writer applies the scenario's edits; the fake reviewer answers with the scenario's review.
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
const FEATURE_REVIEW_MD = '# Review focus\n\nFlag: greetings in the wrong language (the feature branch rule).\n'
const NEW_REVIEW_MD = '# Review focus\n\nFlag nothing at all (written by the package).\n'

// The repository every scenario starts from: a tiny app, a unit test, an end-to-end script and REVIEW.md.
const APP = "export const greet = (name) => `hello, ${name}`\nif (process.argv[1] && process.argv[1].endsWith('app.mjs')) console.log(greet(process.argv[2] || 'world'))\n"
const BASE_FILES = {
  'src/app.mjs': APP,
  'test/app.test.mjs': "import { greet } from '../src/app.mjs'\nif (!greet('x').includes('x')) { console.error('FAIL greet'); process.exit(1) }\nconsole.log('ok 1 greet')\n",
  'scripts/e2e.mjs': "import { execFileSync } from 'node:child_process'\nconst out = execFileSync(process.execPath, ['src/app.mjs', 'e2e'], { encoding: 'utf8' })\nif (!/e2e/.test(out)) { console.error('FAIL app output: ' + out); process.exit(1) }\nconsole.log('e2e ok: ' + out.trim())\n",
  'REVIEW.md': BASE_REVIEW_MD,
}

const git = (repo, ...argv) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const gitOk = (repo, ...argv) => { try { git(repo, ...argv); return 0 } catch (e) { return e.status ?? 1 } }
const statusPaths = (repo) => git(repo, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''))
function makeRepo() {
  const repo = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'code-package-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'mock')
  git(repo, 'config', 'user.name', 'mock')
  git(repo, 'config', 'core.autocrlf', 'false')
  for (const [f, t] of Object.entries(BASE_FILES)) { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}
const between = (text, re, what) => { const m = text.match(re); if (!m) throw new Error(`the prompt has no ${what}`); return m[1] }
// A single-quoted shell word as q() writes it: '\'' stands for a quote.
const unquote = (w) => w.slice(1, -1).replace(/'\\''/g, "'")
const run = (cmd, cwd) => {
  try { return { exitCode: 0, output: execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (e) { return { exitCode: e.status ?? 1, output: `${e.stdout || ''}${e.stderr || ''}` } }
}

function fakeAgent(ctx) {
  const { repo, tmp, s } = ctx
  return async (prompt, opts = {}) => {
    const label = opts.label || ''
    ctx.prompts.push({ label, prompt })
    if (label.startsWith('gate ')) {
      return {
        homeModels: JSON.stringify(TABLE), repoModels: '', account: JSON.stringify(ACCOUNT), git: true,
        head: git(repo, 'rev-parse', 'HEAD').trim(), ignoreExit: 0, dirty: statusPaths(repo),
        verifySkill: gitOk(repo, 'cat-file', '-e', 'HEAD:.claude/skills/verify/SKILL.md') === 0,
        reviewMd: gitOk(repo, 'cat-file', '-e', 'HEAD:REVIEW.md') === 0,
      }
    }
    if (label.startsWith('claim ') || label.startsWith('claim more ')) {
      // The claim step switches to args.branch, as its prompt says (step 5).
      const sw = prompt.match(/`git switch ('(?:[^']|'\\'')*')`, or `git switch -c ('(?:[^']|'\\'')*')`/)
      if (sw && label.startsWith('claim ')) { const b = unquote(sw[1]); if (gitOk(repo, 'switch', b) !== 0) git(repo, 'switch', '-c', b) }
      return { ok: true, conflicts: [], summary: 'claimed (mock)' }
    }
    if (label.startsWith('base ')) {
      return {
        ok: true, head: git(repo, 'rev-parse', 'HEAD').trim(), branch: git(repo, 'branch', '--show-current').trim(),
        verifySkill: gitOk(repo, 'cat-file', '-e', 'HEAD:.claude/skills/verify/SKILL.md') === 0,
        reviewMd: gitOk(repo, 'cat-file', '-e', 'HEAD:REVIEW.md') === 0,
      }
    }
    if (label.startsWith('close claim ')) return { ok: true, summary: 'closed (mock)' }
    if (opts.agentType === 'zodchi-core:coder') {
      const step = label.replace(` ${ctx.label}`, '')
      const edits = (s.writes || {})[step]
      if (!edits) throw new Error(`the scenario has no edits for the writer step "${step}"`)
      for (const [f, t] of Object.entries(edits)) { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, t) }
      return { done: true, summary: `mock writer: ${step}`, changed: Object.keys(edits).map(f => `${repo}/${f}`), unverified: [] }
    }
    if (label.startsWith('status ')) return { ok: true, summary: 'listed', paths: statusPaths(repo) }
    if (label.startsWith('protect ')) {
      const base = between(prompt, /with the base commit ([0-9a-f]+) in /, 'base commit')
      const list = JSON.parse(between(prompt, /Paths, relative to the repository: (\[.*?\])\. /, 'paths'))
      return { ok: true, summary: 'compared', paths: list.filter(p => gitOk(repo, 'cat-file', '-e', `${base}:${p}`) === 0 && gitOk(repo, 'diff', '--quiet', base, '--', p) === 1) }
    }
    if (label.startsWith('checks ') || label.startsWith('verify ')) {
      const kind = label.split(' ')[0]
      const m = prompt.match(/^Run (?:these checks|these verify commands, the real program end to end): (\[\{"cmd".*?\}\]) from /) ||
        (/^Run the repository's verify skill/.test(prompt) ? [null, '[{"cmd":"node scripts/e2e.mjs"}]'] : null)
      if (!m) throw new Error(`the ${kind} step lists no commands: ${prompt.slice(0, 120)}`)
      const results = [], logs = [], evidence = []
      let cause = 'none'
      for (const c of JSON.parse(m[1])) {
        const r = run(c.cmd, repo)
        const log = `${tmp}/logs/${kind}-${++ctx.logN}.log`
        fs.mkdirSync(path.dirname(log), { recursive: true })
        fs.writeFileSync(log, r.output)
        ctx.ran.push(kind)
        results.push(`${c.cmd}: exit ${r.exitCode}, ${r.exitCode ? 'fail' : 'pass'}`)
        logs.push(log)
        evidence.push({ command: c.cmd, exitCode: r.exitCode, log })
        if (r.exitCode) { cause = 'code'; break }
      }
      return { ok: cause === 'none', results, logs, cause, evidence: s.noEvidence ? [] : evidence }
    }
    if (label.startsWith('commit ')) {
      const paths = JSON.parse(between(prompt, /The package paths, relative to the repository: (\[.*?\])\.\n/, 'package paths'))
      const [, subject, stamp] = prompt.match(/`git commit -m ('(?:[^']|'\\'')*') -m ('(?:[^']|'\\'')*') -- <those paths>`/) || []
      if (!subject) throw new Error('the commit step gives no message')
      const add = paths.filter(p => fs.existsSync(`${repo}/${p}`) || gitOk(repo, 'ls-files', '--error-unmatch', '--', p) === 0)
      if (add.length) git(repo, 'add', '-A', '--', ...add)
      if (gitOk(repo, 'diff', '--cached', '--quiet', '--', ...add) !== 0) git(repo, 'commit', '-q', '-m', unquote(subject), '-m', unquote(stamp), '--', ...add)
      return { ok: true, summary: git(repo, 'rev-parse', 'HEAD').trim() }
    }
    if (label.startsWith('review ')) {
      // What the runner does for a gateway review: REVIEW.md as of the base commit, then the call; the fake gateway
      // "receives" every attachment that exists, as the gateway would.
      const [, showFrom, focusFile] = prompt.match(/`git show ([0-9a-f]+):REVIEW\.md > '([^']+)'`/) || []
      if (showFrom) fs.writeFileSync(focusFile, git(repo, 'show', `${showFrom}:REVIEW.md`))
      const call = between(prompt, /`(zodchi run [^`]+)`/, 'gateway command')
      const attached = {}
      for (const m of call.matchAll(/--attach '([^']+)'/g)) if (fs.existsSync(m[1])) attached[slash(m[1])] = fs.readFileSync(m[1], 'utf8')
      const n = Number(label.split(' ')[1])
      const answer = (s.reviews || [])[n - 1] || { verdict: 'approved', findings: [] }
      ctx.reviews.push({ n, attached, showFrom, prompt })
      return {
        verdict: answer.verdict, summary: 'mock review', reviewFile: `${tmp}/review-${n}.json`,
        findings: answer.findings.map(f => `${f.id} ${f.severity} ${f.location}: ${f.problem}`), gateway: 'final', infra: '',
      }
    }
    throw new Error(`the fake agent has no answer for the step "${label}"`)
  }
}

async function runScenario(name, s) {
  const repo = makeRepo()
  const tmp = slash(fs.mkdtempSync(path.join(os.tmpdir(), 'code-package-tmp-')))
  const brief = `${tmp}/brief.md`
  fs.writeFileSync(brief, `# Brief: ${name}\n\nChange the greeting.\n`)
  const ctx = { s, repo, tmp, label: 'mock-pkg', prompts: [], ran: [], reviews: [], logN: 0, base: git(repo, 'rev-parse', 'HEAD').trim() }
  if (s.setup) ctx.setup = s.setup(repo)
  const args = { label: ctx.label, brief, repo, tmp, files: ['src/app.mjs'], checks: ['node test/app.test.mjs'], ...(s.args || {}) }
  const result = await runWorkflow(args, fakeAgent(ctx), () => {}, () => {}, null, null, { total: null })
  return { ctx, result }
}

const labels = (ctx) => ctx.prompts.map(p => p.label)
const has = (ctx, prefix) => labels(ctx).some(l => l.startsWith(prefix))
const lastMessage = (ctx) => git(ctx.repo, 'log', '-1', '--format=%B').trim()

const SCENARIOS = {
  // verify passes: its evidence is in the result, the cheap check ran first, the commit ends with the Verified line.
  'verify-passes': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'good day'), 'test/polite.test.mjs': "console.log('ok new test')\n" } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved || r.verdict !== 'approved') bad.push(`not approved: ${r.stoppedAt}`)
      if (r.verifiedBy !== 'args.verify') bad.push(`verifiedBy ${r.verifiedBy}`)
      const ev = r.verification.evidence
      // the cheap check's evidence is kept next to the slow run's
      if (!(ev.length === 2 && ev[0].command === 'node test/app.test.mjs' && ev[1].command === 'node scripts/e2e.mjs' && ev[1].exitCode === 0 && /e2e ok/.test(fs.readFileSync(ev[1].log, 'utf8')))) bad.push(`evidence ${JSON.stringify(ev)}`)
      if (ctx.ran.join(',') !== 'checks,verify') bad.push(`run order ${ctx.ran.join(',')}, expected the cheap check before verify`)
      if (!/\n\nVerified: checks exit 0; args\.verify exit 0$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (r.protectedChanged) bad.push(`a new test file was refused: ${r.protectedChanged}`)
      const w = ctx.prompts.find(p => p.label.startsWith('write ')).prompt
      if (!/Protected checks: do not change or delete an existing file/.test(w) || !/Never skip a check, add a sleep/.test(w)) bad.push('the writer was not told the check rules')
      if (!/Never skip a check, add a sleep/.test(ctx.prompts.find(p => p.label.startsWith('verify ')).prompt)) bad.push('the runner was not told the flaky rule')
      return bad
    },
  },
  // Nothing can run the change: verifiedBy "none", said plainly, also in the commit and to the reviewer.
  'nothing-to-run': {
    args: { checks: [] },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'hi') } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'none') bad.push(`verifiedBy ${r.verifiedBy}`)
      if (!/not verified by running/.test(r.verification.note)) bad.push(`note ${JSON.stringify(r.verification.note)}`)
      if (has(ctx, 'checks ') || has(ctx, 'verify ')) bad.push('a check ran although there is nothing to run')
      if (!/\n\nVerified: none$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (!/Verified: none: not verified by running/.test(ctx.reviews[0].prompt)) bad.push('the reviewer was not told the change is not verified by running')
      return bad
    },
  },
  // F7: the public commit message names the source and the exit codes, never a command string; the reviewer keeps them.
  'stamp-no-commands': {
    args: { checks: ['node test/app.test.mjs /private/path/to-secret'], verify: ['node scripts/e2e.mjs --token=hunter2'] },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'howdy') } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      const full = git(ctx.repo, 'log', '-1', '--format=%B')
      if (/private|hunter2|node |scripts\//.test(full)) bad.push(`the commit message carries a command: ${JSON.stringify(full)}`)
      if (!/\n\nVerified: checks exit 0; args\.verify exit 0$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      if (!/--token=hunter2 exit 0/.test(ctx.reviews[0].prompt)) bad.push('the reviewer lost the commands')
      if (r.verification.evidence.length !== 2) bad.push(`evidence ${JSON.stringify(r.verification.evidence)}`)
      return bad
    },
  },
  // F5: a runner that says ok with no evidence does not verify anything: verifiedBy and the stamp say none.
  'no-evidence': {
    args: { verify: ['node scripts/e2e.mjs'] },
    noEvidence: true,
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'hey') } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (r.verifiedBy !== 'none' || r.verification.verifiedBy !== 'none') bad.push(`verifiedBy ${r.verifiedBy} / ${r.verification.verifiedBy}`)
      if (!/not verified by running/.test(r.verification.note)) bad.push(`note ${JSON.stringify(r.verification.note)}`)
      if (!/\n\nVerified: none$/.test(lastMessage(ctx))) bad.push(`commit message ${JSON.stringify(lastMessage(ctx))}`)
      return bad
    },
  },
  // F2: the base, REVIEW.md and the verify skill are read on args.branch after the claim step switched to it; the branch
  // already exists with another tip, its own REVIEW.md and a verify skill.
  'branch-base': {
    args: { branch: 'feature', checks: [] },
    setup: (repo) => {
      git(repo, 'switch', '-q', '-c', 'feature')
      fs.writeFileSync(`${repo}/REVIEW.md`, FEATURE_REVIEW_MD)
      fs.mkdirSync(`${repo}/.claude/skills/verify`, { recursive: true })
      fs.writeFileSync(`${repo}/.claude/skills/verify/SKILL.md`, '# verify\n\nRun node scripts/e2e.mjs.\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'feature tip')
      const tip = git(repo, 'rev-parse', 'HEAD').trim()
      git(repo, 'switch', '-q', 'main')
      return { tip }
    },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'salut') } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      const rv = ctx.reviews[0]
      if (!rv) return [`no review: ${r.stoppedAt}`]
      if (rv.showFrom !== ctx.setup.tip) bad.push(`REVIEW.md was read from ${rv.showFrom}, not the branch tip ${ctx.setup.tip}`)
      const focus = Object.entries(rv.attached).find(([p]) => p.endsWith('/REVIEW.base.md'))
      if (!focus || focus[1] !== FEATURE_REVIEW_MD) bad.push(`the attached REVIEW.md is not the branch's: ${JSON.stringify(focus && focus[1])}`)
      if (r.verifiedBy !== 'verify skill') bad.push(`verifiedBy ${r.verifiedBy}, expected the branch's verify skill`)
      const pr = ctx.prompts.find(p => p.label.startsWith('protect '))
      if (pr && !pr.prompt.includes(ctx.setup.tip)) bad.push('the protected checks were compared with another base')
      if (git(ctx.repo, 'branch', '--show-current').trim() !== 'feature') bad.push('not on the branch')
      return bad
    },
  },
  // An edit of an existing test stops before review (and before the checks), with the path listed.
  'edits-test': {
    args: { verify: ['node scripts/e2e.mjs'] },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'yo'), 'test/app.test.mjs': "console.log('ok 1 greet (assertion removed)')\n" } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (JSON.stringify(r.protectedChanged) !== JSON.stringify(['test/app.test.mjs'])) bad.push(`protectedChanged ${JSON.stringify(r.protectedChanged)}`)
      if (!/^protected checks changed/.test(r.stoppedAt || '')) bad.push(`stoppedAt ${r.stoppedAt}`)
      if (has(ctx, 'review ') || has(ctx, 'checks ') || has(ctx, 'commit ')) bad.push(`steps ran after the stop: ${labels(ctx).join(', ')}`)
      if (r.approved || r.verifiedBy !== 'none') bad.push(`approved ${r.approved}, verifiedBy ${r.verifiedBy}`)
      if (git(ctx.repo, 'rev-parse', 'HEAD').trim() !== ctx.base) bad.push('the work was committed')
      return bad
    },
  },
  // Only nit and pre-existing findings: approved whatever the reviewer's word; old severities are read too.
  'nits-approve': {
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'hullo') } },
    reviews: [{ verdict: 'changes_requested', findings: [
      { id: 'F1', severity: 'nit', location: 'src/app.mjs:1', problem: 'name the default' },
      { id: 'F2', severity: 'pre-existing', location: 'src/app.mjs:2', problem: 'argv check was there before' },
      { id: 'F3', severity: 'should_fix', location: 'src/app.mjs:1', problem: 'old word, read as nit' },
    ] }],
    expect: ({ ctx, result: r }) => {
      const bad = []
      if (!r.approved || r.verdict !== 'approved') bad.push(`approved ${r.approved}, verdict ${r.verdict}: ${r.stoppedAt}`)
      if (ctx.reviews.length !== 1 || labels(ctx).some(l => /^close \d/.test(l))) bad.push(`steps: ${labels(ctx).join(', ')}`)
      if (r.openFindings.map(f => f.split(' ')[1]).join(',') !== 'nit,pre-existing,nit') bad.push(`openFindings ${JSON.stringify(r.openFindings)}`)
      if (r.rounds[0].review.verdict !== 'changes_requested') bad.push(`the reviewer's own word is lost: ${r.rounds[0].review.verdict}`)
      if (r.verifiedBy !== 'checks') bad.push(`verifiedBy ${r.verifiedBy}`)
      return bad
    },
  },
  // REVIEW.md is attached from the base commit even when the package changes it (an allowed check change).
  'review-md-from-base': {
    args: { allowCheckChanges: ['REVIEW.md'] },
    writes: { write: { 'src/app.mjs': APP.replace('hello', 'greetings'), 'REVIEW.md': NEW_REVIEW_MD } },
    expect: ({ ctx, result: r }) => {
      const bad = []
      const rv = ctx.reviews[0]
      const focus = rv && Object.entries(rv.attached).find(([p]) => p.endsWith('/REVIEW.base.md'))
      if (!focus) bad.push(`REVIEW.base.md was not attached: ${rv ? Object.keys(rv.attached).join(', ') : 'no review'}`)
      else if (focus[1] !== BASE_REVIEW_MD) bad.push(`the attached REVIEW.md is not the base one: ${JSON.stringify(focus[1])}`)
      if (rv && rv.showFrom !== ctx.base) bad.push(`REVIEW.md was read from ${rv.showFrom}, not the base ${ctx.base}`)
      if (rv && !/for every required attachment: \[[^\]]*REVIEW\.base\.md/.test(rv.prompt)) bad.push('REVIEW.base.md is not a required attachment')
      if (JSON.stringify(r.checkChanges) !== JSON.stringify(['REVIEW.md'])) bad.push(`checkChanges ${JSON.stringify(r.checkChanges)}`)
      if (!r.approved) bad.push(`not approved: ${r.stoppedAt}`)
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
