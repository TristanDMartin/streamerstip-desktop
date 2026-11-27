// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { AudioTrigger, mulToDb, peakMul } from './audioTrigger'
import { connect, saveCount, withObs } from './helpers'

test('audio trigger stays off until calibrated and then respects threshold, sustain, and cooldown', () => {
  const trigger = new AudioTrigger()
  const now = 1_000_000
  assert.equal(trigger.observe(0.9, now).reason, 'disabled')
  const armed = trigger.setEnabled(true)
  assert.equal(armed.ok, false)
  assert.equal(trigger.enabled, false)
  const tooShort = trigger.calibrate([0.1, 0.1, 0.1])
  assert.equal(tooShort.ok, false)
  const quietGame = Array.from({ length: 12 }, () => 0.1)
  const calibrated = trigger.calibrate(quietGame)
  assert.equal(calibrated.ok, true)
  assert.ok((calibrated.thresholdDb ?? 0) > mulToDb(0.1))
  trigger.setEnabled(true)
  assert.equal(trigger.observe(0.05, now).reason, 'below_threshold')
  assert.equal(trigger.observe(0.5, now + 50).reason, 'sustaining')
  assert.equal(trigger.observe(0.5, now + 100).reason, 'sustaining')
  const fired = trigger.observe(0.5, now + 150)
  assert.equal(fired.fire, true)
  assert.equal(trigger.observe(0.9, now + 200).reason, 'cooldown')
  assert.equal(trigger.observe(0.9, now + 150 + 20_000).fire, false)
  const afterGap = trigger.observe(0.9, now + 150 + 20_000)
  assert.equal(afterGap.reason, 'sustaining')
  trigger.observe(0.01, now + 150 + 20_050)
  assert.equal(trigger.observe(0.9, now + 150 + 20_100).reason, 'sustaining')
  const otherInput = peakMul(
    [{ inputName: 'Desktop', inputLevelsMul: [[0.9, 0.9, 0.9]] }],
    'Mic/Aux',
  )
  assert.equal(otherInput, null)
})

test('a loud meter from OBS fires one save and a quiet meter does not', async () => {
  await withObs({}, async (fixture) => {
    await connect(fixture)
    const samples = Array.from({ length: 12 }, () => 0.1)
    const calibrated = fixture.app.applyCalibration(samples)
    assert.equal(calibrated.ok, true)
    const loud = meter('Mic/Aux', 0.5)
    const quiet = meter('Mic/Aux', 0.05)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    await delay(30)
    assert.equal(saveCount(fixture.server), 0)
    const enabled = fixture.app.setAudio({ enabled: true, inputName: 'Mic/Aux' })
    assert.equal(enabled.ok, true)
    fixture.server.emitMeters(quiet)
    await delay(30)
    assert.equal(saveCount(fixture.server), 0)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    await delay(200)
    assert.equal(saveCount(fixture.server), 1)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    fixture.server.emitMeters(loud)
    await delay(100)
    assert.equal(saveCount(fixture.server), 1)
    const saved = fixture.app.status().candidates[0]
    assert.equal(saved?.trigger, 'audio')
    assert.equal(saved?.fileSizeBytes, Buffer.byteLength('replay-bytes'))
  })
})

function meter(inputName: string, peak: number): Array<Record<string, unknown>> {
  return [{ inputName, inputLevelsMul: [[peak / 2, peak, peak]] }]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
