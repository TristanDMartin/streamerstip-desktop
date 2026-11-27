// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { authorizeClipUpload, fileIdempotencyKey, describeDeviceSignIn, planLocalMoment, planMuxUpload, runMuxUpload, toMarkerReport, type ClipCandidate } from './contract'
import { clipsAuthorizedForUpload, rememberClip, setUploadAuthorization } from './inventory'
import { assertObsRequestAllowed } from './policy'
import { safeText } from './redact'

test('upload plan is not executed', async () => {
  const candidate = sampleCandidate()
  const plan = planMuxUpload(candidate)
  assert.equal(plan.enabled, false)
  assert.equal(plan.request.body.privacy, 'private')
  assert.equal(plan.request.body.isDraft, true)
  let called = false
  const fetchImpl = async (): Promise<unknown> => {
    called = true
    throw new Error('network')
  }
  const off = await runMuxUpload(plan, { flag: false, fetchImpl })
  const locked = await runMuxUpload(plan, { flag: true, fetchImpl })
  assert.deepEqual(off, { ran: false, reason: 'flag_off' })
  assert.deepEqual(locked, { ran: false, reason: 'prototype_lock' })
  assert.equal(called, false)
})

test('local processing is the saved moment only and does not run', () => {
  const moment = planLocalMoment({ localPath: '/tmp/replay.mkv', replayLengthSeconds: 30 })
  assert.equal(moment.ok, true)
  if (moment.ok) {
    assert.equal(moment.runsNow, false)
    assert.equal(moment.network, 'none')
    assert.equal(moment.scope, 'candidate_window_only')
    assert.equal(moment.maxSeconds, 30)
  }
  const stream = planLocalMoment({ localPath: '/tmp/stream.mkv', replayLengthSeconds: 4 * 60 * 60 })
  assert.equal(stream.ok, false)
  if (!stream.ok) assert.equal(stream.reason, 'window_too_long')
  assert.equal(stream.refuses, 'whole_stream_transcription')
})

test('marker report keeps Twitch media empty and ownership on the token', () => {
  const report = toMarkerReport(sampleCandidate())
  assert.equal(report.collection, 'tippyClipMarkers')
  assert.equal(report.write, 'server_admin_sdk')
  assert.equal(report.ownerIdSource, 'firebase_id_token')
  assert.equal(report.media, 'local_only')
  assert.equal(report.document.source, 'obs_replay')
  assert.equal(report.document.rightsStatus, 'creator_owned')
  assert.equal(report.document.clipStatus, 'marked')
  assert.equal(report.document.clipUrl, null)
  assert.equal(report.document.twitchClipId, null)
  assert.equal(report.document.embedUrl, null)
  const signIn = describeDeviceSignIn()
  assert.equal(signIn.implemented, false)
  assert.equal(signIn.network, 'none')
})

test('idempotency keys differ per PC for the same file', () => {
  const path = 'C:\\Videos\\Replay.mkv'
  const left = fileIdempotencyKey('pc-a', path, 1000, 50)
  const right = fileIdempotencyKey('pc-b', path, 1000, 50)
  assert.notEqual(left, right)
})

test('stream and recording changes are blocked', () => {
  const blocked = [
    'StartStream',
    'StopStream',
    'StartRecord',
    'StopRecord',
    'SetStreamServiceSettings',
    'SetProfileParameter',
    'SetVideoSettings',
    'SetRecordDirectory',
    'ToggleReplayBuffer',
    'StopReplayBuffer',
  ]
  for (const name of blocked) {
    assert.throws(() => assertObsRequestAllowed(name, { action: 'start_replay_buffer', confirmed: true }), /Blocked/)
  }
  assert.throws(() => assertObsRequestAllowed('StartReplayBuffer', null), /explicit confirmation/)
  assert.doesNotThrow(() => assertObsRequestAllowed('StartReplayBuffer', { action: 'start_replay_buffer', confirmed: true }))
  assert.doesNotThrow(() => assertObsRequestAllowed('SaveReplayBuffer', null))
  assert.doesNotThrow(() => assertObsRequestAllowed('GetReplayBufferStatus', null))
})

test('redacts a password that leaks into an error string', () => {
  const secret = 'tippy-obs-password-9f3c'
  assert.equal(safeText(`failed ${secret}`, secret).includes(secret), false)
})

test('a clip is not uploadable until that clip is explicitly approved', async () => {
  const candidate = sampleCandidate()
  assert.equal(authorizeClipUpload(candidate, false), null)
  const plan = authorizeClipUpload(candidate, true)
  assert.ok(plan)
  assert.equal(plan?.enabled, false)
  let called = false
  if (plan) {
    const result = await runMuxUpload(plan, {
      flag: true,
      fetchImpl: async () => {
        called = true
        return {}
      },
    })
    assert.equal(result.ran, false)
  }
  assert.equal(called, false)
  const stored = rememberClip([], {
    localPath: candidate.localPath,
    fileSizeBytes: candidate.fileSizeBytes,
    trigger: candidate.trigger,
    idempotencyKey: candidate.idempotencyKey,
    triggerTimestamp: candidate.triggerTimestamp,
    uploadAuthorized: false,
  })
  assert.equal(clipsAuthorizedForUpload(stored).length, 0)
  const approved = setUploadAuthorization(stored, candidate.idempotencyKey, true)
  assert.equal(clipsAuthorizedForUpload(approved).length, 1)
  assert.equal(rememberClip(approved, approved[0]).length, 1)
})

function sampleCandidate(): ClipCandidate {
  return {
    source: 'obs_replay',
    localPath: '/tmp/replay.mkv',
    fileSizeBytes: 12,
    fileModifiedAtMs: 10,
    trigger: 'manual',
    triggerTimestamp: 100,
    clipStartTimestamp: 70,
    clipEndTimestamp: 100,
    idempotencyKey: 'obs_replay:pc:/tmp/replay.mkv:12:10',
    rightsStatus: 'creator_owned',
    deviceId: 'pc',
    hostname: 'rig',
    sessionId: 'session',
    obsVersion: '33.0.3',
    obsWebSocketVersion: '5.5.2',
    obsPlatform: 'windows',
    replayLengthSeconds: 30,
    moment: planLocalMoment({ localPath: '/tmp/replay.mkv', replayLengthSeconds: 30 }),
  }
}
