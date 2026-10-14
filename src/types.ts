export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
  sizeBytes: number;
}

export interface MediaAsset {
  mediaId: string;
  originalPath: string;
  fileName: string;
  proxyPath: string | null;
  audioPath: string | null;
  thumbnailPath: string | null;
  waveform: number[];
  probe: ProbeInfo | null;
  importedAt: string;
  scenes: SceneSpan[];
  silences: SilenceSpan[];
}

export interface SceneSpan {
  startMs: number;
  endMs: number;
  thumbnailPath: string | null;
}

export interface SilenceSpan {
  startMs: number;
  endMs: number;
}

export interface TranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  profanity: boolean;
  words?: TranscriptWord[];
}

export interface Transcript {
  mediaId: string;
  segments: TranscriptSegment[];
}

export interface MomentScores {
  hookStrength: number;
  emotion: number;
  clarity: number;
  payoff: number;
  pacing: number;
  standaloneContext: number;
}

export interface Moment {
  momentId: string;
  mediaId: string;
  startMs: number;
  endMs: number;
  usableMs: number;
  category: string;
  quote: string;
  explanation: string;
  previewPath: string | null;
  scores: MomentScores;
}

export interface SequenceClip {
  mediaId: string;
  startMs: number;
  endMs: number;
}

export interface CaptionCue {
  captionId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ReviewChange {
  changeId: string;
  kind: string;
  label: string;
  undone: boolean;
  accepted: boolean;
}

export interface Sequence {
  sequenceId: string;
  name: string;
  clips: SequenceClip[];
  momentId: string;
  variation: string;
  aspectRatio: string;
  captionTheme: string;
  exportPreset: string;
  captions: CaptionCue[];
  changes: ReviewChange[];
  previewPath: string | null;
  sourceStartMs: number;
  sourceEndMs: number;
}

export interface ActionRecord {
  actionId: string;
  action: string;
  projectId: string;
  createdAt: string;
  payload: unknown;
  requiresApproval: boolean;
}

export interface ExportRecord {
  exportId: string;
  mediaId: string;
  path: string;
  createdAt: string;
  sequenceId: string;
}

export interface VersionEntry {
  versionId: string;
  label: string;
  createdAt: string;
}

export interface TippyContext {
  privacyMode: "local_first" | "cloud_assisted" | "cloud_project";
  versions: VersionEntry[];
}

export type JobState =
  | "queued"
  | "planning"
  | "ready"
  | "running"
  | "waiting_for_dependency"
  | "waiting_for_tool"
  | "waiting_for_user"
  | "paused"
  | "retrying"
  | "failed"
  | "completed"
  | "cancelled";

export interface Job {
  jobId: string;
  projectId: string;
  type: string;
  agent: string;
  state: JobState;
  progress: number;
  dependencies: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  mediaId: string;
  message: string;
  subjectId: string;
}

export interface Project {
  schemaVersion: number;
  projectId: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  media: MediaAsset[];
  sequences: Sequence[];
  transcript: Transcript;
  moments: Moment[];
  jobs: Job[];
  actions: ActionRecord[];
  exports: ExportRecord[];
  brandProfile: Record<string, unknown>;
  tippyContext: TippyContext;
}

export interface ProjectCard {
  projectId: string;
  name: string;
  updatedAt: string;
  mediaCount: number;
  error: string | null;
}

export interface JobListItem {
  jobId: string;
  projectId: string;
  projectName: string;
  jobType: string;
  state: JobState;
  progress: number;
  error: string | null;
  message: string;
}

export interface Workspace {
  projects: ProjectCard[];
  jobs: JobListItem[];
}

export interface EngineStatus {
  ready: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  message: string;
}

export interface LocalAccount {
  ownerId: string;
  status: string;
  label: string;
}

export interface FeatureFlags {
  desktopMultiAgent: boolean;
  desktopCloudRender: boolean;
  desktopAutoReframe: boolean;
  desktopCreatorMemory: boolean;
  desktopMobileApproval: boolean;
  desktopOperatorMode: boolean;
}

export interface AppMeta {
  schemaVersion: number;
  engine: EngineStatus;
  account: LocalAccount;
  flags: FeatureFlags;
  dataDir: string;
  previewOrigin: string;
}

export interface TippyEvent {
  kind: string;
  projectId: string;
  jobId: string | null;
  state: string | null;
  progress: number | null;
  message: string;
}

export interface TippyHit {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface TippyReply {
  connected: boolean;
  handled: boolean;
  message: string;
  hits: TippyHit[];
}
