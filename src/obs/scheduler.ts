// Mirror of TristanDMartin/streamerstipReact services/tippy-media/src/scheduler.ts
// on cursor/tippy-media-pipeline. Cross-repo import is not practical: that
// package is private and is not published. Desktop checks the policy string
// before use and refuses any other version.

export const SCHEDULER_POLICY_VERSION = 'tippy.scheduler.v1'
export const EXPECTED_SCHEDULER_POLICY = 'tippy.scheduler.v1'
export const GAMING_PC_PROCESSES_WHILE_STREAMING = false
export const BALANCED_ENCODER_SESSION_CAP = 1
export const BALANCED_VRAM_HEADROOM_MB = 2048
export const PERFORMANCE_VRAM_HEADROOM_MB = 512

export const PROCESSING_MODES = ['live', 'balanced', 'performance'] as const
export type ProcessingMode = (typeof PROCESSING_MODES)[number]

export const SCHEDULER_REASONS = [
  'obs_process',
  'obs_streaming',
  'obs_recording',
  'frame_drops',
  'vram_headroom',
  'vram_unknown',
  'cuda_unavailable',
  'nvenc_unavailable',
  'encoder_session_cap',
  'encoder_sessions_unknown',
] as const
export type SchedulerReason = (typeof SCHEDULER_REASONS)[number]

export interface ObsObservation {
  processDetected: boolean
  streaming: boolean
  recording: boolean
  droppedFrames: number | null
  laggedFrames: number | null
}

export interface GpuObservation {
  cudaAvailable: boolean
  nvencAvailable: boolean
  vramTotalMb: number | null
  vramUsedMb: number | null
  encoderSessions: number | null
}

export interface SchedulerInput {
  requestedMode: ProcessingMode
  obs: ObsObservation
  gpu: GpuObservation
}

export interface SchedulerDecision {
  policy: typeof SCHEDULER_POLICY_VERSION
  requestedMode: ProcessingMode
  effectiveMode: ProcessingMode
  downgraded: boolean
  reasons: SchedulerReason[]
  allowLightweightDetection: true
  allowCapture: true
  allowTranscription: boolean
  allowRender: boolean
  transcriptionDevice: 'cpu' | 'cuda'
  transcriptionModel: 'small.en'
  transcriptionComputeType: 'int8' | 'float16' | 'int8_float16'
  renderEncoder: 'libx264' | 'h264_nvenc'
  cpuPriority: 'normal' | 'below_normal'
  maxGpuEncoderSessions: number | null
  vramHeadroomMb: number
  processesWhileStreaming: false
}

export const UNKNOWN_GPU: GpuObservation = {
  cudaAvailable: false,
  nvencAvailable: false,
  vramTotalMb: null,
  vramUsedMb: null,
  encoderSessions: null,
}

export function isProcessingMode(value: string): value is ProcessingMode {
  return (PROCESSING_MODES as readonly string[]).includes(value)
}

export function assertSchedulerPolicy(): void {
  if (SCHEDULER_POLICY_VERSION !== EXPECTED_SCHEDULER_POLICY) {
    throw new Error(`scheduler policy must be ${EXPECTED_SCHEDULER_POLICY}`)
  }
}

export function decideDesktopProcessing(input: SchedulerInput): SchedulerDecision {
  assertSchedulerPolicy()
  return decideProcessing(input)
}

function hasFrameDrops(obs: ObsObservation): boolean {
  return (obs.droppedFrames ?? 0) > 0 || (obs.laggedFrames ?? 0) > 0
}

function freeVramMb(gpu: GpuObservation): number | null {
  if (gpu.vramTotalMb === null || gpu.vramUsedMb === null) {
    return null
  }
  return Math.max(0, gpu.vramTotalMb - gpu.vramUsedMb)
}

