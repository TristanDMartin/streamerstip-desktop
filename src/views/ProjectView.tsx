import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { Waveform } from "../components/Waveform";
import {
  formatBytes,
  formatDuration,
  formatWhen,
  jobLabel,
  jobPhase,
  phaseLabel,
  privacyLabel,
} from "../lib/format";
import type {
  ExportRecord,
  Job,
  MediaAsset,
  Moment,
  Project,
  Sequence,
  TranscriptSegment,
} from "../types";

interface ProjectViewProps {
  project: Project;
  engineReady: boolean;
  engineMessage: string;
  previewOrigin: string;
  seekToken: number;
  seekMs: number | null;
  onSeek: (ms: number) => void;
  onImport: () => Promise<void>;
  onExport: (mediaId: string) => Promise<void>;
  onCreateShort: (momentId: string) => Promise<void>;
  onUndoShort: (sequenceId: string) => Promise<void>;
  onAcceptShort: (sequenceId: string) => Promise<void>;
  onExportShort: (sequenceId: string) => Promise<void>;
}

export function ProjectView({
  project,
  engineReady,
  engineMessage,
  previewOrigin,
  seekToken,
  seekMs,
  onSeek,
  onImport,
  onExport,
  onCreateShort,
  onUndoShort,
  onAcceptShort,
  onExportShort,
}: ProjectViewProps) {
  const media = project.media[0] ?? null;
  const [playhead, setPlayhead] = useState(0);
  const canExport = Boolean(media?.probe) && engineReady;

  return (
    <section className="workspace project-view">
      <header className="project-header">
        <div>
          <p className="eyebrow">Project</p>
          <h1 data-testid="project-title">{project.name}</h1>
        </div>
        <div className="header-meta">
          <span className="pill">{privacyLabel(project.tippyContext.privacyMode)}</span>
          <span data-testid="autosave">Autosaved {formatWhen(project.updatedAt)}</span>
          <button
            type="button"
            className="ghost"
            data-testid="export-video"
            disabled={!canExport || !media}
            onClick={() => {
              if (media) {
                void onExport(media.mediaId);
              }
            }}
          >
            Export
          </button>
        </div>
      </header>
      {!engineReady ? <p className="banner">{engineMessage}</p> : null}
      <div className="overview-grid">
        <article className="panel">
          <p className="section-label">Overview</p>
          <dl className="facts">
            <div>
              <dt>Schema</dt>
              <dd>{project.schemaVersion}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd className="mono">{project.ownerId}</dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>{project.tippyContext.versions.length}</dd>
            </div>
          </dl>
          {project.tippyContext.versions.length > 0 ? (
            <ul className="version-list">
              {project.tippyContext.versions.map((version) => (
                <li key={version.versionId}>
                  <span>{version.label}</span>
                  <time>{formatWhen(version.createdAt)}</time>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
        <Pipeline jobs={project.jobs.filter((job) => media && job.mediaId === media.mediaId)} />
      </div>
      <article className="panel media-panel">
        <div className="media-toolbar">
          <p className="section-label">Media</p>
          <button
            type="button"
            className="primary"
            data-testid="import-video"
            disabled={!engineReady}
            onClick={() => void onImport()}
          >
            Import video
          </button>
        </div>
        {media ? (
          <MediaStage
            media={media}
            playhead={playhead}
            previewOrigin={previewOrigin}
            seekToken={seekToken}
            seekMs={seekMs}
            segments={project.transcript.segments}
            transcriptError={
              project.jobs.find(
                (job) => job.type === "transcribe_media" && job.state === "failed",
              )?.error ?? null
            }
            moments={project.moments}
            sequences={project.sequences}
            jobs={project.jobs}
            exports={project.exports}
            onSeek={onSeek}
            onPlayhead={setPlayhead}
            onCreateShort={onCreateShort}
            onUndoShort={onUndoShort}
            onAcceptShort={onAcceptShort}
            onExportShort={onExportShort}
          />
        ) : (
          <p className="empty">Import an MP4 to probe it, build a proxy, and preview it.</p>
        )}
      </article>
      {project.exports.length > 0 ? (
        <article className="panel">
          <p className="section-label">Exports</p>
          <ul className="export-list">
            {project.exports.map((item) => (
              <li key={item.exportId}>
                <span className="mono">{item.path}</span>
                <time>{formatWhen(item.createdAt)}</time>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function MediaStage({
  media,
  playhead,
  previewOrigin,
  seekToken,
  seekMs,
  segments,
  moments,
  sequences,
  jobs,
  exports,
  transcriptError,
  onSeek,
  onPlayhead,
  onCreateShort,
  onUndoShort,
  onAcceptShort,
  onExportShort,
}: {
  media: MediaAsset;
  playhead: number;
  previewOrigin: string;
  seekToken: number;
  seekMs: number | null;
  segments: TranscriptSegment[];
  moments: Moment[];
  sequences: Sequence[];
  jobs: Job[];
  exports: ExportRecord[];
  transcriptError: string | null;
  onSeek: (ms: number) => void;
  onPlayhead: (value: number) => void;
  onCreateShort: (momentId: string) => Promise<void>;
  onUndoShort: (sequenceId: string) => Promise<void>;
  onAcceptShort: (sequenceId: string) => Promise<void>;
  onExportShort: (sequenceId: string) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (seekMs == null || !videoRef.current) {
      return;
    }
    videoRef.current.currentTime = seekMs / 1000;
  }, [seekMs, seekToken]);
  const preview = media.proxyPath
    ? `${previewOrigin}/v/${encodeURIComponent(media.proxyPath)}`
    : "";
  const thumb = media.thumbnailPath ? convertFileSrc(media.thumbnailPath) : "";
  const probe = media.probe;

  return (
    <div className="media-stage">
      <div className="preview-frame">
        {preview && previewOrigin ? (
          <video
            ref={videoRef}
            key={preview}
            data-testid="preview"
            src={preview}
            poster={thumb || undefined}
            controls
            muted
            autoPlay
            onTimeUpdate={(event) => {
              const element = event.currentTarget;
              if (element.duration > 0) {
                onPlayhead(element.currentTime / element.duration);
              }
            }}
          />
        ) : (
          <p className="empty">Proxy preview appears when the proxy job finishes.</p>
        )}
      </div>
      <div className="media-side">
        {thumb ? <img src={thumb} alt="" className="thumb" /> : null}
        <h2>{media.fileName}</h2>
        {probe ? (
          <dl className="facts">
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(probe.durationMs)}</dd>
            </div>
            <div>
              <dt>Resolution</dt>
              <dd>
                {probe.width}×{probe.height}
              </dd>
            </div>
            <div>
              <dt>Frame rate</dt>
              <dd>{probe.frameRate.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd>{probe.videoCodec}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{probe.audioCodec || "None"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(probe.sizeBytes)}</dd>
            </div>
          </dl>
        ) : (
          <p className="empty">Waiting for probe metadata.</p>
        )}
      </div>
      <div className="waveform-wrap">
        <div className="waveform-label">
          <span>Waveform</span>
          <span>{probe ? formatDuration(probe.durationMs) : ""}</span>
        </div>
        {media.waveform.length > 0 ? (
          <Waveform peaks={media.waveform} progress={playhead} />
        ) : (
          <p className="empty">Waveform appears after the audio pass.</p>
        )}
      </div>
      <Moments moments={moments} jobs={jobs} onSeek={onSeek} onCreateShort={onCreateShort} />
      <Shorts
        sequences={sequences}
        jobs={jobs}
        exports={exports}
        previewOrigin={previewOrigin}
        sourcePreview={preview}
        onUndo={onUndoShort}
        onAccept={onAcceptShort}
        onExport={onExportShort}
      />
      <Analysis
        media={media}
        segments={segments}
        query={query}
        transcriptError={transcriptError}
        onQuery={setQuery}
        onSeek={onSeek}
      />
    </div>
  );
}

const SCORE_BARS: Array<{ key: keyof Moment["scores"]; label: string }> = [
  { key: "hookStrength", label: "Hook" },
  { key: "emotion", label: "Emotion" },
  { key: "clarity", label: "Clarity" },
  { key: "payoff", label: "Payoff" },
  { key: "pacing", label: "Pacing" },
  { key: "standaloneContext", label: "Context" },
];

function Moments({
  moments,
  jobs,
  onSeek,
  onCreateShort,
}: {
  moments: Moment[];
  jobs: Job[];
  onSeek: (ms: number) => void;
  onCreateShort: (momentId: string) => Promise<void>;
}) {
  return (
    <div className="moment-block" data-testid="moments">
      <div className="waveform-label">
        <span>Moments</span>
        <span>{moments.length}</span>
      </div>
      {moments.length > 0 ? (
        <ul className="moment-list">
          {moments.map((moment) => (
            <li key={moment.momentId}>
              <article className="moment-card">
                {moment.previewPath ? (
                  <img src={convertFileSrc(moment.previewPath)} alt="" />
                ) : (
                  <span className="moment-still" />
                )}
                <div className="moment-copy">
                  <p className="moment-kicker">
                    <em>Tippy</em>
                    <strong>{moment.category}</strong>
                    <time>
                      {formatDuration(moment.startMs)}–{formatDuration(moment.endMs)}
                    </time>
                  </p>
                  <p className="moment-quote">“{moment.quote}”</p>
                  <p className="moment-why">{moment.explanation}</p>
                  <ul className="score-bars">
                    {SCORE_BARS.map((bar) => {
                      const value = moment.scores[bar.key];
                      return (
                        <li key={bar.key}>
                          <span>{bar.label}</span>
                          <span className="bar" aria-hidden="true">
                            <span style={{ width: `${Math.round(value * 100)}%` }} />
                          </span>
                          <span className="bar-value">{value.toFixed(2)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="moment-actions">
                    <button type="button" onClick={() => onSeek(moment.startMs)}>
                      Preview
                    </button>
                    <button
                      type="button"
                      data-testid={`create-short-${moment.momentId}`}
                      onClick={() => void onCreateShort(moment.momentId)}
                    >
                      Create Short
                    </button>
                    <ShortProgress jobs={jobs} momentId={moment.momentId} />
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">Moments appear after the local scout pass.</p>
      )}
    </div>
  );
}

function ShortProgress({ jobs, momentId }: { jobs: Job[]; momentId: string }) {
  const job = jobs.find(
    (item) =>
      item.type === "create_short" &&
      item.subjectId === momentId &&
      (item.state === "queued" || item.state === "running" || item.state === "retrying"),
  );
  if (!job) {
    return null;
  }
  const width = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  return (
    <span className="short-progress" data-testid="short-progress">
      {jobLabel(job.type)} {width}%
    </span>
  );
}

function Shorts({
  sequences,
  jobs,
  exports,
  previewOrigin,
  sourcePreview,
  onUndo,
  onAccept,
  onExport,
}: {
  sequences: Sequence[];
  jobs: Job[];
  exports: ExportRecord[];
  previewOrigin: string;
  sourcePreview: string;
  onUndo: (sequenceId: string) => Promise<void>;
  onAccept: (sequenceId: string) => Promise<void>;
  onExport: (sequenceId: string) => Promise<void>;
}) {
  const shorts = sequences.filter(
    (sequence) => sequence.variation === "original" || sequence.variation === "tippy",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    shorts.find((sequence) => sequence.sequenceId === selectedId) ??
    shorts.find((sequence) => sequence.variation === "tippy") ??
    shorts[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewPath = selected?.previewPath ?? "";
  const portrait =
    selected?.variation === "tippy" && previewPath && previewOrigin
      ? `${previewOrigin}/v/${encodeURIComponent(previewPath)}`
      : "";
  const selectedIdLive = selected?.sequenceId ?? "";
  const selectedVariation = selected?.variation ?? "";
  const selectedStart = selected?.sourceStartMs ?? 0;
  const captionStart = selected?.captions[0]?.startMs ?? 0;
  const previewStamp =
    jobs.find(
      (job) =>
        job.state === "completed" &&
        ((job.type === "refresh_short" && job.subjectId === selectedIdLive) ||
          (job.type === "create_short" && job.subjectId === selected?.momentId)),
    )?.completedAt ?? "";
  useEffect(() => {
    if (!selectedIdLive || !videoRef.current) {
      return;
    }
    const at =
      selectedVariation === "original" ? selectedStart / 1000 : Math.max(0, captionStart / 1000);
    videoRef.current.currentTime = at;
  }, [selectedIdLive, selectedVariation, selectedStart, captionStart, portrait, previewStamp]);
  if (shorts.length === 0) {
    return null;
  }
  const running = jobs.filter(
    (job) =>
      (job.type === "create_short" || job.type === "refresh_short" || job.type === "export_short") &&
      (job.state === "queued" || job.state === "running" || job.state === "retrying"),
  );
  const canUndo = selected?.changes.some((change) => !change.undone) ?? false;
  return (
    <div className="shorts-block" data-testid="shorts">
      <div className="waveform-label">
        <span>Shorts</span>
        <span>{shorts.length}</span>
      </div>
      <div className="short-picker" role="listbox" aria-label="Short variations">
        {shorts.map((sequence) => {
          const active = sequence.sequenceId === selected?.sequenceId;
          return (
            <button
              key={sequence.sequenceId}
              type="button"
              role="option"
              aria-selected={active}
              className={
                sequence.variation === "tippy"
                  ? active
                    ? "short-choice tippy selected"
                    : "short-choice tippy"
                  : active
                    ? "short-choice selected"
                    : "short-choice"
              }
              onClick={() => setSelectedId(sequence.sequenceId)}
            >
              {sequence.name}
            </button>
          );
        })}
      </div>
      {running.length > 0 ? (
        <ul className="short-jobs">
          {running.map((job) => (
            <li key={job.jobId}>
              {jobLabel(job.type)} {Math.round(job.progress * 100)}%
            </li>
          ))}
        </ul>
      ) : null}
      {selected ? (
        <div className="short-layout">
          <div className={portrait ? "short-stage portrait" : "short-stage"}>
            {portrait || sourcePreview ? (
              <video
                ref={videoRef}
                key={`${portrait || sourcePreview}|${previewStamp}|${selected.aspectRatio}|${selected.captions.length}`}
                data-testid="short-preview"
                src={portrait ? `${portrait}?t=${encodeURIComponent(previewStamp || selected.sequenceId)}` : sourcePreview}
                controls
                muted
                onLoadedMetadata={(event) => {
                  const at =
                    selected.variation === "original"
                      ? selected.sourceStartMs / 1000
                      : Math.max(0, (selected.captions[0]?.startMs ?? 0) / 1000);
                  event.currentTarget.currentTime = at;
                }}
              />
            ) : (
              <p className="empty">The Short preview appears when the render finishes.</p>
            )}
          </div>
          <div className="review-changes" data-testid="review-changes">
            <p className="section-label">Review Changes</p>
            <ul>
              {selected.changes.map((change) => (
                <li
                  key={change.changeId}
                  className={change.undone ? "undone" : change.accepted ? "accepted" : ""}
                >
                  {change.label}
                </li>
              ))}
            </ul>
            <div className="moment-actions">
              <button
                type="button"
                data-testid="undo-change"
                disabled={!canUndo}
                onClick={() => void onUndo(selected.sequenceId)}
              >
                Undo
              </button>
              <button
                type="button"
                data-testid="accept-changes"
                onClick={() => void onAccept(selected.sequenceId)}
              >
                Accept all
              </button>
              <button
                type="button"
                data-testid="export-short"
                disabled={!portrait && selected.variation === "tippy"}
                onClick={() => void onExport(selected.sequenceId)}
              >
                Export this Short
              </button>
            </div>
            {exports
              .filter((item) => item.sequenceId === selected.sequenceId)
              .map((item) => (
                <p key={item.exportId} className="short-export" data-testid="short-export-path">
                  Exported {item.path}
                </p>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Analysis({
  media,
  segments,
  query,
  transcriptError,
  onQuery,
  onSeek,
}: {
  media: MediaAsset;
  segments: TranscriptSegment[];
  query: string;
  transcriptError: string | null;
  onQuery: (value: string) => void;
  onSeek: (ms: number) => void;
}) {
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? segments.filter((segment) => segment.text.toLowerCase().includes(needle))
    : segments;
  return (
    <>
      {media.scenes.length > 0 ? (
        <div className="scene-row" data-testid="scenes">
          {media.scenes.map((scene) => (
            <button
              key={`${scene.startMs}-${scene.endMs}`}
              type="button"
              className="scene-card"
              onClick={() => onSeek(scene.startMs)}
            >
              {scene.thumbnailPath ? (
                <img src={convertFileSrc(scene.thumbnailPath)} alt="" />
              ) : null}
              <span>{formatDuration(scene.startMs)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {media.silences.length > 0 ? (
        <p className="silence-line" data-testid="silences">
          Silence{" "}
          {media.silences
            .map((span) => `${formatDuration(span.startMs)}–${formatDuration(span.endMs)}`)
            .join(", ")}
        </p>
      ) : null}
      <div className="transcript" data-testid="transcript">
        <div className="waveform-label">
          <span>Transcript</span>
          <span>{shown.length}</span>
        </div>
        <input
          type="text"
          value={query}
          placeholder="Search the transcript"
          aria-label="Search the transcript"
          data-testid="transcript-search"
          onChange={(event) => onQuery(event.target.value)}
        />
        {transcriptError ? <p className="empty">{transcriptError}</p> : null}
        {shown.length > 0 ? (
          <ul className="transcript-list">
            {shown.map((segment) => (
              <li key={segment.segmentId}>
                <button type="button" onClick={() => onSeek(segment.startMs)}>
                  <time>{formatDuration(segment.startMs)}</time>
                  <span>{segment.text}</span>
                  {segment.profanity ? <em>Flagged</em> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">
            {segments.length === 0
              ? "The transcript appears after the local speech pass."
              : "No transcript lines match that search."}
          </p>
        )}
      </div>
    </>
  );
}

function Pipeline({ jobs }: { jobs: Job[] }) {
  const ordered = [
    "probe_media",
    "create_proxy",
    "extract_audio",
    "create_thumbnail",
    "detect_scenes",
    "detect_silence",
    "transcribe_media",
    "scout_moments",
    "create_export",
  ];
  const shown = [
    ...ordered
      .map((type) => jobs.find((job) => job.type === type))
      .filter((job): job is Job => Boolean(job)),
    ...jobs.filter(
      (job) =>
        job.type === "create_short" || job.type === "refresh_short" || job.type === "export_short",
    ),
  ];
  if (shown.length === 0) {
    return null;
  }
  return (
    <article className="panel">
      <p className="section-label">Processing</p>
      <ul className="pipeline">
        {shown.map((job) => {
          const phase = jobPhase(job.state);
          return (
            <li key={job.jobId} className={`phase-${phase}`}>
              <span className="mark" aria-hidden="true" />
              <span>{jobLabel(job.type)}</span>
              <em>{phaseLabel(phase)}</em>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
