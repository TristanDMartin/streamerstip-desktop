import { LOW_DISK_MB } from './constants'

export const AUTH_FAILED_MESSAGE =
  'OBS refused that password. Use the password from OBS → Tools → WebSocket Server Settings. It stays on this PC.'

export const AUTH_REQUIRED_MESSAGE =
  'OBS WebSocket is not asking for a password. Enable authentication in Tools → WebSocket Server Settings, set a password, and connect again.'

export const EMPTY_PASSWORD_MESSAGE =
  'Enter the OBS WebSocket password. Tippy will not connect without one.'

export const NOT_LOCAL_MESSAGE =
  'Tippy only connects to OBS on this computer (127.0.0.1). On a two-PC setup, run this app on the PC where OBS is recording.'

export const REPLAY_OFF_MESSAGE =
  'Replay buffer is off. In OBS, open Settings → Output → Replay Buffer, enable it, set the length, and start the replay buffer. Tippy will not change your stream or recording settings unless you explicitly confirm that here.'

export const DISCONNECTED_SAVE_MESSAGE =
  'OBS disconnected before the replay file was confirmed. Tippy did not mark this moment as saved. Reconnect and try again. If OBS already wrote a file, the next save uses that file instead of saving a second one.'

export const DISCONNECTED_IDLE_MESSAGE =
  'OBS disconnected. Check that OBS is open and the WebSocket server is still enabled.'

export const DUPLICATE_MESSAGE =
  'This moment is already saved. Tippy did not ask OBS to save again.'

export const ADOPTED_MESSAGE =
  'OBS had already written this replay. Tippy recorded the file and did not save a second one.'

export const STALE_PATH_MESSAGE =
  'OBS did not produce a new replay file. Tippy did not mark this moment as saved.'

export const UNCALIBRATED_MESSAGE =
  'Calibrate the audio spike against normal game volume before turning it on.'

export const AUDIO_OFF_COPY =
  'Audio spike is off until you calibrate it. Tippy listens only on this PC. The level has to stay above your normal game volume, then it waits 20 seconds.'

export function incompatibleMessage(obsVersion: string, websocketVersion: string): string {
  return `This prototype needs OBS Studio 28 or newer with obs-websocket 5. OBS reported ${obsVersion} and websocket ${websocketVersion}.`
}

export function lowDiskMessage(freeMb: number, minimumMb = LOW_DISK_MB): string {
  const free = Math.round(freeMb)
  return `OBS reports ${free} MB free on the recording drive. Free at least ${minimumMb} MB, then try again. Nothing was saved.`
}

export function missingFileMessage(filePath: string): string {
  return `OBS named a replay file, but it is not on disk: ${filePath}`
}

export function emptyFileMessage(filePath: string): string {
  return `The replay file is empty (0 bytes): ${filePath}`
}

export function blockedRequestMessage(requestType: string): string {
  return `Blocked ${requestType}. Tippy does not change OBS stream or recording settings.`
}

export function consentRequiredMessage(requestType: string): string {
  return `${requestType} needs an explicit confirmation. Stream and recording settings stay as they are until you confirm.`
}
