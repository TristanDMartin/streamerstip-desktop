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
Test Files  13 passed (13)
     Tests  51 passed (51)
  Duration  3.23s
```

That includes the existing shell tests (Home, Tippy rail, team, format) and the OBS tests: auth failure, replay off, save, duplicate save, disconnect mid-save, adopt after disconnect, two device ids, audio threshold, chat flag, pre-stream check, reconnect after a dropped socket, no retry after a bad password, the global-shortcut binder, the keychain vault contract, the Path B grant, the VOD stub, the Capture screen render, `tippy.scheduler.v1`, `GetStats` skipped frames, and `tippy.clip-contract.v1`.

```
rustc --edition 2021 --test src-tauri/src/http_framing.rs
```

exited 0. 2 passed. A header packet is incomplete until `Content-Length` bytes arrive. One packet still parses.

`cargo test` is BLOCKED on this agent. The locked Tauri crates need Rust 1.90, and the 1.91 build stops because `gdk-3.0` is not installed. The tests inside `src-tauri/src/obs_local.rs` were not executed. The framing test above does not compile the Tauri crate, so it is not a `cargo test` result.

## Section 4B

| Item | Result |
| --- | --- |
| OBS WebSocket and password auth | PASS against a mock server |
| Replay buffer status | PASS |
| Start the buffer only with consent | PASS |
| Save replay and verify size | PASS against a mock file |
| ReplayBufferSaved / adopt after disconnect | PASS |
| Audio monitoring and spike detection | PASS |
| Reconnect with backoff | PASS against a mock drop. Stops on a bad password |
| Manual hotkey chord | PASS for the OS binder. The operating-system hook is BLOCKED |
| Chat-triggered save, flag off by default | PASS with a mocked signal. Split-body framing PASS via rustc. Live bot NOT RUN |
| Local clip inventory and per-file authorization | PASS. The grant is built only when the row is checked. Mux is not called |
| Disconnect recovery | PASS |
| StreamersTip token in the OS keychain | PASS for the vault contract. The OS keychain call is BLOCKED |
| Path B handoff to tippy-media | PASS as a local grant. The pipeline was not called |
| VOD sidecar plan | PASS for argv, cancel, and the flag. The Node process was not spawned |
| Processing mode | PASS for `tippy.scheduler.v1`. Streaming, recording, dropped frames, or lagged frames force Live. OBS open and idle drops Performance to Balanced. A real GPU was not measured |
| Clip contract | PASS. Path A cannot enter editing. Paths B and C stay out of the inbox while `tippy_creator_inbox_enabled` is off |
| OBS stream and record status | PASS against a mock, including `GetStats` skipped frames. A real OBS output was not read |
| VOD intelligence screen | PASS as a flagged UI. The scanner and pipeline were not executed |
| Pre-stream check | PASS. A second search still found no StreamReady module |
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
6. Optional: press CommandOrControl+Shift+F9 while another window is focused. On macOS, grant Accessibility if the OS does not deliver it. Save moment still works if the shortcut is not registered.
7. Optional: set `desktopChatReplay` to true in `flags.json`, restart, and `POST` the JSON body in `docs/INTEGRATION.md` to `http://127.0.0.1:4736/capture` with header `x-tippy-local: 1` and a `Content-Length`.
8. The StreamersTip clips dashboard and Mux should not change.

On two PCs, run Tippy Desktop on the PC where OBS is recording.
