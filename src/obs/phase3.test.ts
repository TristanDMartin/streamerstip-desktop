import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createLocalEditGrant } from './captureContracts'
import { planObsReplayGrant } from './mediaHandoff'
import { decideDesktopProcessing, type ObsObservation } from './scheduler'
import { planAuthorize, planEdit, planReplayManifest, planScan } from './sidecarPlan'
import type { SidecarRun as PlannedRun } from './sidecarPlan'
import { VodDesk } from './vodDesk'

const PATHS = {
  nodePath: 'node',
  scannerCli: '/opt/streamerstipReact/services/tippy-vod-scanner/src/cli.ts',
  workDir: '/tmp/tippy-work',
}

const IDLE: ObsObservation = {
  processDetected: false,
  streaming: false,
  recording: false,
  droppedFrames: 0,
  laggedFrames: 0,
}
const LIVE_OBS: ObsObservation = {
  processDetected: true,
  streaming: true,
  recording: false,
  droppedFrames: 0,
  laggedFrames: 0,
}

test('tippy.scheduler.v1 drops to live for output, drops, or lag', () => {
  const streaming = decideDesktopProcessing({
    requestedMode: 'performance',
    obs: LIVE_OBS,
    gpu: { cudaAvailable: true, nvencAvailable: true, vramTotalMb: 12288, vramUsedMb: 1000, encoderSessions: 0 },
  })
  assert.equal(streaming.policy, 'tippy.scheduler.v1')
  assert.equal(streaming.effectiveMode, 'live')
  assert.equal(streaming.downgraded, true)
  assert.equal(streaming.allowRender, false)
  assert.equal(streaming.allowCapture, true)
  assert.equal(streaming.reasons.includes('obs_streaming'), true)
  assert.equal(streaming.processesWhileStreaming, false)
  const recording = decideDesktopProcessing({
    requestedMode: 'balanced',
    obs: { ...IDLE, processDetected: true, recording: true },
    gpu: { cudaAvailable: false, nvencAvailable: false, vramTotalMb: null, vramUsedMb: null, encoderSessions: null },
  })
  assert.equal(recording.effectiveMode, 'live')
  assert.equal(recording.reasons.includes('obs_recording'), true)
  const lagged = decideDesktopProcessing({
    requestedMode: 'performance',
    obs: { ...IDLE, processDetected: true, laggedFrames: 4 },
    gpu: { cudaAvailable: true, nvencAvailable: true, vramTotalMb: 12288, vramUsedMb: 1000, encoderSessions: 0 },
  })
  assert.equal(lagged.effectiveMode, 'live')
  assert.equal(lagged.reasons.includes('frame_drops'), true)
  const networkOnly = decideDesktopProcessing({
    requestedMode: 'performance',
    obs: { ...IDLE, networkDroppedFrames: 40 },
    gpu: { cudaAvailable: true, nvencAvailable: true, vramTotalMb: 12288, vramUsedMb: 1000, encoderSessions: 0 },
  })
  assert.equal(networkOnly.effectiveMode, 'performance')
  assert.equal(networkOnly.reasons.includes('frame_drops'), false)
  const open = decideDesktopProcessing({
    requestedMode: 'performance',
    obs: { ...IDLE, processDetected: true },
    gpu: { cudaAvailable: true, nvencAvailable: true, vramTotalMb: 12288, vramUsedMb: 1000, encoderSessions: 0 },
  })
  assert.equal(open.effectiveMode, 'balanced')
  assert.equal(open.reasons.includes('obs_process'), true)
  assert.equal(open.vramHeadroomMb, 2048)
  assert.equal(open.maxGpuEncoderSessions, 1)
  assert.equal(open.cpuPriority, 'below_normal')
  const offline = decideDesktopProcessing({
    requestedMode: 'performance',
    obs: IDLE,
    gpu: { cudaAvailable: true, nvencAvailable: true, vramTotalMb: 12288, vramUsedMb: 1000, encoderSessions: 0 },
  })
  assert.equal(offline.effectiveMode, 'performance')
  assert.equal(offline.allowTranscription, true)
  assert.equal(offline.allowRender, true)
  assert.equal(offline.vramHeadroomMb, 512)
})

