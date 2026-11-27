export const RESOURCE_POLICY = 'tippy.resource-monitor.v1'
export const RESOURCE_COOLDOWN_MS = 10_000

export const SUSPEND_AT = {
  cpuPercent: 85,
  memoryPercent: 90,
  gpuUtilPercent: 85,
  vramFreeMb: 2048,
  encoderUtilPercent: 70,
  frameRenderMs: 16.7,
  outputCongestion: 0.2,
  activeFps: 45,
} as const

export const RESUME_AT = {
  cpuPercent: 70,
  memoryPercent: 75,
  gpuUtilPercent: 60,
  vramFreeMb: 3072,
  encoderUtilPercent: 40,
  frameRenderMs: 12,
  outputCongestion: 0.05,
  activeFps: 55,
} as const

export interface ResourceSample {
  atMs: number
  cpuPercent: number | null
  memoryPercent: number | null
  obsCpuPercent: number | null
  gpuUtilPercent: number | null
  vramTotalMb: number | null
  vramUsedMb: number | null
  encoderUtilPercent: number | null
  encoderSessions: number | null
  droppedFrames: number | null
  laggedFrames: number | null
  renderLagFrames: number | null
  encodingLagFrames: number | null
  networkDroppedFrames: number | null
  averageFrameRenderTimeMs: number | null
  outputCongestion: number | null
  activeFps: number | null
  streaming: boolean
  recording: boolean
  obsProcessDetected: boolean
}

export interface ResourceState {
  phase: 'running' | 'suspended'
  stableSinceMs: number | null
  previousDropped: number | null
  previousLagged: number | null
  previousNetworkDropped: number | null
  suspendReasons: string[]
}

export interface ResourceDecision {
  policy: typeof RESOURCE_POLICY
  phase: 'running' | 'suspended'
  suspendProcessing: boolean
  reasons: string[]
  atMs: number
  obsProcessDetected: boolean
  renderLagFrames: number | null
  encodingLagFrames: number | null
  networkDroppedFrames: number | null
  networkCondition: 'network_drops' | null
}

export interface HostReading {
  cpuPercent: number | null
  memoryPercent: number | null
  gpuUtilPercent: number | null
  vramTotalMb: number | null
  vramUsedMb: number | null
  encoderUtilPercent: number | null
}

export interface ObsReading {
  processDetected: boolean
  streaming: boolean
  recording: boolean
  droppedFrames: number | null
  laggedFrames: number | null
  renderLagFrames?: number | null
  encodingLagFrames?: number | null
  networkDroppedFrames?: number | null
  obsCpuPercent: number | null
  activeFps: number | null
  averageFrameRenderTimeMs: number | null
  outputCongestion: number | null
}

export function resourceSampleFrom(atMs: number, host: HostReading, obs: ObsReading | null): ResourceSample {
  return {
    atMs,
    cpuPercent: host.cpuPercent,
    memoryPercent: host.memoryPercent,
    obsCpuPercent: obs?.obsCpuPercent ?? null,
    gpuUtilPercent: host.gpuUtilPercent,
    vramTotalMb: host.vramTotalMb,
    vramUsedMb: host.vramUsedMb,
    encoderUtilPercent: host.encoderUtilPercent,
    encoderSessions: null,
    droppedFrames: obs?.encodingLagFrames ?? obs?.droppedFrames ?? null,
    laggedFrames: obs?.renderLagFrames ?? obs?.laggedFrames ?? null,
    renderLagFrames: obs?.renderLagFrames ?? obs?.laggedFrames ?? null,
    encodingLagFrames: obs?.encodingLagFrames ?? obs?.droppedFrames ?? null,
    networkDroppedFrames: obs?.networkDroppedFrames ?? null,
    averageFrameRenderTimeMs: obs?.averageFrameRenderTimeMs ?? null,
    outputCongestion: obs?.outputCongestion ?? null,
    activeFps: obs?.activeFps ?? null,
    streaming: obs?.streaming ?? false,
    recording: obs?.recording ?? false,
    obsProcessDetected: obs?.processDetected ?? false,
  }
}

export function initialResourceState(): ResourceState {
  return {
    phase: 'suspended',
    stableSinceMs: null,
    previousDropped: null,
    previousLagged: null,
    previousNetworkDropped: null,
    suspendReasons: ['not_measured'],
  }
}

