# Reclaim Zodchi disk space

Zodchi stores Flow data in `~/.zodchi` or the directory set by `ZODCHI_HOME`.

| Location | Contents |
| --- | --- |
| `flow-writers/<run>/` | Writer copies of the repository, including installed dependencies and build output |
| `flow-candidates/<run>/` | The isolated candidate checkout |
| `flows/<run>/` | Run inputs, events, results and evidence, with scratch files under `tmp/` |
| `packages/<repo-slug>/` | File claims and pending application receipts |
| `dev-builds/<commit>/` | Local development builds |
| System temporary directory | Check exports named `zodchi-flow-<run>-...` |

When a foreground or detached run has a finished event and a saved result with its claim closed, Zodchi removes its writer copies and check scratch, including `flows/<run>/tmp/`. Waiting runs keep their workspace so they can resume. The journal records the removed paths, their sizes and any cleanup errors in a `cleanup` event. Cleanup leaves the workflow result and exit code intact.

## Preview and apply

```sh
zodchi flow cleanup
zodchi flow cleanup --apply
zodchi flow cleanup --journals --retention-days 30
zodchi flow cleanup --claims --apply
```

The default preview prints JSON. Each entry in `items` gives a path, kind, `sizeBytes` and reason. The `kept` list shows protected entries larger than 100 MB and entries skipped because their worker is live. `totalBytes` describes the listed items. With `--apply`, successfully deleted or archived entries have `removed: true`. `bytesFreed` sums the sizes of deleted entries. Cleanup skips items for runs with live workers or active run locks and leaves link targets alone.

The command removes applied candidate checkouts and unapproved candidates that have been finished longer than the retention period. It keeps a candidate while an unfinished run names it as `sourceRun`. The Git refs under `refs/zodchi/candidates/` stay available. `--retention-days` takes an integer from 1 through 365 and defaults to 14 days.

DEV cleanup keeps the selected build in `dev-current.json`, the newest other build, builds used by live workers, and builds pinned by retained run journals. The installed launcher uses those pins for resume, status and apply.

## Journals and claims

Journals are eligible only with `--journals`, after the retention period has elapsed since the run finished. Every package claim and pending application reference protects its journal. An approved isolated package keeps its journal while it awaits application. An unfinished run also protects any journal it needs as `sourceRun` or as a child workflow. References in the default profile also protect journals in a custom `ZODCHI_HOME`. If cleanup cannot check or remove eligible external scratch for a run, it keeps the journal so a later cleanup can find the remaining scratch.

Leave journals in place and use the command to retire them. If an application was interrupted, `applications/pending.json` can still point to its run. Deleting its journal by hand can block `zodchi flow apply` for that repository with “No run … in …flows.”

`--claims` reports claims with missing journals, legacy claims without a run ID, and pending application receipts that refer to missing journals. With `--apply` it moves eligible records to `packages/.removed/<date>/` in the home that stores the record and reports their destination as `movedTo`. Archiving a record leaves its bytes on disk.

Runs with a custom `ZODCHI_HOME` can write claims and pending receipts to the default profile. New code-package runs register their journal home under `package-journal-homes/` in that profile. Run cleanup with the owning `ZODCHI_HOME` to archive shared records whose journal is missing and whose sole ownership marker matches. Shared records with a different or unconfirmed journal home appear in `kept` when their journal is absent from the selected home. Run cleanup from the default profile to archive legacy claims there that have no run ID.
