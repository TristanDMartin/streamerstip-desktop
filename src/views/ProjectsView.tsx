import { CreateCard, ProjectList } from "./HomeView";
import type { ProjectCard } from "../types";

interface ProjectsViewProps {
  projects: ProjectCard[];
  onCreate: (name: string) => Promise<void>;
  onOpen: (projectId: string) => void;
}

export function ProjectsView({ projects, onCreate, onOpen }: ProjectsViewProps) {
  return (
    <section className="workspace">
      <header className="page-head">
        <p className="eyebrow">Projects</p>
        <h1>Local projects</h1>
        <p className="lede">Projects stay on this machine. Cloud sync is not connected.</p>
      </header>
      <CreateCard onCreate={onCreate} />
      <ProjectList projects={projects} onOpen={onOpen} />
    </section>
  );
}
