# Windows build and device test

Draft only. Do not merge, sign, or upload. `desktopVodIntelligence` and `tippy_creator_inbox_enabled` stay off unless a step below says to turn the VOD flag on for one run and turn it off again.

Versions below are the ones this branch was built with on 27 Nov 2026, or the publisher’s stated minimum. Record the version the PC actually prints when it differs.

## Dependencies

| Piece | Version | Install |
| --- | --- | --- |
| Rust | 1.91.0 (`f8297e351`, 2025-10-28) | The lockfile’s Tauri 2.12 crates need rustc 1.90 or newer. `Cargo.toml` `rust-version` is still 1.77.2 and is not enough. |
| Node | 22.23.4 | `winget install --id OpenJS.NodeJS.22 -e` |
| npm | 10.9.9 | Comes with that Node. Check with `npm -v`. |
| MSVC Build Tools | Visual Studio 2022 Build Tools, workload `Microsoft.VisualStudio.Workload.VCTools` (MSVC v143, Windows 10/11 SDK) | Command below. |
| WebView2 | Evergreen Runtime, already on current Windows 11 | Bootstrapper only if the registry check is missing. |
| Python / OpenCV | Not used | Do not install them. This build has no face detection. |
| FFmpeg for Tippy Desktop | Any `ffmpeg` and `ffprobe` on `PATH` | The desktop media engine uses MPEG-4 and AAC. It does not use NVENC and it does not ship a GPL build. |
| FFmpeg for the pipeline encode check | A separate build whose `ffmpeg -encoders` lists `h264_nvenc` | Only for the Balanced and Performance device runs. Keep it off the desktop media engine’s `PATH` if it is a GPL build. |
| NVIDIA driver | 610.00 or newer | Video Codec SDK 13.1 / current `nv-codec-headers` require driver 610.00 on Windows. Older NVENC headers can run on older drivers. Record `nvidia-smi` and do not encode if it is below 610.00. |

Rust:

```powershell
winget install --id Rustlang.Rustup -e
rustup toolchain install 1.91.0
rustup default 1.91.0
rustc --version
```

MSVC Build Tools:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Open a new "x64 Native Tools Command Prompt for VS 2022" and run `cl`. The first line is the exact compiler version. WebView2:

```powershell
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv
```

If that key is missing, install the Evergreen bootstrapper from `https://go.microsoft.com/fwlink/p/?LinkId=2124703` and run the query again. Record the `pv` value.

NVIDIA and the encode-only FFmpeg:

```powershell
nvidia-smi
ffmpeg -version
ffmpeg -encoders | findstr nvenc
```

`nvidia-smi` must show driver 610.00 or newer before an NVENC encode. Tippy Desktop itself still calls the non-NVENC `ffmpeg` on `PATH`.

## Resource monitor

OBS being open is not treated as free CPU, RAM, GPU, or encoder time. Every 5 seconds Capture reads host CPU and memory, `nvidia-smi` when it is installed, and OBS `GetStats` plus stream status when the socket is up. Processing suspends when any suspend line is crossed. It resumes only after every resume line has held for 10 seconds. The first CPU sample can be empty, so the first line may say `not_measured`.

| Signal | Suspend | Resume |
| --- | --- | --- |
| CPU, host or OBS | 85% | 70% |
| Memory | 90% | 75% |
| GPU utilization | 85% | 60% |
| Free VRAM | under 2048 MB | at least 3072 MB |
| Encoder utilization | 70% | 40% |
| Encoder sessions | 1 or more | 0 |
| Render lag (`GetStats.renderSkippedFrames`) | any new frame since the last sample | no new frames |
| Encoding lag (`GetStats.outputSkippedFrames`) | any new frame since the last sample | no new frames |
| Network-dropped frames (`GetStreamStatus.outputSkippedFrames`) | never suspends | ignored |
| Average frame render time | 16.7 ms | 12 ms |
| Output congestion | 0.2 | 0.05 |
| Active FPS while streaming or recording | under 45 | at least 55 |

Decisions are one JSON object per line, policy `tippy.resource-monitor.v1`. Each line has `renderLagFrames`, `encodingLagFrames`, and `networkDroppedFrames` as separate numbers. A rise in network-dropped frames sets `networkCondition` to `network_drops` and does not suspend processing. Render lag and encoding lag can suspend. The desktop writes `%APPDATA%\com.streamerstip.desktop\logs\resource-monitor.jsonl`. The page also keeps the last 200 lines in local storage under `tippy.resourceLog`. Save moment still works while processing is suspended.

