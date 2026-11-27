// Mirror of TristanDMartin/streamerstipReact lib/tippy/contracts/mediaPaths.ts
// at 6b92cf83 on cursor/tippy-live-clips-week1-2435, plus docs/TIPPY_MEDIA_CONTRACTS.md.
// Cross-repo import is not practical. validateClipContract refuses any other schema.

export const CLIP_CONTRACT_SCHEMA = 'tippy.clip-contract.v1' as const
export const SAMPLE_MANIFEST_SCHEMA = 'tippy.sample-manifest.v1' as const
export const TIPPY_CREATOR_INBOX_FLAG = 'tippy_creator_inbox_enabled'
export const EXPECTED_CLIP_CONTRACT_SCHEMA = 'tippy.clip-contract.v1'

export type SourcePath = 'twitch_live' | 'obs_replay' | 'vod_intelligence'

type PlannerFields = {
  schema: typeof CLIP_CONTRACT_SCHEMA
  title: string
  hook: string
  caption: string
  status: 'idea'
  approvalRequired: true
  inboxMarkerId: string | null
}

export type TwitchLiveClip = PlannerFields & {
  sourcePath: 'twitch_live'
  mediaRights: 'twitch_hosted'
  storage: 'link_only'
  processing: 'none'
  editingPipeline: false
  download: false
  rehost: false
  clipId: string | null
  clipUrl: string | null
  embedUrl: string | null
  shareHref: string | null
}

export type ObsReplayClip = PlannerFields & {
  sourcePath: 'obs_replay'
  mediaRights: 'creator_owned'
  storage: 'creator_inventory'
  processing: 'authorized_only'
  editingPipeline: boolean
  download: false
  authorized: boolean
  inventoryId: string
  editedVideoId: string | null
  publishing: 'unapproved'
}

export type VodIntelligenceClip = PlannerFields & {
  sourcePath: 'vod_intelligence'
  mediaRights: 'creator_owned'
  storage: 'creator_inventory'
  processing: 'authorized_only'
  editingPipeline: boolean
  download: false
  authorized: boolean
  sampleManifestSchema: typeof SAMPLE_MANIFEST_SCHEMA
  sampleManifestId: string
  editedVideoId: string | null
  publishing: 'unapproved'
}

export type ClipContract = TwitchLiveClip | ObsReplayClip | VodIntelligenceClip

const REVIEW_ACTIONS = ['edit', 'dismiss', 'retry', 'save', 'undo'] as const

export function assertClipContractSchema(): void {
  if (CLIP_CONTRACT_SCHEMA !== EXPECTED_CLIP_CONTRACT_SCHEMA) {
    throw new Error(`clip contract must be ${EXPECTED_CLIP_CONTRACT_SCHEMA}`)
  }
}

export function sourcePathOf(value: unknown): SourcePath {
  if (value === 'obs_replay' || value === 'vod_intelligence') return value
  return 'twitch_live'
}

export function clipInboxVisible(input: {
  sourcePath: unknown
  liveClipsEnabled: boolean
  creatorInboxEnabled: boolean
}): boolean {
  const sourcePath = sourcePathOf(input.sourcePath)
  if (sourcePath === 'twitch_live') return input.liveClipsEnabled
  return input.creatorInboxEnabled
}

export function canEnterEditingPipeline(contract: ClipContract): boolean {
  const rights: string = contract.mediaRights
  if (contract.sourcePath === 'twitch_live' || rights === 'twitch_hosted') return false
  return contract.authorized && contract.editingPipeline && contract.publishing === 'unapproved'
}

export function assertEditingAllowed(contract: ClipContract): void {
  const rights: string = contract.mediaRights
  if (contract.sourcePath === 'twitch_live' || rights === 'twitch_hosted') {
    throw new Error('Path A clips stay on Twitch and cannot enter the editing pipeline.')
  }
  if (!contract.authorized) throw new Error('Editing needs creator authorization.')
  if (contract.publishing !== 'unapproved') throw new Error('Publishing stays unapproved.')
}

export function clipReviewActionAllowed(sourcePath: unknown, action: string): boolean {
  if (action === 'publish' || action === 'process' || action === 'edit_media') return false
  if (!REVIEW_ACTIONS.includes(action as (typeof REVIEW_ACTIONS)[number])) return false
  if (sourcePathOf(sourcePath) !== 'twitch_live' && action === 'retry') return false
  return true
}

function plannerFields(title: string): PlannerFields {
  assertClipContractSchema()
  return {
    schema: CLIP_CONTRACT_SCHEMA,
    title,
    hook: '',
    caption: '',
    status: 'idea',
    approvalRequired: true,
    inboxMarkerId: null,
  }
}

