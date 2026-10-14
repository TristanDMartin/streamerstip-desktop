import type { JobState } from "../types";

export type JobPhase = "queued" | "running" | "done" | "failed" | "cancelled";

export function jobPhase(state: JobState | string): JobPhase {
  switch (state) {
    case "running":
    case "retrying":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "queued";
  }
}

export function phaseLabel(phase: JobPhase): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function jobLabel(jobType: string): string {
  switch (jobType) {
    case "probe_media":
      return "Probe media";
    case "create_proxy":
      return "Create proxy";
    case "extract_audio":
      return "Waveform";
    case "create_thumbnail":
      return "Thumbnail";
    case "detect_scenes":
      return "Scenes";
    case "detect_silence":
      return "Silence";
    case "transcribe_media":
      return "Transcript";
    case "scout_moments":
      return "Moments";
    case "create_short":
      return "Short";
    case "refresh_short":
      return "Short";
    case "export_short":
      return "Export Short";
    case "create_export":
      return "Export";
    default:
      return jobType;
  }
}

export function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return clock;
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function searchSubject(query: string): string {
  const trimmed = query.trim().replace(/[?.!]+$/, "").trim();
  const lower = trimmed.toLowerCase();
  const leads = [
    "where did i talk about ",
    "where did i mention ",
    "where did i say ",
    "find where i talked about ",
    "find where i talk about ",
    "find where i mentioned ",
    "find where i said ",
  ];
  for (const lead of leads) {
    if (lower.startsWith(lead)) {
      return lower.slice(lead.length).trim();
    }
  }
  return trimmed;
}

export function privacyLabel(mode: string): string {
  switch (mode) {
    case "cloud_assisted":
      return "Cloud Assisted";
    case "cloud_project":
      return "Cloud Project";
    default:
      return "Local First";
  }
}