`GetStats.renderSkippedFrames` is frames missed because rendering lagged. `GetStats.outputSkippedFrames` is frames skipped because the encoder lagged. OBS does not put network drops on `GetStats`. Those are `GetStreamStatus.outputSkippedFrames` (`obs_output_get_frames_dropped`). The monitor stores that third counter on its own and does not treat it as CPU or GPU overload.

## Runbook for the streaming PC (RTX 3060)

Founder-approved controlled test on the streaming PC only. The GPU for this script is an RTX 3060. Do not run it on the gaming PC. No live Twitch. No uploads. Do not start a stream to Twitch. `desktopVodIntelligence` stays false. Fill the Result line on each step. Leave `BLOCKED` if you skip it. A mock, CI, and this agent do not fill these lines.

Open "x64 Native Tools Command Prompt for VS 2022" for every `cargo` command. PowerShell is fine for `git`, `winget`, and the log reads.

### 1. Install and launch

Paste the Rust, MSVC, WebView2, and `nvidia-smi` commands in Dependencies. Then:

```powershell
cd $env:USERPROFILE
git clone https://github.com/TristanDMartin/streamerstip-desktop.git
cd streamerstip-desktop
git fetch origin cursor/obs-replay-prototype-a23e
git checkout cursor/obs-replay-prototype-a23e
git rev-parse HEAD
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build
cargo build --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

`git rev-parse HEAD` should print `5e48bc923aba99b0b63ca86a015cbf15a222da50` or a later commit on this same branch. Tippy Desktop opens. Open Capture in the sidebar. The first line under Capture says replays stay on this PC.

The first launch creates `%APPDATA%\com.streamerstip.desktop\flags.json`. Do not set `TIPPY_DATA_DIR`.

Result: BLOCKED

### 2. OBS WebSocket connect

In OBS: Tools, WebSocket Server Settings. Enable the WebSocket server. Server port `4455`. Enable authentication and set a password. Leave the server on this computer. Do not open it to the network. Show the Start Replay Buffer button in the OBS dock if it is hidden.

In Capture, under OBS WebSocket, Host is already `127.0.0.1` and Port is already `4455`. Leave them. Click Connect only after the next step has the password.

Result: BLOCKED

### 3. Auth

Type a wrong password. Click Connect. The status line stays disconnected and does not say Reconnected. The password is not printed there.

Clear the field, type the real OBS password, and click Connect. The status line starts with `Connected to OBS` and includes the OBS version. Pre-stream check shows `Ready · OBS WebSocket authenticated`.

Result: BLOCKED

### 4. Replay buffer status

In OBS, start the replay buffer. Within a few seconds the pre-stream check shows `Ready · Replay buffer is on. Ready to save`.

Stop the replay buffer in OBS. The same row becomes `Not ready · Replay buffer is on`. Start the buffer again before the next step.

Result: BLOCKED

### 5. Manual replay capture

Under Save moment, leave “I authorize local editing of this save” unchecked. Click Save moment. Do not use chat. Under On this PC, a row appears with trigger `manual`, a size greater than 0, and a local path. The upload checkbox on that row stays unchecked.

Result: BLOCKED

### 6. Audio trigger

Under Audio spike, set OBS input name to the mic name OBS shows (the placeholder is `Mic/Aux`). Click Calibrate 3 seconds and stay quiet. Then check Turn on the audio spike. Make one loud sound. One new row appears. Stay quiet for several seconds. No second row appears from silence.

Result: BLOCKED

### 7. Chat trigger, simulated first

Quit Tippy Desktop. Do not connect Twitch.

```powershell
$flags = "$env:APPDATA\com.streamerstip.desktop\flags.json"
$json = Get-Content $flags -Raw | ConvertFrom-Json
$json.desktopChatReplay = $true
$json.desktopVodIntelligence = $false
$json | ConvertTo-Json | Set-Content $flags -Encoding utf8
Get-Content $flags
```

Start the app again with `npm run tauri dev`. Open Capture. On this PC says `Chat replay is on` and `Twitch chat is not read here`. Click Simulate chat event once. A row appears with trigger `chat`. Click Simulate chat event again. No second chat row appears.

Quit the app and set the flag back off:

```powershell
$flags = "$env:APPDATA\com.streamerstip.desktop\flags.json"
$json = Get-Content $flags -Raw | ConvertFrom-Json
$json.desktopChatReplay = $false
$json | ConvertTo-Json | Set-Content $flags -Encoding utf8
```

Start the app again before the next step.

Result: BLOCKED

### 8. Local clip inventory

Under On this PC, the manual, audio, and chat rows are still listed with local paths. Leave “I authorize uploading this replay later” unchecked on every row. The line says `0 selected for a later upload. This build does not send them.` Mux and Twitch are unchanged.

Result: BLOCKED

### 9. Live, Balanced, and Performance

Connect to OBS again. Under Settings, the Processing menu has Live, Balanced, and Performance. Under VOD intelligence the sentence names the effective mode.

- OBS is streaming or recording, menu set to Performance: the sentence says processing stays on `live`.
- OBS is open, not streaming and not recording, menu set to Performance: the sentence says processing stays on `balanced`.
- Disconnect from OBS, menu set to Performance: the sentence says `Processing is performance`.

Do not turn `desktopVodIntelligence` on. Do not click Scan or Send selected.

Result: BLOCKED

### 10. Resource-pressure detection

Leave Capture open and connected for at least 10 seconds. Then:

```powershell
Get-Content "$env:APPDATA\com.streamerstip.desktop\logs\resource-monitor.jsonl" -Tail 1
nvidia-smi
```

The JSON line contains `renderLagFrames`, `encodingLagFrames`, and `networkDroppedFrames` as three separate numbers, plus `policy` `tippy.resource-monitor.v1`. `nvidia-smi` names the RTX 3060. Write the driver version and the three numbers on this result line.

`renderLagFrames` is OBS `GetStats.renderSkippedFrames` (rendering). `encodingLagFrames` is OBS `GetStats.outputSkippedFrames` (encoder). `networkDroppedFrames` is OBS `GetStreamStatus.outputSkippedFrames` (network). OBS does not put network drops on `GetStats`.

Result: BLOCKED

### 11. Suspend

While connected, put enough load on the RTX 3060 that OBS Stats shows new skipped frames from rendering or from the encoder, or CPU, GPU, VRAM, or encoder use crosses the suspend line in the table above. Within about 5 seconds the Settings note says `Processing is suspended`. Click Save moment. A local save still appears. Do not click Scan or Send selected.

Result: BLOCKED

### 12. Recover

Ease the load until render lag and encoding lag stop increasing and the resume lines in the table above hold. Wait 10 seconds. The note says `Processing can run`.

If only network-dropped frames increase, the note still says processing can run, and the JSON line has `"networkCondition":"network_drops"`. That increase is not a CPU or GPU overload and does not suspend processing.

Result: BLOCKED

### 13. Disconnect and reconnect

In OBS, disable the WebSocket server. The Capture status line reports the drop. Enable the server again with the same password. The status line says `Reconnected` and does not save a second replay by itself.

Optional: click Save moment and disable the WebSocket server before the save finishes. The status line marks that save ambiguous. Reconnect. Tippy adopts the file OBS already wrote and does not call Save Replay Buffer a second time for that attempt.

Result: BLOCKED

### 14. Authorization revocation

On one inventory row, check “I authorize local editing of this replay”, then uncheck it. Under VOD intelligence, type `loud_reaction` in Replay category and click Send checked replay. The progress line reads `not_authorized`. Nothing is uploaded. Leave every upload checkbox unchecked. Quit with `desktopChatReplay` and `desktopVodIntelligence` both false.

Result: BLOCKED

## Side-by-side scanner checkout

Only if a later flagged run needs the scanner. This controlled pass leaves `desktopVodIntelligence` off, so skip this section unless the founder asks for it.

```powershell
cd $env:USERPROFILE
git clone https://github.com/TristanDMartin/streamerstipReact.git
cd streamerstipReact
git fetch origin cursor/tippy-vod-scanner-fcb2 cursor/tippy-media-pipeline
git worktree add ..\tippy-vod cursor/tippy-vod-scanner-fcb2
git worktree add ..\tippy-media cursor/tippy-media-pipeline
```

Confirm these files exist:

- `$env:USERPROFILE\tippy-vod\services\tippy-vod-scanner\src\cli.ts`
- `$env:USERPROFILE\tippy-media\services\tippy-media\src\scheduler.ts`

The scanner command, used only after the founder turns the VOD flag on, is:

```text
node --experimental-strip-types $env:USERPROFILE\tippy-vod\services\tippy-vod-scanner\src\cli.ts
```

Point the Capture Scanner CLI field at that `cli.ts`. The work folder must be outside the recording folder. Turn the flag off when that run ends.

## Device runs

The measurement script and the blank results table are in `docs/TEST_REPORT.md`. Those rows stay BLOCKED until Tristan fills them on the streaming PC and the gaming PC. This agent did not run them.
