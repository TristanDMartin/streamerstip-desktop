export const UI_HOST = '127.0.0.1'
export const UI_PORT = 4735
export const LOW_DISK_MB = 2048
export const DUPLICATE_WINDOW_MS = 3000
export const DEFAULT_REPLAY_SECONDS = 30
export const MAX_MOMENT_SECONDS = 120
export const AUDIO_MARGIN_DB = 8
export const AUDIO_MINIMUM_DB = -24
export const AUDIO_COOLDOWN_MS = 20_000
export const AUDIO_SUSTAIN_SAMPLES = 3
export const AUDIO_MAX_GAP_MS = 120
export const CALIBRATION_MIN_SAMPLES = 10
export const SAVE_TIMEOUT_MS = 8000
export const ADOPT_SLACK_MS = 10_000
export const AUTH_CLOSE_CODE = 4009
export const OUTPUT_NOT_RUNNING = 501
export const LOCAL_HEADER = 'x-tippy-local'
export const DEFAULT_HOTKEY = 'Ctrl+Shift+F9'
export const UPLOAD_FLAG = 'tippy_obs_replay_upload_enabled'
export const REQUIRED_OBS_REQUESTS = [
  'GetVersion',
  'GetStats',
  'GetReplayBufferStatus',
  'SaveReplayBuffer',
  'GetLastReplayBufferReplay',
] as const
