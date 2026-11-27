import { createHash } from 'node:crypto'

export const FIXTURE_SCHEMA = 'tippy.contract-fixture.v1'
export const FIXTURE_SUITE_SCHEMA = 'tippy.contract-fixtures.v1'
export const FIXTURE_SUITE_VERSION = 1
export const CONSENT_GRANT_SCHEMA = 'tippy.consent-grant.v1'
export const CLIP_CONTRACT_SCHEMA = 'tippy.clip-contract.v1'
export const SAMPLE_MANIFEST_SCHEMA = 'tippy.sample-manifest.v1'
export const CLIP_CONTRACT_SOURCE = '6b92cf83'
export const SCANNER_HANDOFF_SOURCE = 'c3ff9ee62bac40e0634d43a6b6ede45d7058dc2d'

export const DECISION_CODES = [
  'twitch_link_only',
  'remote_media_refused',
  'consent_missing',
  'grant_missing',
  'grant_mismatch',
  'grant_revoked',
  'sample_unknown',
  'sample_mismatch',
  'duplicate_event',
  'schema_unsupported',
] as const

export type DecisionCode = (typeof DECISION_CODES)[number]
export type GrantScope = 'local_edit' | 'cloud_sync'

export interface ConsentGrant {
  schema: typeof CONSENT_GRANT_SCHEMA
  id: string
  ownerId: string
  source: string
  timestamp: string
  scope: GrantScope
  hash: string
  revokedAt: string | null
}

export interface EditableClip {
  schema: typeof CLIP_CONTRACT_SCHEMA
  sourcePath: 'obs_replay' | 'vod_intelligence'
  mediaRights: 'creator_owned'
  authorized: true
  editingPipeline: true
  publishing: 'unapproved'
  sampleManifestId?: string
  sampleId?: string
}

export type FixtureDecision =
  | { ok: true; clip: EditableClip }
  | { ok: false; code: DecisionCode; message: string }

const TWITCH_HOST_SUFFIXES = ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net', 'twitchsvc.net']

export function sourcePathOf(value: unknown): 'twitch_live' | 'obs_replay' | 'vod_intelligence' {
  if (value === 'obs_replay' || value === 'vod_intelligence') {
    return value
  }
  return 'twitch_live'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]))
  }
  return value
}

export function grantHash(input: { source: string; timestamp: string; scope: string }): string {
  const payload = JSON.stringify(sortValue({
    source: input.source,
    timestamp: input.timestamp,
    scope: input.scope,
  }))
  return createHash('sha256').update(payload).digest('hex')
}

export function evaluateFixture(value: unknown): FixtureDecision {
  const fixture = record(value)
  if (!fixture || fixture.fixtureSchema !== FIXTURE_SCHEMA) {
    return refuse('schema_unsupported', 'fixture schema must be tippy.contract-fixture.v1')
  }
  const events = Array.isArray(fixture.events) ? fixture.events : []
  const duplicateEvent = duplicateId(events)
  if (duplicateEvent) {
    return refuse('duplicate_event', `duplicate event id ${duplicateEvent}`)
  }
  const manifestDecision = readManifest(fixture.manifest)
  if (manifestDecision && !manifestDecision.ok) {
    return manifestDecision
  }
  const source = typeof fixture.source === 'string' ? fixture.source : ''
  const sourceClass = classifyRef(source)
  if (source && sourceClass === 'twitch') {
    return refuse('twitch_link_only', 'Twitch-hosted media stays link/embed only and is not ingested')
  }
  if (source && sourceClass === 'remote') {
    return refuse('remote_media_refused', 'remote media URLs are not fetched')
  }
  const clipDecision = readClip(fixture)
  if (!clipDecision.ok) {
    return clipDecision
  }
  const sampleDecision = matchSample(fixture, clipDecision.clip, manifestDecision?.manifest ?? null)
  if (!sampleDecision.ok) {
    return sampleDecision
  }
  const grantDecision = matchEditGrant(fixture, source)
  if (!grantDecision.ok) {
    return grantDecision
  }
  return { ok: true, clip: clipDecision.clip }
}

export function planCloudSync(input: {
  requested: boolean
  grants: unknown
  source: string
  ownerId: string
}): { sync: false; reason: string } | { sync: true; grantId: string } {
  if (!input.requested) {
    return { sync: false, reason: 'cloud sync was not requested' }
  }
  const grants = Array.isArray(input.grants) ? input.grants : []
  const match = grants
    .map((grant) => readGrant(grant))
    .find((grant) => grant
      && grant.ownerId === input.ownerId
      && grant.source === input.source
      && grant.scope === 'cloud_sync'
      && grant.revokedAt === null
      && grant.hash === grantHash(grant))
  if (!match) {
    return { sync: false, reason: 'cloud sync requires an explicit unrevoked cloud_sync grant' }
  }
  return { sync: true, grantId: match.id }
}

