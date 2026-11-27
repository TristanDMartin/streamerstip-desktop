# Integration contract

Capture is a screen in Tippy Desktop. It does not write Firestore, does not call Mux, and does not transcribe. The web app and the Tippy bot stay in `streamerstipReact`. This document maps a local replay onto `tippyClipMarkers` and does not change that repo.

## Where it sits

The shell is Tauri 2. The local owner id in `account.json` is the device id on each clip. The label remains "Waiting for the shared StreamersTip identity contract." Device sign-in (`describeDeviceSignIn`) is still `implemented: false` and `network: 'none'`. There is no `firebase` package.

StreamReady is not in this repository. The pre-stream check is `obsReadiness` on the Capture screen:

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

The file key is `obs_replay:{deviceId}:{path}:{size}:{mtimeMs}`. The window key collapses duplicate clicks inside 3 seconds. The inventory on this PC is the list in local storage (`tippy.obsInventory`) plus the files OBS wrote. Checking "I authorize uploading this replay later" sets `uploadAuthorized` on that row only.

`authorizeClipUpload` returns a Mux plan only when that checkbox is true. `plan.enabled` stays false. `runMuxUpload` returns `flag_off` or `prototype_lock` and does not call fetch. The plan, if it is ever enabled on a staging project, is `POST /api/mux/direct-upload` with the Firebase ID token, `userId` equal to the token uid, `privacy: private`, `isDraft: true`, then `PUT` the bytes. The local file is not deleted.

## Chat channel

Default off. Flag `desktopChatReplay` in `flags.json` (Rust field `desktop_chat_replay`). When it is false, no port is opened and `ingestChat` returns `flag_off`.

When it is true, Tippy listens on `127.0.0.1:4736`. The bot, on the same PC, sends:

```
POST /capture HTTP/1.1
x-tippy-local: 1

{"idempotencyKey":"bot:channel:message","phrase":"!clip"}
```

A second request with the same key does not save again. The listener does not read Twitch chat and does not open Firestore. A Firestore listener is a later option on an isolated staging project. It is not built here, because staging is not provisioned and this app has no Firebase credentials.

## Local processing

`planLocalMoment` for a 30 second replay returns `runsNow: false`, `network: 'none'`, `scope: 'candidate_window_only'`. A 4 hour window returns `window_too_long` and `refuses: 'whole_stream_transcription'`. No speech-to-text runs.

Audio is off until calibration (at least 10 samples, p95 plus 8 dB, floor -24 dB, three sustained samples, 20 second cooldown). A named input does not fall through to another input.
