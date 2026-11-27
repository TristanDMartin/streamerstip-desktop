// @vitest-environment node
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { TippyApp } from './app'
import { MockObs } from './mockObs'
import { PASSWORD, assertAllowlist, connect, saveCount, statLocalFile, withObs } from './helpers'

test('refuses a bad OBS password and does not echo it', async () => {
  await withObs({}, async (fixture) => {
    const result = await connect(fixture, 'wrong-password-value')
    assert.equal(result.ok, false)
    assert.equal(result.message.includes('wrong-password-value'), false)
    assert.equal(result.message.includes(PASSWORD), false)
    assert.equal(JSON.stringify(fixture.app.status()).includes('wrong-password-value'), false)
    assert.equal(fixture.app.status().connected, false)
    const save = await fixture.app.saveMoment('manual')
    assert.equal(save.ok, false)
    if (!save.ok) assert.equal(save.code, 'not_connected')
  })
})

test('refuses an empty password before opening a socket', async () => {
  await withObs({}, async (fixture) => {
    const result = await connect(fixture, '')
    assert.equal(result.ok, false)
    assert.equal(fixture.server.connectionCount, 0)
  })
})

test('refuses OBS when authentication is not required', async () => {
  await withObs({ requireAuth: false }, async (fixture) => {
    const result = await connect(fixture)
    assert.equal(result.ok, false)
    assert.match(result.message, /not asking for a password/i)
    assert.equal(fixture.app.status().connected, false)
  })
})

test('rejects obs-websocket 4 and OBS before 28', async () => {
  await withObs({ obsVersion: '27.2.4', obsWebSocketVersion: '4.9.1' }, async (fixture) => {
    const result = await connect(fixture)
    assert.equal(result.ok, false)
    assert.match(result.message, /OBS Studio 28/)
    assert.equal(fixture.app.status().connected, false)
  })
})

test('refuses a non-local OBS host', async () => {
  const app = new TippyApp({ deviceId: 'pc-test', statFile: statLocalFile })
  const result = await app.connect({ host: '192.168.1.20', port: 4455, password: PASSWORD })
  assert.equal(result.ok, false)
  assert.match(result.message, /this computer/)
})

test('reports replay buffer off and does not save', async () => {
  await withObs({ replayActive: false }, async (fixture) => {
    const connected = await connect(fixture)
    assert.equal(connected.ok, true)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, false)
    if (!saved.ok) {
      assert.equal(saved.code, 'replay_off')
      assert.match(saved.message, /Replay buffer is off/)
      assert.match(saved.message, /will not change your stream or recording settings/)
    }
    assert.equal(saveCount(fixture.server), 0)
    assertAllowlist(fixture.server)
  })
})

test('blocks a replay-buffer start until the user confirms', async () => {
  await withObs({ replayActive: false }, async (fixture) => {
    await connect(fixture)
    const denied = await fixture.app.startReplayBuffer(false)
    assert.equal(denied.ok, false)
    assert.equal(fixture.server.requests.includes('StartReplayBuffer'), false)
    const allowed = await fixture.app.startReplayBuffer(true)
    assert.equal(allowed.ok, true)
    assert.equal(fixture.server.requests.filter((name) => name === 'StartReplayBuffer').length, 1)
    assert.equal(fixture.app.status().replayActive, true)
    assertAllowlist(fixture.server)
  })
})

test('low disk blocks the save', async () => {
  await withObs({ availableDiskSpaceMb: 100 }, async (fixture) => {
    await connect(fixture)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, false)
    if (!saved.ok) assert.equal(saved.code, 'low_disk')
    assert.equal(saveCount(fixture.server), 0)
  })
})

test('saves a replay and verifies the file size', async () => {
  await withObs({}, async (fixture) => {
    await connect(fixture)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    assert.equal(saved.duplicate, false)
    assert.equal(saved.candidate.source, 'obs_replay')
    assert.equal(saved.candidate.rightsStatus, 'creator_owned')
    assert.equal(saved.candidate.localPath, fixture.file)
    assert.equal(saved.candidate.fileSizeBytes, Buffer.byteLength('replay-bytes'))
    assert.equal(saved.candidate.moment.runsNow, false)
    assert.equal(saved.candidate.moment.network, 'none')
    assert.equal(saved.candidate.idempotencyKey.includes('pc-test'), true)
    assert.equal(saveCount(fixture.server), 1)
    assertAllowlist(fixture.server)
    assert.equal(JSON.stringify(saved).includes(PASSWORD), false)
  })
})

test('collapses a duplicate save into one OBS request', async () => {
  let now = 1_700_000_000_000
  await withObs({}, async (fixture) => {
    await connect(fixture)
    const [first, second] = await Promise.all([
      fixture.app.saveMoment('hotkey'),
      fixture.app.saveMoment('manual'),
    ])
    assert.equal(first.ok && second.ok, true)
    assert.equal(saveCount(fixture.server), 1)
    const third = await fixture.app.saveMoment('manual')
    assert.equal(third.ok, true)
    if (third.ok) assert.equal(third.duplicate, true)
    assert.equal(saveCount(fixture.server), 1)
  }, { now: () => now })
  assert.equal(now, 1_700_000_000_000)
})

test('fails closed when OBS disconnects mid-save', async () => {
  await withObs({ closeOnSave: true }, async (fixture) => {
    await connect(fixture)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, false)
    if (!saved.ok) assert.equal(saved.code, 'disconnected')
    assert.match(JSON.stringify(saved), /did not mark this moment as saved/)
    assert.equal(saveCount(fixture.server), 1)
    assert.equal(fixture.app.status().candidates.length, 0)
  })
})

