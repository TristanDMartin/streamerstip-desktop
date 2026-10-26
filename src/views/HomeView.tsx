import { FormEvent, useEffect, useMemo, useState } from "react";

import { TIPPY_NOT_CONNECTED } from "../components/TippyRail";
import type { ProjectCard } from "../types";

const SUGGESTIONS = [
  "Where did I talk about GTA VI?",
  "Find my best clips",
  "Create 4 Shorts",
  "Remove dead space",
];

interface HomeViewProps {
  projects: ProjectCard[];
  accountLabel: string;
  onCreate: (name: string) => Promise<void>;
  onOpen: (projectId: string) => void;
  onAskTippy: (text: string) => Promise<string>;
}

function greetingLine(): { kicker: string; headline: string } {
  const hour = new Date().getHours();
  if (hour < 12) {
    return { kicker: "Good morning", headline: "You've got this." };
  }
  if (hour < 18) {
    return { kicker: "Good afternoon", headline: "Ready when you are." };
  }
  return { kicker: "Good evening", headline: "Let's make something calm." };
}

function formatClock(now: Date): { time: string; date: string } {
  const time = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return { time, date };
}

export function HomeView({
  projects,
  accountLabel,
  onCreate,
  onOpen,
  onAskTippy,
}: HomeViewProps) {
  const greeting = useMemo(() => greetingLine(), []);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = formatClock(now);
  return (
    <section className="home-board" data-testid="home-board">
      <header className="home-widget home-greeting">
        <p className="greeting-kicker">{greeting.kicker}</p>
        <h1>{greeting.headline}</h1>
        <p className="lede">
          A calmer edit. Same Tippy hustle, kinder pace on this machine.
        </p>
      </header>
      <aside className="home-widget home-clock">
        <p className="clock-time">{clock.time}</p>
        <p className="clock-date">{clock.date}</p>
        <p className="clock-status">
          <span className="clock-dot" aria-hidden="true" />
          Local First · {accountLabel}
        </p>
      </aside>
      <div className="home-widget home-projects">
        <ProjectList projects={projects} onOpen={onOpen} />
      </div>
      <CreateCard onCreate={onCreate} />
      <AskTippyCard onAskTippy={onAskTippy} />
      <aside className="home-widget home-inspire" aria-label="Tippy note">
        <p className="inspire-quote">Progress over perfection.</p>
        <p className="inspire-by">— Tippy</p>
      </aside>
    </section>
  );
}

export function CreateCard({
  onCreate,
}: {
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isSaving) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      await onCreate("");
      return;
    }
    setIsSaving(true);
    try {
      await onCreate(trimmed);
      setName("");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      className="home-widget home-focus"
      onSubmit={(event) => void submit(event)}
    >
      <p className="section-label">Start</p>
      <p className="focus-title">New project</p>
      <label htmlFor="project-name" className="focus-label">
        Name your next recording
      </label>
      <input
        id="project-name"
        data-testid="new-project-name"
        value={name}
        placeholder="Project name"
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="button"
        className="focus-play"
        data-testid="create-project"
        disabled={isSaving}
        aria-label="New Project"
        onClick={(event) => void submit(event)}
      >
        <span className="focus-play-icon" aria-hidden="true" />
      </button>
      <p className="focus-caption">Begin when it feels right</p>
    </form>
  );
}

function AskTippyCard({
  onAskTippy,
}: {
  onAskTippy: (text: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState(TIPPY_NOT_CONNECTED);
  const [isSending, setIsSending] = useState(false);

  async function submit() {
    const text = draft.trim();
    if (!text || isSending) {
      return;
    }
    setIsSending(true);
    const message = await onAskTippy(text);
    setReply(message);
    setIsSending(false);
  }

  return (
    <div className="home-widget home-ask">
      <p className="section-label">Ask Tippy</p>
      <p className="ask-title">What are we making?</p>
      <div className="ask-suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="ask-chip"
            onClick={() => setDraft(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <textarea
        id="tippy-composer"
        data-testid="tippy-composer"
        value={draft}
        placeholder="Ask Tippy…"
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        className="tippy-submit"
        data-testid="tippy-submit"
        disabled={isSending || draft.trim().length === 0}
        onClick={() => {
          void submit();
        }}
      >
        Ask Tippy
      </button>
      <p className="tippy-reply" data-testid="tippy-reply">
        {reply}
      </p>
    </div>
  );
}

export function ProjectList({
  projects,
  onOpen,
}: {
  projects: ProjectCard[];
  onOpen: (projectId: string) => void;
}) {
  return (
    <div className="project-list">
      <div className="recent-head">
        <p className="section-label">Today</p>
        <span className="recent-count">
          {projects.length === 0
            ? "0 projects"
            : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Start one when you are ready.</p>
      ) : (
        <ul className="recent-list">
          {projects.map((project) => (
            <li key={project.projectId}>
              <button
                type="button"
                className="project-card"
                onClick={() => onOpen(project.projectId)}
              >
                <span className="project-mark" aria-hidden="true" />
                <strong>{project.name}</strong>
                <span>
                  {project.error
                    ? project.error
                    : `${project.mediaCount} video${
                        project.mediaCount === 1 ? "" : "s"
                      }`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
