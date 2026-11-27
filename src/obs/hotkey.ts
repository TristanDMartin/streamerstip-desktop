export interface Chord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

export interface HotkeyEvent {
  type: 'down' | 'up'
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
}

export function parseChord(spec: string): Chord {
  const parts = spec.split('+').map((part) => part.trim()).filter((part) => part.length > 0)
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') chord.ctrl = true
    else if (lower === 'shift') chord.shift = true
    else if (lower === 'alt' || lower === 'option') chord.alt = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') chord.meta = true
    else chord.key = part.toUpperCase()
  }
  if (!chord.key) throw new Error('Hotkey needs a non-modifier key.')
  return chord
}

export function createHotkeyController(chord: Chord, onFire: () => void): {
  handle: (event: HotkeyEvent) => void
} {
  let armed = false
  const matches = (event: HotkeyEvent): boolean =>
    event.ctrl === chord.ctrl
    && event.shift === chord.shift
    && event.alt === chord.alt
    && event.meta === chord.meta
    && event.key.toUpperCase() === chord.key
  return {
    handle(event: HotkeyEvent): void {
      if (event.type === 'up') {
        if (event.key.toUpperCase() === chord.key) armed = false
        return
      }
      if (!matches(event)) {
        armed = false
        return
      }
      if (armed) return
      armed = true
      onFire()
    },
  }
}

export function shouldAttemptHotkey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.TIPPY_DISABLE_HOTKEY === '1') return false
  if (env.TIPPY_FORCE_HOTKEY === '1') return true
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}
