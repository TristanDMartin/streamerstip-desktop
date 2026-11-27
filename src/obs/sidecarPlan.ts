import { isBenchmarkCategory, SAMPLE_MANIFEST_SCHEMA, type BenchmarkCategory } from './captureContracts'
import type { ObsReplayGrant } from './mediaHandoff'
import { resolveProcessingMode, type OutputActivity, type ProcessingMode } from './processingMode'

export interface SidecarPaths {
  nodePath: string
  scannerCli: string
  workDir: string
}

export interface SidecarRun {
  argv: string[]
  cwd: string
}

export type PlanResult = { ok: true; run: SidecarRun } | { ok: false; reason: string }

const CONSENT = 'creator_authorized_local_folder'

export function planAuthorize(input: {
  enabled: boolean
  paths: SidecarPaths
  ownerId: string
  rootPath: string
}): PlanResult {
  const gate = gatePaths(input.enabled, input.paths)
  if (!gate.ok) return gate
  if (!isLocalPath(input.rootPath)) return { ok: false, reason: 'remote_refused' }
  const grantPath = joinPath(input.paths.workDir, 'vod-grant.json')
  if (isInside(grantPath, input.rootPath)) return { ok: false, reason: 'output_inside_source' }
  return {
    ok: true,
    run: command(input.paths, [
      'authorize',
      '--root', input.rootPath,
      '--owner', input.ownerId,
      '--consent', CONSENT,
      '--out', grantPath,
    ]),
  }
}

export function planScan(input: {
  enabled: boolean
  paths: SidecarPaths
  grantPath: string
  filePath: string
  authorized: boolean
  mode: ProcessingMode
  activity: OutputActivity
}): PlanResult {
  const gate = gatePaths(input.enabled, input.paths)
  if (!gate.ok) return gate
  if (!input.authorized) return { ok: false, reason: 'not_authorized' }
  if (!isLocalPath(input.filePath) || !isLocalPath(input.grantPath)) return { ok: false, reason: 'remote_refused' }
  const decision = resolveProcessingMode(input.mode, input.activity)
  const out = joinPath(input.paths.workDir, 'extracted')
  if (isInside(out, parentOf(input.filePath))) return { ok: false, reason: 'output_inside_source' }
  return {
    ok: true,
    run: command(input.paths, [
      'scan',
      '--grant', input.grantPath,
      '--out', out,
      '--file', input.filePath,
      '--asr', decision.asr,
      '--footage', 'authorized_local',
    ]),
  }
}

export function planEdit(input: {
  enabled: boolean
  paths: SidecarPaths
  manifestPath: string
  ownerId: string
  sampleId: string
  selected: boolean
  mode: ProcessingMode
  activity: OutputActivity
}): PlanResult {
  const gate = gatePaths(input.enabled, input.paths)
  if (!gate.ok) return gate
  if (!input.selected) return { ok: false, reason: 'not_selected' }
  if (!isLocalPath(input.manifestPath)) return { ok: false, reason: 'remote_refused' }
  const decision = resolveProcessingMode(input.mode, input.activity)
  if (!decision.allowEdit) return { ok: false, reason: 'mode_blocks_edit' }
  if (decision.maxSamples === 0) return { ok: false, reason: 'mode_blocks_edit' }
  const out = joinPath(input.paths.workDir, 'rendered')
  return {
    ok: true,
    run: command(input.paths, [
      'edit',
      '--manifest', input.manifestPath,
      '--out', out,
      '--owner', input.ownerId,
      '--sample', input.sampleId,
    ]),
  }
}

export interface ReplayManifest {
  schema: typeof SAMPLE_MANIFEST_SCHEMA
  footage: 'real'
  authorization: {
    ownerId: string
    consent: 'creator_authorized_local_replay'
    savedAt: string
  }
  samples: Array<{
    id: string
    source: string
    startSec: 0
    endSec: number
    durationSec: number
    detectionReason: string
    classification: BenchmarkCategory[]
    audioTracks: []
  }>
}

export function planReplayManifest(input: {
  grant: ObsReplayGrant | null
  category: string
  durationSec: number
}): { ok: true; manifest: ReplayManifest } | { ok: false; reason: string } {
  if (!input.grant) return { ok: false, reason: 'not_authorized' }
  if (!isLocalPath(input.grant.replayPath)) return { ok: false, reason: 'remote_refused' }
  if (!isBenchmarkCategory(input.category)) return { ok: false, reason: 'category_required' }
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > 120) {
    return { ok: false, reason: 'window_exceeds_120s' }
  }
  return {
    ok: true,
    manifest: {
      schema: SAMPLE_MANIFEST_SCHEMA,
      footage: 'real',
      authorization: {
        ownerId: input.grant.ownerId,
        consent: 'creator_authorized_local_replay',
        savedAt: input.grant.savedAt,
      },
      samples: [{
        id: 'obs-replay',
        source: input.grant.replayPath,
        startSec: 0,
        endSec: input.durationSec,
        durationSec: input.durationSec,
        detectionReason: 'Creator-owned OBS replay. Tippy did not invent a highlight category.',
        classification: [input.category],
        audioTracks: [],
      }],
    },
  }
}

function gatePaths(enabled: boolean, paths: SidecarPaths): { ok: true } | { ok: false; reason: string } {
  if (!enabled) return { ok: false, reason: 'flag_off' }
  if (!isNodeProgram(paths.nodePath)) return { ok: false, reason: 'bad_node' }
  if (!isScannerCli(paths.scannerCli)) return { ok: false, reason: 'bad_cli' }
  if (!isLocalPath(paths.workDir)) return { ok: false, reason: 'bad_workdir' }
  return { ok: true }
}

function command(paths: SidecarPaths, args: string[]): SidecarRun {
  return {
    cwd: paths.workDir,
    argv: [paths.nodePath, '--experimental-strip-types', paths.scannerCli, ...args],
  }
}

function isNodeProgram(value: string): boolean {
  if (value === 'node') return true
  return isLocalPath(value) && /[/\\]node(\.exe)?$/i.test(value)
}

function isScannerCli(value: string): boolean {
  return isLocalPath(value) && value.replace(/\\/g, '/').endsWith('services/tippy-vod-scanner/src/cli.ts')
}

function isLocalPath(value: string): boolean {
  const path = value.trim()
  if (!path || path.includes('://') || path.toLowerCase().includes('twitch.tv')) return false
  if (path.startsWith('/') || path.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(path)
}

function isInside(child: string, parent: string): boolean {
  const left = child.replace(/\\/g, '/').replace(/\/+$/, '')
  const right = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  return left === right || left.startsWith(`${right}/`)
}

function parentOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? normalized : normalized.slice(0, index)
}

function joinPath(dir: string, name: string): string {
  if (dir.includes('\\')) return `${dir.replace(/\\+$/, '')}\\${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}
