import { AudioTrigger, peakMul, readMeterInputs, type CalibrationResult } from './audioTrigger'
import {
  ADOPT_SLACK_MS,
  DEFAULT_REPLAY_SECONDS,
  DUPLICATE_WINDOW_MS,
  LOW_DISK_MB,
  MAX_MOMENT_SECONDS,
} from './constants'
import {
  fileIdempotencyKey,
  planLocalMoment,
  windowIdempotencyKey,
  type ClipCandidate,
  type SaveTrigger,
} from './contract'
import { diskDecision } from './policy'
import { CaptureError, type FailureCode } from './errors'
import {
  ADOPTED_MESSAGE,
  AUDIO_OFF_COPY,
  DISCONNECTED_IDLE_MESSAGE,
  DUPLICATE_MESSAGE,
  RECONNECTING_MESSAGE,
  REPLAY_OFF_MESSAGE,
  STALE_PATH_MESSAGE,
  consentRequiredMessage,
  emptyFileMessage,
  lowDiskMessage,
  missingFileMessage,
} from './messages'
import { nextReconnectDelayMs, shouldKeepReconnecting } from './reconnect'
import { ObsSession } from './obsSession'

export type SaveResult =
  | { ok: true; duplicate: boolean; adopted: boolean; message: string; candidate: ClipCandidate }
  | { ok: false; code: FailureCode; message: string }

export interface AppStatus {
  connected: boolean
  host: string | null
  obsVersion: string | null
  obsWebSocketVersion: string | null
  obsPlatform: string | null
  replayActive: boolean | null
  diskFreeMb: number | null
  diskState: 'ok' | 'low' | 'unknown'
  lowDiskMb: number
  audioEnabled: boolean
  audioCalibrated: boolean
  audioThresholdDb: number | null
  audioInputName: string | null
  audioCopy: string
  hotkey: string
  deviceId: string
  hostname: string
  replayLengthSeconds: number
  lastMessage: string | null
  lastCode: string | null
  guidance: string | null
  candidates: Array<{
    localPath: string
    fileSizeBytes: number
    trigger: SaveTrigger
    idempotencyKey: string
    triggerTimestamp: number
    momentRunsNow: false
  }>
}

interface AmbiguousSave {
  startedAt: number
  previousPath: string | null
  trigger: SaveTrigger
}

interface FileInfo {
  size: number
  mtimeMs: number
}

export type StatFile = (filePath: string) => Promise<FileInfo | null>

export interface ChatSignal {
  idempotencyKey: string
  phrase: string
}

export interface AppOptions {
  deviceId?: string
  hostname?: string
  now?: () => number
  lowDiskMb?: number
  duplicateWindowMs?: number
  replayLengthSeconds?: number
  hotkey?: string
  statFile?: StatFile
}

export class TippyApp {
  readonly deviceId: string
  readonly hostname: string
  readonly audio = new AudioTrigger()
  private readonly session = new ObsSession()
  private readonly now: () => number
  private readonly lowDiskMb: number
  private readonly duplicateWindowMs: number
  private readonly journal = new Journal()
  private readonly inflight = new Map<string, Promise<SaveResult>>()
  private replayLengthSeconds: number
  private host: string | null = null
  private sessionId = ''
  private replayActive: boolean | null = null
  private diskFreeMb: number | null = null
  private lastMessage: string | null = null
  private lastCode: string | null = null
  private ambiguous: AmbiguousSave | null = null
  private saveInFlight = false
  private calibrationSamples: number[] | null = null
  private hotkey: string
  private readonly statFile: StatFile
  private readonly chatKeys = new Set<string>()
  private keepAlive = false
  private reconnectAttempt = 0
  private reconnecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private credentials: { host: string; port: number; password: string } | null = null

