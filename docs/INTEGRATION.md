# Integration contract

Capture is a screen in Tippy Desktop. It does not write Firestore, does not call Mux, and does not transcribe. The web app and the Tippy bot stay in `streamerstipReact`. This document maps a local replay onto `tippyClipMarkers` and does not change that repo.

## Where it sits

The shell is Tauri 2. The local owner id in `account.json` is the device id on each clip. The label remains "Waiting for the shared StreamersTip identity contract." Device sign-in (`describeDeviceSignIn`) is still `implemented: false` and `network: 'none'`. There is no `firebase` package.

A second search of every remote branch on 27 Nov 2026 still found no StreamReady module. The pre-stream check is `obsReadiness` on the Capture screen:

- The host is this PC (`127.0.0.1`, `localhost`, or `::1`).
- OBS WebSocket is authenticated and reported a version.
- The replay buffer is on.
- Free space on the recording drive is not under 2048 MB. Unknown disk space does not block. Low disk does.

## OBS session

Allowed without extra consent: `GetVersion`, `GetStats`, `GetReplayBufferStatus`, `GetLastReplayBufferReplay`, `SaveReplayBuffer`.

`StartReplayBuffer` is sent only when the creator checks the box. The consent object is `{ action: 'start_replay_buffer', confirmed: true }`.

Always blocked, including with that consent: `StartStream`, `StopStream`, `StartRecord`, `StopRecord`, `SetStreamServiceSettings`, `SetProfileParameter`, `SetVideoSettings`, `SetRecordDirectory`, `ToggleReplayBuffer`, `StopReplayBuffer`.

`SaveReplayBuffer` writes the buffer. It does not change stream or recording settings. The path comes from `ReplayBufferSaved` or `GetLastReplayBufferReplay`. Rust stats the file. Missing or empty is not a saved clip.

If the socket drops during a save, the next save adopts the file OBS already wrote when the path changed, the size is greater than 0, and the modified time is within 10 seconds of the attempt. It does not call `SaveReplayBuffer` a second time.

If the creator did not click Disconnect, a dropped socket retries after 1, 2, 4, 8, and 16 seconds, then stays at 30 seconds. Retry stops for a wrong password, a server that does not challenge, an incompatible version, or a host that is not this PC. Disconnect cancels the timer. The password stays in process memory for the retry and is not written to local storage or the status object.

## Clip record

`ClipCandidate` is `source: 'obs_replay'` and `rightsStatus: 'creator_owned'`. Triggers are `manual`, `hotkey`, `audio`, or `chat`.

`toMarkerReport` is the document a future server would write with the Admin SDK. The desktop app does not write it.

| Field | Value |
| --- | --- |
| collection | `tippyClipMarkers` |
| write | `server_admin_sdk` |
| owner | Firebase ID token, when that contract exists |
| platform | `obs` |
| clipStatus | `marked` |
| twitchClipId, clipUrl, embedUrl | null |
| localPath, size, trigger, timestamps, idempotencyKey, deviceId | from the clip |

The file key is `obs_replay:{deviceId}:{path}:{size}:{mtimeMs}`. The window key collapses duplicate clicks inside 3 seconds. The inventory on this PC is the list in local storage (`tippy.obsInventory`) plus the files OBS wrote. Checking "I authorize uploading this replay later" sets `uploadAuthorized` on that row only. `planObsReplayGrant` returns a grant only for a checked row.

`authorizeClipUpload` returns a Mux plan only when that checkbox is true. `plan.enabled` stays false. `runMuxUpload` returns `flag_off` or `prototype_lock` and does not call fetch. The plan, if it is ever enabled on a staging project, is `POST /api/mux/direct-upload` with the Firebase ID token, `userId` equal to the token uid, `privacy: private`, `isDraft: true`, then `PUT` the bytes. The local file is not deleted.

## Chat channel

Default off. Flag `desktopChatReplay` in `flags.json` (Rust field `desktop_chat_replay`). When it is false, no port is opened and `ingestChat` returns `flag_off`.

When it is true, Tippy listens on `127.0.0.1:4736`. The bot, on the same PC, sends:

```
POST /capture HTTP/1.1
x-tippy-local: 1
Content-Length: 57

{"idempotencyKey":"bot:channel:message","phrase":"!clip"}
```

