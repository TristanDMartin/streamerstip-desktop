import { jobLabel, jobPhase, phaseLabel } from "../lib/format";
import type { JobListItem } from "../types";

interface JobBarProps {
  jobs: JobListItem[];
  onCancel: (job: JobListItem) => void;
}

export function JobBar({ jobs, onCancel }: JobBarProps) {
  const visible = jobs.slice(0, 8);
  return (
    <footer className="job-bar" data-testid="job-bar" role="status">
      <span className="job-bar-label">Processing</span>
      {visible.length === 0 ? (
        <span className="job-empty">No background work</span>
      ) : (
        <div className="job-scroll">
          {visible.map((job) => {
            const phase = jobPhase(job.state);
            const width = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
            return (
              <article key={job.jobId} className={`job-chip phase-${phase}`}>
                <div className="job-chip-copy">
                  <strong>{jobLabel(job.jobType)}</strong>
                  <span>{job.projectName}</span>
                </div>
                <div className="job-track" aria-hidden="true">
                  <span style={{ width: `${phase === "done" ? 100 : width}%` }} />
                </div>
                <em>{phaseLabel(phase)}</em>
                {phase === "failed" && job.error ? (
                  <span className="job-error" title={job.error}>
                    {job.error}
                  </span>
                ) : null}
                {phase === "queued" || phase === "running" ? (
                  <button type="button" onClick={() => onCancel(job)}>
                    Cancel
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </footer>
  );
}