function readManifest(value: unknown): { ok: true; manifest: Record<string, unknown> } | { ok: false; code: DecisionCode; message: string } | null {
  if (value === null || value === undefined) {
    return null
  }
  const manifest = record(value)
  if (!manifest) {
    return refuse('schema_unsupported', 'sample manifest must be an object')
  }
  if (manifest.schema !== SAMPLE_MANIFEST_SCHEMA) {
    return refuse('schema_unsupported', 'sample manifest schema must be tippy.sample-manifest.v1')
  }
  if (!Array.isArray(manifest.samples)) {
    return refuse('consent_missing', 'sample manifest samples must be an array')
  }
  const duplicate = duplicateId(manifest.samples)
  if (duplicate) {
    return refuse('duplicate_event', `duplicate sample id ${duplicate}`)
  }
  for (const sample of manifest.samples) {
    const item = record(sample)
    const sampleSource = typeof item?.source === 'string' ? item.source : ''
    const kind = classifyRef(sampleSource)
    if (kind === 'twitch') {
      return refuse('twitch_link_only', 'Twitch-hosted media stays link/embed only and is not ingested')
    }
    if (kind === 'remote') {
      return refuse('remote_media_refused', 'remote media URLs are not fetched')
    }
  }
  if (manifest.footage === 'real' && !hasReplayAuthorization(manifest.authorization)) {
    return refuse('consent_missing', 'real footage manifest requires authorization with ownerId, consent, and savedAt')
  }
  return { ok: true, manifest }
}

function readClip(fixture: Record<string, unknown>): { ok: true; clip: EditableClip } | FixtureDecision {
  const clip = record(fixture.clip)
  if (!clip) {
    return refuse('consent_missing', 'clip contract is missing')
  }
  const sourcePath = sourcePathOf(clip.sourcePath)
  if (sourcePath === 'twitch_live' || clip.mediaRights === 'twitch_hosted') {
    return refuse('twitch_link_only', 'Path A clips stay on Twitch and cannot enter the editing pipeline.')
  }
  for (const key of ['clipUrl', 'embedUrl', 'shareHref', 'source']) {
    const ref = clip[key]
    if (typeof ref !== 'string' || ref.length === 0) {
      continue
    }
    const kind = classifyRef(ref)
    if (kind === 'twitch') {
      return refuse('twitch_link_only', 'Twitch-hosted media stays link/embed only and is not ingested')
    }
    if (kind === 'remote') {
      return refuse('remote_media_refused', 'remote media URLs are not fetched')
    }
  }
  if (clip.schema !== CLIP_CONTRACT_SCHEMA) {
    return refuse('schema_unsupported', 'schema must be tippy.clip-contract.v1.')
  }
  if (clip.mediaRights !== 'creator_owned') {
    return refuse('consent_missing', 'mediaRights does not permit editing.')
  }
  if (clip.authorized !== true) {
    return refuse('consent_missing', 'Editing needs creator authorization.')
  }
  if (clip.publishing !== 'unapproved') {
    return refuse('consent_missing', 'Publishing stays unapproved.')
  }
  if (clip.editingPipeline !== true) {
    return refuse('consent_missing', 'editingPipeline is false, so this item cannot be edited.')
  }
  const editable: EditableClip = {
    schema: CLIP_CONTRACT_SCHEMA,
    sourcePath,
    mediaRights: 'creator_owned',
    authorized: true,
    editingPipeline: true,
    publishing: 'unapproved',
  }
  if (sourcePath === 'vod_intelligence') {
    if (clip.sampleManifestSchema !== SAMPLE_MANIFEST_SCHEMA || typeof clip.sampleManifestId !== 'string' || clip.sampleManifestId.length === 0) {
      return refuse('consent_missing', 'Path C requires sampleManifestSchema tippy.sample-manifest.v1 and a sampleManifestId.')
    }
    editable.sampleManifestId = clip.sampleManifestId
    if (typeof clip.sampleId === 'string' && clip.sampleId.length > 0) {
      editable.sampleId = clip.sampleId
    }
  }
  return { ok: true, clip: editable }
}

