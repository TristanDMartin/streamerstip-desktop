import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppMeta,
  Project,
  TippyEvent,
  TippyReply,
  Workspace,
} from "./types";

export function getAppMeta(): Promise<AppMeta> {
  return invoke<AppMeta>("app_meta");
}

export function listWorkspace(): Promise<Workspace> {
  return invoke<Workspace>("list_workspace");
}

export function createProject(name: string): Promise<Project> {
  return invoke<Project>("create_project", { name });
}

export function openProject(projectId: string): Promise<Project> {
  return invoke<Project>("open_project", { projectId });
}

export function pickVideo(): Promise<string | null> {
  return invoke<string | null>("pick_video");
}

export function importVideo(projectId: string, path: string): Promise<Project> {
  return invoke<Project>("import_video", { projectId, path });
}

export function exportVideo(
  projectId: string,
  mediaId: string,
): Promise<Project> {
  return invoke<Project>("export_video", { projectId, mediaId });
}

export function cancelJob(projectId: string, jobId: string): Promise<Project> {
  return invoke<Project>("cancel_job", { projectId, jobId });
}

export function submitTippy(text: string): Promise<TippyReply> {
  return invoke<TippyReply>("submit_tippy", { text });
}

export function onTippyEvent(
  handler: (event: TippyEvent) => void,
): Promise<UnlistenFn> {
  return listen<TippyEvent>("tippy-event", (event) => {
    handler(event.payload);
  });
}
