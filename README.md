# Tippy Desktop

Phase 0 through Phase 3 of Tippy Desktop: a local Tauri shell for creating a project, importing video, reading the media, and ranking moments on this machine.

This repository is the isolated desktop app. It does not change the StreamersTip website or the Flutter app.

## What this build includes

- Tauri 2, React, TypeScript, and a Rust service layer
- Project files with `schemaVersion` 1, atomic writes, autosave snapshots, and launch recovery
- A job model, action registry, event bus, feature flags, and logging
- A thin agent runtime: context, planner, scheduler, tool registry, permissions, state, versions, checkpoints, cost meter, and one orchestrator
- Model-provider interfaces. No network model calls. Local-only privacy refuses cloud routes
- `MediaEngine` (`probe`, `createProxy`, `extractAudio`, `trim`, `renderSequence`, `createThumbnail`, `exportVideo`) implemented with the system `ffmpeg` / `ffprobe` binaries
- Home, Projects, import, probe metadata, proxy preview, waveform, autosave, and basic export
- Scene detection, silence detection, thumbnails, and a searchable local transcript
- A local Moment Scout shortlist: time range, category, explanation, preview, and component scores for hook, emotion, clarity, payoff, pacing, and standalone context
- A Tippy panel that answers “Where did I talk about GTA VI?” from the transcript, and “Find my best clips” from that shortlist

Clip creation, publishing, Planner, the full editor, and live model calls are not in this build.

## Account seam

The app stores one local owner id in `account.json` inside the app data directory. The label is “Waiting for the shared StreamersTip identity contract.” There is no second user table and no desktop OAuth flow. When the shared StreamersTip identity contract exists, this id is the seam that should attach to it.

## FFmpeg

Tippy calls `ffmpeg` and `ffprobe` on `PATH`. It does not vendor FFmpeg and does not pass `--enable-gpl`. Encodes use the built-in MPEG-4 Part 2 encoder (`mpeg4`) and the native AAC encoder, not `libx264`.

Install both binaries with the Ubuntu package:

```bash
sudo apt install ffmpeg
```

If they are missing, the project screen says so.

The in-app preview plays that MPEG-4 proxy through WebKitGTK’s GStreamer pipeline. The app serves the proxy from `127.0.0.1` because GStreamer cannot read Tauri’s `asset://` URLs. On Ubuntu, install the LGPL `gstreamer1.0-libav` package so the system can decode MPEG-4 Part 2 and AAC:

```bash
sudo apt install gstreamer1.0-libav
```

## Media intelligence

After import, Tippy detects scenes and silence locally, transcribes speech on this machine, and ranks a shortlist of moments from that transcript. Asking “Where did I talk about GTA VI?” returns a timestamp. Asking “Find my best clips” jumps to the first moment. There is no single viral score and no cloud model. Clip generation and publishing stay out of this phase.

Local transcription uses `whisper-cli` from whisper.cpp. Tippy looks for that binary on `PATH`, then in `~/.local/bin`. It looks for a ggml model in `TIPPY_WHISPER_MODEL`, then `~/.local/share/tippy/ggml-tiny.en.bin`, then `/usr/local/share/tippy/ggml-tiny.en.bin`. Without that binary and model, the transcript job fails closed and says so. Scene detection, silence detection, and the rest of the import still finish.

## Develop

```bash
npm install
npm run check
npm run tauri dev
```

`npm run check` runs the TypeScript check, frontend tests, and `cargo test`.

Optional: set `TIPPY_DATA_DIR` to keep project files in a chosen directory. When unset, Tauri uses the OS app data directory.
