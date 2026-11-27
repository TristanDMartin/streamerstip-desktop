import assert from 'node:assert/strict'
import { test } from 'vitest'
import { CAPTURE_PATHS } from './captureContracts'
import { planObsReplayGrant } from './mediaHandoff'
import { resolveProcessingMode } from './processingMode'
import { planAuthorize, planEdit, planReplayManifest, planScan } from './sidecarPlan'
import type { SidecarRun as PlannedRun } from './sidecarPlan'
import { VodDesk } from './vodDesk'

const PATHS = {
  nodePath: 'node',
  scannerCli: '/opt/streamerstipReact/services/tippy-vod-scanner/src/cli.ts',
  workDir: '/tmp/tippy-work',
}

const IDLE = { streaming: false, recording: false }
const LIVE_OBS = { streaming: true, recording: false }

test('processing drops to live while OBS is streaming or recording', () => {
  const dropped = resolveProcessingMode('performance', LIVE_OBS)
  assert.equal(dropped.effective, 'live')
  assert.equal(dropped.downgraded, true)
  assert.equal(dropped.allowEdit, false)
  assert.equal(dropped.asr, 'off')
  assert.equal(dropped.network, 'none')
  const recording = resolveProcessingMode('balanced', { streaming: false, recording: true })
  assert.equal(recording.effective, 'live')
  const offline = resolveProcessingMode('performance', IDLE)
  assert.equal(offline.effective, 'performance')
  assert.equal(offline.asr, 'local')
  assert.equal(offline.allowEdit, true)
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
  const sent = planEdit({
    enabled: true,
    paths: PATHS,
    manifestPath: '/tmp/tippy-work/manifest.json',
    ownerId: 'owner_test',
    sampleId: 'smp-1',
    selected: true,
    mode: 'balanced',
    activity: IDLE,
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
  const unlabeled = planReplayManifest({ grant, category: '', durationSec: 30 })
  assert.equal(unlabeled.ok, false)
  const labeled = planReplayManifest({ grant, category: 'loud_reaction', durationSec: 30 })
  assert.equal(labeled.ok, true)
  if (labeled.ok) {
    assert.equal(labeled.manifest.schema, 'tippy.sample-manifest.v1')
    assert.equal(labeled.manifest.authorization.consent, 'creator_authorized_local_replay')
    assert.equal(labeled.manifest.samples[0]?.source, '/videos/replay.mkv')
  }
  const tooLong = planReplayManifest({ grant, category: 'loud_reaction', durationSec: 121 })
  assert.equal(tooLong.ok, false)
  assert.equal(CAPTURE_PATHS.A.desktopRuns, false)
  assert.equal(CAPTURE_PATHS.C.manifest, 'tippy.sample-manifest.v1')
})
