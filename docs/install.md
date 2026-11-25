# Install and connect Zodchi

[Русский](install.ru.md) · [Project home](https://github.com/Inkasor/zodchi)

Send this request to your agent along with the repository link.

> Install and connect Zodchi on this computer. Follow the installation guide and verify the CLI and the plugins for the clients installed here.

The release includes the Rust CLI, workflow catalog, model roles and a shared plugin for Codex and Claude Code. Run the setup on the computer where you use those clients.

## Install a release

1. Download the executable and archive for your system from [the latest stable release](https://github.com/Inkasor/zodchi/releases/latest). Check the SHA-256 of both files against the digests shown by GitHub.

   | System | Executable | Archive |
   | --- | --- | --- |
   | Windows x64 | `zodchi-win32-x64.exe` | `zodchi-win32-x64.bundle.json.gz` |
   | Linux x64 | `zodchi-linux-x64` | `zodchi-linux-x64.bundle.json.gz` |
   | macOS Apple Silicon | `zodchi-darwin-arm64` | `zodchi-darwin-arm64.bundle.json.gz` |
   | macOS Intel | `zodchi-darwin-x64` | `zodchi-darwin-x64.bundle.json.gz` |

2. Run the downloaded executable with `release install`. Pass the archive's published digest without the `sha256:` prefix. Include the client names you want to connect. Omit `--clients` for CLI-only use.

   Run this in PowerShell on Windows.

   ```powershell
   $archiveSha256 = '<published archive SHA-256>'
   .\zodchi-win32-x64.exe release install --archive .\zodchi-win32-x64.bundle.json.gz --sha256 $archiveSha256 --clients 'codex,claude'
   ```

   For Linux x64, use these filenames.

   ```sh
   archive_sha256='<published archive SHA-256>'
   chmod +x ./zodchi-linux-x64
   ./zodchi-linux-x64 release install --archive ./zodchi-linux-x64.bundle.json.gz --sha256 "$archive_sha256" --clients codex,claude
   ```

   On macOS use the corresponding executable and archive names. For a source build or a system outside the table, see [Build from source](install-from-source.md).

3. Add the directory of the returned `launcher` to your user PATH. It defaults to `~/.zodchi/bin` and follows `ZODCHI_HOME` if set. Run `zodchi release current` and `zodchi flow list`. Configure provider sign-in and roles as needed. [Model roles](model-roles.md) · [Claude executor](flow-claude.md)

## Load the plugin in your client

- Claude Code can load it in the open chat with `/reload-plugins`. [Claude Code commands](https://code.claude.com/docs/en/commands)
- In Codex, start a new chat in the same project to load the plugin's skills. Restart the desktop app if its terminal still has its previous PATH. [Codex plugins](https://learn.chatgpt.com/docs/plugins)

Use `zodchi flow status <run-id>` from either client to inspect an existing run. Resume it with the same run ID. The journal is shared locally.

## Steps for an agent

1. Check the local OS, architecture, installed `codex` and `claude` commands and any existing Zodchi setup. For a working managed installation, verify the active build and use the [update procedure](flow.md#client-packages). Follow the install steps below for a fresh setup.
2. Read the latest release metadata and select the two assets named in the platform table. Download each `browser_download_url` from this repository and compare its bytes with the matching published `digest`. Run the executable after both checks pass. [Release metadata](https://api.github.com/repos/Inkasor/zodchi/releases/latest) · [GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
3. Execute `release install` with the verified archive digest and only the installed clients requested by the user. Add the reported launcher directory to the user's PATH and preserve the current PATH entries.
4. Verify the CLI with `zodchi release current` and `zodchi flow list`. Use the reported absolute launcher path if the current chat still has its startup environment. Confirm `zodchi@zodchi-local` with `codex plugin list --json` or `claude plugin list --json` for each connected client. Report the version, launcher path, connected clients and how to load the skills in the chat. Use the client's sign-in for any account step that needs the user.

## Startup build note

The shared plugin installs a `SessionStart` hook matching `startup`. It runs `zodchi release notes --hook` from PATH with a short timeout and provides a brief public build note. Client hook trust and approval follow the normal Codex or Claude Code settings. Run `zodchi release notes` for JSON, or `zodchi release current` for the selected build details.
