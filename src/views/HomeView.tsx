import { FormEvent, useMemo, useState } from "react";

import type { ProjectCard } from "../types";

interface HomeViewProps {
  projects: ProjectCard[];
  accountLabel: string;
  onCreate: (name: string) => Promise<void>;
  onOpen: (projectId: string) => void;
  onAsk: () => void;
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

export function HomeView({
  projects,
  accountLabel,
  onCreate,
  onOpen,
  onAsk,
}: HomeViewProps) {
  const greeting = useMemo(() => greetingLine(), []);
  return (
    <section className="home-board" data-testid="home-board">
      <header className="home-widget home-greeting">
        <p className="brand-signal">StreamersTip · Tippy</p>
        <p className="greeting-kicker">{greeting.kicker}</p>
        <h1>{greeting.headline}</h1>
        <p className="lede">
          Tippy stays with you on this machine — create when it feels right.
        </p>
      </header>
      <aside className="home-widget home-local">
        <p className="section-label">On this machine</p>
        <strong>Local First</strong>
        <p className="lede">{accountLabel}</p>
      </aside>
      <CreateCard onCreate={onCreate} />
      <button type="button" className="home-widget home-ask" onClick={onAsk}>
        <p className="ask-strip-kicker">Tippy</p>
        <strong className="ask-strip-label">Ask Tippy</strong>
        <p className="lede">
          Moments, Shorts, cleanup — ask from the companion rail anytime.
        </p>
      </button>
      <div className="home-widget home-projects">
        <ProjectList projects={projects} onOpen={onOpen} />
      </div>
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
      className="home-widget create-card"
      onSubmit={(event) => void submit(event)}
    >
      <p className="section-label">New project</p>
      <label htmlFor="project-name">Name your next recording</label>
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
        className="primary new-project"
        data-testid="create-project"
        disabled={isSaving}
        onClick={(event) => void submit(event)}
      >
        New Project
      </button>
    </form>
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
        <p className="section-label">Recent</p>
        <span className="recent-count">
          {projects.length === 0
            ? "Nothing yet"
            : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Create one to import a recording.</p>
      ) : (
        <ul className="recent-list">
          {projects.map((project) => (
            <li key={project.projectId}>
              <button
                type="button"
                className="project-card"
                onClick={() => onOpen(project.projectId)}
              >
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
