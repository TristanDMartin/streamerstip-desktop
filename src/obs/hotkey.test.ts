// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createHotkeyController, parseChord, shouldAttemptHotkey } from './hotkey'

test('hotkey chord fires once until the key is released', () => {
  let fires = 0
  const controller = createHotkeyController(parseChord('Ctrl+Shift+F9'), () => {
    fires += 1
  })
  const down = { type: 'down' as const, ctrl: true, shift: true, alt: false, meta: false, key: 'F9' }
  controller.handle(down)
  controller.handle(down)
  assert.equal(fires, 1)
  controller.handle({ type: 'up', ctrl: true, shift: true, alt: false, meta: false, key: 'F9' })
  controller.handle(down)
  assert.equal(fires, 2)
  controller.handle({ type: 'down', ctrl: true, shift: false, alt: false, meta: false, key: 'F9' })
  assert.equal(fires, 2)
})

test('global hook stays off on a headless linux agent', () => {
  assert.equal(shouldAttemptHotkey({ TIPPY_DISABLE_HOTKEY: '1' }, 'win32'), false)
  assert.equal(shouldAttemptHotkey({}, 'linux'), false)
  assert.equal(shouldAttemptHotkey({ DISPLAY: ':0' }, 'linux'), true)
  assert.equal(shouldAttemptHotkey({}, 'win32'), true)
  assert.equal(shouldAttemptHotkey({}, 'darwin'), true)
})