export function stepResourceMonitor(state: ResourceState, sample: ResourceSample): {
  state: ResourceState
  decision: ResourceDecision
  logLine: string
} {
  const encodingDelta = counterDelta(state.previousDropped, sample.encodingLagFrames)
  const renderDelta = counterDelta(state.previousLagged, sample.renderLagFrames)
  const networkDelta = counterDelta(state.previousNetworkDropped, sample.networkDroppedFrames)
  const reasons = collectSuspendReasons(sample, encodingDelta, renderDelta)
  let phase = state.phase
  let stableSinceMs = state.stableSinceMs
  let suspendReasons = state.suspendReasons
  if (reasons.length > 0) {
    phase = 'suspended'
    stableSinceMs = null
    suspendReasons = reasons
  } else if (phase === 'suspended') {
    if (!canResume(sample, suspendReasons, encodingDelta, renderDelta)) {
      stableSinceMs = null
    } else if (stableSinceMs === null) {
      stableSinceMs = sample.atMs
    } else if (sample.atMs - stableSinceMs >= RESOURCE_COOLDOWN_MS) {
      phase = 'running'
      stableSinceMs = null
      suspendReasons = []
    }
  }
  const next: ResourceState = {
    phase,
    stableSinceMs,
    previousDropped: sample.encodingLagFrames ?? state.previousDropped,
    previousLagged: sample.renderLagFrames ?? state.previousLagged,
    previousNetworkDropped: sample.networkDroppedFrames ?? state.previousNetworkDropped,
    suspendReasons,
  }
  const decision: ResourceDecision = {
    policy: RESOURCE_POLICY,
    phase,
    suspendProcessing: phase !== 'running',
    reasons: phase === 'running' ? [] : suspendReasons,
    atMs: sample.atMs,
    obsProcessDetected: sample.obsProcessDetected,
    renderLagFrames: sample.renderLagFrames,
    encodingLagFrames: sample.encodingLagFrames,
    networkDroppedFrames: sample.networkDroppedFrames,
    networkCondition: networkDelta > 0 ? 'network_drops' : null,
  }
  return { state: next, decision, logLine: JSON.stringify(decision) }
}

export function rememberResourceLog(existing: string, line: string): string {
  const lines = existing.split('\n').filter((item) => item.length > 0)
  lines.push(line)
  return lines.slice(-200).join('\n')
}

function collectSuspendReasons(sample: ResourceSample, encodingDelta: number, renderDelta: number): string[] {
  const reasons: string[] = []
  if (sample.cpuPercent === null || sample.memoryPercent === null) reasons.push('not_measured')
  if (over(sample.cpuPercent, SUSPEND_AT.cpuPercent) || over(sample.obsCpuPercent, SUSPEND_AT.cpuPercent)) {
    reasons.push('cpu')
  }
  if (over(sample.memoryPercent, SUSPEND_AT.memoryPercent)) reasons.push('memory')
  if (over(sample.gpuUtilPercent, SUSPEND_AT.gpuUtilPercent)) reasons.push('gpu')
  const free = freeVram(sample)
  if (free !== null && free < SUSPEND_AT.vramFreeMb) reasons.push('vram')
  if (over(sample.encoderUtilPercent, SUSPEND_AT.encoderUtilPercent)) reasons.push('encoder')
  if (sample.encoderSessions !== null && sample.encoderSessions >= 1) reasons.push('encoder_sessions')
  if (renderDelta > 0) reasons.push('render_lag')
  if (encodingDelta > 0) reasons.push('encoding_lag')
  if (over(sample.averageFrameRenderTimeMs, SUSPEND_AT.frameRenderMs)) reasons.push('render_time')
  if (over(sample.outputCongestion, SUSPEND_AT.outputCongestion)) reasons.push('congestion')
  if ((sample.streaming || sample.recording) && sample.activeFps !== null && sample.activeFps < SUSPEND_AT.activeFps) {
    reasons.push('active_fps')
  }
  return reasons
}

function canResume(sample: ResourceSample, reasons: readonly string[], encodingDelta: number, renderDelta: number): boolean {
  if (sample.cpuPercent === null || sample.cpuPercent > RESUME_AT.cpuPercent) return false
  if (sample.obsCpuPercent !== null && sample.obsCpuPercent > RESUME_AT.cpuPercent) return false
  if (sample.memoryPercent === null || sample.memoryPercent > RESUME_AT.memoryPercent) return false
  if (sample.gpuUtilPercent !== null && sample.gpuUtilPercent > RESUME_AT.gpuUtilPercent) return false
  if (reasons.includes('gpu') && sample.gpuUtilPercent === null) return false
  const free = freeVram(sample)
  if (free !== null && free < RESUME_AT.vramFreeMb) return false
  if (reasons.includes('vram') && free === null) return false
  if (sample.encoderUtilPercent !== null && sample.encoderUtilPercent > RESUME_AT.encoderUtilPercent) return false
  if (reasons.includes('encoder') && sample.encoderUtilPercent === null) return false
  if (sample.encoderSessions !== null && sample.encoderSessions > 0) return false
  if (reasons.includes('encoder_sessions') && sample.encoderSessions === null) return false
  if (renderDelta > 0 || encodingDelta > 0) return false
  if (reasons.includes('render_lag') && sample.renderLagFrames === null) return false
  if (reasons.includes('encoding_lag') && sample.encodingLagFrames === null) return false
  if (sample.averageFrameRenderTimeMs !== null && sample.averageFrameRenderTimeMs > RESUME_AT.frameRenderMs) return false
  if (reasons.includes('render_time') && sample.averageFrameRenderTimeMs === null) return false
  if (sample.outputCongestion !== null && sample.outputCongestion > RESUME_AT.outputCongestion) return false
  if (reasons.includes('congestion') && sample.outputCongestion === null) return false
  if (sample.streaming || sample.recording) {
    if (sample.activeFps === null || sample.activeFps < RESUME_AT.activeFps) return false
  }
  return true
}

function counterDelta(previous: number | null, current: number | null): number {
  if (previous === null || current === null) return 0
  return Math.max(0, current - previous)
}

function freeVram(sample: ResourceSample): number | null {
  if (sample.vramTotalMb === null || sample.vramUsedMb === null) return null
  return Math.max(0, sample.vramTotalMb - sample.vramUsedMb)
}

function over(value: number | null, limit: number): boolean {
  return value !== null && value >= limit
}