test('the scanner sidecar is not spawned until the flag and a local grant exist', async () => {
  const calls: PlannedRun[] = []
  const desk = new VodDesk(async (run) => {
    calls.push(run)
    return { code: 0, stdout: 'manifest.json' }
  }, PATHS, false)
  const blocked = await desk.scan({
    grantPath: '/tmp/tippy-work/vod-grant.json',
    filePath: '/videos/one.mkv',
    authorized: true,
    mode: 'performance',
    activity: IDLE,
  })
  assert.equal(blocked.ok, false)
  assert.equal(calls.length, 0)
  const remote = planScan({
    enabled: true,
    paths: PATHS,
    grantPath: '/tmp/tippy-work/vod-grant.json',
    filePath: 'https://twitch.tv/clip',
    authorized: true,
    mode: 'live',
    activity: IDLE,
  })
  assert.equal(remote.ok, false)
  const missing = planAuthorize({
    enabled: true,
    paths: { ...PATHS, scannerCli: '/tmp/other.ts' },
    ownerId: 'owner_test',
    rootPath: '/videos',
  })
  assert.equal(missing.ok, false)
})

test('an authorized recording scans locally and cancel stops the process', async () => {
  let aborted = false
  const desk = new VodDesk(async (run, signal) => {
    assert.equal(run.argv[0], 'node')
    assert.equal(run.argv[1], '--experimental-strip-types')
    assert.equal(run.argv.includes('--file'), true)
    assert.equal(run.argv.includes('https://'), false)
    assert.equal(run.argv[run.argv.indexOf('--asr') + 1], 'off')
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('cancelled'))
      })
    })
  }, PATHS, true)
  const pending = desk.scan({
    grantPath: '/tmp/tippy-work/vod-grant.json',
    filePath: '/videos/one.mkv',
    authorized: true,
    mode: 'performance',
    activity: LIVE_OBS,
  })
  desk.cancel()
  await assert.rejects(pending, /cancelled/)
  assert.equal(aborted, true)
})

test('selected samples go to the pipeline edit command and live mode refuses it', () => {
  const refused = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: true,
    mode: 'performance',
    activity: LIVE_OBS,
  })
  assert.equal(refused.ok, false)
  const editGrant = createLocalEditGrant({
    id: 'grant-1',
    ownerId: 'owner_test',
    source: '/videos/one.mkv',
    timestamp: '2026-11-27T00:00:00.000Z',
  })
  const missingGrant = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: true,
    mode: 'balanced',
    activity: IDLE,
  })
  assert.equal(missingGrant.ok, false)
  const sent = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: true,
    mode: 'balanced',
    activity: IDLE,
    source: '/videos/one.mkv',
    grants: [editGrant],
  })
  assert.equal(sent.ok, true)
  if (sent.ok) {
    assert.deepEqual(sent.run.argv.slice(3, 5), ['edit', '--manifest'])
    assert.equal(sent.run.argv.includes('smp-1'), true)
  }
  const idle = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: false,
    mode: 'performance',
    activity: IDLE,
  })
  assert.equal(idle.ok, false)
})

test('a checked OBS replay becomes a manifest only after the creator picks a category', () => {
  const item = {
    localPath: '/videos/replay.mkv',
    fileSizeBytes: 12,
    trigger: 'manual' as const,
    idempotencyKey: 'obs_replay:pc:file:12:1',
    triggerTimestamp: Date.parse('2026-11-27T00:00:00.000Z'),
    uploadAuthorized: true,
  }
  const grant = planObsReplayGrant(item, 'owner_test')
  const editGrant = createLocalEditGrant({
    id: item.idempotencyKey,
    ownerId: 'owner_test',
    source: item.localPath,
    timestamp: '2026-11-27T00:00:00.000Z',
  })
  const unlabeled = planReplayManifest({ grant, editGrants: [editGrant], category: '', durationSec: 30 })
  assert.equal(unlabeled.ok, false)
  const labeled = planReplayManifest({ grant, editGrants: [editGrant], category: 'loud_reaction', durationSec: 30 })
  assert.equal(labeled.ok, true)
  if (labeled.ok) {
    assert.equal(labeled.manifest.schema, 'tippy.sample-manifest.v1')
    assert.equal(labeled.manifest.authorization.consent, 'creator_authorized_local_replay')
    assert.equal(labeled.manifest.samples[0]?.source, '/videos/replay.mkv')
  }
  const tooLong = planReplayManifest({ grant, editGrants: [editGrant], category: 'loud_reaction', durationSec: 121 })
  const rightsOnly = planReplayManifest({ grant, category: 'loud_reaction', durationSec: 30 })
  assert.equal(rightsOnly.ok, false)
  assert.equal(tooLong.ok, false)
})
