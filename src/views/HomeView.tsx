import { FormEvent, useState } from "react";

import type { ProjectCard } from "../types";

interface HomeViewProps {
  projects: ProjectCard[];
  accountLabel: string;
  onCreate: (name: string) => Promise<void>;
  onOpen: (projectId: string) => void;
  onAsk: () => void;
}

export function HomeView({
  projects,
  accountLabel,
  onCreate,
  onOpen,
  onAsk,
}: HomeViewProps) {
  return (
    <section className="workspace">
      <header className="page-head">
        <p className="eyebrow">Creator hub</p>
        <h1>What should Tippy help you create today?</h1>
        <p className="lede">{accountLabel}</p>
      </header>
      <CreateCard onCreate={onCreate} />
      <button type="button" className="text-button" onClick={onAsk}>
        Ask Tippy
      </button>
      <ProjectList projects={projects} onOpen={onOpen} />
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
    if (!name.trim() || isSaving) {
      return;
    }
    setIsSaving(true);
    await onCreate(name.trim());
    setName("");
    setIsSaving(false);
  }

  return (
    <form className="panel create-card" onSubmit={(event) => void submit(event)}>
      <label htmlFor="project-name">New project</label>
      <div className="create-row">
        <input
          id="project-name"
          data-testid="new-project-name"
          value={name}
          placeholder="Project name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="primary"
          data-testid="create-project"
          disabled={isSaving || name.trim().length === 0}
        >
          New Project
        </button>
      </div>
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
      <p className="section-label">Projects</p>
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Create one to import a recording.</p>
      ) : (
        projects.map((project) => (
          <button
            key={project.projectId}
            type="button"
            className="project-card"
            onClick={() => onOpen(project.projectId)}
          >
            <strong>{project.name}</strong>
            <span>
              {project.error
                ? project.error
                : `${project.mediaCount} video${project.mediaCount === 1 ? "" : "s"}`}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
