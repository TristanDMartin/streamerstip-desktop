import { MAX_MOMENT_SECONDS, UPLOAD_FLAG } from './constants'

export type SaveTrigger = 'manual' | 'hotkey' | 'audio' | 'chat'

export interface ClipCandidate {
  source: 'obs_replay'
  localPath: string
  fileSizeBytes: number
  fileModifiedAtMs: number
  trigger: SaveTrigger
  triggerTimestamp: number
  clipStartTimestamp: number
  clipEndTimestamp: number
  idempotencyKey: string
  rightsStatus: 'creator_owned'
  deviceId: string
  hostname: string
  sessionId: string
  obsVersion: string
  obsWebSocketVersion: string
  obsPlatform: string
  replayLengthSeconds: number
  moment: LocalMomentPlan
}

export type LocalMomentPlan =
  | {
      ok: true
      runsNow: false
      network: 'none'
      scope: 'candidate_window_only'
      localPath: string
      maxSeconds: number
      refuses: 'whole_stream_transcription'
    }
  | {
      ok: false
      runsNow: false
      network: 'none'
      reason: 'window_too_long' | 'window_invalid'
      refuses: 'whole_stream_transcription'
    }

export function planLocalMoment(input: {
  localPath: string
  replayLengthSeconds: number
}): LocalMomentPlan {
  const seconds = input.replayLengthSeconds
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return {
      ok: false,
      runsNow: false,
      network: 'none',
      reason: 'window_invalid',
      refuses: 'whole_stream_transcription',
    }
  }
  if (seconds > MAX_MOMENT_SECONDS) {
    return {
      ok: false,
      runsNow: false,
      network: 'none',
      reason: 'window_too_long',
      refuses: 'whole_stream_transcription',
    }
  }
  return {
    ok: true,
    runsNow: false,
    network: 'none',
    scope: 'candidate_window_only',
    localPath: input.localPath,
    maxSeconds: seconds,
    refuses: 'whole_stream_transcription',
  }
}

export function fileIdempotencyKey(deviceId: string, localPath: string, fileSizeBytes: number, fileModifiedAtMs: number): string {
  return `obs_replay:${deviceId}:${localPath}:${fileSizeBytes}:${fileModifiedAtMs}`
}

export function windowIdempotencyKey(deviceId: string, sessionId: string, nowMs: number, windowMs: number): string {
  const bucket = Math.floor(nowMs / windowMs)
  return `obs_replay:${deviceId}:${sessionId}:${bucket}`
}

export interface MarkerReport {
  collection: 'tippyClipMarkers'
  write: 'server_admin_sdk'
  ownerIdSource: 'firebase_id_token'
  media: 'local_only'
  document: {
    source: 'obs_replay'
    platform: 'obs'
    clipStatus: 'marked'
    twitchClipId: null
    clipUrl: null
    embedUrl: null
    rightsStatus: 'creator_owned'
    localPath: string
    fileSizeBytes: number
    triggerType: SaveTrigger
    triggerTimestamp: number
    clipStartTimestamp: number
    clipEndTimestamp: number
    idempotencyKey: string
    deviceId: string
    note: string
  }
}

export function toMarkerReport(candidate: ClipCandidate): MarkerReport {
  return {
    collection: 'tippyClipMarkers',
    write: 'server_admin_sdk',
    ownerIdSource: 'firebase_id_token',
    media: 'local_only',
    document: {
      source: candidate.source,
      platform: 'obs',
      clipStatus: 'marked',
      twitchClipId: null,
      clipUrl: null,
      embedUrl: null,
      rightsStatus: 'creator_owned',
      localPath: candidate.localPath,
      fileSizeBytes: candidate.fileSizeBytes,
      triggerType: candidate.trigger,
      triggerTimestamp: candidate.triggerTimestamp,
      clipStartTimestamp: candidate.clipStartTimestamp,
      clipEndTimestamp: candidate.clipEndTimestamp,
      idempotencyKey: candidate.idempotencyKey,
      deviceId: candidate.deviceId,
      note: `OBS replay on ${candidate.hostname}`,
    },
  }
}

export interface MuxUploadPlan {
  flag: typeof UPLOAD_FLAG
  enabled: false
  request: {
    method: 'POST'
    path: '/api/mux/direct-upload'
    authorization: 'Bearer <firebase-id-token>'
    body: {
      userId: '<token.uid>'
      videoId: null
      caption: string
      privacy: 'private'
      isDraft: true
    }
  }
  followUp: 'PUT the local file bytes to uploadUrl. Do not delete the local file.'
}

export function authorizeClipUpload(candidate: ClipCandidate, approved: boolean): MuxUploadPlan | null {
  if (approved !== true) return null
  return planMuxUpload(candidate)
}

export function planMuxUpload(candidate: ClipCandidate): MuxUploadPlan {
  return {
    flag: UPLOAD_FLAG,
    enabled: false,
    request: {
      method: 'POST',
      path: '/api/mux/direct-upload',
      authorization: 'Bearer <firebase-id-token>',
      body: {
        userId: '<token.uid>',
        videoId: null,
        caption: `OBS replay ${candidate.trigger}`,
        privacy: 'private',
        isDraft: true,
      },
    },
    followUp: 'PUT the local file bytes to uploadUrl. Do not delete the local file.',
  }
}

export interface UploadRunResult {
  ran: false
  reason: 'flag_off' | 'prototype_lock'
}

export async function runMuxUpload(
  _plan: MuxUploadPlan,
  deps: { flag: boolean; fetchImpl: (url: string) => Promise<unknown> },
): Promise<UploadRunResult> {
  if (!deps.flag) return { ran: false, reason: 'flag_off' }
  return { ran: false, reason: 'prototype_lock' }
}

export interface DeviceSignInPlan {
  implemented: false
  network: 'none'
  steps: readonly string[]
}

export function describeDeviceSignIn(): DeviceSignInPlan {
  return {
    implemented: false,
    network: 'none',
    steps: [
      'Generate a device code, a short user code, and a PKCE verifier on this PC.',
      'Open the existing StreamersTip sign-in (Google or Apple via Firebase Auth) in the system browser.',
      'Require a verified email, the same gate as Mux direct upload and tippyClipMarkers creates.',
      'The server stores a single-use approval and mints a Firebase custom token with the Admin SDK.',
      'This PC exchanges the device code plus the verifier for that custom token, then calls signInWithCustomToken.',
      'Later API calls send Authorization: Bearer <id token>. The uid comes from the token, not from the body.',
      'Each PC keeps its own deviceId so one machine can be revoked without signing the account out everywhere.',
    ],
  }
}
