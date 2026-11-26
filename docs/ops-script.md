# ops-script

`zodchi flow ops-script --args args.json` checks a snapshot of a local operator-owned script and prints a command for the operator to run manually. Each static check has a 30-second limit. The snapshot copy runs with `--check` under a 60-second limit. `--detach`, `flow status <run-id>` and `flow ops-script --resume <run-id>` use the shared journal. Run from a non-root, non-elevated account. The script's check mode must itself avoid making changes and must not attempt privilege escalation.

The arguments are a JSON object:

```json
{
  "script": "/srv/ops/project/deploy.py",
  "tmp": "/srv/ops/ops-tmp",
  "files": ["/srv/ops/project/payload.json"],
  "check": ["python3", "{copy}", "--check"],
  "sudo": ["sudo", "python3", "{script}", "--apply"],
  "fixes": 0
}
```

`script`, `tmp` and every companion path must be absolute local paths; `files` may be omitted. `tmp` must already exist. Files must be distinct regular files with distinct base names. `files` may be one path or an array. The default check is `python3 {copy} --check` for Python files and `bash {copy} --check` otherwise. A check must contain exactly one standalone `{copy}` in the executable position, or immediately after `bash`, `python` or `python3`, immediately followed by `--check`; `--apply` is refused. The required `sudo` argv must begin with `sudo`, the same explicit interpreter as the check, and `{script}`, in that order; arguments may follow. The dry-run receipt records the resolved executable path, which is also used in the operator command. On Linux, direct `{copy}` requires a supported absolute interpreter shebang; PATH-dependent `env` shebangs require an explicit interpreter. Windows requires an explicit interpreter. A simple whitespace-separated string is accepted; use an array for literal arguments containing spaces or shell characters. Shell operators, interpolation, quoting and interpreter options such as `bash -c` are not accepted in the string form. The operator command is rendered as quoted shell arguments, never executed by the workflow.

Each attempt gets a fresh snapshot. The receipt records every copied file's SHA-256, file identity and change timestamp. Static checks cover the script and script companions recognized by suffix or supported shebang: `bash -n` and ShellCheck at warning severity when installed, or isolated Python `py_compile`; data companions are hashed. Supported shebangs name `bash` or `sh` in `/bin` or `/usr/bin`, an absolute executable named `python` or `python3`, or those interpreter names through `/usr/bin/env` or `/bin/env`. Shebang options, unsupported interpreters, and suffix conflicts are refused. Direct shebangs require LF line endings and an available executable. A direct Python shebang selects the same executable for compilation, the dry run and the human command, including after a resume; this permits a virtual environment interpreter. Python bytecode is outside the snapshot. The dry run uses the snapshot directory as its working directory and checks the files before and after execution. Output excerpts are bounded and sanitized. The printed Bash command checks the exact entry set, regular distinct files, and receipt's literal hashes again before the operator's command. Do not change the snapshot after checking it. `nopass` is accepted as a boolean, but the result remains a command for a human terminal.

A scoped code-package with independent review can run only for a script defect, with a claimable primary script inside `repo` and repair attempts remaining. `fixes` defaults to two. A static check (`bash -n`, `py_compile` or ShellCheck) qualifies if it exits nonzero or stops on a signal within the time limit. The dry run qualifies on a nonzero exit or a timeout. With attempts remaining, a qualifying static failure on an unselected companion goes to the owner. If repair attempts are exhausted, a script defect ends the run as `failed`.

An initial tool preflight failure is refused before a run is created. Python preflight imports `py_compile` in isolated mode. During a run, snapshot errors, missing or broken tools, static timeouts and other effect errors end the run with `ready: false` and `status: "failed"`. The result records the step and its sanitized diagnostic. This includes a missing interpreter in the static receipt, a process that failed to initialize, and process output that did not close. On Linux, a loader failure to load a direct or transitive shared-library dependency of the check executable is a startup failure. A dry run stopped by a signal before its timeout also ends the run as `failed`. These failures make no model call. Resume applies the same rule to recorded failures and reuses any repair already recorded for the attempt.

Companions stay local by default, including configuration files with script suffixes. To allow repair of a companion, explicitly list its absolute path in `repairFiles`, an array of distinct paths already named in `files`. Select only source code safe to send. Selected companions must be inside `repo` and have a `.py`, `.sh` or `.bash` suffix, or no suffix and a supported shebang. All companions remain in the snapshot. The child claims the primary script and any selected companions. When unselected companions are present, check output, errors and static check labels also stay in the local receipt, since they might expose local data or names. Every claimed file must be readable text and is screened using the current private-word and credential checks. `models.expertWriter` and `models.reviewer` supply its role overrides, and the legacy `writer` selects a Claude writer model. Do not supply both `writer` and `models.expertWriter`. The child run ID is journaled before its gate. A cut before the child journal exists is unresolved, since the gate may already have started a model preflight. The workflow leaves recovery to the owner. If the files cannot be claimed or the package gate refuses, the journal requests an owner handoff. Edit only the named originals, record a response with `zodchi flow reply <run-id> --file <text-file>`, and resume. An approved repair or owner response starts a fresh snapshot. A child that needs attention is reported with its run ID.

If the journal records the start of a `snapshot N`, `static N` or `dry N` effect but the run is interrupted before its result is recorded, the run is `unresolved`. Inspect the interrupted effect and start a new run after resolving it. Resume reuses completed snapshots and checks.

Remote mode is not yet implemented: any `remote` argument is explicitly refused before filesystem validation or a remote action. The local process guard checks the current privilege level; on Linux it also sets `no_new_privs` and uses a worker-bound watcher to terminate the process group, and on Windows it contains each process tree in a job. Other Unix platforms are refused because this implementation cannot enforce their privilege boundary. The check is not a filesystem or network sandbox for arbitrary scripts. Review the script's check mode before running it. Resume or status of a finished local run refuses a changed snapshot.

QA commands from the checkout:

```text
cargo test -p zodchi-flow --locked --manifest-path rust/Cargo.toml
node scripts/e2e.mjs flow-ops-script flow-ops-script-refusal flow-ops-script-resume flow-ops-script-recovery flow-ops-script-scoped-repair flow-ops-script-no-repair-on-tools
node scripts/e2e.mjs flow-project-domains
```
