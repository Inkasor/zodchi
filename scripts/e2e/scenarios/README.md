One file per area (for example `flow-server.mjs`, `flow-claude.mjs`). Each file's default export receives the helpers
of `scripts/e2e.mjs` (`scenario`, `world`, `repo`, `zodchi`, `serve`, `flowWorld`, ...) and registers its scenarios
with `scenario(name, about, fn)`. Packages that run in parallel each add their own file.
