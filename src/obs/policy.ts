import { REQUIRED_OBS_REQUESTS } from './constants'
import { blockedRequestMessage, consentRequiredMessage, incompatibleMessage, NOT_LOCAL_MESSAGE } from './messages'
import { CaptureError } from './errors'

const READ_REQUESTS = new Set<string>([
  ...REQUIRED_OBS_REQUESTS.filter((name) => name !== 'SaveReplayBuffer'),
  'GetStreamStatus',
  'GetRecordStatus',
])
const SAVE_REQUESTS = new Set<string>(['SaveReplayBuffer'])
const CONSENT_REQUESTS = new Set<string>(['StartReplayBuffer'])

export interface ReplayBufferConsent {
  action: 'start_replay_buffer'
  confirmed: true
}

export function assertObsRequestAllowed(requestType: string, consent: ReplayBufferConsent | null): void {
  if (READ_REQUESTS.has(requestType) || SAVE_REQUESTS.has(requestType)) return
  if (CONSENT_REQUESTS.has(requestType)) {
    if (consent?.action === 'start_replay_buffer' && consent.confirmed === true) return
    throw new CaptureError('blocked', consentRequiredMessage(requestType))
  }
  throw new CaptureError('blocked', blockedRequestMessage(requestType))
}

export interface ObsVersionReport {
  obsVersion: string
  obsWebSocketVersion: string
  rpcVersion: number
  availableRequests: readonly string[]
}

export function majorVersion(version: string): number {
  const match = /^(\d+)/.exec(version.trim())
  return match ? Number(match[1]) : 0
}

export function checkCompatibility(version: ObsVersionReport): { ok: true } | { ok: false; message: string } {
  const obsMajor = majorVersion(version.obsVersion)
  const socketMajor = majorVersion(version.obsWebSocketVersion)
  if (socketMajor < 5 || version.rpcVersion < 1 || obsMajor < 28) {
    return { ok: false, message: incompatibleMessage(version.obsVersion, version.obsWebSocketVersion) }
  }
  const missing = REQUIRED_OBS_REQUESTS.filter((name) => !version.availableRequests.includes(name))
  if (missing.length > 0) {
    return { ok: false, message: `OBS is missing ${missing.join(', ')}.` }
  }
  return { ok: true }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function assertLocalObsHost(host: string): void {
  if (!LOCAL_HOSTS.has(host.trim().toLowerCase())) {
    throw new CaptureError('not_local', NOT_LOCAL_MESSAGE)
  }
}

export function assertObsPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CaptureError('not_connected', 'OBS WebSocket port must be between 1 and 65535.')
  }
}

export function obsWebSocketUrl(host: string, port: number): string {
  assertLocalObsHost(host)
  assertObsPort(port)
  const normalized = host.trim().toLowerCase()
  if (normalized === '::1') return `ws://[::1]:${port}`
  return `ws://${normalized}:${port}`
}

export function diskDecision(freeMb: number | null, minimumMb: number): 'ok' | 'low' | 'unknown' {
  if (freeMb === null || !Number.isFinite(freeMb)) return 'unknown'
  if (freeMb < minimumMb) return 'low'
  return 'ok'
}