test('adopts a file OBS wrote before the socket dropped', async () => {
  await withObs({ commitThenClose: true }, async (fixture) => {
    await connect(fixture)
    const failed = await fixture.app.saveMoment('hotkey')
    assert.equal(failed.ok, false)
    const again = await connect(fixture)
    assert.equal(again.ok, true)
    const adopted = await fixture.app.saveMoment('manual')
    assert.equal(adopted.ok, true)
    if (adopted.ok) {
      assert.equal(adopted.adopted, true)
      assert.equal(adopted.candidate.localPath, fixture.file)
      assert.equal(adopted.candidate.trigger, 'hotkey')
    }
    assert.equal(saveCount(fixture.server), 1)
  })
})

test('missing file is not a success', async () => {
  await withObs({}, async (fixture) => {
    fixture.server.replayPath = `${fixture.dir}/missing.mkv`
    await connect(fixture)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, false)
    if (!saved.ok) assert.equal(saved.code, 'missing_file')
    assert.equal(fixture.app.status().candidates.length, 0)
  })
})

test('an empty replay file is not a success', async () => {
  await withObs({}, async (fixture) => {
    await writeFile(fixture.file, Buffer.alloc(0))
    await connect(fixture)
    const saved = await fixture.app.saveMoment('manual')
    assert.equal(saved.ok, false)
    if (!saved.ok) assert.equal(saved.code, 'empty_file')
  })
})

test('two PCs do not share an idempotency key', async () => {
  const leftServer = new MockObs({ password: PASSWORD })
  const rightServer = new MockObs({ password: PASSWORD })
  const dir = await mkdtemp(join(tmpdir(), 'tippy-two-pc-'))
  const leftFile = join(dir, 'Replay.mkv')
  const rightFile = join(dir, 'Replay.mkv')
  await writeFile(leftFile, Buffer.from('replay-bytes'))
  leftServer.replayPath = leftFile
  rightServer.replayPath = rightFile
  const leftPort = await leftServer.start()
  const rightPort = await rightServer.start()
  const left = new TippyApp({ deviceId: 'pc-a', hostname: 'rig-a', statFile: statLocalFile })
  const right = new TippyApp({ deviceId: 'pc-b', hostname: 'rig-b', statFile: statLocalFile })
  try {
    const leftConnected = await left.connect({ host: '127.0.0.1', port: leftPort, password: PASSWORD })
    const rightConnected = await right.connect({ host: '127.0.0.1', port: rightPort, password: PASSWORD })
    assert.equal(leftConnected.ok && rightConnected.ok, true)
    const first = await left.saveMoment('manual')
    const second = await right.saveMoment('manual')
    assert.equal(first.ok && second.ok, true)
    if (first.ok && second.ok) {
      assert.notEqual(first.candidate.idempotencyKey, second.candidate.idempotencyKey)
      assert.equal(first.candidate.idempotencyKey.includes('pc-a'), true)
      assert.equal(second.candidate.idempotencyKey.includes('pc-b'), true)
      assert.equal(first.candidate.deviceId, 'pc-a')
      assert.equal(second.candidate.deviceId, 'pc-b')
      assert.equal(left.status().candidates.length, 1)
      assert.equal(right.status().candidates.length, 1)
    }
  } finally {
    await left.disconnect()
    await right.disconnect()
    await leftServer.stop()
    await rightServer.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconnects after the socket drops and does not save', async () => {
  await withObs({}, async (fixture) => {
    const connected = await connect(fixture)
    assert.equal(connected.ok, true)
    const saves = saveCount(fixture.server)
    fixture.server.dropClients()
    await new Promise((resolve) => setTimeout(resolve, 1600))
    assert.equal(fixture.app.status().connected, true)
    assert.match(fixture.app.status().lastMessage ?? '', /Reconnected/)
    assert.equal(saveCount(fixture.server), saves)
    assert.equal(JSON.stringify(fixture.app.status()).includes(PASSWORD), false)
  })
})

test('reads whether OBS is streaming or recording', async () => {
  await withObs({ streaming: true }, async (fixture) => {
    await connect(fixture)
    const activity = await fixture.app.outputActivity()
    assert.equal(activity.processDetected, true)
    assert.equal(activity.streaming, true)
    assert.equal(activity.recording, false)
    assert.equal(activity.droppedFrames, 0)
    assert.equal(activity.laggedFrames, 0)
    assert.equal(activity.networkDroppedFrames, 0)
    assertAllowlist(fixture.server)
  })
})

test('GetStats skipped frames are dropped and lagged counts', async () => {
  await withObs({ outputSkippedFrames: 3, renderSkippedFrames: 2, networkDroppedFrames: 11 }, async (fixture) => {
    await connect(fixture)
    const activity = await fixture.app.outputActivity()
    assert.equal(activity.encodingLagFrames, 3)
    assert.equal(activity.renderLagFrames, 2)
    assert.equal(activity.droppedFrames, 3)
    assert.equal(activity.laggedFrames, 2)
    assert.equal(activity.networkDroppedFrames, 11)
    const reading = await fixture.app.resourceSample()
    assert.equal(reading.encodingLagFrames, 3)
    assert.equal(reading.renderLagFrames, 2)
    assert.equal(reading.networkDroppedFrames, 11)
  })
})

test('a rejected password does not start reconnect', async () => {
  await withObs({}, async (fixture) => {
    const result = await connect(fixture, 'wrong-password-value')
    assert.equal(result.ok, false)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(fixture.server.connectionCount, 1)
    assert.equal(fixture.app.status().connected, false)
  })
})
