// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { connect, saveCount, withObs } from './helpers'
import { SIMULATED_CHAT_SOURCE, simulateChatEvent } from './simulatedChat'

test('a simulated chat event saves once and does not name Twitch', async () => {
  const signal = simulateChatEvent({ phrase: '!clip', atMs: 1 })
  assert.equal(signal.source, SIMULATED_CHAT_SOURCE)
  assert.equal(signal.simulated, true)
  assert.equal(JSON.stringify(signal).includes('twitch'), false)
  await withObs({}, async (fixture) => {
    await connect(fixture)
    const blocked = fixture.app.ingestChat(signal, false)
    assert.equal(blocked.reason, 'flag_off')
    assert.equal(saveCount(fixture.server), 0)
    const accepted = fixture.app.ingestChat(signal, true)
    assert.equal(accepted.accepted, true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(saveCount(fixture.server), 1)
    assert.equal(fixture.app.status().candidates[0]?.trigger, 'chat')
    const duplicate = fixture.app.ingestChat(simulateChatEvent({ atMs: 1 }), true)
    assert.equal(duplicate.reason, 'duplicate')
  })
})
