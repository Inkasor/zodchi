# Private YouTube upload

`youtube-publish` uploads the accepted MP4 from a `video` run to one authorized YouTube channel. The Rust workflow
verifies the uploaded video through the YouTube Data API and keeps its own run ID in the shared journal. A private
upload receipt leaves the source video ready for a later publication decision.

## Connect a channel

For one Google account, create a [Personal project and Desktop app OAuth client](https://support.google.com/cloud/answer/15544987)
under the account that can authorize the channel. Enable YouTube Data API v3 and save the downloaded client JSON
outside the project and chat. The connection requests `youtube.upload` and `youtube.readonly`.

Write a local connection arguments file with the channel ID you intend to use.

```json
{
  "profile": "personal",
  "channelId": "UC0000000000000000000000",
  "clientFile": "<absolute path to the Desktop client JSON>"
}
```

```text
zodchi flow youtube-publish connect --args <connection.json>
zodchi flow youtube-publish whoami --profile personal
```

Run `connect` in the foreground. It prints a Google consent link and waits up to five minutes for the system
browser to return the authorization code to the local loopback listener. The Desktop exchange uses PKCE S256.
The profile is saved only after a successful channel ID check. Refresh tokens and resumable session URLs are kept
in the system credential store under the calling user, using Credential Manager on Windows, Keychain on macOS,
or an available Secret Service on Linux. Both chat clients use this same connection when running as that user.

## Approve the private upload

Choose an accepted `videoRun`. For an existing export, use [video adoption](flow-video.md#inputs-and-the-three-decisions)
and approve the exact MP4 there. Supply the metadata and the same profile and channel ID.

```json
{
  "videoRun": "<approved video run ID>",
  "profile": "personal",
  "channelId": "UC0000000000000000000000",
  "title": "A private test upload",
  "description": "The approved description.",
  "categoryId": "22",
  "selfDeclaredMadeForKids": false
}
```

```text
zodchi flow youtube-publish --args <upload.json>
zodchi flow status <upload-run-id> --handoff
```

Start returns the upload run ID and its pending plan. Show the owner the chosen channel, metadata, file path,
SHA-256 and private visibility. Uploads in this workflow use `notifySubscribers=false`. A reply approves or rejects
the displayed plan. Record the owner's words and the `planSha256` shown in `youtube`.

```json
{
  "decision": "approve",
  "planSha256": "<digest from the waiting plan>",
  "ownerWords": "Upload this file privately to this channel."
}
```

```text
zodchi flow reply <upload-run-id> --file <decision.json>
zodchi flow youtube-publish --resume <upload-run-id> --detach
zodchi flow status <upload-run-id> --handoff
```

## Read the receipt or resume

The worker refreshes the access token and checks the authorized channel before sending media. It checks the
approved file digest and verifies each block before sending it. The journal keeps the confirmed byte count and
the video ID. A new run targeting the same file digest and channel reports the run that already owns the upload.

If a transfer was interrupted, `--resume` asks the saved session for the acknowledged offset or its final video
ID. An expired or missing session stops with a reason and the same run ID for reconciliation. When a video ID is
already recorded, resume checks that ID. If YouTube still reports processing, the run returns `processing` and
can be resumed for another read. Reconnect the same profile if YouTube revokes authorization.

`private_verified` confirms the returned channel, metadata, private visibility and successful processing. The
receipt records the local file digest, the video ID, URL and verification time. Use the ID of the upload run for
continuation and the source `videoRun` when working on the video itself.

Reference [Desktop authorization](https://developers.google.com/identity/protocols/oauth2/native-app) and
[YouTube resumable uploads](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol).