  constructor(options: AppOptions = {}) {
    this.deviceId = options.deviceId ?? 'this-pc'
    this.hostname = options.hostname ?? 'this-pc'
    this.statFile = options.statFile ?? statViaShell
    this.now = options.now ?? Date.now
    this.lowDiskMb = options.lowDiskMb ?? LOW_DISK_MB
    this.duplicateWindowMs = options.duplicateWindowMs ?? DUPLICATE_WINDOW_MS
    this.replayLengthSeconds = clampReplayLength(options.replayLengthSeconds ?? DEFAULT_REPLAY_SECONDS)
    this.hotkey = options.hotkey ?? 'Ctrl+Shift+F9'
    this.session.onDropped = () => {
      this.replayActive = null
      this.diskFreeMb = null
      if (!this.saveInFlight) {
        this.lastCode = 'disconnected'
        this.lastMessage = this.keepAlive ? RECONNECTING_MESSAGE : DISCONNECTED_IDLE_MESSAGE
      }
      this.scheduleReconnect()
    }
    this.session.onMeters((data) => this.handleMeter(data))
    this.session.setExternalSaveHandler((filePath) => {
      if (this.saveInFlight) return
      void this.recordExternal(filePath)
    })
  }

  async connect(input: { host: string; port: number; password: string }): Promise<{ ok: boolean; message: string }> {
    this.clearReconnect()
    this.credentials = { host: input.host, port: input.port, password: input.password }
    try {
      const version = await this.session.connect(input)
      this.host = input.host
      this.sessionId = nextId()
      this.keepAlive = true
      this.reconnectAttempt = 0
      this.lastCode = null
      this.lastMessage = `Connected to OBS ${version.obsVersion} (websocket ${version.obsWebSocketVersion}).`
      await this.refresh()
      if (this.replayActive === false) this.lastMessage = `${this.lastMessage} ${REPLAY_OFF_MESSAGE}`
      return { ok: true, message: this.lastMessage }
    } catch (error) {
      const message = error instanceof CaptureError ? error.message : 'Could not connect.'
      this.lastCode = error instanceof CaptureError ? error.code : 'not_connected'
      this.lastMessage = message
      this.host = null
      if (!this.keepAlive) this.credentials = null
      return { ok: false, message }
    }
  }

  async disconnect(): Promise<void> {
    this.keepAlive = false
    this.credentials = null
    this.clearReconnect()
    await this.session.disconnect()
    this.host = null
    this.replayActive = null
    this.diskFreeMb = null
  }

