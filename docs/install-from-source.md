# Build from source

[Русский](install-from-source.ru.md) · [Home](../README.md)

Install [Rust](https://rustup.rs), clone the repository and open its root. For a published build, see [Client packages](flow.md#client-packages).

```sh
git clone https://github.com/Inkasor/zodchi.git
cd zodchi
./install/install.sh --out ../zodchi-bundle
```

On Windows, run this from the root in PowerShell.

```powershell
.\install\install.ps1 -Out ..\zodchi-bundle
```

The output directory contains the CLI, model roles, workflow catalog and both client manifests. Add its `bin` to your PATH and run `zodchi --version` and `zodchi flow list`.

To register the shared plugin in your installed clients, run `zodchi release register --clients codex,claude` using that bundle's executable. You can name just one client. Restart your client to load the plugin.

For Codex model roles, sign in to [Codex CLI](https://learn.chatgpt.com/docs). To enable Claude model roles, follow [Claude executor configuration](flow-claude.md). Manage project domains through [the workflow catalog](flow.md#running-it) and choose models in [the role table](model-roles.md).

A source build stays at the revision you built. Create a new output directory when you build another revision. Managed stable updates use the [release installer](flow.md#client-packages).

## Local DEV builds

Use the same `zodchi` command in Codex, Claude Code and your shell. The launcher selects your latest activated DEV bundle for new tasks. Each DEV run records its Git revision and resumes from that bundle.

On Windows, commit the revision and run `.\install\dev.ps1 -RegisterClients` to build, verify and select it and register its shared plugin. On later builds, `.\install\dev.ps1` updates the executable selection. Add `-RegisterClients` when the client instructions change.

You can also build an archive with `zodchi release build --out <new-directory> --archive`, then activate it with `zodchi release dev --archive <file> --sha256 <digest>`. Use the checked-out revision's executable for these commands. The launcher is in the Zodchi home's `bin` directory. `zodchi release current` shows the selected CLI, Git revision and journal home.