export function emitTwitchLiveClip(input: { title?: string; clipUrl?: string | null }): TwitchLiveClip {
  return {
    ...plannerFields(input.title ?? ''),
    sourcePath: 'twitch_live',
    mediaRights: 'twitch_hosted',
    storage: 'link_only',
    processing: 'none',
    editingPipeline: false,
    download: false,
    rehost: false,
    clipId: null,
    clipUrl: input.clipUrl ?? null,
    embedUrl: null,
    shareHref: null,
  }
}

export function emitObsReplayClip(input: {
  title?: string
  inventoryId: string
  authorized: boolean
}): ObsReplayClip {
  return {
    ...plannerFields(input.title ?? ''),
    sourcePath: 'obs_replay',
    mediaRights: 'creator_owned',
    storage: 'creator_inventory',
    processing: 'authorized_only',
    editingPipeline: input.authorized,
    download: false,
    authorized: input.authorized,
    inventoryId: input.inventoryId,
    editedVideoId: null,
    publishing: 'unapproved',
  }
}

export function emitVodClip(input: {
  title?: string
  sampleManifestId: string
  authorized: boolean
}): VodIntelligenceClip {
  return {
    ...plannerFields(input.title ?? ''),
    sourcePath: 'vod_intelligence',
    mediaRights: 'creator_owned',
    storage: 'creator_inventory',
    processing: 'authorized_only',
    editingPipeline: input.authorized,
    download: false,
    authorized: input.authorized,
    sampleManifestSchema: SAMPLE_MANIFEST_SCHEMA,
    sampleManifestId: input.sampleManifestId,
    editedVideoId: null,
    publishing: 'unapproved',
  }
}

export function validateClipContract(value: unknown): { ok: true; contract: ClipContract } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'not_an_object' }
  if (value.schema !== CLIP_CONTRACT_SCHEMA) return { ok: false, reason: 'schema' }
  if (value.status !== 'idea' || value.approvalRequired !== true) return { ok: false, reason: 'planner' }
  if (value.sourcePath === 'twitch_live') return validateTwitch(value)
  if (value.sourcePath === 'obs_replay') return validateObs(value)
  if (value.sourcePath === 'vod_intelligence') return validateVod(value)
  return { ok: false, reason: 'sourcePath' }
}

function validateTwitch(value: Record<string, unknown>): { ok: true; contract: TwitchLiveClip } | { ok: false; reason: string } {
  if (value.mediaRights !== 'twitch_hosted' || value.storage !== 'link_only' || value.processing !== 'none') {
    return { ok: false, reason: 'path_a_rights' }
  }
  if (value.editingPipeline !== false || value.download !== false || value.rehost !== false) {
    return { ok: false, reason: 'path_a_cannot_edit' }
  }
  return { ok: true, contract: value as unknown as TwitchLiveClip }
}

function validateObs(value: Record<string, unknown>): { ok: true; contract: ObsReplayClip } | { ok: false; reason: string } {
  if (value.mediaRights !== 'creator_owned' || value.storage !== 'creator_inventory' || value.processing !== 'authorized_only') {
    return { ok: false, reason: 'path_b_rights' }
  }
  if (value.download !== false || value.publishing !== 'unapproved') return { ok: false, reason: 'path_b_publish' }
  if (typeof value.inventoryId !== 'string' || value.inventoryId.length === 0) return { ok: false, reason: 'inventoryId' }
  if (typeof value.authorized !== 'boolean' || value.editingPipeline !== value.authorized) {
    return { ok: false, reason: 'authorized' }
  }
  return { ok: true, contract: value as unknown as ObsReplayClip }
}

function validateVod(value: Record<string, unknown>): { ok: true; contract: VodIntelligenceClip } | { ok: false; reason: string } {
  if (value.mediaRights !== 'creator_owned' || value.sampleManifestSchema !== SAMPLE_MANIFEST_SCHEMA) {
    return { ok: false, reason: 'path_c_manifest' }
  }
  if (typeof value.sampleManifestId !== 'string' || value.sampleManifestId.length === 0) {
    return { ok: false, reason: 'sampleManifestId' }
  }
  if (value.download !== false || value.publishing !== 'unapproved') return { ok: false, reason: 'path_c_publish' }
  if (typeof value.authorized !== 'boolean' || value.editingPipeline !== value.authorized) {
    return { ok: false, reason: 'authorized' }
  }
  return { ok: true, contract: value as unknown as VodIntelligenceClip }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