  private scheduleReconnect(): void {
    if (!this.keepAlive || !this.credentials || this.reconnectTimer || this.reconnecting) return
    const delay = nextReconnectDelayMs(this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnectNow()
    }, delay)
  }

  private async reconnectNow(): Promise<void> {
    if (!this.keepAlive || !this.credentials) return
    this.reconnecting = true
    let retry = false
    try {
      const result = await this.connect(this.credentials)
      if (result.ok) {
        this.lastMessage = `Reconnected. ${result.message}`
        return
      }
      if (!shouldKeepReconnecting(this.lastCode ?? '')) {
        this.keepAlive = false
        this.credentials = null
        this.clearReconnect()
        return
      }
      retry = true
    } finally {
      this.reconnecting = false
    }
    if (retry && this.keepAlive) this.scheduleReconnect()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  ingestChat(signal: ChatSignal, flagEnabled: boolean): { accepted: boolean; reason: string } {
    if (!flagEnabled) return { accepted: false, reason: 'flag_off' }
    const key = signal.idempotencyKey.trim()
    if (!key) return { accepted: false, reason: 'missing_key' }
    if (this.chatKeys.has(key)) return { accepted: false, reason: 'duplicate' }
    this.chatKeys.add(key)
    void this.saveMoment('chat')
    return { accepted: true, reason: 'queued' }
  }

  async saveMoment(trigger: SaveTrigger): Promise<SaveResult> {
    const now = this.now()
    const key = windowIdempotencyKey(this.deviceId, this.sessionId || 'offline', now, this.duplicateWindowMs)
    const recent = this.journal.findWindow(key)
    if (recent) return { ok: true, duplicate: true, adopted: false, message: DUPLICATE_MESSAGE, candidate: recent }
    const existing = this.inflight.get(key)
    if (existing) {
      const result = await existing
      if (!result.ok) return result
      return { ...result, duplicate: true, message: DUPLICATE_MESSAGE }
    }
    const run = this.execute(trigger, now, key)
    this.inflight.set(key, run)
    try {
      return await run
    } finally {
      this.inflight.delete(key)
    }
  }

  setReplayLength(seconds: number): void {
    this.replayLengthSeconds = clampReplayLength(seconds)
  }

  applyCalibration(samples: readonly number[]): CalibrationResult {
    return this.audio.calibrate(samples)
  }

  setAudio(input: { enabled?: boolean; inputName?: string | null }): { ok: boolean; message: string } {
    if (input.inputName !== undefined) {
      const name = input.inputName?.trim() ?? ''
      this.audio.inputName = name.length > 0 ? name : null
    }
    if (input.enabled === undefined) return { ok: true, message: 'Audio input updated.' }
    const result = this.audio.setEnabled(input.enabled)
    void this.syncMeters()
    return result
  }

  async calibrateLive(durationMs = 3000): Promise<CalibrationResult> {
    if (!this.session.isReady) {
      return {
        ok: false,
        thresholdDb: null,
        noiseFloorDb: null,
        sampleCount: 0,
        silenceWarning: false,
        message: 'Connect to OBS before calibrating.',
      }
    }
    const samples: number[] = []
    this.calibrationSamples = samples
    await this.session.setAudioSubscription(true)
    await sleep(Math.min(5000, Math.max(1000, durationMs)))
    this.calibrationSamples = null
    if (!this.audio.enabled) await this.session.setAudioSubscription(false).catch(() => undefined)
    return this.applyCalibration(samples)
  }

  async startReplayBuffer(consent: boolean): Promise<{ ok: boolean; message: string }> {
    if (consent !== true) return { ok: false, message: consentRequiredMessage('StartReplayBuffer') }
    try {
      await this.session.startReplayBuffer({ action: 'start_replay_buffer', confirmed: true })
      await this.refresh()
      const message = 'Replay buffer started. Stream and recording settings were not changed.'
      this.lastMessage = message
      this.lastCode = null
      return { ok: true, message }
    } catch (error) {
      const message = error instanceof CaptureError ? error.message : 'Could not start the replay buffer.'
      this.lastMessage = message
      this.lastCode = error instanceof CaptureError ? error.code : 'obs_error'
      return { ok: false, message }
    }
  }

  status(): AppStatus {
    const diskState = diskDecision(this.diskFreeMb, this.lowDiskMb)
    const guidance = this.session.isReady && this.replayActive === false ? REPLAY_OFF_MESSAGE : null
    return {
      connected: this.session.isReady,
      host: this.host,
      obsVersion: this.session.info?.obsVersion ?? null,
      obsWebSocketVersion: this.session.info?.obsWebSocketVersion ?? null,
      obsPlatform: this.session.info?.platform ?? null,
      replayActive: this.replayActive,
      diskFreeMb: this.diskFreeMb,
      diskState,
      lowDiskMb: this.lowDiskMb,
      audioEnabled: this.audio.enabled,
      audioCalibrated: this.audio.thresholdDb !== null,
      audioThresholdDb: this.audio.thresholdDb,
      audioInputName: this.audio.inputName,
      audioCopy: AUDIO_OFF_COPY,
      hotkey: this.hotkey,
      deviceId: this.deviceId,
      hostname: this.hostname,
      replayLengthSeconds: this.replayLengthSeconds,
      lastMessage: this.lastMessage,
      lastCode: this.lastCode,
      guidance,
      candidates: this.journal.items.map((candidate) => ({
        localPath: candidate.localPath,
        fileSizeBytes: candidate.fileSizeBytes,
        trigger: candidate.trigger,
        idempotencyKey: candidate.idempotencyKey,
        triggerTimestamp: candidate.triggerTimestamp,
        momentRunsNow: false as const,
      })),
    }
  }

  private async execute(trigger: SaveTrigger, now: number, windowKey: string): Promise<SaveResult> {
    this.saveInFlight = true
    try {
      if (!this.session.isReady) return this.fail('not_connected', 'Connect to OBS before saving a moment.')
      if (this.ambiguous) {
        const adopted = await this.tryAdopt()
        if (adopted?.ok) {
          if (!adopted.duplicate) this.journal.remember(windowKey, adopted.candidate)
          this.lastMessage = adopted.message
          this.lastCode = null
          return adopted
        }
      }
      let active = false
      try {
        active = await this.session.replayActive()
        this.replayActive = active
      } catch (error) {
        return this.failFrom(error, 'replay_off')
      }
      if (!active) return this.fail('replay_off', REPLAY_OFF_MESSAGE)
      let freeMb: number | null = null
      try {
        freeMb = await this.session.diskFreeMb()
        this.diskFreeMb = freeMb
      } catch (error) {
        return this.failFrom(error, 'disconnected')
      }
      if (diskDecision(freeMb, this.lowDiskMb) === 'low') {
        return this.fail('low_disk', lowDiskMessage(freeMb ?? 0, this.lowDiskMb))
      }
      let previous: string | null = null
      try {
        previous = await this.session.lastReplayPath(false)
      } catch (error) {
        if (error instanceof CaptureError && error.code === 'disconnected') return this.failFrom(error, 'disconnected')
        previous = null
      }
      let saved: { eventPath: string | null; lastPath: string | null }
      try {
        saved = await this.session.saveReplay()
      } catch (error) {
        if (error instanceof CaptureError && error.duringSave && error.code === 'disconnected') {
          this.ambiguous = { startedAt: now, previousPath: previous, trigger }
        }
        return this.failFrom(error, 'disconnected')
      }
      const filePath = choosePath(saved.eventPath, saved.lastPath, previous)
      if (!filePath) return this.fail('stale_path', STALE_PATH_MESSAGE)
      const info = await this.statFile(filePath)
      if (!info) return this.fail('missing_file', missingFileMessage(filePath))
      if (info.size < 1) return this.fail('empty_file', emptyFileMessage(filePath))
      const result = this.finishCandidate(trigger, now, filePath, info, false)
      if (!result.duplicate) this.journal.remember(windowKey, result.candidate)
      this.lastMessage = result.message
      this.lastCode = null
      return result
    } finally {
      this.saveInFlight = false
    }
  }

  private async tryAdopt(): Promise<SaveResult | null> {
    const pending = this.ambiguous
    this.ambiguous = null
    if (!pending || !this.session.isReady) return null
    let filePath: string | null
    try {
      filePath = await this.session.lastReplayPath(false)
    } catch {
      return null
    }
    if (!filePath || filePath === pending.previousPath) return null
    const info = await this.statFile(filePath)
    if (!info || info.size < 1) return null
    if (info.mtimeMs + ADOPT_SLACK_MS < pending.startedAt) return null
    return this.finishCandidate(pending.trigger, pending.startedAt, filePath, info, true)
  }

  private async recordExternal(filePath: string): Promise<void> {
    if (!filePath || this.saveInFlight) return
    const info = await this.statFile(filePath)
    if (!info || info.size < 1) return
    const result = this.finishCandidate('manual', this.now(), filePath, info, true)
    if (result.duplicate) return
    const key = windowIdempotencyKey(this.deviceId, this.sessionId || 'offline', result.candidate.triggerTimestamp, this.duplicateWindowMs)
    this.journal.remember(key, result.candidate)
    this.lastMessage = result.message
    this.lastCode = null
  }

  private finishCandidate(
    trigger: SaveTrigger,
    when: number,
    filePath: string,
    info: FileInfo,
    adopted: boolean,
  ): SaveResult & { ok: true } {
    const idempotencyKey = fileIdempotencyKey(this.deviceId, filePath, info.size, info.mtimeMs)
    const existing = this.journal.findFile(idempotencyKey)
    if (existing) {
      return { ok: true, duplicate: true, adopted, message: DUPLICATE_MESSAGE, candidate: existing }
    }
    const lengthMs = this.replayLengthSeconds * 1000
    const candidate: ClipCandidate = {
      source: 'obs_replay',
      localPath: filePath,
      fileSizeBytes: info.size,
      fileModifiedAtMs: info.mtimeMs,
      trigger,
      triggerTimestamp: when,
      clipStartTimestamp: when - lengthMs,
      clipEndTimestamp: when,
      idempotencyKey,
      rightsStatus: 'creator_owned',
      deviceId: this.deviceId,
      hostname: this.hostname,
      sessionId: this.sessionId,
      obsVersion: this.session.info?.obsVersion ?? '',
      obsWebSocketVersion: this.session.info?.obsWebSocketVersion ?? '',
      obsPlatform: this.session.info?.platform ?? '',
      replayLengthSeconds: this.replayLengthSeconds,
      moment: planLocalMoment({ localPath: filePath, replayLengthSeconds: this.replayLengthSeconds }),
    }
    const message = adopted
      ? ADOPTED_MESSAGE
      : `Saved ${info.size} bytes. The file stays on this PC: ${filePath}`
    return { ok: true, duplicate: false, adopted, message, candidate }
  }

  private fail(code: FailureCode, message: string): SaveResult {
    this.lastCode = code
    this.lastMessage = message
    return { ok: false, code, message }
  }

  private failFrom(error: unknown, fallback: FailureCode): SaveResult {
    if (error instanceof CaptureError) return this.fail(error.code, error.message)
    return this.fail(fallback, 'OBS did not finish the save.')
  }

  private async refresh(): Promise<void> {
    if (!this.session.isReady) {
      this.replayActive = null
      this.diskFreeMb = null
      return
    }
    try {
      this.replayActive = await this.session.replayActive()
      this.diskFreeMb = await this.session.diskFreeMb()
    } catch {
      this.replayActive = null
    }
  }

  private handleMeter(data: { inputs?: unknown }): void {
    const peak = peakMul(readMeterInputs(data), this.audio.inputName)
    if (this.calibrationSamples) {
      if (peak !== null) this.calibrationSamples.push(peak)
      return
    }
    const decision = this.audio.observe(peak, this.now())
    if (!decision.fire) return
    void this.saveMoment('audio')
  }

  private async syncMeters(): Promise<void> {
    if (!this.session.isReady) return
    const on = this.audio.enabled || this.calibrationSamples !== null
    await this.session.setAudioSubscription(on).catch(() => undefined)
  }
}

