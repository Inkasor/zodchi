#!/usr/bin/env node
// Runs the incident-triage workflow over the synthetic cases in ./cases with a fake agent, and prints the verdict of
// each case. Exit code 0 only when every case meets its expectations.
//
//   node core/workflows/fixtures/incident-triage/mock.mjs [case ...]
//
// The fake agent does what each runner step's prompt asks, for real, in a temporary incident folder: it takes the
// lock, writes the exact files the workflow hands over (checking their SHA-256, which also checks the workflow's own
// SHA-256), runs the generated collector with node (so Facts runs the synthetic product of ./product.mjs for real) and
// publishes the draft. Only the model is faked: the classifier's answer is the case's classification.json, returned
// as the gateway would (a Codex candidate) or as a Claude subagent would (when the case's role table has only Claude).
// Each case folder holds case.json: { about, report, params, models?, adapterFrom?, twinReport?, expect }.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW = path.resolve(HERE, '..', '..', 'incident-triage.js')
const slash = (p) => p.replace(/\\/g, '/')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// The workflow body runs as the Workflow tool runs it: an async function of args, agent, phase and log.
const source = fs.readFileSync(WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const runWorkflow = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'pipeline', 'budget', source)

const CODEX_TABLE = { roles: { architect: { candidates: [{ provider: 'codex', model: 'mock-architect', effort: 'high' }, { provider: 'claude', model: 'fable', effort: 'high' }] } } }
const ACCOUNT = { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } }

