# Video manifest

Each video has one directory with a `manifest.json`. Edit the draft, then allocate a render. Give its `absolutePath` to the renderer. Once the helper records the result, that render is final. Each later probe or build gets its own path, including after acceptance or publication.

For an accepted or published video, find the render whose `id` equals `chosen`. Read its `edit` for the cuts, texts, attribution, costs and claims that go with its file. The current draft can already describe a different cut.

## Working with a manifest

Use [the video workflow](flow-video.md) to allocate renders, record verification and apply owner decisions. The manifest is a file record for render identification and reuse. The test suite checks that version 1 files remain readable by the [original reader](../scripts/e2e/fixtures/video-manifest-v1.mjs).

## Owner decisions and defaults

Initialization sets `status` to `draft`, `chosen` and `publication` to null, and the delivery limit to 20971520 bytes (20 MiB) for either format. The optional `title` string defaults to empty when omitted. The optional render `note` string also defaults to empty. `verifyFiles` is an optional boolean. It defaults to false. File verification is opt-in.

The trusted caller is the lead or a later workflow. The caller must obtain the owner's decision and actual nonblank words of 1–2000 characters for each transition. The caller must set `ownerConfirmed: true`. The helper records that confirmation. It relies on the trusted caller for the owner's decision and identity. It does not authenticate the owner. Without confirmation it refuses the transition without changing the manifest bytes. An agent cannot decide acceptance or publication on its own.

Acceptance requires a ready draft and a ready built render with purpose `build`. The render's frozen edit must match the draft. Its file must match its stored bytes. An accepted call rejects `publicationId` and `snapshotAt`. After the owner publishes in the video service, the caller records publication with a separate confirmed `video-set-status` call. Set `status: "published"` and pass the accepted `chosen` render's ID as `render`. Set `ownerWords` to the owner's publication words. Provide a nonblank `publicationId` and a UTC `snapshotAt`. The helper rechecks the chosen file's bytes and uses the chosen edit even if the draft has moved on. Acceptance and publication each occur once.

## Manifest format, version 1

The helper writes UTF-8 JSON with two-space indentation and one final newline. On initialization, the top-level fields are ordered `version, id, format, status, proposed, deliveryLimitBytes, sources, segments, audio, costs, claims, renders, chosen, publication, history`. Rewrites preserve the loaded manifest's top-level key order with the same JSON formatting. They do not canonically sort keys. Unknown fields anywhere are errors. Times use UTC in `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.sssZ` form.

Hand-edit only `proposed`, `deliveryLimitBytes`, `sources`, `segments`, `audio`, `costs` and `claims`. The helper owns all other fields. The video id matches `^[a-z0-9][a-z0-9._-]{0,47}$`, and format is `long` or `short`. The draft starts with empty lists apart from its initialization history. The delivery limit is a positive integer. Exceeding it sets the informational `overDeliveryLimit` flag.

| Editable record | Fields and meaning |
| --- | --- |
| `proposed` | Strings `title, description, prompt, voiceText` default to empty. Keep the exact prompt and the spoken text separately. The export path lives on the render. |
| `sources[]` | `id, kind, path, sha256, note`. Kind is `screen`, `voice`, `music`, `image` or `other`. Give a nonempty relative or absolute path, a nullable digest and a string note. A source check only tests existence. |
| `segments[]` | `id, source, in, out, speed, speedMarked, reason, evidence, model, effort`. Reference a source id. Seconds are finite with `0 <= in < out`. Speed is positive, with 1 for real time. The boolean mark records an on-screen label. Give the reason for the cut and what the viewer can see. Model and effort name what appears in frame and may be empty strings. |
| `audio[]` | `id, role, origin, source, license, attribution, licenseChecked`. Role is `voice`, `music` or `effect`. Origin is `recorded`, `synthetic`, `licensed` or `own`. Source is an id or null. Licence and credit are strings, and the check is boolean. |
| `costs[]` | `id, label, scope, basis, amount, currency, rubPerUsd, note`. Separate figures shown `in-frame` from `production` spending. Basis is `api-equivalent`, `subscription-estimate` or `measured`. Amount is finite and nonnegative. Currency is `RUB` or `USD`, the conversion rate is null or positive, and label and note are strings. |
| `claims[]` | `id, text, kind, segment, confirmation, note`. Reference a segment id or null. A `reported` claim has empty confirmation. A `confirmed` claim names the supporting artifact in a nonempty confirmation string. Text and note are strings. |

