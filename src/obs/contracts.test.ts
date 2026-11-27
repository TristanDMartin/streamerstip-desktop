import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  CLIP_CONTRACT_SCHEMA,
  SAMPLE_MANIFEST_SCHEMA,
  TIPPY_CREATOR_INBOX_FLAG,
  assertEditingAllowed,
  canEnterEditingPipeline,
  clipInboxVisible,
  clipReviewActionAllowed,
  createLocalEditGrant,
  emitObsReplayClip,
  emitTwitchLiveClip,
  emitVodClip,
  requireLocalEditGrant,
  revokeLocalEditGrant,
  validateClipContract,
} from './captureContracts'

test('path A is link only and can never enter editing', () => {
  const contract = emitTwitchLiveClip({ clipUrl: 'https://clips.twitch.tv/Example' })
  assert.equal(contract.schema, CLIP_CONTRACT_SCHEMA)
  assert.equal(contract.sourcePath, 'twitch_live')
  assert.equal(contract.mediaRights, 'twitch_hosted')
  assert.equal(contract.editingPipeline, false)
  assert.equal(contract.download, false)
  assert.equal(contract.rehost, false)
  assert.equal(canEnterEditingPipeline(contract), false)
  assert.throws(() => assertEditingAllowed(contract), /cannot enter the editing pipeline/)
  const forced = { ...contract, editingPipeline: true }
  assert.equal(canEnterEditingPipeline(forced as typeof contract), false)
  const validated = validateClipContract(forced)
  assert.equal(validated.ok, false)
  assert.equal(clipReviewActionAllowed('twitch_live', 'publish'), false)
  assert.equal(clipReviewActionAllowed('twitch_live', 'retry'), true)
})

test('paths B and C stay out of the inbox until the creator flag is on', () => {
  const replay = emitObsReplayClip({ inventoryId: 'obs_replay:pc:file:12:1', authorized: true, title: 'Save' })
  const checked = validateClipContract(replay)
  assert.equal(checked.ok, true)
  if (checked.ok) {
    assert.equal(checked.contract.sourcePath, 'obs_replay')
    assert.equal(checked.contract.mediaRights, 'creator_owned')
    assert.equal(canEnterEditingPipeline(checked.contract), false)
    const known = createLocalEditGrant({
      id: 'grant-path-b',
      ownerId: 'owner-1',
      source: '/local/obs/replay.mp4',
      timestamp: '2026-11-27T00:00:00.000Z',
    })
    assert.equal(known.hash, '8f9d0827de17845bcf7cda0ef3ed65ed2f62b688870d8f2748178de0dc13cda1')
    const grant = createLocalEditGrant({
      id: 'grant-1',
      ownerId: 'owner_test',
      source: '/videos/replay.mkv',
      timestamp: '2026-11-27T00:00:00.000Z',
    })
    const input = { ownerId: 'owner_test', source: '/videos/replay.mkv', grants: [grant] }
    assert.equal(canEnterEditingPipeline(checked.contract, input), true)
    assert.doesNotThrow(() => assertEditingAllowed(checked.contract, input))
    const revoked = revokeLocalEditGrant(grant, '2026-11-27T01:00:00.000Z')
    assert.equal(requireLocalEditGrant({ ...input, grants: [revoked] }).ok, false)
    assert.throws(() => assertEditingAllowed(checked.contract, { ...input, grants: [revoked] }), /revoked/)
  }
  const blocked = emitObsReplayClip({ inventoryId: 'obs_replay:pc:file:12:1', authorized: false })
  assert.equal(canEnterEditingPipeline(blocked), false)
  assert.throws(() => assertEditingAllowed(blocked), /authorization/)
  const vod = emitVodClip({ sampleManifestId: 'manifest-1', authorized: true })
  assert.equal(vod.sampleManifestSchema, SAMPLE_MANIFEST_SCHEMA)
  assert.equal(vod.sourcePath, 'vod_intelligence')
  assert.equal(validateClipContract({ ...vod, sampleManifestId: '' }).ok, false)
  assert.equal(clipInboxVisible({
    sourcePath: 'obs_replay',
    liveClipsEnabled: true,
    creatorInboxEnabled: false,
  }), false)
  assert.equal(clipInboxVisible({
    sourcePath: 'vod_intelligence',
    liveClipsEnabled: false,
    creatorInboxEnabled: true,
  }), true)
  assert.equal(TIPPY_CREATOR_INBOX_FLAG, 'tippy_creator_inbox_enabled')
  assert.equal(clipReviewActionAllowed('obs_replay', 'retry'), false)
  assert.equal(clipReviewActionAllowed('vod_intelligence', 'edit'), true)
  assert.equal(validateClipContract({ ...replay, mediaRights: 'twitch_hosted' }).ok, false)
})
