# Workspace audit

The native workflow inventories an explicitly named directory. It records hashes without copying source contents to the journal. The report lists files, directory fingerprints, Git checkout state and unreadable items. Git checkouts and links are available for inspection.

```text
zodchi flow workspace-audit --args /absolute/path/audit.json --detach
zodchi flow status <run-id>
zodchi flow reply <run-id> --file /absolute/path/decision.json
zodchi flow workspace-audit --resume <run-id>
```

Supply an absolute `root`. For a verified archive copy, also name an absolute `archive` path in an existing directory outside the audited root and Git checkouts. That archive path must be new. The workflow waits at the inventory until the owner replies with `{"inventorySha256":"<digest>","copy":["exact-name.txt"]}`. Eligible items are regular top-level files identified as archivable in the report.

The archive contains a copy and the workflow returns its hash. The workflow verifies the source against the inventory before copying and verifies the output after writing. Changed sources are skipped. The native archive step preserves the originals. Use the workspace-audit skill for an owner-authorized removal, including the in-use and duplicate-copy checks.
