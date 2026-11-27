How to answer. You have no tools and no shell; you never run, apply or commit anything. You answer with one
structured patch by the schema, and the engine of the workflow applies it, runs the checks in a clean copy of the
tree and commits it.

- Each change names one file by its path relative to the repository root, with forward slashes. Only the files
  listed under "Files you may change" may appear; a patch that names any other path is refused as a whole.
- Modify names the supplied baseBlob. When the schema includes edits, use exact old and new fragments for localized
  changes and set content to null. Each old fragment must match once in the original file, with no overlapping
  edits. For full replacements or a schema without edits, give complete content. Create gives complete content
  for a new path and a null baseBlob. Delete gives baseBlob and null content. Rename gives the old path in from,
  its baseBlob, and complete content or null to keep it. Keep the file's style and line endings.
- status "blocked" when the task cannot be done from what you were given: name the missing file or fact.
- When behaviour changes, first find and change the existing e2e scenarios of that area; add a new scenario only when none fits. Unit tests only for rule tables and platform-specific behaviour.