// The exact-file blocks of a prompt, in order.
function blocks(prompt) {
  const re = /<<<FILE path=("(?:[^"\\]|\\.)*") sha256=([0-9a-f]{64})>>>\n([\s\S]*?)<<<END FILE>>>/g
  return [...prompt.matchAll(re)].map(m => ({ path: JSON.parse(m[1]), sha: m[2], text: m[3] }))
}
function writeBlocks(prompt) {
  const wrote = []
  const replace = new Set()
  // "(replace)" follows the quoted path in the list of files of each group.
  for (const m of prompt.matchAll(/("(?:[^"\\]|\\.)*") \(replace\)/g)) replace.add(JSON.parse(m[1]))
  for (const b of blocks(prompt)) {
    const got = sha(Buffer.from(b.text, 'utf8'))
    if (got !== b.sha) throw new Error(`the workflow's sha256 of ${b.path} is ${b.sha}, node says ${got}`)
    fs.mkdirSync(path.dirname(b.path), { recursive: true })
    if (!replace.has(b.path) && fs.existsSync(b.path)) throw new Error(`${b.path} exists and is not marked replace: a revision is never overwritten`)
    fs.writeFileSync(b.path + '.tmp', b.text)
    fs.renameSync(b.path + '.tmp', b.path)
    wrote.push({ path: b.path, sha256: got })
  }
  return wrote
}

function fakeAgent(ctx) {
  return async (prompt, opts = {}) => {
    const label = opts.label || ''
    ctx.prompts.push({ label, prompt, opts })
    const { tmp } = ctx
    if (label.startsWith('open ')) {
      let locked = true
      try { fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(`${tmp}/.lock`) } catch { locked = false }
      if (!locked) return { ok: false, locked: false, incident: '', revs: [], adapter: '', adapterSha256: '', homeModels: '', repoModels: '', account: '' }
      const adapter = fs.readFileSync(ctx.adapter)
      return {
        ok: true, locked: true,
        incident: fs.existsSync(`${tmp}/incident.json`) ? fs.readFileSync(`${tmp}/incident.json`, 'utf8') : '',
        revs: fs.readdirSync(tmp).filter(n => /^rev-\d+$/.test(n)),
        adapter: adapter.toString('utf8'), adapterSha256: `${sha(adapter)}  ${ctx.adapter}`,
        homeModels: JSON.stringify(CODEX_TABLE), repoModels: '', account: JSON.stringify(ACCOUNT), ignoreExit: 0,
      }
    }
    if (label.startsWith('collect ')) {
      const collector = blocks(prompt).find(b => b.path.endsWith('/collect.cjs'))
      const revDir = path.dirname(collector.path)
      fs.mkdirSync(revDir) // not recursive: the revision folder must be new
      const wrote = writeBlocks(prompt)
      ctx.collector = collector.text
      let summary = '', exitCode = 0, error = ''
      try { summary = execFileSync(process.execPath, [collector.path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch (e) { exitCode = e.status ?? 1; error = String(e.stderr || e.message).slice(-2000) }
      const ev = `${revDir}/evidence.json`
      return { ok: exitCode === 0, summary, evidenceSha256: fs.existsSync(ev) ? sha(fs.readFileSync(ev)) : '', exitCode, error, wrote }
    }
    if (label.startsWith('classify ')) {
      if (ctx.failClassify) return { ok: false, answer: '', answerSha256: '', infra: 'the gateway created no job (mock)' }
      const text = fs.readFileSync(path.join(ctx.caseDir, 'classification.json'), 'utf8')
      if (opts.schema && opts.schema.properties && opts.schema.properties.answer) {
        // The gateway path: the runner returns the file the gateway wrote with --out.
        const outFile = prompt.match(/--out '([^']+)'/)[1]
        fs.writeFileSync(outFile, text)
        ctx.classifier = 'codex/' + (prompt.match(/--model (\S+)/) || [])[1]
        return { ok: true, answer: text, answerSha256: sha(Buffer.from(text, 'utf8')), infra: '' }
      }
      ctx.classifier = `claude/${opts.model}`
      return JSON.parse(text)
    }
    if (label.startsWith('publish ') || label.startsWith('unlock ')) {
      const wrote = writeBlocks(prompt)
      if (label.startsWith('unlock ')) { try { fs.rmdirSync(`${tmp}/.lock`) } catch { return { ok: false, summary: 'no lock', wrote } } }
      return { ok: true, summary: 'written', wrote }
    }
    throw new Error(`the fake agent has no answer for the step "${label}"`)
  }
}

async function runCase(name, overrides = {}) {
  const caseDir = path.join(HERE, 'cases', name)
  const c = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'))
  const adapter = slash(path.join(HERE, 'cases', c.adapterFrom || name, 'adapter.json'))
  const tmp = overrides.tmp || slash(fs.mkdtempSync(path.join(os.tmpdir(), `incident-triage-${name}-`)))
  const ctx = { tmp, adapter, caseDir, prompts: [], failClassify: Boolean(overrides.failClassify) }
  const args = { incident: `case-${name}`, tmp, adapter, report: overrides.report ?? c.report, params: c.params, repo: tmp, ...(c.models ? { models: c.models } : {}) }
  const logs = []
  const result = await runWorkflow(args, fakeAgent(ctx), () => {}, (m) => logs.push(m), null, null, { total: null })
  return { c, ctx, result, tmp, logs }
}

const readIf = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''

// The expectations of one case; returns the list of problems.
function verify(name, run) {
  const { c, ctx, result: r, tmp } = run
  const e = c.expect || {}
  const bad = []
  const rev = `${tmp}/rev-${r.revision}`
  const draft = readIf(`${rev}/draft.md`)
  const evidenceText = readIf(`${rev}/evidence.json`)
  const evidence = evidenceText ? JSON.parse(evidenceText) : { items: [] }
  const cls = readIf(`${rev}/classification.json`) ? JSON.parse(readIf(`${rev}/classification.json`)) : null
  const item = (id) => evidence.items.find(i => i.id === id) || {}
  if (fs.existsSync(`${tmp}/.lock`)) bad.push('the lock was left behind')
  if (e.noRevision) {
    if (fs.readdirSync(tmp).some(n => /^rev-/.test(n))) bad.push('a revision folder was made although the adapter was refused')
    if (ctx.prompts.some(p => /^collect /.test(p.label))) bad.push('the collector ran although the adapter was refused')
  }
  if (e.state && r.state !== e.state) bad.push(`state ${r.state}, expected ${e.state}`)
  if (e.route && r.route !== e.route) bad.push(`route ${r.route}, expected ${e.route}`)
  if (e.kinds && JSON.stringify(r.kinds) !== JSON.stringify(e.kinds)) bad.push(`kinds ${JSON.stringify(r.kinds)}, expected ${JSON.stringify(e.kinds)}`)
  if (e.classifier && ctx.classifier !== e.classifier) bad.push(`classifier ${ctx.classifier}, expected ${e.classifier}`)
  for (const [id, want] of Object.entries(e.outcomes || {})) if (item(id).outcome !== want) bad.push(`${id} (${item(id).source}) ended ${item(id).outcome}, expected ${want}`)
  for (const [id, want] of Object.entries(e.reasonIncludes || {})) if (!String(item(id).reason || '').includes(want)) bad.push(`${id}: reason ${JSON.stringify(item(id).reason)} lacks ${JSON.stringify(want)}`)
  for (const s of e.refusedIncludes || []) if (!(r.refused || []).some(x => x.includes(s))) bad.push(`refused lacks ${JSON.stringify(s)}: ${JSON.stringify(r.refused)}`)
  for (const s of e.notesInclude || []) if (!(r.notes || []).some(x => x.includes(s))) bad.push(`notes lack ${JSON.stringify(s)}: ${JSON.stringify(r.notes)}`)
  for (const s of e.draftIncludes || []) if (!draft.includes(s)) bad.push(`the draft lacks ${JSON.stringify(s)}`)
  for (const s of e.evidenceExcludes || []) if (evidenceText.includes(s)) bad.push(`the evidence bundle holds ${JSON.stringify(s)} (not redacted)`)
  for (const id of e.gapFor || []) if (!cls || !(cls.gaps || []).some(g => g.evidence.includes(id))) bad.push(`no gap covers the item ${id}`)
  if (e.draftExcludesAccess && /\b(grant|give|request|ask for)\b[^.\n]{0,40}\baccess\b|\bno access\b/i.test(draft)) bad.push('the draft asks for access')
  if (e.citesBothSources) {
    const f = cls && cls.findings && cls.findings[0]
    const src = f ? f.evidence.map(id => item(id).source) : []
    if (!src.includes('agentSkill') || !src.some(s => String(s).startsWith('allowList:'))) bad.push(`the main finding does not cite both the agent skill and an allow-list: ${JSON.stringify(src)}`)
  }
  // Every case that classified: the report reached the classifier only as untrusted evidence, never in the prompt.
  const promptText = readIf(`${rev}/classify-prompt.md`) + readIf(`${rev}/classifier/incident-classify.md`)
  if (promptText) {
    if (promptText.includes(c.report)) bad.push('the report text is in the classifier prompt')
    if (!evidence.items.some(i => i.source === 'report' && i.untrusted === true)) bad.push('the report is not an untrusted evidence item')
    if (!evidence.items.every(i => i.untrusted === true)) bad.push('an evidence item is not marked untrusted')
  }
  for (const s of e.promptExcludes || []) if (promptText.includes(s)) bad.push(`the classifier prompt holds ${JSON.stringify(s)}`)
  if (r.state && r.state !== 'failed' && !r.refused) {
    const inc = JSON.parse(readIf(`${tmp}/incident.json`) || '{}')
    if (inc.revision !== r.revision || inc.state !== r.state) bad.push(`incident.json says revision ${inc.revision} ${inc.state}, the run ${r.revision} ${r.state}`)
    if (readIf(`${rev}/adapterHash`).trim() !== sha(fs.readFileSync(run.ctx.adapter))) bad.push('rev adapterHash differs from the adapter file')
  }
  return bad
}

// The injection case is run a second time with a plain report: the prompt, the plan and the verdict must not differ.
async function twin(name, run) {
  const bad = []
  const plain = await runCase(name, { report: run.c.twinReport })
  const plan = (text) => { const p = JSON.parse(text.match(/const PLAN = ([\s\S]*?)\n\n/)[1]); delete p.revDir; p.items[0].text = '<report>'; return JSON.stringify(p) }
  const prompt = (r) => readIf(`${r.tmp}/rev-${r.result.revision}/classify-prompt.md`)
  if (prompt(run) !== prompt(plain)) bad.push('the classifier prompt differs between the injected and the plain report')
  if (plan(run.ctx.collector) !== plan(plain.ctx.collector)) bad.push('the collector plan differs between the injected and the plain report')
  for (const k of ['state', 'route']) if (run.result[k] !== plain.result[k]) bad.push(`${k} differs: ${run.result[k]} with the injection, ${plain.result[k]} without`)
  if (JSON.stringify(run.result.kinds) !== JSON.stringify(plain.result.kinds)) bad.push('the kinds differ')
  fs.rmSync(plain.tmp, { recursive: true, force: true })
  return bad
}

// Revisions: a second run in the same folder makes rev-2 and leaves rev-1 as it was; a held lock refuses a run.
async function revisions() {
  const bad = []
  const first = await runCase('stale')
  const before = Object.fromEntries(['evidence.json', 'classification.json', 'draft.md', 'adapterHash'].map(f => [f, sha(fs.readFileSync(`${first.tmp}/rev-1/${f}`))]))
  const second = await runCase('stale', { tmp: first.tmp })
  if (second.result.revision !== 2) bad.push(`the second run got revision ${second.result.revision}, expected 2`)
  for (const [f, h] of Object.entries(before)) if (sha(fs.readFileSync(`${first.tmp}/rev-1/${f}`)) !== h) bad.push(`rev-1/${f} changed`)
  const inc = JSON.parse(fs.readFileSync(`${first.tmp}/incident.json`, 'utf8'))
  if (inc.revision !== 2 || inc.revisions.length !== 2 || inc.revisions.some(x => x.state !== 'drafted')) bad.push(`incident.json: ${JSON.stringify(inc)}`)
  fs.mkdirSync(`${first.tmp}/.lock`)
  const third = await runCase('stale', { tmp: first.tmp })
  if (!third.result.refused || !/locked/.test(third.result.refused[0])) bad.push(`a held lock did not refuse the run: ${JSON.stringify(third.result)}`)
  if (fs.existsSync(`${first.tmp}/rev-3`)) bad.push('a locked run made rev-3')
  fs.rmSync(first.tmp, { recursive: true, force: true })
  return bad
}

// An infrastructure failure at Classify: the revision is marked failed, nothing is drafted, the lock is released.
async function infra() {
  const bad = []
  const run = await runCase('stale', { failClassify: true })
  const r = run.result
  if (r.state !== 'failed' || !/^classify/.test(r.stoppedAt || '')) bad.push(`state ${r.state}, stoppedAt ${r.stoppedAt}`)
  const inc = JSON.parse(readIf(`${run.tmp}/incident.json`) || '{}')
  if (inc.state !== 'failed' || inc.revision !== 1) bad.push(`incident.json: ${JSON.stringify(inc)}`)
  if (fs.existsSync(`${run.tmp}/rev-1/draft.md`)) bad.push('a draft was written')
  if (fs.existsSync(`${run.tmp}/.lock`)) bad.push('the lock was left behind')
  fs.rmSync(run.tmp, { recursive: true, force: true })
  return bad
}

const wanted = process.argv.slice(2)
const names = fs.readdirSync(path.join(HERE, 'cases')).filter(n => fs.existsSync(path.join(HERE, 'cases', n, 'case.json'))).filter(n => !wanted.length || wanted.includes(n))
let failed = 0
for (const name of names) {
  let bad, run
  try {
    run = await runCase(name)
    bad = verify(name, run)
    if (run.c.twinReport) bad.push(...await twin(name, run))
  } catch (e) { bad = [`threw: ${e.stack || e.message}`] }
  const r = run ? run.result : {}
  const verdict = r.refused && !r.route ? `refused (${r.refused.length})` : `state=${r.state} route=${r.route || '-'} kinds=${(r.kinds || []).join(',') || '-'}`
  if (bad.length) { failed++; console.log(`FAIL ${name}: ${verdict}\n  - ${bad.join('\n  - ')}${run ? `\n  folder kept: ${run.tmp}` : ''}`) }
  else { console.log(`PASS ${name}: ${verdict}`); fs.rmSync(run.tmp, { recursive: true, force: true }) }
}
if (!wanted.length) {
  let bad
  try { bad = await revisions() } catch (e) { bad = [`threw: ${e.stack || e.message}`] }
  if (bad.length) { failed++; console.log(`FAIL revisions:\n  - ${bad.join('\n  - ')}`) } else console.log('PASS revisions: a second run makes rev-2 and keeps rev-1; a held lock refuses a run')
  try { bad = await infra() } catch (e) { bad = [`threw: ${e.stack || e.message}`] }
  if (bad.length) { failed++; console.log(`FAIL infra:\n  - ${bad.join('\n  - ')}`) } else console.log('PASS infra: a gateway failure marks the revision failed, drafts nothing and releases the lock')
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
