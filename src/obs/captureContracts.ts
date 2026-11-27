// Mirror of TristanDMartin/streamerstipReact lib/tippy/contracts/mediaPaths.ts
// at 6b92cf83 on cursor/tippy-live-clips-week1-2435, plus docs/TIPPY_MEDIA_CONTRACTS.md.
// Cross-repo import is not practical. validateClipContract refuses any other schema.
// Editing also requires tippy.consent-grant.v1 from contracts/ at 1e95995c.
// A claimed mediaRights or sample id is not a grant.

export const CLIP_CONTRACT_SCHEMA = 'tippy.clip-contract.v1' as const
export const SAMPLE_MANIFEST_SCHEMA = 'tippy.sample-manifest.v1' as const
export const TIPPY_CREATOR_INBOX_FLAG = 'tippy_creator_inbox_enabled'
export const CONSENT_GRANT_SCHEMA = 'tippy.consent-grant.v1' as const
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

export function canEnterEditingPipeline(
  contract: ClipContract,
  input: EditGrantInput = { ownerId: '', source: '', grants: [] },
): boolean {
  const rights: string = contract.mediaRights
  if (contract.sourcePath === 'twitch_live' || rights === 'twitch_hosted') return false
  if (!contract.authorized || !contract.editingPipeline || contract.publishing !== 'unapproved') return false
  return requireLocalEditGrant(input).ok
}

export function assertEditingAllowed(
  contract: ClipContract,
  input: EditGrantInput = { ownerId: '', source: '', grants: [] },
): void {
  const rights: string = contract.mediaRights
  if (contract.sourcePath === 'twitch_live' || rights === 'twitch_hosted') {
    throw new Error('Path A clips stay on Twitch and cannot enter the editing pipeline.')
  }
  if (!contract.authorized) throw new Error('Editing needs creator authorization.')
  if (contract.publishing !== 'unapproved') throw new Error('Publishing stays unapproved.')
  const grant = requireLocalEditGrant(input)
  if (!grant.ok) throw new Error(grant.message)
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

export interface EditGrantInput {
  ownerId: string
  source: string
  grants: readonly unknown[]
}

export interface LocalEditGrant {
  schema: typeof CONSENT_GRANT_SCHEMA
  id: string
  ownerId: string
  source: string
  timestamp: string
  scope: 'local_edit' | 'cloud_sync'
  hash: string
  revokedAt: string | null
}

export function createLocalEditGrant(input: {
  id: string
  ownerId: string
  source: string
  timestamp: string
}): LocalEditGrant {
  const scope = 'local_edit' as const
  return {
    schema: CONSENT_GRANT_SCHEMA,
    id: input.id,
    ownerId: input.ownerId,
    source: input.source,
    timestamp: input.timestamp,
    scope,
    hash: grantHash({ source: input.source, timestamp: input.timestamp, scope }),
    revokedAt: null,
  }
}

export function revokeLocalEditGrant(grant: LocalEditGrant, revokedAt: string): LocalEditGrant {
  return { ...grant, revokedAt }
}

export function requireLocalEditGrant(
  input: EditGrantInput,
): { ok: true; grant: LocalEditGrant } | { ok: false; reason: 'grant_missing' | 'grant_mismatch' | 'grant_revoked'; message: string } {
  const owned = input.grants
    .map((grant) => readConsentGrant(grant))
    .filter((grant): grant is LocalEditGrant => grant !== null && grant.ownerId === input.ownerId && grant.source === input.source)
  if (owned.length === 0) {
    return { ok: false, reason: 'grant_missing', message: 'a claimed mediaRights or sampleManifestId is not a local authorization grant.' }
  }
  const editGrants = owned.filter((grant) => grant.scope === 'local_edit')
  if (editGrants.length === 0) {
    return { ok: false, reason: 'grant_mismatch', message: 'consent grant scope is not local_edit.' }
  }
  const grant = editGrants[0]
  if (grant.hash !== grantHash(grant)) {
    return { ok: false, reason: 'grant_mismatch', message: 'consent grant hash does not match source, timestamp, and scope.' }
  }
  if (grant.revokedAt !== null) {
    return { ok: false, reason: 'grant_revoked', message: 'consent grant is revoked.' }
  }
  return { ok: true, grant }
}

function readConsentGrant(value: unknown): LocalEditGrant | null {
  if (!isRecord(value) || value.schema !== CONSENT_GRANT_SCHEMA) return null
  if (typeof value.id !== 'string' || typeof value.ownerId !== 'string' || typeof value.source !== 'string') return null
  if (value.scope !== 'local_edit' && value.scope !== 'cloud_sync') return null
  if (typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return null
  if (typeof value.hash !== 'string') return null
  if (value.revokedAt !== null && typeof value.revokedAt !== 'string') return null
  return {
    schema: CONSENT_GRANT_SCHEMA,
    id: value.id,
    ownerId: value.ownerId,
    source: value.source,
    timestamp: value.timestamp,
    scope: value.scope,
    hash: value.hash,
    revokedAt: value.revokedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function grantHash(input: { source: string; timestamp: string; scope: string }): string {
  const payload = JSON.stringify({
    scope: input.scope,
    source: input.source,
    timestamp: input.timestamp,
  })
  return sha256Hex(payload)
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function sha256Hex(message: string): string {
  const data = new TextEncoder().encode(message)
  const bitLength = data.length * 8
  const paddedLength = ((data.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  let a0 = 0x6a09e667
  let b0 = 0xbb67ae85
  let c0 = 0x3c6ef372
  let d0 = 0xa54ff53a
  let e0 = 0x510e527f
  let f0 = 0x9b05688c
  let g0 = 0x1f83d9ab
  let h0 = 0x5be0cd19
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3)
      const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10)
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0
    }
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    let e = e0
    let f = f0
    let g = g0
    let h = h0
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + SHA256_K[i] + words[i]) >>> 0
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
    e0 = (e0 + e) >>> 0
    f0 = (f0 + f) >>> 0
    g0 = (g0 + g) >>> 0
    h0 = (h0 + h) >>> 0
  }
  return [a0, b0, c0, d0, e0, f0, g0, h0].map((word) => word.toString(16).padStart(8, '0')).join('')
}
