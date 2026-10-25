import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelJob,
  pauseJob,
  resumeJob,
  retryJob,
  createProject,
  acceptShortChanges,
  createShort,
  exportShort,
  exportVideo,
  getAppMeta,
  importVideo,
  listWorkspace,
  onTippyEvent,
  openProject,
  pickVideo,
  submitTippy,
  undoShortChange,
} from "./api";
import { JobBar } from "./components/JobBar";
import {
  IconAnalytics,
  IconBrand,
  IconHome,
  IconLibrary,
  IconPlanner,
  IconPlus,
  IconProjects,
  IconReview,
  IconUser,
} from "./components/Icons";
import { TIPPY_NOT_CONNECTED, TippyRail } from "./components/TippyRail";
import { workerCards } from "./lib/team";
import type { AppMeta, JobListItem, Project, ProjectCard } from "./types";
import { HomeView } from "./views/HomeView";
import { ProjectView } from "./views/ProjectView";
import { ProjectsView } from "./views/ProjectsView";

type Route =
  | { name: "home" }
  | { name: "projects" }
  | { name: "project"; projectId: string };

const NAV = [
  { id: "home", label: "Home", icon: IconHome, enabled: true },
  { id: "projects", label: "Projects", icon: IconProjects, enabled: true },
  { id: "create", label: "Create", icon: IconPlus, enabled: true },
  { id: "review", label: "Review", icon: IconReview, enabled: false },
  { id: "planner", label: "Planner", icon: IconPlanner, enabled: false },
  { id: "analytics", label: "Analytics", icon: IconAnalytics, enabled: false },
  { id: "library", label: "Library", icon: IconLibrary, enabled: false },
  { id: "brand", label: "Brand Kit", icon: IconBrand, enabled: false },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seek, setSeek] = useState<{ ms: number; token: number } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const routeRef = useRef(route);
  const workspaceGen = useRef(0);
  const projectGen = useRef(0);
  routeRef.current = route;

  const refreshWorkspace = useCallback(async () => {
    const gen = ++workspaceGen.current;
    const workspace = await listWorkspace();
    if (gen !== workspaceGen.current) {
      return;
    }
    setProjects(workspace.projects);
    setJobs(workspace.jobs);
  }, []);

  const refreshOpenProject = useCallback(async (projectId: string) => {
    const gen = ++projectGen.current;
    const next = await openProject(projectId);
    if (gen !== projectGen.current) {
      return;
    }
    setProject(next);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer = 0;
    void (async () => {
      try {
        const [nextMeta] = await Promise.all([getAppMeta(), refreshWorkspace()]);
        setMeta(nextMeta);
        unlisten = await onTippyEvent(() => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            void refreshWorkspace().catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
            });
            const current = routeRef.current;
            if (current.name === "project") {
              void refreshOpenProject(current.projectId).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }
          }, 120);
        });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [refreshOpenProject, refreshWorkspace]);

  useEffect(() => {
    const active = jobs.some((job) => {
      const state = job.state;
      return (
        state === "queued" ||
        state === "ready" ||
        state === "running" ||
        state === "retrying" ||
        state === "planning" ||
        state === "waiting_for_dependency" ||
        state === "waiting_for_tool"
      );
    });
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshWorkspace();
      const current = routeRef.current;
      if (current.name === "project") {
        void refreshOpenProject(current.projectId);
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [jobs, refreshOpenProject, refreshWorkspace]);

  async function handleCreate(name: string) {
    setError(null);
    const created = await createProject(name);
    setRoute({ name: "project", projectId: created.projectId });
    setProject(created);
    await refreshWorkspace();
  }

  async function handleOpen(projectId: string) {
    setError(null);
    try {
      const opened = await openProject(projectId);
      setProject(opened);
      setRoute({ name: "project", projectId });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImport() {
    if (!project) {
      return;
    }
    setError(null);
    const path = await pickVideo();
    if (!path) {
      return;
    }
    const projectId = project.projectId;
    await importVideo(projectId, path);
    await refreshOpenProject(projectId);
    await refreshWorkspace();
  }

  async function handleExport(mediaId: string) {
    if (!project) {
      return;
    }
    setError(null);
    const projectId = project.projectId;
    await exportVideo(projectId, mediaId);
    await refreshOpenProject(projectId);
    await refreshWorkspace();
  }

  async function handleCreateShort(momentId: string) {
    if (!project) {
      return;
    }
    setError(null);
    const projectId = project.projectId;
    await createShort(projectId, momentId);
    await refreshOpenProject(projectId);
    await refreshWorkspace();
  }

  async function handleUndoShort(sequenceId: string) {
    if (!project) {
      return;
    }
    setError(null);
    const projectId = project.projectId;
    const next = await undoShortChange(projectId, sequenceId);
    setProject(next);
    await refreshWorkspace();
  }

  async function handleAcceptShort(sequenceId: string) {
    if (!project) {
      return;
    }
    setError(null);
    const next = await acceptShortChanges(project.projectId, sequenceId);
    setProject(next);
  }

  async function handleExportShort(sequenceId: string) {
    if (!project) {
      return;
    }
    setError(null);
    const projectId = project.projectId;
    await exportShort(projectId, sequenceId);
    await refreshOpenProject(projectId);
    await refreshWorkspace();
  }

  async function handleCancel(job: JobListItem) {
    const next = await cancelJob(job.projectId, job.jobId);
    if (project?.projectId === job.projectId) {
      setProject(next);
    }
    await refreshWorkspace();
  }

  function requestSeek(ms: number) {
    setSeek({ ms, token: Date.now() });
  }

  const accountLabel =
    meta?.account.label ?? "Waiting for the shared StreamersTip identity contract";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="wordmark">StreamersTip</span>
          <span className="product-name">Tippy Desktop</span>
        </div>
        <input className="search" placeholder="Search" disabled aria-label="Search" />
        <div className="avatar" title={accountLabel} aria-label={accountLabel}>
          <IconUser />
        </div>
      </header>
      <nav className="nav" aria-label="Primary">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isCreate = item.id === "create";
          const active =
            (item.id === "home" && route.name === "home") ||
            (item.id === "projects" &&
              (route.name === "projects" || route.name === "project"));
          return (
            <button
              key={item.id}
              type="button"
              className={
                isCreate
                  ? "nav-item nav-create"
                  : active && item.enabled
                    ? "nav-item active"
                    : "nav-item"
              }
              disabled={!item.enabled}
              title={item.enabled ? item.label : "Not in this phase"}
              data-testid={`nav-${item.id}`}
              onClick={() => {
                if (item.id === "home" || item.id === "create") {
                  setRoute({ name: "home" });
                }
                if (item.id === "projects") {
                  setRoute({ name: "projects" });
                }
              }}
            >
              {isCreate ? null : <Icon />}
              {item.label}
            </button>
          );
        })}
      </nav>
      <main className="main">
        {error ? <p className="banner">{error}</p> : null}
        {route.name === "home" ? (
          <HomeView
            projects={projects}
            accountLabel={accountLabel}
            onCreate={handleCreate}
            onOpen={(id) => void handleOpen(id)}
            onAsk={() => composerRef.current?.focus()}
          />
        ) : null}
        {route.name === "projects" ? (
          <ProjectsView
            projects={projects}
            onCreate={handleCreate}
            onOpen={(id) => void handleOpen(id)}
          />
        ) : null}
        {route.name === "project" && project ? (
          <ProjectView
            project={project}
            engineReady={meta?.engine.ready ?? false}
            engineMessage={
              meta?.engine.message ??
              "FFmpeg was not found. Install the apt package `ffmpeg`."
            }
            previewOrigin={meta?.previewOrigin ?? ""}
            seekToken={seek?.token ?? 0}
            seekMs={seek?.ms ?? null}
            onSeek={requestSeek}
            onImport={handleImport}
            onExport={handleExport}
            onCreateShort={handleCreateShort}
            onPauseJob={async (jobId) => {
              if (!project) {
                return;
              }
              setError(null);
              const next = await pauseJob(project.projectId, jobId);
              setProject(next);
              await refreshWorkspace();
            }}
            onResumeJob={async (jobId) => {
              if (!project) {
                return;
              }
              setError(null);
              const next = await resumeJob(project.projectId, jobId);
              setProject(next);
              await refreshWorkspace();
            }}
            onCancelJob={async (jobId) => {
              if (!project) {
                return;
              }
              setError(null);
              const next = await cancelJob(project.projectId, jobId);
              setProject(next);
              await refreshWorkspace();
            }}
            onRetryJob={async (jobId) => {
              if (!project) {
                return;
              }
              setError(null);
              const next = await retryJob(project.projectId, jobId);
              setProject(next);
              await refreshWorkspace();
            }}
            onUndoShort={handleUndoShort}
            onAcceptShort={handleAcceptShort}
            onExportShort={handleExportShort}
          />
        ) : null}
      </main>
      <TippyRail
        activity={
          project
            ? workerCards(project.jobs)
                .filter((card) => card.tone !== "done")
                .map((card) => ({
                  id: card.id,
                  name: card.name,
                  label: card.label,
                  tone: card.tone,
                }))
            : []
        }
        composerRef={composerRef}
        onSubmit={async (text) => {
          const reply = await submitTippy(text, project?.projectId);
          if (reply.hits[0]) {
            requestSeek(reply.hits[0].startMs);
          }
          if (project) {
            await refreshOpenProject(project.projectId);
            await refreshWorkspace();
          }
          if (reply.handled || reply.connected) {
            return reply.message;
          }
          return TIPPY_NOT_CONNECTED;
        }}
      />
      <JobBar jobs={jobs} onCancel={(job) => void handleCancel(job)} />
    </div>
  );
}
