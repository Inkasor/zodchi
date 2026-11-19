One file per area (for example `flow-server.mjs`, `flow-claude.mjs`). Each file's default export receives the helpers
of `scripts/e2e.mjs` (`scenario`, `world`, `repo`, `zodchi`, `serve`, `flowWorld`, ...) and registers its scenarios
with `scenario(name, about, fn)`. Packages that run in parallel each add their own file.

`incident-triage.mjs` runs the real `core/workflows/incident-triage.js` over the synthetic cases of `scripts/e2e/fixtures/incident-triage/` with a fake agent (the evidence is collected for real from a made-up product, only the model answer is a saved file).
