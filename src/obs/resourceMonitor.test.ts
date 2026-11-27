import assert from 'node:assert/strict'
import { test } from 'vitest'
import { planEdit } from './sidecarPlan'
import {
  RESOURCE_COOLDOWN_MS,
  initialResourceState,
  rememberResourceLog,
  stepResourceMonitor,
  type ResourceSample,
} from './resourceMonitor'

const PATHS = {
  nodePath: 'node',
  scannerCli: '/opt/streamerstipReact/services/tippy-vod-scanner/src/cli.ts',
  workDir: '/tmp/tippy-work',
}

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  const encodingLagFrames = overrides.encodingLagFrames ?? overrides.droppedFrames ?? 4
  const renderLagFrames = overrides.renderLagFrames ?? overrides.laggedFrames ?? 1
  const networkDroppedFrames = overrides.networkDroppedFrames ?? 0
  return {
    atMs: 0,
    cpuPercent: 20,
    memoryPercent: 40,
    obsCpuPercent: 10,
    gpuUtilPercent: 15,
    vramTotalMb: 12288,
    vramUsedMb: 1024,
    encoderUtilPercent: 5,
    encoderSessions: 0,
    averageFrameRenderTimeMs: 8,
    outputCongestion: 0,
    activeFps: 60,
    streaming: true,
    recording: false,
    obsProcessDetected: true,
    ...overrides,
    droppedFrames: overrides.droppedFrames ?? encodingLagFrames,
    laggedFrames: overrides.laggedFrames ?? renderLagFrames,
    renderLagFrames,
    encodingLagFrames,
    networkDroppedFrames,
  }
}

test('processing stays suspended until readings hold through the cooldown', () => {
  const first = stepResourceMonitor(initialResourceState(), sample({ atMs: 0 }))
  assert.equal(first.decision.phase, 'suspended')
  assert.equal(first.decision.suspendProcessing, true)
  assert.equal(first.decision.policy, 'tippy.resource-monitor.v1')
  const mid = stepResourceMonitor(first.state, sample({ atMs: RESOURCE_COOLDOWN_MS - 1 }))
  assert.equal(mid.decision.phase, 'suspended')
  const resumed = stepResourceMonitor(mid.state, sample({ atMs: (RESOURCE_COOLDOWN_MS - 1) + RESOURCE_COOLDOWN_MS }))
  assert.equal(resumed.decision.phase, 'running')
  assert.equal(resumed.decision.suspendProcessing, false)
  assert.equal(resumed.logLine.includes('tippy.resource-monitor.v1'), true)
})

test('a crossed threshold suspends immediately and a gap inside the band does not resume', () => {
  const calm = stepResourceMonitor(initialResourceState(), sample({ atMs: 0 }))
  const held = stepResourceMonitor(calm.state, sample({ atMs: RESOURCE_COOLDOWN_MS }))
  assert.equal(held.decision.phase, 'running')
  const dropped = stepResourceMonitor(held.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 1000,
    droppedFrames: 5,
    obsProcessDetected: true,
  }))
  assert.equal(dropped.decision.phase, 'suspended')
  assert.equal(dropped.decision.reasons.includes('encoding_lag'), true)
  assert.equal(dropped.decision.networkCondition, null)
  const inside = stepResourceMonitor(held.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 500,
    droppedFrames: 4,
    cpuPercent: 80,
  }))
  assert.equal(inside.decision.phase, 'running')
  const busy = stepResourceMonitor(dropped.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 2000,
    droppedFrames: 5,
    cpuPercent: 80,
  }))
  assert.equal(busy.decision.phase, 'suspended')
  const settling = stepResourceMonitor(busy.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 3000,
    droppedFrames: 5,
    cpuPercent: 20,
  }))
  assert.equal(settling.decision.phase, 'suspended')
  const clear = stepResourceMonitor(settling.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 3000 + RESOURCE_COOLDOWN_MS,
    droppedFrames: 5,
    cpuPercent: 20,
  }))
  assert.equal(clear.decision.phase, 'running')
})

