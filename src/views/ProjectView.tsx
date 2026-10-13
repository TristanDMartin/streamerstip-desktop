import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";

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
import type { Job, MediaAsset, Project } from "../types";

interface ProjectViewProps {
  project: Project;
  engineReady: boolean;
  engineMessage: string;
  previewOrigin: string;
  onImport: () => Promise<void>;
  onExport: (mediaId: string) => Promise<void>;
}

export function ProjectView({
  project,
  engineReady,
  engineMessage,
  previewOrigin,
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
  onPlayhead,
}: {
  media: MediaAsset;
  playhead: number;
  previewOrigin: string;
  onPlayhead: (value: number) => void;
}) {
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
    </div>
  );
}

function Pipeline({ jobs }: { jobs: Job[] }) {
  const ordered = ["probe_media", "create_proxy", "extract_audio", "create_thumbnail", "create_export"];
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
