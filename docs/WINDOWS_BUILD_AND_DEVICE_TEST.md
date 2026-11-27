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

## Check out the three branches

PR #10 is this repo. PR #84 (`cursor/tippy-vod-scanner-fcb2`) is stacked on PR #83 (`cursor/tippy-media-pipeline`). Use two clones so neither branch has to carry the other repo.

```powershell
git clone https://github.com/TristanDMartin/streamerstip-desktop.git
cd streamerstip-desktop
git fetch origin cursor/obs-replay-prototype-a23e
git checkout cursor/obs-replay-prototype-a23e

cd ..
git clone https://github.com/TristanDMartin/streamerstipReact.git
cd streamerstipReact
git fetch origin cursor/tippy-vod-scanner-fcb2 cursor/tippy-media-pipeline
git worktree add ..\tippy-vod cursor/tippy-vod-scanner-fcb2
git worktree add ..\tippy-media cursor/tippy-media-pipeline
```

Confirm these files exist:

- `..\tippy-vod\services\tippy-vod-scanner\src\cli.ts`
- `..\tippy-media\services\tippy-media\src\scheduler.ts`

If `scheduler.ts` is also on the VOD worktree, that checkout already contains PR #83. Keep the media worktree anyway so the policy file you read is the PR #83 branch.

## Build and run

From `streamerstip-desktop`, in the VS 2022 x64 prompt:

```powershell
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build
cargo build --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

Leave `desktopVodIntelligence` false for the first launch. Capture must not spawn Node. Nothing is uploaded.

The scanner command, used only in the flagged device runs, is:

```text
node --experimental-strip-types <absolute path>\tippy-vod\services\tippy-vod-scanner\src\cli.ts
```

Point the Capture "Scanner CLI" field at that `cli.ts`. The work folder must be outside the recording folder.

## Resource monitor

OBS being open is not treated as free CPU, RAM, GPU, or encoder time. Every 5 seconds Capture reads host CPU and memory, `nvidia-smi` when it is installed, and OBS `GetStats` / stream status when the socket is up. Processing suspends when any suspend line is crossed. It resumes only after every resume line has held for 10 seconds. The first CPU sample can be empty, so the first line may say `not_measured`.

| Signal | Suspend | Resume |
| --- | --- | --- |
| CPU, host or OBS | 85% | 70% |
| Memory | 90% | 75% |
| GPU utilization | 85% | 60% |
| Free VRAM | under 2048 MB | at least 3072 MB |
| Encoder utilization | 70% | 40% |
| Encoder sessions | 1 or more | 0 |
| Skipped or lagged frames | any new frame since the last sample | no new frames |
| Average frame render time | 16.7 ms | 12 ms |
| Output congestion | 0.2 | 0.05 |
| Active FPS while streaming or recording | under 45 | at least 55 |

Decisions are one JSON object per line, policy `tippy.resource-monitor.v1`. The desktop writes `%APPDATA%\com.streamerstip.desktop\logs\resource-monitor.jsonl`. The page also keeps the last 200 lines in local storage under `tippy.resourceLog`. Save moment still works while processing is suspended.

## Device runs

The measurement script and the blank results table are in `docs/TEST_REPORT.md`. Those rows stay BLOCKED until Tristan fills them on the streaming PC and the gaming PC. This agent did not run them.
