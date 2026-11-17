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
  `do not redo finished work or overwrite its outputs blindly, and for a gateway call it records as submitted, wait on that key (zodchi wait --key <key>) instead of submitting again. ` +
  `After each finished step append one line to it (create the folder if needed): what is done, the paths it produced, what comes next. When your whole task is finished, append a last line DONE.`, opts)

phase('Editor')
return await step(
  `Unity Editor operations. Your steps and their expectations are the file ${a.steps}: read it first and run its steps in order, stopping at the first failed expectation. ` +
  `Captures and logs go to ${a.tmp}. ${a.note || 'A dirty scene or Play mode you did not start belongs to someone else: stop and report.'} ` +
  `Before the first menu command: AssetDatabase.Refresh, wait for ready, and confirm the Console has no compile errors, so the Editor runs the current code.`,
  {
    agentType: 'unity-runner',
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
