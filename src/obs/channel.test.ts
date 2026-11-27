// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { AppStatus } from './app'
import { obsReadiness } from './readiness'
import { connect, saveCount, withObs } from './helpers'

test('chat replay stays off until the flag is on, then one signal saves once', async () => {
  await withObs({}, async (fixture) => {
    await connect(fixture)
    const blocked = fixture.app.ingestChat({ idempotencyKey: 'bot-1', phrase: '!clip' }, false)
    assert.equal(blocked.reason, 'flag_off')
    assert.equal(saveCount(fixture.server), 0)
    const accepted = fixture.app.ingestChat({ idempotencyKey: 'bot-1', phrase: '!clip' }, true)
    assert.equal(accepted.accepted, true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(saveCount(fixture.server), 1)
    const duplicate = fixture.app.ingestChat({ idempotencyKey: 'bot-1', phrase: '!clip' }, true)
    assert.equal(duplicate.reason, 'duplicate')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(saveCount(fixture.server), 1)
    assert.equal(fixture.app.status().candidates[0]?.trigger, 'chat')
  })
})

test('the pre-stream check is not ready until OBS, the buffer, and disk are ok', () => {
  const idle = status({ connected: false, host: null, obsVersion: null, replayActive: null, diskState: 'unknown', diskFreeMb: null })
  const idleReport = obsReadiness(idle)
  assert.equal(idleReport.ready, false)
  assert.equal(idleReport.items.find((item) => item.id === 'obs_connected')?.ok, false)
  const ready = obsReadiness(status({
    connected: true,
    host: '127.0.0.1',
    obsVersion: '33.0.3',
    replayActive: true,
    diskState: 'ok',
    diskFreeMb: 9000,
  }))
  assert.equal(ready.ready, true)
  const lowDisk = obsReadiness(status({
    connected: true,
    host: '127.0.0.1',
    obsVersion: '33.0.3',
    replayActive: true,
    diskState: 'low',
    diskFreeMb: 100,
  }))
  assert.equal(lowDisk.ready, false)
})

function status(overrides: Partial<AppStatus>): AppStatus {
  return {
    connected: false,
    host: null,
    obsVersion: null,
    obsWebSocketVersion: null,
    obsPlatform: null,
    replayActive: null,
    diskFreeMb: null,
    diskState: 'unknown',
    lowDiskMb: 2048,
    audioEnabled: false,
    audioCalibrated: false,
    audioThresholdDb: null,
    audioInputName: null,
    audioCopy: '',
    hotkey: 'Ctrl+Shift+F9',
    deviceId: 'owner',
    hostname: 'this-pc',
    replayLengthSeconds: 30,
    lastMessage: null,
    lastCode: null,
    guidance: null,
    candidates: [],
    ...overrides,
  }
}
