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
Test Files  16 passed (16)
     Tests  58 passed (58)
  Duration  3.26s
```

That includes the existing shell tests (Home, Tippy rail, team, format) and the OBS tests: auth failure, replay off, save, duplicate save, disconnect mid-save, adopt after disconnect, two device ids, audio threshold, chat flag, pre-stream check, reconnect after a dropped socket, no retry after a bad password, the global-shortcut binder, the keychain vault contract, the Path B grant, the VOD stub, the Capture screen render, `tippy.scheduler.v1`, `GetStats` skipped frames, `tippy.clip-contract.v1`, resource-monitor suspend/resume, and the vendored `tippy.contract-fixtures.v1` suite (26 cases, checksum ok), separate render-lag, encoding-lag, and network-drop counters, and the simulated chat harness. The same runner is `node --experimental-strip-types contracts/runner/run-fixtures.ts`: 26 pass, 0 fail. A path B or C send without an unrevoked `local_edit` grant fails. The known path B grant hash is `8f9d0827de17845bcf7cda0ef3ed65ed2f62b688870d8f2748178de0dc13cda1`.

```
rustc --edition 2021 --test src-tauri/src/http_framing.rs
```

exited 0. 2 passed. A header packet is incomplete until `Content-Length` bytes arrive. One packet still parses.

`cargo +1.91.0 test --locked --manifest-path src-tauri/Cargo.toml --lib` exited 0 after `libgtk-3-dev` 3.24.41 and `libwebkit2gtk-4.1-dev` 2.52.6 were installed:

```
test result: ok. 65 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.23s
```

`cargo +1.91.0 build --locked --manifest-path src-tauri/Cargo.toml` exited 0:

```
Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.13s
```

That run includes `sidecar.rs`, the empty-secret keychain test, the global-shortcut plugin link test, `obs_local.rs`, and `http_framing.rs`. It does not open the OS keychain and it does not register the shortcut with the OS. `apt-get` still reported exit 100 because `fuse3` and `xdg-desktop-portal` failed to configure. Those packages are not required for this build. `pkg-config` reports `gdk-3.0` 3.24.41 and `webkit2gtk-4.1` 2.52.6.

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
| Resource monitor | PASS for suspend, hysteresis, resume, and for network drops staying out of the suspend reasons in Vitest, and for the host parsers in `cargo test`. A live OBS workload was not measured |
| Simulated chat harness | PASS. `simulateChatEvent` saves once with the flag on and does not name Twitch. Live Twitch was not used |
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

Windows install commands, versions, and the side-by-side checkout of PR #10, PR #84, and PR #83 are in `docs/WINDOWS_BUILD_AND_DEVICE_TEST.md`.

## Device workload

BLOCKED until Tristan runs this on the streaming PC and the gaming PC. Do not mark these rows passed from a mock, this agent, or CI.

Use one repeated scene, about 10 minutes, with OBS streaming and recording. Keep the game on the gaming PC. Read the OBS log at `%APPDATA%\obs-studio\logs` and search for `audio buffering`, `encoding overloaded`, and a failed or stopped recording. Read skipped frames, lagged frames, congestion, and active FPS from OBS Stats. Read memory from Task Manager and from `resource-monitor.jsonl`. Read gameplay FPS from the game or RTSS on the gaming PC. Copy the resource log at `%APPDATA%\com.streamerstip.desktop\logs\resource-monitor.jsonl`.

1. Processing off: `desktopVodIntelligence` false. Do not scan or edit.
2. Live: set the flag true, choose Live, and leave the scanner idle except for detection and capture.
3. Balanced: same scene, one selected sample only if the resource line says processing can run.
4. Performance: same scene. If the monitor suspends, leave it suspended and record that. Do not force the encode.

Turn the flag off when the four runs are done. Do not upload the recordings.

| Measure | Off | Live | Balanced | Performance |
| --- | --- | --- | --- | --- |
| Encoding lag (`GetStats.outputSkippedFrames`, delta) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Render lag (`GetStats.renderSkippedFrames`, delta) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Network-dropped frames (`GetStreamStatus.outputSkippedFrames`, delta) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Encoding overload (OBS log and encoder %) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Audio buffering lines in the OBS log | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Recording failures | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Memory (host % peak, OBS MB) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Gameplay FPS (avg and 1% low) | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Resource monitor phase at the end | BLOCKED | BLOCKED | BLOCKED | BLOCKED |

Date, OBS version, NVIDIA driver, and the two PC names: BLOCKED.
