import { jobLabel } from "./format";
import type { Job, JobState } from "../types";

export type TeamTone = "running" | "waiting" | "paused" | "done" | "failed" | "cancelled";

export interface WorkerCardModel {
  id: string;
  name: string;
  tone: TeamTone;
  label: string;
  progress: number;
  explanation: string;
  detail: string;
  jobId: string | null;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRetry: boolean;
}

const AGENT_ORDER = [
  "media_analyst",
  "transcript_agent",
  "moment_scout",
  "clip_editor",
  "packaging_agent",
  "qa_agent",
];

export function workerName(agent: string): string {
  switch (agent) {
    case "media_analyst":
      return "Media Analyst";
    case "transcript_agent":
      return "Transcript";
    case "moment_scout":
      return "Clip Scout";
    case "clip_editor":
      return "Short Editor";
    case "packaging_agent":
      return "Packaging";
    case "qa_agent":
      return "QA";
    default:
      return "Tippy";
  }
}

function toneFor(states: JobState[]): TeamTone {
  if (states.some((state) => state === "running" || state === "retrying")) {
    return "running";
  }
  if (states.some((state) => state === "paused")) {
    return "paused";
  }
  if (
    states.some((state) =>
      ["queued", "ready", "planning", "waiting_for_dependency", "waiting_for_tool", "waiting_for_user"].includes(
        state,
      ),
    )
  ) {
    return "waiting";
  }
  if (states.some((state) => state === "failed")) {
    return "failed";
  }
  if (states.some((state) => state === "cancelled")) {
    return "cancelled";
  }
  return "done";
}

function toneLabel(tone: TeamTone): string {
  switch (tone) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "paused":
      return "Paused";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "done":
      return "Done";
  }
}

function leadJob(jobs: Job[]): Job | null {
  const active = jobs.find((job) => !["completed", "failed", "cancelled"].includes(job.state));
  return active ?? jobs[jobs.length - 1] ?? null;
}

function cardFrom(id: string, name: string, jobs: Job[]): WorkerCardModel {
  const lead = leadJob(jobs);
  const tone = toneFor(jobs.map((job) => job.state));
  const running = jobs.filter((job) => job.state === "running" || job.state === "retrying");
  const progress =
    running.length > 0
      ? running.reduce((sum, job) => sum + job.progress, 0) / running.length
      : tone === "done"
        ? 1
        : (lead?.progress ?? 0);
  const detail =
    lead && lead.message && lead.message !== "Done" && lead.message !== "Ready"
      ? lead.message
      : "";
  return {
    id,
    name,
    tone,
    label: toneLabel(tone),
    progress,
    explanation: lead?.explanation ?? "",
    detail,
    jobId: lead?.jobId ?? null,
    canPause: Boolean(
      lead &&
        ["queued", "ready", "planning", "running", "retrying", "waiting_for_dependency", "waiting_for_tool"].includes(
          lead.state,
        ),
    ),
    canResume: lead?.state === "paused",
    canCancel: Boolean(lead && !["completed", "failed", "cancelled"].includes(lead.state)),
    canRetry: lead?.state === "failed" || lead?.state === "cancelled",
  };
}

function letter(index: number): string {
  return String.fromCharCode(65 + Math.min(index, 25));
}

export function workerCards(jobs: Job[]): WorkerCardModel[] {
  const cards: WorkerCardModel[] = [];
  for (const agent of AGENT_ORDER) {
    const owned = jobs.filter((job) => job.agent === agent);
    if (owned.length === 0) {
      continue;
    }
    if (agent === "clip_editor") {
      const active = owned.filter((job) => !["completed", "failed", "cancelled"].includes(job.state));
      if (active.length > 1) {
        active.forEach((job, index) => {
          cards.push(cardFrom(job.jobId, `Short Editor ${letter(index)}`, [job]));
        });
        continue;
      }
    }
    cards.push(cardFrom(agent, workerName(agent), owned));
  }
  return cards;
}

function historyLabel(job: Job): string {
  const spoken = job.message.trim();
  const showMessage =
    spoken.length > 0 &&
    !["Ready", "Done", "Paused", "Retrying", "Failed", "Cancelled"].includes(spoken) &&
    (job.state === "running" ||
      job.state === "retrying" ||
      job.state === "completed" ||
      job.state === "failed");
  if (showMessage) {
    return spoken;
  }
  switch (job.state) {
    case "completed":
      return "Done";
    case "paused":
      return "Paused";
    case "running":
    case "retrying":
      return "Running";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "waiting_for_dependency":
    case "waiting_for_tool":
    case "waiting_for_user":
      return "Waiting";
    default:
      return "Queued";
  }
}

export function jobHistory(jobs: Job[]): Array<{ id: string; title: string; label: string; explanation: string }> {
  return [...jobs]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12)
    .map((job) => ({
      id: job.jobId,
      title: `${workerName(job.agent)} · ${jobLabel(job.type)}`,
      label: historyLabel(job),
      explanation: job.explanation,
    }));
}
