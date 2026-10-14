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
import type { Job, MediaAsset, Moment, Project, TranscriptSegment } from "../types";

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
            onSeek={onSeek}
            onPlayhead={setPlayhead}
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
  transcriptError,
  onSeek,
  onPlayhead,
}: {
  media: MediaAsset;
  playhead: number;
  previewOrigin: string;
  seekToken: number;
  seekMs: number | null;
  segments: TranscriptSegment[];
  moments: Moment[];
  transcriptError: string | null;
  onSeek: (ms: number) => void;
  onPlayhead: (value: number) => void;
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
      <Moments moments={moments} onSeek={onSeek} />
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

function Moments({ moments, onSeek }: { moments: Moment[]; onSeek: (ms: number) => void }) {
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
                  <button type="button" onClick={() => onSeek(moment.startMs)}>
                    Preview
                  </button>
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
  const shown = ordered
    .map((type) => jobs.find((job) => job.type === type))
    .filter((job): job is Job => Boolean(job));
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
