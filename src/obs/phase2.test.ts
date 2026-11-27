import assert from 'node:assert/strict'
import { test } from 'vitest'
import { acceleratorFor, bindGlobalHotkey } from './globalHotkey'
import { planObsReplayGrant, planVodScan, VOD_STEPS } from './mediaHandoff'
import { nextReconnectDelayMs, shouldKeepReconnecting } from './reconnect'
import { createKeychainVault, createMemoryVault, secretLeakedInto } from './tokenVault'

test('reconnect backs off and stops on auth or version failure', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => nextReconnectDelayMs(attempt)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  )
  assert.equal(shouldKeepReconnecting('disconnected'), true)
  assert.equal(shouldKeepReconnecting('auth_failed'), false)
  assert.equal(shouldKeepReconnecting('incompatible'), false)
})

test('the hotkey binder asks the operating system and does not use the window', async () => {
  const calls: string[] = []
  const binding = await bindGlobalHotkey('Ctrl+Shift+F9', () => calls.push('fire'), async (accelerator, handler) => {
    calls.push(accelerator)
    handler({ state: 'Pressed' })
    handler({ state: 'Released' })
  })
  assert.equal(acceleratorFor('Ctrl+Shift+F9'), 'CommandOrControl+Shift+F9')
  assert.equal(binding.scope, 'global')
  assert.equal(binding.accelerator, 'CommandOrControl+Shift+F9')
  assert.deepEqual(calls, ['CommandOrControl+Shift+F9', 'fire'])
  assert.equal('addEventListener' in binding, false)
})

test('a streamers tip token is not written to page storage', async () => {
  const secret = 'refresh-token-9f3c-secret'
  const page = { snapshot: () => '' }
  const memory = createMemoryVault()
  await memory.save('owner_test', secret)
  assert.equal(await memory.load('owner_test'), secret)
  assert.equal(memory.writes.some((item) => item.startsWith('local')), false)
  assert.equal(secretLeakedInto(page, secret), false)
  const sent: Array<{ command: string; args: Record<string, string> }> = []
  const vault = createKeychainVault(async (command, args) => {
    sent.push({ command, args })
    if (command === 'keychain_load') return secret
    return null
  })
  await vault.save('owner_test', secret)
  assert.equal(await vault.load('owner_test'), secret)
  assert.equal(sent[0]?.command, 'keychain_save')
  assert.equal(sent.every((item) => item.command.startsWith('keychain_')), true)
  assert.equal(secretLeakedInto(page, secret), false)
})

test('only an authorized replay becomes a media pipeline grant', () => {
  const item = {
    localPath: '/tmp/replay.mkv',
    fileSizeBytes: 12,
    trigger: 'manual' as const,
    idempotencyKey: 'obs_replay:pc:file:12:1',
    triggerTimestamp: Date.parse('2026-11-27T00:00:00.000Z'),
    uploadAuthorized: false,
  }
  assert.equal(planObsReplayGrant(item, 'owner_test'), null)
  const grant = planObsReplayGrant({ ...item, uploadAuthorized: true }, 'owner_test', '33.0.3')
  assert.deepEqual(grant, {
    ownerId: 'owner_test',
    replayPath: '/tmp/replay.mkv',
    savedAt: '2026-11-27T00:00:00.000Z',
    consent: 'creator_authorized_local_replay',
    obsVersion: '33.0.3',
  })
})

test('vod intelligence stays off and does not scan', () => {
  assert.equal(VOD_STEPS.length, 8)
  assert.deepEqual(planVodScan('/tmp/stream.mkv', false), { ok: false, reason: 'flag_off' })
  const plan = planVodScan('/tmp/stream.mkv', true)
  assert.equal('runsNow' in plan && plan.runsNow, false)
  if (!('ok' in plan)) {
    assert.equal(plan.modifySource, false)
    assert.equal(plan.maxWindowSec, 120)
    assert.equal(plan.network, 'none')
  }
})
