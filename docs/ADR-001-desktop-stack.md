# ADR-001: Desktop stack for OBS capture

Status: revised. The first draft of this ADR recommended an unsigned Node companion. That draft is withdrawn. The desktop foundation is already Tauri.

## Decision

OBS capture lives inside Tippy Desktop, the existing Tauri 2 shell (React, TypeScript, Rust). The Capture screen uses `obs-websocket-js` in the webview. File size checks and the optional chat listener live in the Rust service (`stat_local_replay`, `obs_local`). There is no second app and no Node server.

This pull request is based on `cursor/comfort-glass-redesign-988a` (pull request 9), the current tip of the desktop stack. That tip sits on the Phase 0–1 foundation (pull request 1, branch `desktop-foundation`) through Phases 2–6 and the New Project fix (pull requests 2–6 and 8).

## What the audit found

Every branch and pull request in this repo was listed. There is no Cursor `environment.json` in the repo. The cloud environment for this run is personal and does not expose one.

| Pull request | Branch | What it is |
| --- | --- | --- |
| 1 | `desktop-foundation` | Tauri 2, React, TypeScript, Rust. Projects, jobs, flags, local owner id, FFmpeg media engine. |
| 2–6 | phase 2 through phase 6 | Local media intelligence, Moment Scout, Shorts, team workspace, thin editor. |
| 7 | `cursor/desktop-ci-builds-abb7` | Unsigned Mac, Windows, and Linux test builds, beside phase 6. |
| 8 | `cursor/fix-new-project-click-ddb7` | New Project click result, on phase 6. |
| 9 | `cursor/comfort-glass-redesign-988a` | Current shell. Comfort glass Home. |
| 10 | this branch | Was a Node companion on `main`. Now Capture inside the shell from pull request 9. |

No branch contains StreamReady, a stream-ready module, or a pre-stream checklist. The closest word is a job state named `ready`. Capture adds its own pre-stream check (`obsReadiness`) for OBS authentication, replay buffer, disk, and a loopback host. It does not invent a StreamReady product or call a module that is not in the tree.

## Shell, auth, and OBS

The shell is Tauri 2. The window is React. Rust owns projects, jobs, flags, the preview file server, and now the replay stat and the chat port. The account seam is one local owner id in `account.json`, labeled "Waiting for the shared StreamersTip identity contract." There is no desktop OAuth and no second user table. Capture uses that owner id as the device id on a clip so two PCs do not share an idempotency key.

OBS authentication is the WebSocket password from OBS, Tools, WebSocket Server Settings. The socket is `127.0.0.1` only. A missing password, a wrong password, or a server that does not challenge is refused. OBS Studio 28 or newer and obs-websocket 5 are required.

## Why the Node companion is not the path

A Node companion compiled and tested on its own, and it did not share the shell, the account seam, the flags, or the nav. Keeping it would have been a second app beside Tippy Desktop. The OBS session, audio calibration, hotkey chord, and clip contract moved into `src/obs` and are called from Capture. The standalone HTTP UI is gone.

Electron is not in this repo. Tauri is. A later signed installer is still a founder decision and is not part of this change. Pull request 7 already builds unsigned packages. This pull request does not build, sign, or publish one.

Apple Developer Program is $99 USD per year. Windows OV certificates are typically $150–300 per year. Azure Artifact Signing is about $9.99 per month where an account is eligible. Do not buy a certificate for this spike.

## Windows and macOS

- The same Tauri shell is the Windows and macOS app. Pull request 7 is the unsigned build workflow. Run `npm run tauri dev` on the streaming PC for this spike. Rust 1.90 or newer is what the locked Tauri crates ask for.
- OBS WebSocket v5 is loopback on both systems. The host field rejects a LAN address. On two PCs, run Tippy Desktop on the PC where OBS is recording.
- Replay paths differ. `stat_local_replay` accepts an absolute path with a video extension and returns size and modified time. The webview does not read the file itself.
- Ctrl+Shift+F9 works while the Tippy window is focused. A global hotkey while a game is focused needs the Tauri global-shortcut plugin and, on macOS, Accessibility permission. That plugin is not added here. The button always works.
- This build is unsigned.

## Cost and rights

Creator-owned OBS replays are the only video this screen saves. Twitch clips stay link and embed only. `planLocalMoment` refuses a window longer than 120 seconds (`whole_stream_transcription`) and does not run speech-to-text. The memo's whole-stream figure, not re-measured here, is about $13.82 per month for 12 streams of 4 hours at Deepgram Nova-3 pay-as-you-go ($0.0048 per minute), which is more than Pro at $12.99.

Audio spike detection is off until the creator calibrates it. Eklipse already ships a no-audience mode. This trigger is not a headline. It has to work with zero viewers: p95 floor plus 8 dB, never below -24 dB, three sustained samples, 20 second cooldown.

Nothing in this change calls Mux, Firebase, a speech API, or FFmpeg for the replay save.
