import type { StoredClip } from './inventory'

export const VOD_STEPS = [
  'Import recording',
  'Scan',
  'Detect candidates',
  'Review highlights',
  'AI edit',
  'Approve',
  'Content Planner',
  'Publish',
] as const

export interface ObsReplayGrant {
  ownerId: string
  replayPath: string
  savedAt: string
  consent: 'creator_authorized_local_replay'
  obsVersion?: string
}

export interface VodScanRequest {
  sourcePath: string
  maxWindowSec: 120
  modifySource: false
  runsNow: false
  network: 'none'
}

export interface VodCandidate {
  sourcePath: string
  startSec: number
  endSec: number
  durationSec: number
  reason: string
  classification: string
  confirmedHighlight: false
}

export function planObsReplayGrant(item: StoredClip, ownerId: string, obsVersion?: string): ObsReplayGrant | null {
  if (!item.uploadAuthorized) return null
  if (!ownerId.trim() || !item.localPath.trim()) return null
  return {
    ownerId,
    replayPath: item.localPath,
    savedAt: new Date(item.triggerTimestamp).toISOString(),
    consent: 'creator_authorized_local_replay',
    obsVersion,
  }
}

export function planVodScan(sourcePath: string, enabled: boolean): VodScanRequest | { ok: false; reason: 'flag_off' | 'missing_path' } {
  if (!enabled) return { ok: false, reason: 'flag_off' }
  if (!sourcePath.trim()) return { ok: false, reason: 'missing_path' }
  return {
    sourcePath,
    maxWindowSec: 120,
    modifySource: false,
    runsNow: false,
    network: 'none',
  }
}
