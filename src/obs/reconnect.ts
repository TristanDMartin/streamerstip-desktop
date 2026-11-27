const RECONNECT_CAP_MS = 30_000

export function nextReconnectDelayMs(attempt: number): number {
  const step = Math.min(Math.max(attempt, 0), 5)
  return Math.min(RECONNECT_CAP_MS, 1000 * 2 ** step)
}

export function shouldKeepReconnecting(code: string): boolean {
  return code !== 'auth_failed' && code !== 'auth_required' && code !== 'incompatible' && code !== 'not_local'
}
