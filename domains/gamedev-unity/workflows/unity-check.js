export const meta = {
  name: 'unity-check',
  description: 'Run a written list of steps in the Unity Editor and bring back the readback and frames',
  whenToUse: 'Verifying import or scene code in the Editor from a step file. Args: { steps: path of the step file, tmp: folder for captures, note: what the owner released or forbade }.',
  phases: [
    { title: 'Editor', detail: 'runner executes the steps in the open Editor', model: 'haiku' },
  ],
}

const a = args || {}
if (!a.steps || !a.tmp) throw new Error('unity-check needs args.steps and args.tmp')
// The machine may lose power or the session may be cut. A finished agent() comes back from the journal when the run is
// resumed (resumeFromRunId); an unfinished one starts over, so every step keeps a progress file that the
// restarted agent reads first. step() is agent() with that rule added.
const progressFile = (o) => `${a.tmp}/progress/${String((o && (o.label || o.phase)) || 'step').replace(/[^\w.-]+/g, '-')}.md`
const step = (prompt, opts) => agent(prompt +
  `\n\nResume rule: this run may have been cut off and restarted. If ${progressFile(opts)} exists and its last line is not DONE, read it first and go on from its last line; ` +
  `if its last line is DONE, it is from an earlier finished run: rename it to .old and start fresh. ` +
  `do not redo finished work or overwrite its outputs blindly. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

// Which plugin copy ran. A workflow script cannot see its own file, so one cheap runner step runs the "plugin" command of the gate helper
// (core/scripts/gate.mjs), which the bootstrap below finds in the plugin copy the session loaded (never in a checkout), and the result names
// that copy. The bootstrap is the same text in every workflow that runs the helper (the e2e suite checks they are equal).
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const GATE_API = 1
const GATE_BOOT = 'const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\"),cp=require(\"child_process\");const [repo,...rest]=process.argv.slice(1);const out=(o,c)=>{fs.writeSync(1,JSON.stringify(o)+\"\\n\");process.exit(c)};const rd=f=>{try{return JSON.parse(fs.readFileSync(f,\"utf8\"))}catch(e){return null}};const eq=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();const tried=[];let root=\"\",via=\"\";const has=d=>{const ok=fs.existsSync(path.join(d,\"scripts\",\"gate.mjs\"));tried.push(d+(ok?\"\":\" (no scripts/gate.mjs)\"));return ok};for(const [name,env] of [[\"ZODCHI_PLUGIN_ROOT\",process.env.ZODCHI_PLUGIN_ROOT],[\"CLAUDE_PLUGIN_ROOT\",process.env.CLAUDE_PLUGIN_ROOT]]){if(!root&&env){const m=rd(path.join(env,\".claude-plugin\",\"plugin.json\"));if(m&&m.name===\"zodchi-core\"&&has(env)){root=env;via=name}}}if(!root){const reg=rd(path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),\".claude\"),\"plugins\",\"installed_plugins.json\"));const list=(reg&&reg.plugins&&reg.plugins[\"zodchi-core@zodchi\"])||[];for(const e of [...list.filter(e=>e.projectPath&&eq(e.projectPath,repo)),...list.filter(e=>!e.projectPath)]){if(e.installPath&&has(e.installPath)){root=e.installPath;via=\"installed_plugins.json, scope \"+e.scope;break}}}if(!root)out({ok:false,api:0,error:\"the registered zodchi-core plugin copy has no scripts/gate.mjs (not installed, or an older copy than this workflow): update the plugin; a checkout is never used instead\",tried},4);const r=cp.spawnSync(process.execPath,[path.join(root,\"scripts\",\"gate.mjs\"),...rest],{stdio:\"inherit\",env:{...process.env,ZODCHI_GATE_VIA:via}});process.exit(r.status===null?5:r.status)'
const helperRun = (command, spec) => `${a.pluginRoot ? `ZODCHI_PLUGIN_ROOT=${q(a.pluginRoot)} ` : ''}node -e ${q(GATE_BOOT)} -- ${q(a.repo || a.tmp)} ${command} ${q(JSON.stringify({ api: GATE_API, ...spec }))}`
const HELPER_ANSWER = { type: 'object', required: ['exitCode', 'stdout'], properties: { exitCode: { type: 'number' }, stdout: { type: 'string' }, error: { type: 'string' } } }
const HELPER_NEXT = 'Update the zodchi-core plugin (rerun the installer, then reload plugins in Claude Code) so that the copy this workflow runs from has scripts/gate.mjs, or pass args.pluginRoot, the folder of a zodchi-core copy that has it. Nothing was changed.'
// The helper's answer: the one JSON line of its stdout and the exit code the runner saw, both of which must say it worked.
function readHelper(r, what) {
  if (!r) return { error: `${what}: the runner returned no result` }
  const line = String(r.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  let facts = null
  try { facts = JSON.parse(line) } catch {}
  if (!facts || typeof facts !== 'object') return { error: `${what} printed no JSON line (exit ${r.exitCode}${r.error ? `: ${r.error}` : ''})` }
  if (r.exitCode !== 0 || facts.ok !== true) return { error: `${what}: ${facts.error || 'it reported a failure'} (exit ${r.exitCode})${Array.isArray(facts.tried) ? `; looked in ${JSON.stringify(facts.tried)}` : ''}` }
  if (facts.api !== GATE_API) return { error: `${what}: api ${facts.api}, this workflow needs ${GATE_API}` }
  if (!facts.plugin || !facts.plugin.root) return { error: `${what}: it did not name its plugin copy` }
  return { facts }
}

const copyRead = readHelper(await agent(
  `Run ONE command and return what it printed; change nothing and run nothing else. Run every command with bash (Git Bash on Windows, never PowerShell or cmd). In the foreground, once:
${helperRun('plugin', {})}
` +
  `Do not change, split or rerun it with other options. exitCode: its exit code, a number. stdout: everything it printed to standard output, exactly, as one string (it is one line of JSON): ` +
  `do not parse, summarize, reorder or shorten it. error: what it printed to standard error, at most 300 characters, "" when nothing. ` +
  `If the command could not be started at all, exitCode is -1 and stdout is "".`,
  { agentType: 'zodchi-core:runner', label: 'plugin copy', schema: HELPER_ANSWER }), 'the plugin copy helper')
if (copyRead.error) return { stoppedAt: `plugin copy (${copyRead.error})`, next: HELPER_NEXT }
const pluginCopy = { path: copyRead.facts.plugin.root, commit: copyRead.facts.plugin.commit || 'unknown', version: copyRead.facts.plugin.version || '', via: copyRead.facts.plugin.via || '' }

phase('Editor')
const checked = await step(
  `Unity Editor operations. Your steps and their expectations are the file ${a.steps}: read it first and run its steps in order, stopping at the first failed expectation. ` +
  `Captures and logs go to ${a.tmp}. A dirty scene or Play mode you did not start belongs to someone else: stop and report.${a.note ? ` The owner's note, in addition to that rule: ${a.note}` : ''} ` +
  `Before the first menu command: AssetDatabase.Refresh, wait for ready, and confirm the Console has no compile errors, so the Editor runs the current code.`,
  {
    agentType: 'zodchi-gamedev-unity:unity-runner',
    label: 'unity steps',
    schema: {
      type: 'object', required: ['ok', 'steps', 'editor'],
      properties: {
        ok: { type: 'boolean' },
        steps: { type: 'array', items: { type: 'string' } },
        differs: { type: 'array', items: { type: 'string' } },
        paths: { type: 'array', items: { type: 'string' } },
        editor: { type: 'string' },
      },
    },
  })
return { ...checked, pluginCopy }
