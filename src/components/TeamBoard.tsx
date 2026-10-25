import { workerCards, jobHistory } from "../lib/team";
import type { Job } from "../types";

interface TeamBoardProps {
  jobs: Job[];
  onPause: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
}

export function TeamBoard({ jobs, onPause, onResume, onCancel, onRetry }: TeamBoardProps) {
  const cards = workerCards(jobs);
  const history = jobHistory(jobs);
  if (cards.length === 0) {
    return null;
  }
  return (
    <section className="team-board" data-testid="tippy-team">
      <div className="waveform-label">
        <span>Tippy team</span>
        <span>{cards.filter((card) => card.tone === "running").length} running</span>
      </div>
      <div className="worker-grid">
        {cards.map((card) => {
          const width = Math.round(Math.min(1, Math.max(0, card.progress)) * 100);
          return (
            <article key={card.id} className={`worker-card tone-${card.tone}`} data-testid={`worker-${card.id}`}>
              <header>
                <strong>{card.name}</strong>
                <em>{card.label}</em>
              </header>
              <div className="job-track" aria-hidden="true">
                <span style={{ width: `${card.tone === "done" ? 100 : width}%` }} />
              </div>
              {card.explanation ? <p>{card.explanation}</p> : null}
              {card.detail ? <p className="worker-detail">{card.detail}</p> : null}
              <div className="worker-actions">
                {card.canPause && card.jobId ? (
                  <button type="button" onClick={() => onPause(card.jobId!)}>
                    Pause
                  </button>
                ) : null}
                {card.canResume && card.jobId ? (
                  <button type="button" onClick={() => onResume(card.jobId!)}>
                    Resume
                  </button>
                ) : null}
                {card.canCancel && card.jobId ? (
                  <button type="button" onClick={() => onCancel(card.jobId!)}>
                    Cancel
                  </button>
                ) : null}
                {card.canRetry && card.jobId ? (
                  <button type="button" onClick={() => onRetry(card.jobId!)}>
                    Retry
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <div className="job-history" data-testid="job-history">
        <p className="section-label">Job history</p>
        <ul>
          {history.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.title}</strong>
              <span>{entry.label}</span>
              {entry.explanation ? <em>{entry.explanation}</em> : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
