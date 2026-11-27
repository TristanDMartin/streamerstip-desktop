# Test report

Date: 27 Nov 2026. Machine: this cloud agent. Not the TechnQs streaming PC.

## Commands

```
npx tsc --noEmit
npm test
cargo +1.91.0 test --locked --manifest-path src-tauri/Cargo.toml --lib
```

`npx tsc --noEmit` exited 0.

`npm test` (Vitest 3.2.7) exited 0:

```
Test Files  10 passed (10)
     Tests  35 passed (35)
  Duration  1.69s
```

That includes the existing shell tests (Home, Tippy rail, team, format) and the OBS tests: auth failure, replay off, save, duplicate save, disconnect mid-save, adopt after disconnect, two device ids, audio threshold, chat flag, pre-stream check, and the Capture screen render.

`cargo test` is BLOCKED on this agent. Rust 1.83 cannot compile the locked Tauri crates (they need Rust 1.90). Rust 1.91 was installed, then the build stopped because `gdk-3.0` is not installed. The new Rust tests in `src-tauri/src/obs_local.rs` were not executed. They cover the chat-request decision and `replay_stat`.

## Section 4B

| Item | Result |
| --- | --- |
| OBS WebSocket and password auth | PASS against a mock server |
| Replay buffer status | PASS |
| Start the buffer only with consent | PASS |
| Save replay and verify size | PASS against a mock file |
| ReplayBufferSaved / adopt after disconnect | PASS |
| Audio monitoring and spike detection | PASS |
| Manual hotkey chord | PASS in process. OS-wide hook NOT RUN |
| Chat-triggered save, flag off by default | PASS with a mocked signal. Live bot NOT RUN |
| Local clip inventory and per-clip upload checkbox | PASS. Mux is not called |
| Disconnect recovery | PASS |
| Pre-stream check | PASS. StreamReady was not in the repo to reuse |
| Windows OBS | NOT RUN |
| macOS OBS | NOT RUN |
| Two physical PCs | NOT RUN. Two mocked servers on one host PASS |
| Firebase, Firestore, Mux, transcription | NOT RUN. Design only |
| Signing, installer, publish | NOT RUN |

## Manual script for the streaming PC

Node 20+, Rust 1.90+, and the Tauri Linux or desktop system libraries the existing Tippy Desktop build already uses. OBS Studio 28 or newer.

1. Check out this branch. `npm install`, then `npm run tauri dev`.
2. In OBS, enable the WebSocket server on port 4455 with a password, and start the replay buffer.
3. Open Capture. Connect with `127.0.0.1`. The pre-stream check should list the buffer as ready.
4. With no chat, click Save moment. Confirm a local path and a size greater than 0.
5. Optional: Calibrate 3 seconds, then turn on the audio spike.
6. Optional: Ctrl+Shift+F9 while the Tippy window is focused.
7. Optional: set `desktopChatReplay` to true in `flags.json`, restart, and `POST` the JSON body in `docs/INTEGRATION.md` to `http://127.0.0.1:4736/capture` with header `x-tippy-local: 1`.
8. The StreamersTip clips dashboard and Mux should not change.

On two PCs, run Tippy Desktop on the PC where OBS is recording.