test('an open OBS process is not treated as free capacity', () => {
  const calm = stepResourceMonitor(initialResourceState(), sample({ atMs: 0, streaming: false, recording: false }))
  const running = stepResourceMonitor(calm.state, sample({
    atMs: RESOURCE_COOLDOWN_MS,
    streaming: false,
    recording: false,
    activeFps: null,
  }))
  assert.equal(running.decision.phase, 'running')
  assert.equal(running.decision.obsProcessDetected, true)
  const overloaded = stepResourceMonitor(running.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 1,
    streaming: false,
    recording: false,
    activeFps: null,
    cpuPercent: 96,
    gpuUtilPercent: 97,
    vramUsedMb: 11000,
    encoderUtilPercent: 90,
    encoderSessions: 1,
    outputCongestion: 0.4,
    averageFrameRenderTimeMs: 30,
  }))
  assert.equal(overloaded.decision.phase, 'suspended')
  for (const reason of ['cpu', 'gpu', 'vram', 'encoder', 'encoder_sessions', 'render_time', 'congestion']) {
    assert.equal(overloaded.decision.reasons.includes(reason), true, reason)
  }
  const closedAndHot = stepResourceMonitor(running.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 1,
    obsProcessDetected: false,
    streaming: false,
    recording: false,
    activeFps: null,
    droppedFrames: null,
    laggedFrames: null,
    cpuPercent: 95,
    gpuUtilPercent: null,
    vramTotalMb: null,
    vramUsedMb: null,
    encoderUtilPercent: null,
    encoderSessions: null,
    outputCongestion: null,
    averageFrameRenderTimeMs: null,
  }))
  assert.equal(closedAndHot.decision.phase, 'suspended')
  assert.equal(closedAndHot.decision.reasons.includes('cpu'), true)
})

test('network drops are logged and do not suspend processing', () => {
  const calm = stepResourceMonitor(initialResourceState(), sample({ atMs: 0, networkDroppedFrames: 2 }))
  const running = stepResourceMonitor(calm.state, sample({ atMs: RESOURCE_COOLDOWN_MS, networkDroppedFrames: 2 }))
  assert.equal(running.decision.phase, 'running')
  const networkOnly = stepResourceMonitor(running.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 1000,
    networkDroppedFrames: 9,
  }))
  assert.equal(networkOnly.decision.phase, 'running')
  assert.equal(networkOnly.decision.suspendProcessing, false)
  assert.equal(networkOnly.decision.networkCondition, 'network_drops')
  assert.equal(networkOnly.decision.reasons.includes('encoding_lag'), false)
  assert.equal(networkOnly.decision.reasons.includes('render_lag'), false)
  assert.equal(networkOnly.decision.networkDroppedFrames, 9)
  assert.equal(networkOnly.logLine.includes('network_drops'), true)
  const render = stepResourceMonitor(networkOnly.state, sample({
    atMs: RESOURCE_COOLDOWN_MS + 2000,
    networkDroppedFrames: 9,
    renderLagFrames: 3,
  }))
  assert.equal(render.decision.phase, 'suspended')
  assert.equal(render.decision.reasons.includes('render_lag'), true)
  assert.equal(render.decision.networkCondition, null)
})

test('a missing host reading suspends, and the log stays local', () => {
  const missing = stepResourceMonitor(initialResourceState(), sample({
    atMs: 0,
    cpuPercent: null,
    memoryPercent: null,
  }))
  assert.equal(missing.decision.reasons.includes('not_measured'), true)
  const stored = rememberResourceLog('', missing.logLine)
  assert.equal(stored, missing.logLine)
  const blocked = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: true,
    mode: 'balanced',
    activity: {
      processDetected: false,
      streaming: false,
      recording: false,
      droppedFrames: 0,
      laggedFrames: 0,
    },
    resources: { suspendProcessing: true },
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.reason, 'resources_suspended')
})
