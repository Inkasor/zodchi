# Video in Rust Flow

Run one short or long video from a local directory. The directory can be outside Git. Use the project's media index to select inputs and write the scenario variants. Each variant names its scenario file, its edit and the local commands that produce its probe and final MP4.

```text
zodchi flow video --args <file.json> --detach
zodchi flow status <run-id>
zodchi flow reply <run-id> --file <decision.json>
zodchi flow video --resume <run-id> --detach
```

The run stays in the shared Zodchi journal. The same ID works from any working directory or chat. A foreground command exits 2 when it reaches a decision. Inspect `video.decision` in status for the current question's options and preview paths. A reply records a decision, and resume advances it.

## Inputs and the three decisions

- `dir` is the absolute directory of this video. Supply a lower-case `id`, `format` (`short` or `long`), `title`, and paths to `ffmpeg` and `ffprobe`. Specify `brief` as a text file.
- In `variants` give each variant an `id`, a `scenario` text file with the proposed opening, an `edit` in the [manifest format](video-manifest.md#manifest-format-version-1), and `probe` and `final` tool specs. The edit uses the six editable fields from `proposed` through `claims`; an existing version-one draft can supply them. List the composition and other files used by the renderer in `inputs`. Paths can be relative to `dir` or absolute.
- A tool spec has `program`, an explicit `args` array with one `{out}` argument, and optional `timeoutSeconds`. The program runs hidden on Windows with the video directory as its working directory. Flow substitutes the allocated MP4 path for `{out}`. Set `probeExpect` or `expect` with any of `width`, `height` and `seconds` to check the measured export against the brief. Duration tolerance is 50 ms.
- The first reply chooses a scenario. The next two replies confirm the probe and final MP4. Show the owner the artifact from status and relay their words with the exact render ID and SHA-256. Render verification measures the media with ffprobe, fully decodes it with FFmpeg and hashes it before recording it as built.

```json
{"decision":"choose","variant":"opening-a","ownerWords":"Try the first opening."}
```

```json
{"decision":"accept","render":"r2","sha256":"<digest from the pending decision>","ownerWords":"I approve this cut."}
```

Use `"decision":"reject"` to finish with changes requested. For a render reply, include the displayed render and digest. Completed files, tool receipts and expert answers are reused on resume. If a renderer has no completion receipt, inspect the output and explicitly retry the stopped step with `--rerun probe` or `--rerun final`. The retry gets a new render path.

For an existing export, supply `adopt` with `file`, `edit` and optional `expect` in place of `brief` and `variants`. Flow copies and verifies the exact MP4, then waits at the final-file decision. The original export and any earlier decisions remain in their source location.

## Experts

Optional `experts` entries select `stage` (`script`, `probe` or `final`), a text expert `role`, `provider` (`codex` or `claude`), `model`, `effort` and a `prompt` file. Use `attach` for text files, `images` for prepared PNG/JPEG/WebP assets and `frames` for timestamps in the current verified probe or final MP4. Up to eight images can be sent in one call. Every successful expert answer and its attachments are linked in the journal. An unavailable expert waits for a choice such as `{"decision":"skip","ownerWords":"Continue with the prepared scenarios."}`. To try a different pick or explicitly retry, use `"decision":"replace"` and provide `provider`, `model` and `effort`.

The same Claude route is available from the ordinary local gateway. It uses the local Claude Code subscription. Set `"claudeExperts": true` in `~/.zodchi/flow.json` to enable these calls. The [existing Claude opt-in](flow-claude.md#enabling-it) also enables this route.

```text
zodchi submit --context "<video-directory>" --key opening-review --role text --provider claude --model claude-fable-5-2 --effort high --prompt "<prompt>" --image "<frame>"
zodchi wait --context "<video-directory>" --key opening-review --out "<answer>"
```

Use `--root` for the usual Git gateway directory. The explicit `--context` stores non-Git expert jobs under the Zodchi home. Both routes use the same idempotency key and ephemeral execution contract.

## Research receipts and publication statistics

```text
zodchi flow video research --args <research.json>
zodchi flow video publish <run-id> --file <publication.json>
zodchi flow video stats <run-id> --file <sample.json>
```

Research inputs name an existing capture `dir`. By default, the collector's `youtube-search.json` and `youtube-watch.json` are read there. Supply `search` and `watch` to reference existing files elsewhere, or a `collector` tool spec whose `{out}` argument is the capture directory. Both default files are saved by the project's collector. Already saved captures are reused. Optional `supplements` point to follow-up files containing `queries` and `watch` arrays. The resulting report keeps the source digests, actual queries, failed queries, confirmed counts and pending video IDs. Supply a `reviews` array or JSON file and advance coverage by providing `id`, `basis` (`storyboard`, `video` or `video-and-audio`) and an `evidence` file. Set the video's `research` argument to the resulting report.

Record a publication after the owner approves the final file and publishes it. The publication JSON supplies `render`, `sha256`, `publicationId`, UTC `publishedAt` and `ownerWords`. This command records what happened in the video service.

For a private API upload of an accepted MP4, use [`youtube-publish`](youtube-publish.md). Its own run ID tracks
the authorized channel, upload progress and verified private receipt.

A statistics file supplies `publicationId`, UTC `capturedAt` and `views`, plus `stayedToWatchPercent` and ordered `retention` points with `second` and `percent` when available. The report computes the actual elapsed age and compares views with `viewTarget` (10,000 by default). Supply earlier run IDs in `priorRuns` when starting a new video to freeze their evidence for its brief. Later snapshots use the nearest sample within `comparisonWindowSeconds` (one hour by default) and show the actual age difference.
