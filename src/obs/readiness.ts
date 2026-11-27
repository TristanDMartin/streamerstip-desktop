import type { AppStatus } from './app'

export interface ReadinessItem {
  id: 'obs_connected' | 'replay_buffer' | 'disk' | 'local_only'
  label: string
  ok: boolean
  detail: string
}

export interface ReadinessReport {
  ready: boolean
  items: ReadinessItem[]
}

export function obsReadiness(status: AppStatus): ReadinessReport {
  const items: ReadinessItem[] = [
    {
      id: 'local_only',
      label: 'OBS is on this PC',
      ok: status.host === null || status.host === '127.0.0.1' || status.host === 'localhost' || status.host === '::1',
      detail: status.host ?? 'Not connected yet',
    },
    {
      id: 'obs_connected',
      label: 'OBS WebSocket authenticated',
      ok: status.connected && Boolean(status.obsVersion),
      detail: status.obsVersion ? `OBS ${status.obsVersion}` : 'Connect with the OBS password',
    },
    {
      id: 'replay_buffer',
      label: 'Replay buffer is on',
      ok: status.replayActive === true,
      detail: status.replayActive === true ? 'Ready to save' : 'Start the replay buffer in OBS, or confirm it here',
    },
    {
      id: 'disk',
      label: 'Recording drive has space',
      ok: status.diskState !== 'low',
      detail: status.diskFreeMb === null ? 'Disk space not reported yet' : `${Math.round(status.diskFreeMb)} MB free`,
    },
  ]
  return { ready: items.every((item) => item.ok), items }
}