The body may arrive in a later TCP packet. The listener waits until `Content-Length` bytes are present. A header packet alone is not parsed. The shortcut `CommandOrControl+Shift+F9` is registered with the operating system through `tauri-plugin-global-shortcut`. Capture does not listen for it on the window. Save moment still works when the shortcut is not registered.

A second request with the same key does not save again. The listener does not read Twitch chat and does not open Firestore. A Firestore listener is a later option on an isolated staging project. It is not built here, because staging is not provisioned and this app has no Firebase credentials.

## Local processing

`planLocalMoment` for a 30 second replay returns `runsNow: false`, `network: 'none'`, `scope: 'candidate_window_only'`. A 4 hour window returns `window_too_long` and `refuses: 'whole_stream_transcription'`. No speech-to-text runs.

Audio is off until calibration (at least 10 samples, p95 plus 8 dB, floor -24 dB, three sustained samples, 20 second cooldown). A named input does not fall through to another input. Save moment and the audio spike do not need chat, viewers, or a Twitch clip.

## StreamersTip token

`createKeychainVault` calls the Rust commands `keychain_save`, `keychain_load`, and `keychain_clear` (`keyring` 3, service `com.streamerstip.desktop`). The secret is an argument to that command. It is not written to `localStorage`, the inventory, or the status object. Tests use an in-memory vault and a fake invoke. This agent did not open the OS keychain. Device sign-in remains unimplemented.

## Path B media handoff

`docs/TIPPY_MEDIA_CONTRACTS.md` is not on `cursor/tippy-media-pipeline`. The aligned contract is `docs/TIPPY_MEDIA_PIPELINE.md` and `services/tippy-media/src/types.ts` (`ObsReplayGrant`, `acceptObsReplay`). Desktop does not import that package and does not call it.

A checked replay can become this grant. An unchecked replay cannot.

```ts
{
  ownerId: string
  replayPath: string
  savedAt: string
  consent: "creator_authorized_local_replay"
  obsVersion?: string
}
```

The pipeline's `ClipCandidate` (`ownerId`, `state`, `window`, `assetRef`, `source`) is a different record from the desktop `ClipCandidate`. `score`, `title`, and `caption` stay null for Tippy Brain. A future job must still refuse a window over 120 seconds, a Twitch or remote URL, and a file the creator did not check. This screen does not probe, render, or upload.

## Processing mode

`services/tippy-media` has no scheduling module yet. Desktop uses `resolveProcessingMode` until that module lands. Settings offers Live, Balanced, and Performance. Live keeps detection and capture and does not edit. Balanced can send one selected sample. Performance can ask the scanner for local ASR and can edit. If `GetStreamStatus` or `GetRecordStatus` says OBS is streaming or recording, the effective mode becomes Live. No mode opens the network.

## Three capture paths

`lib/tippy/contracts` is not on `cursor/tippy-vod-scanner-fcb2` or `cursor/tippy-media-pipeline`. Desktop records the same three paths locally:

| Path | Id | Desktop |
| --- | --- | --- |
| A Twitch | `tippy.capture.twitch.v1` | Link and embed only. This app does not download it. |
| B OBS replay | `tippy.capture.obs-replay.v1` | A checked inventory row. The creator also picks a benchmark category. The manifest is `tippy.sample-manifest.v1`. |
| C VOD | `tippy.capture.vod.v1` | `createVodDesktopApi()` on PR #84, consent `creator_authorized_local_folder`. |

## VOD intelligence

Flag `desktopVodIntelligence` (`desktop_vod_intelligence`) defaults to false. While it is off, Capture does not spawn a process.

When it is on, Capture starts a local Node process. The program is `node` or an absolute `node` binary. The script must be an absolute `services/tippy-vod-scanner/src/cli.ts`. Rust `sidecar_start` repeats that check and does not use a shell. Cancel calls `sidecar_cancel`.

The flow is authorize folder, scan the checked recording, review candidate ids, then `edit` for a selected sample. `edit` is the scanner command that calls `runEdits` in `services/tippy-media`. The pipeline has no separate job CLI. Publish stays refused. Nothing is uploaded.

The scanner CLI lives on `cursor/tippy-vod-scanner-fcb2` (draft PR #84), not inside this repo. It writes `tippy.sample-manifest.v1`. Spikes stay candidates. The scanner must not modify the source. Each pipeline job stays at or under 120 seconds. This desktop build does not extract samples itself and does not upload them.
