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
    case "create_export":
      return "Export";
    default:
      return jobType;
  }
}

export function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