Item ids in these lists match `^[a-z0-9][a-z0-9_-]{0,31}$` and are unique within each list. On allocation, the helper copies `{proposed, sources, segments, audio, costs, claims}` in that order to `edit`. References resolve within that copy. Its `editSha256` hashes the UTF-8 compact `JSON.stringify` of the record. The delivery limit stays with the video.

Each render stores `id, path, purpose, state, createdAt, doneAt, bytes, sha256, note, edit, editSha256`. The id is `r` followed by a positive decimal number without a leading zero. Its path is exactly `renders/<id>/<id>.<ext>` with forward slashes. The helper records creation time at allocation and completion time for either final outcome.

| Render state | doneAt | bytes | sha256 |
| --- | --- | --- | --- |
| allocated | null | null | null |
| built | UTC time | positive integer | file digest |
| failed | UTC time | null | null |

| Video status | chosen | publication |
| --- | --- | --- |
| draft | null | null |
| accepted | id of a built render with purpose build | null |
| published | same chosen render | `{id, snapshotAt}` with a nonempty publication id and UTC time |

History entries have `at, event, render, by, words`. Each entry carries its UTC time.

| Event | by | render | words | Count and order |
| --- | --- | --- | --- | --- |
| init | helper | null | null | Exactly one, first. |
| render-new | helper | existing render | null | Once per render. |
| render-done | helper | built or failed render | null | Once after its allocation. Absent while allocated. |
| accepted | owner | chosen render | owner's words | Once when accepted or published, after completion. |
| published | owner | chosen render | owner's words | Once when published, after acceptance. |

## Read a check

Each diagnostic list holds up to 50 messages with a field or path and the problem.

- **errors** identify a malformed record, including wrong types or fields, invalid references or ids, inconsistent state or history, a noncanonical render path, and a frozen edit whose digest differs. Fix structure before any further writes.
- **notReady** identifies an empty segment list, an unmarked speed change, a missing cut reason, or music missing its licence or attribution. With `verifyFiles: true`, it also flags a built file that is missing, irregular or different in size or digest. Verification re-hashes the file to catch changes of the same size.
- **warnings** identify missing visible evidence, missing source paths, unchecked synthetic voice licences, reported claims and orphan render directories. These allow acceptance. Without file verification the helper does not open render media.

## Worked example

1. Create the video directory `demo/` and put the input at `demo/footage/demo.mp4`. Resolve `demo/` to the absolute `dir` argument on your machine. Run `video-init` with the spec above.
2. In `manifest.json`, replace the three empty lists below with these entries. Keep the prompt, spoken words and proposed title in `proposed`.

```json
{
  "sources": [
    {"id":"screen","kind":"screen","path":"footage/demo.mp4","sha256":null,"note":"Demo session"}
  ],
  "segments": [
    {"id":"s3","source":"screen","in":0,"out":405,"speed":1,"speedMarked":false,"reason":"Keep the save and its receipt together","evidence":"A new order number appears","model":"demo model","effort":"high"}
  ],
  "claims": [
    {"id":"message","text":"the demo model says the order was saved","kind":"reported","segment":"s3","confirmation":"","note":""},
    {"id":"receipt","text":"a new order exists","kind":"confirmed","segment":"s3","confirmation":"the new order number is visible at 6:41 of segment s3","note":""}
  ]
}
```

3. Run `video-check`. Correct the draft until both `errors` and `notReady` are empty. The reported claim here produces a warning.
4. Run `video-render-new` with `purpose: "build", ext: "mp4"`. The first allocation returns `r1`. Have the rendering tool write to the returned `absolutePath` only.
5. Run `video-render-done` with `render: "r1", ok: true`. Check the reported file size, hash and delivery-limit flag.
6. Have the owner review that export. If the owner approves it, relay their actual words with `video-set-status` as in the acceptance spec above. See [Owner decisions and defaults](#owner-decisions-and-defaults) for the confirmation, acceptance and publication requirements.

## Storage and scope

Writes use an exclusive `manifest.json.tmp-<pid>` and a rename over the manifest. Helper files and real render directories stay within the video directory. On failure the helper removes its temporary file and any empty directory it just created. A killed allocation can leave an orphan directory. The next allocation skips its number. For rollback tests, set `ZODCHI_VIDEO_FAIL=write` or `ZODCHI_VIDEO_FAIL=rename` in the helper process to simulate that manifest write step failing.

This standalone package can run when its files are free and its prerequisites are committed. File checks with ffprobe, full decode, loudness and chapters belong to the next package. This helper does not know the real duration of a source.