function downgradeMode(input: SchedulerInput): { mode: ProcessingMode; reasons: SchedulerReason[] } {
  const reasons: SchedulerReason[] = []
  let mode = input.requestedMode
  const obsOpen = input.obs.processDetected && !input.obs.streaming && !input.obs.recording
  if (mode === 'performance' && obsOpen && !hasFrameDrops(input.obs)) {
    mode = 'balanced'
    reasons.push('obs_process')
  }
  if (input.obs.streaming) {
    mode = 'live'
    reasons.push('obs_streaming')
  }
  if (input.obs.recording) {
    mode = 'live'
    reasons.push('obs_recording')
  }
  if (hasFrameDrops(input.obs)) {
    mode = 'live'
    reasons.push('frame_drops')
  }
  return { mode, reasons }
}

function chooseDevice(input: {
  mode: ProcessingMode
  gpu: GpuObservation
  reasons: SchedulerReason[]
}): { device: 'cpu' | 'cuda'; compute: SchedulerDecision['transcriptionComputeType'] } {
  if (input.mode === 'live') {
    return { device: 'cpu', compute: 'int8' }
  }
  const headroom = input.mode === 'balanced' ? BALANCED_VRAM_HEADROOM_MB : PERFORMANCE_VRAM_HEADROOM_MB
  const free = freeVramMb(input.gpu)
  if (!input.gpu.cudaAvailable) {
    input.reasons.push('cuda_unavailable')
    return { device: 'cpu', compute: 'int8' }
  }
  if (free === null) {
    input.reasons.push('vram_unknown')
    return { device: 'cpu', compute: 'int8' }
  }
  if (free < headroom) {
    input.reasons.push('vram_headroom')
    return { device: 'cpu', compute: 'int8' }
  }
  return {
    device: 'cuda',
    compute: input.mode === 'balanced' ? 'int8_float16' : 'float16',
  }
}

function chooseEncoder(input: {
  mode: ProcessingMode
  gpu: GpuObservation
  device: 'cpu' | 'cuda'
  reasons: SchedulerReason[]
}): 'libx264' | 'h264_nvenc' {
  if (input.mode === 'live') {
    return 'libx264'
  }
  if (!input.gpu.nvencAvailable) {
    input.reasons.push('nvenc_unavailable')
    return 'libx264'
  }
  if (input.device !== 'cuda') {
    return 'libx264'
  }
  if (input.mode === 'balanced') {
    if (input.gpu.encoderSessions === null) {
      input.reasons.push('encoder_sessions_unknown')
      return 'libx264'
    }
    if (input.gpu.encoderSessions >= BALANCED_ENCODER_SESSION_CAP) {
      input.reasons.push('encoder_session_cap')
      return 'libx264'
    }
  }
  return 'h264_nvenc'
}

export function decideProcessing(input: SchedulerInput): SchedulerDecision {
  const downgraded = downgradeMode(input)
  const device = chooseDevice({ mode: downgraded.mode, gpu: input.gpu, reasons: downgraded.reasons })
  const encoder = chooseEncoder({
    mode: downgraded.mode,
    gpu: input.gpu,
    device: device.device,
    reasons: downgraded.reasons,
  })
  const live = downgraded.mode === 'live'
  return {
    policy: SCHEDULER_POLICY_VERSION,
    requestedMode: input.requestedMode,
    effectiveMode: downgraded.mode,
    downgraded: downgraded.mode !== input.requestedMode,
    reasons: downgraded.reasons,
    allowLightweightDetection: true,
    allowCapture: true,
    allowTranscription: !live,
    allowRender: !live,
    transcriptionDevice: device.device,
    transcriptionModel: 'small.en',
    transcriptionComputeType: device.compute,
    renderEncoder: encoder,
    cpuPriority: downgraded.mode === 'performance' ? 'normal' : 'below_normal',
    maxGpuEncoderSessions: live ? 0 : downgraded.mode === 'balanced' ? BALANCED_ENCODER_SESSION_CAP : null,
    vramHeadroomMb: live ? 0 : downgraded.mode === 'balanced' ? BALANCED_VRAM_HEADROOM_MB : PERFORMANCE_VRAM_HEADROOM_MB,
    processesWhileStreaming: GAMING_PC_PROCESSES_WHILE_STREAMING,
  }
}
