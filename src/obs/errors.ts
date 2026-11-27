export type FailureCode =
  | 'auth_failed'
  | 'auth_required'
  | 'incompatible'
  | 'not_local'
  | 'not_connected'
  | 'replay_off'
  | 'low_disk'
  | 'disconnected'
  | 'missing_file'
  | 'empty_file'
  | 'stale_path'
  | 'blocked'
  | 'obs_error'
  | 'uncalibrated'

export class CaptureError extends Error {
  readonly code: FailureCode
  readonly duringSave: boolean

  constructor(code: FailureCode, message: string, duringSave = false) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
    this.duringSave = duringSave
  }
}