class Journal {
  private readonly byWindow = new Map<string, ClipCandidate>()
  private readonly byFile = new Map<string, ClipCandidate>()
  readonly items: ClipCandidate[] = []

  remember(windowKey: string, candidate: ClipCandidate): void {
    this.byWindow.set(windowKey, candidate)
    this.byFile.set(candidate.idempotencyKey, candidate)
    this.items.unshift(candidate)
  }

  findWindow(windowKey: string): ClipCandidate | undefined {
    return this.byWindow.get(windowKey)
  }

  findFile(fileKey: string): ClipCandidate | undefined {
    return this.byFile.get(fileKey)
  }
}

async function statViaShell(filePath: string): Promise<FileInfo | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const info = await invoke<{ exists: boolean; size: number; modifiedMs: number }>('stat_local_replay', { path: filePath })
    if (!info.exists) return null
    return { size: info.size, mtimeMs: info.modifiedMs }
  } catch {
    return null
  }
}

function nextId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function choosePath(eventPath: string | null, lastPath: string | null, previous: string | null): string | null {
  if (eventPath && eventPath !== previous) return eventPath
  if (lastPath && lastPath !== previous) return lastPath
  return null
}

function clampReplayLength(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_REPLAY_SECONDS
  return Math.min(MAX_MOMENT_SECONDS, Math.max(5, Math.round(seconds)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