function matchSample(
  fixture: Record<string, unknown>,
  clip: EditableClip,
  manifest: Record<string, unknown> | null,
): { ok: true } | FixtureDecision {
  if (clip.sourcePath !== 'vod_intelligence') {
    return { ok: true }
  }
  const sampleManifestId = clip.sampleManifestId ?? ''
  const catalog = Array.isArray(fixture.catalog) ? fixture.catalog.filter((id) => typeof id === 'string') : null
  if (catalog && !catalog.includes(sampleManifestId)) {
    return refuse('sample_unknown', 'sampleManifestId is not in the local catalog.')
  }
  if (!manifest) {
    return refuse('sample_unknown', 'sampleManifestId is not backed by a local manifest.')
  }
  if (manifest.id !== sampleManifestId) {
    return refuse('sample_mismatch', 'sampleManifestId does not match the local manifest.')
  }
  if (clip.sampleId) {
    const samples = Array.isArray(manifest.samples) ? manifest.samples : []
    const found = samples.some((sample) => record(sample)?.id === clip.sampleId)
    if (!found) {
      return refuse('sample_unknown', 'sample id is not in the manifest.')
    }
  }
  return { ok: true }
}

function matchEditGrant(fixture: Record<string, unknown>, source: string): { ok: true } | FixtureDecision {
  const ownerId = typeof fixture.ownerId === 'string' ? fixture.ownerId : ''
  const grants = Array.isArray(fixture.grants) ? fixture.grants : []
  const owned = grants
    .map((grant) => readGrant(grant))
    .filter((grant): grant is ConsentGrant => grant !== null && grant.ownerId === ownerId && grant.source === source)
  if (owned.length === 0) {
    return refuse('grant_missing', 'a claimed mediaRights or sampleManifestId is not a local authorization grant.')
  }
  const editGrants = owned.filter((grant) => grant.scope === 'local_edit')
  if (editGrants.length === 0) {
    return refuse('grant_mismatch', 'consent grant scope is not local_edit.')
  }
  const grant = editGrants[0]
  if (grant.hash !== grantHash(grant)) {
    return refuse('grant_mismatch', 'consent grant hash does not match source, timestamp, and scope.')
  }
  if (grant.revokedAt !== null) {
    return refuse('grant_revoked', 'consent grant is revoked.')
  }
  return { ok: true }
}

function readGrant(value: unknown): ConsentGrant | null {
  const grant = record(value)
  if (!grant || grant.schema !== CONSENT_GRANT_SCHEMA) {
    return null
  }
  if (typeof grant.id !== 'string' || typeof grant.ownerId !== 'string' || typeof grant.source !== 'string') {
    return null
  }
  if (grant.scope !== 'local_edit' && grant.scope !== 'cloud_sync') {
    return null
  }
  if (typeof grant.timestamp !== 'string' || Number.isNaN(Date.parse(grant.timestamp))) {
    return null
  }
  if (typeof grant.hash !== 'string') {
    return null
  }
  if (grant.revokedAt !== null && typeof grant.revokedAt !== 'string') {
    return null
  }
  return {
    schema: CONSENT_GRANT_SCHEMA,
    id: grant.id,
    ownerId: grant.ownerId,
    source: grant.source,
    timestamp: grant.timestamp,
    scope: grant.scope,
    hash: grant.hash,
    revokedAt: grant.revokedAt,
  }
}

function hasReplayAuthorization(value: unknown): boolean {
  const authorization = record(value)
  return Boolean(
    authorization
    && authorization.consent === 'creator_authorized_local_replay'
    && typeof authorization.ownerId === 'string'
    && typeof authorization.savedAt === 'string',
  )
}

function duplicateId(items: unknown[]): string | null {
  const seen = new Set<string>()
  for (const item of items) {
    const id = record(item)?.id
    if (typeof id !== 'string' || id.length === 0) {
      continue
    }
    if (seen.has(id)) {
      return id
    }
    seen.add(id)
  }
  return null
}

function classifyRef(input: string): 'twitch' | 'remote' | 'local' {
  const trimmed = input.trim()
  if (!trimmed || (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed) && !/^https?:/i.test(trimmed))) {
    return 'local'
  }
  let hostname = ''
  try {
    hostname = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed).hostname.toLowerCase()
  } catch {
    return 'remote'
  }
  const isTwitch = TWITCH_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  return isTwitch ? 'twitch' : 'remote'
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function refuse(code: DecisionCode, message: string): { ok: false; code: DecisionCode; message: string } {
  return { ok: false, code, message }
}
