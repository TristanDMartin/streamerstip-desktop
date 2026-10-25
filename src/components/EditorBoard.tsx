import { useEffect, useRef, useState } from "react";

import type { EditorClip, Project, TimelineEdit } from "../types";

const TRACKS = [
  { id: "v1", label: "Video 1" },
  { id: "v2", label: "Video 2" },
  { id: "a1", label: "Audio 1" },
  { id: "a2", label: "Audio 2" },
] as const;

const PUNCH_MS = 800;

interface EditorBoardProps {
  project: Project;
  previewOrigin: string;
  onEdit: (edit: TimelineEdit) => Promise<void>;
}

export function EditorBoard({ project, previewOrigin, onEdit }: EditorBoardProps) {
  const sequence =
    project.sequences.find(
      (item) => item.variation === "" && item.momentId === "",
    ) ?? null;
  const media = project.media[0] ?? null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [note, setNote] = useState("");
  const caption = sequence?.captions[0] ?? null;
  const [captionText, setCaptionText] = useState(caption?.text ?? "");
  const [captionStart, setCaptionStart] = useState(caption?.startMs ?? 0);
  const [captionEnd, setCaptionEnd] = useState(caption?.endMs ?? 2000);
  const [overlayText, setOverlayText] = useState(sequence?.editor.overlayText ?? "");

  useEffect(() => {
    setCaptionText(caption?.text ?? "");
    setCaptionStart(caption?.startMs ?? 0);
    setCaptionEnd(caption?.endMs ?? 2000);
  }, [caption?.captionId, caption?.text, caption?.startMs, caption?.endMs]);

  useEffect(() => {
    setOverlayText(sequence?.editor.overlayText ?? "");
  }, [sequence?.sequenceId, sequence?.editor.overlayText]);

  const clips = sequence?.editor.clips ?? [];
  const duration = Math.max(
    media?.probe?.durationMs ?? 0,
    ...clips.map((clip) => clipEnd(clip)),
    1000,
  );
  const selected =
    clips.find((clip) => clip.clipId === selectedId) ??
    clips.find((clip) => clip.track === "v1") ??
    null;
  const audio =
    clips.find((clip) => clip.clipId === selectedId && isAudio(clip.track)) ??
    clips.find((clip) => clip.track === "a1") ??
    null;
  const punching =
    Boolean(sequence?.editor.punchIn) &&
    playhead >= (sequence?.editor.punchInMs ?? 0) &&
    playhead < (sequence?.editor.punchInMs ?? 0) + PUNCH_MS;
  const showCaption =
    caption != null &&
    playhead >= caption.startMs &&
    playhead < caption.endMs &&
    caption.text.trim().length > 0;
  const showOverlay =
    (sequence?.editor.overlayText.trim().length ?? 0) > 0 &&
    playhead >= (sequence?.editor.overlayStartMs ?? 0) &&
    playhead < (sequence?.editor.overlayEndMs ?? 0);
  const preview =
    media?.proxyPath && previewOrigin
      ? `${previewOrigin}/v/${encodeURIComponent(media.proxyPath)}`
      : "";
  const latest = project.tippyContext.versions.at(-1);

  useEffect(() => {
    if (videoRef.current && audio) {
      videoRef.current.volume = audio.volume;
    }
  }, [audio?.clipId, audio?.volume]);

  async function run(edit: TimelineEdit) {
    setNote("");
    try {
      await onEdit(edit);
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play();
      return;
    }
    video.pause();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (event.code === "Space" && !typing) {
        event.preventDefault();
        togglePlay();
        return;
      }
      if (typing) {
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        if (selected) {
          void run({ op: "split", clipId: selected.clipId, atMs: Math.round(playhead) });
        }
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (selected) {
          void run({ op: "delete", clipId: selected.clipId });
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void run({ op: "undo" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function seek(ms: number) {
    const next = Math.max(0, Math.min(duration, ms));
    setPlayhead(next);
    if (videoRef.current) {
      videoRef.current.currentTime = next / 1000;
    }
  }

  if (!sequence) {
    return (
      <section className="panel editor" data-testid="editor">
        <p className="section-label">Editor</p>
        <p className="empty">Import a video to open the timeline.</p>
      </section>
    );
  }

  const stageClass = [
    "editor-stage",
    sequence.editor.crop === "center" ? "cropped" : "",
    punching ? "punched" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="panel editor" data-testid="editor">
      <div className="editor-head">
        <p className="section-label">Editor</p>
        <p className="editor-version" data-testid="editor-version">
          {latest ? latest.label : "No saved version yet"}
        </p>
      </div>
      <div className={stageClass}>
        {preview ? (
          <video
            ref={videoRef}
            className="editor-video"
            data-testid="editor-preview"
            src={preview}
            onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime * 1000)}
            onClick={togglePlay}
          />
        ) : (
          <p className="empty">The preview appears after the proxy is ready.</p>
        )}
        {showCaption ? <p className="editor-caption">{caption?.text}</p> : null}
        {showOverlay ? (
          <p className="editor-overlay">{sequence.editor.overlayText}</p>
        ) : null}
      </div>
      <div className="editor-tools">
        <button type="button" className="ghost" onClick={togglePlay}>
          Play
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="split-clip"
          onClick={() => {
            if (selected) {
              void run({ op: "split", clipId: selected.clipId, atMs: Math.round(playhead) });
            }
          }}
        >
          Split
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="delete-clip"
          onClick={() => {
            if (selected) {
              void run({ op: "delete", clipId: selected.clipId });
            }
          }}
        >
          Delete
        </button>
        <button
          type="button"
          className="ghost"
          data-testid="undo-edit"
          onClick={() => void run({ op: "undo" })}
        >
          Undo
        </button>
        <button
          type="button"
          className={sequence.editor.crop === "center" ? "ghost on" : "ghost"}
          data-testid="crop-toggle"
          onClick={() =>
            void run({ op: "set_crop", enabled: sequence.editor.crop !== "center" })
          }
        >
          Crop
        </button>
        <button
          type="button"
          className={sequence.editor.punchIn ? "ghost on" : "ghost"}
          data-testid="punch-toggle"
          onClick={() =>
            void run({
              op: "set_punch_in",
              enabled: !sequence.editor.punchIn,
              atMs: Math.round(playhead),
            })
          }
        >
          Punch-in
        </button>
        <button
          type="button"
          className={sequence.editor.transition === "cut" ? "ghost on" : "ghost"}
          data-testid="transition-cut"
          onClick={() => void run({ op: "set_transition", kind: "cut" })}
        >
          Cut
        </button>
        <button
          type="button"
          className={sequence.editor.transition === "crossfade" ? "ghost on" : "ghost"}
          data-testid="transition-crossfade"
          onClick={() => void run({ op: "set_transition", kind: "crossfade" })}
        >
          Crossfade
        </button>
        <button
          type="button"
          className="primary"
          data-testid="save-version"
          onClick={() => void run({ op: "save_version" })}
        >
          Save Version
        </button>
      </div>
      <p className="editor-keys">Space play/pause · S split · Delete · Ctrl+Z undo</p>
      <div className="editor-fields">
        <label>
          Caption
          <input
            data-testid="caption-text"
            value={captionText}
            onChange={(event) => setCaptionText(event.target.value)}
            onBlur={() =>
              void run({
                op: "set_caption",
                captionId: caption?.captionId ?? "",
                text: captionText,
                startMs: captionStart,
                endMs: captionEnd,
              })
            }
          />
        </label>
        <label>
          Start
          <input
            type="number"
            min={0}
            step={0.1}
            value={(captionStart / 1000).toFixed(1)}
            onChange={(event) => setCaptionStart(Math.round(Number(event.target.value) * 1000))}
            onBlur={() =>
              void run({
                op: "set_caption",
                captionId: caption?.captionId ?? "",
                text: captionText,
                startMs: captionStart,
                endMs: captionEnd,
              })
            }
          />
        </label>
        <label>
          End
          <input
            type="number"
            min={0}
            step={0.1}
            value={(captionEnd / 1000).toFixed(1)}
            onChange={(event) => setCaptionEnd(Math.round(Number(event.target.value) * 1000))}
            onBlur={() =>
              void run({
                op: "set_caption",
                captionId: caption?.captionId ?? "",
                text: captionText,
                startMs: captionStart,
                endMs: captionEnd,
              })
            }
          />
        </label>
        <label>
          Text overlay
          <input
            data-testid="overlay-text"
            value={overlayText}
            onChange={(event) => setOverlayText(event.target.value)}
            onBlur={() =>
              void run({
                op: "set_overlay",
                text: overlayText,
                startMs: sequence.editor.overlayStartMs,
                endMs: sequence.editor.overlayEndMs || 2000,
              })
            }
          />
        </label>
        <label>
          Audio volume
          <input
            data-testid="audio-volume"
            type="range"
            min={0}
            max={100}
            value={Math.round((audio?.volume ?? 1) * 100)}
            onChange={(event) => {
              const video = videoRef.current;
              if (video) {
                video.volume = Number(event.target.value) / 100;
              }
            }}
            onPointerUp={(event) => {
              if (!audio) {
                return;
              }
              void run({
                op: "set_volume",
                clipId: audio.clipId,
                volume: Number(event.currentTarget.value) / 100,
              });
            }}
          />
        </label>
      </div>
      {note ? <p className="editor-note">{note}</p> : null}
      <div className="timeline" data-testid="timeline">
        {TRACKS.map((track) => (
          <TrackLane
            key={track.id}
            label={track.label}
            clips={clips.filter((clip) => clip.track === track.id)}
            duration={duration}
            selectedId={selected?.clipId ?? ""}
            transition={track.id === "v1" ? sequence.editor.transition : ""}
            onSelect={(clipId, ms) => {
              setSelectedId(clipId);
              seek(ms);
            }}
          />
        ))}
        <TrackLane
          label="Captions"
          clips={[]}
          duration={duration}
          selectedId=""
          transition=""
          caption={caption}
          onSelect={(_clipId, ms) => seek(ms)}
        />
      </div>
    </section>
  );
}

function TrackLane({
  label,
  clips,
  duration,
  selectedId,
  transition,
  caption,
  onSelect,
}: {
  label: string;
  clips: EditorClip[];
  duration: number;
  selectedId: string;
  transition: string;
  caption?: { startMs: number; endMs: number; text: string } | null;
  onSelect: (clipId: string, ms: number) => void;
}) {
  return (
    <div className="track">
      <span>{label}</span>
      <div
        className="track-lane"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          onSelect("", Math.round(ratio * duration));
        }}
      >
        {clips.map((clip) => {
          const span = Math.max(40, clip.sourceOutMs - clip.sourceInMs);
          const left = (clip.timelineInMs / duration) * 100;
          const width = (span / duration) * 100;
          return (
            <button
              key={clip.clipId}
              type="button"
              className={clip.clipId === selectedId ? "clip-bar selected" : "clip-bar"}
              style={{ left: `${left}%`, width: `${Math.max(width, 4)}%` }}
              onClick={(event) => {
                event.stopPropagation();
                const lane = event.currentTarget.parentElement?.getBoundingClientRect();
                const rect = lane ?? event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / rect.width;
                onSelect(clip.clipId, Math.round(Math.max(0, Math.min(1, ratio)) * duration));
              }}
            >
              {label.startsWith("Audio") ? `${Math.round(clip.volume * 100)}%` : label}
            </button>
          );
        })}
        {caption ? (
          <button
            type="button"
            className="clip-bar caption-bar"
            style={{
              left: `${(caption.startMs / duration) * 100}%`,
              width: `${Math.max(((caption.endMs - caption.startMs) / duration) * 100, 8)}%`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect("", caption.startMs);
            }}
          >
            {caption.text || "Caption"}
          </button>
        ) : null}
        {transition && clips.length > 1 ? (
          <em className="transition-mark">{transition === "crossfade" ? "Crossfade" : "Cut"}</em>
        ) : null}
      </div>
    </div>
  );
}

function clipEnd(clip: EditorClip): number {
  return clip.timelineInMs + Math.max(0, clip.sourceOutMs - clip.sourceInMs);
}

function isAudio(track: string): boolean {
  return track === "a1" || track === "a2";
}
