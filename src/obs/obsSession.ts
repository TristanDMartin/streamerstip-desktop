import OBSWebSocket, { EventSubscription, OBSWebSocketError } from 'obs-websocket-js/json'
import { AUTH_CLOSE_CODE, OUTPUT_NOT_RUNNING, SAVE_TIMEOUT_MS } from './constants'
import { CaptureError } from './errors'
import {
  AUTH_FAILED_MESSAGE,
  AUTH_REQUIRED_MESSAGE,
  DISCONNECTED_SAVE_MESSAGE,
  EMPTY_PASSWORD_MESSAGE,
  REPLAY_OFF_MESSAGE,
} from './messages'
import { assertObsRequestAllowed, checkCompatibility, type ObsVersionReport, obsWebSocketUrl, type ReplayBufferConsent } from './policy'
import { safeText } from './redact'

type ObsCall = OBSWebSocket['call']
type RequestName = Parameters<ObsCall>[0]

interface HelloMessage {
  authentication?: { challenge?: string; salt?: string }
}

export interface ConnectedObs {
  obsVersion: string
  obsWebSocketVersion: string
  rpcVersion: number
  platform: string
  availableRequests: string[]
}

export class ObsSession {
  private readonly obs = new OBSWebSocket()
  private socketUp = false
  private compatible = false
  private saving = false
  private version: ConnectedObs | null = null
  private externalHandler: ((filePath: string) => void) | null = null
  saveTimeoutMs = SAVE_TIMEOUT_MS
  onDropped: (() => void) | null = null

  constructor() {
    this.obs.on('ConnectionClosed', () => {
      const wasUp = this.socketUp
      this.socketUp = false
      this.compatible = false
      if (wasUp) this.onDropped?.()
    })
    this.obs.on('ReplayBufferSaved', (data) => {
      if (this.saving) return
      const filePath = typeof data?.savedReplayPath === 'string' ? data.savedReplayPath : ''
      if (filePath) this.externalHandler?.(filePath)
    })
  }

  get isReady(): boolean {
    return this.compatible
  }

  get info(): ConnectedObs | null {
    return this.version
  }

  setExternalSaveHandler(handler: ((filePath: string) => void) | null): void {
    this.externalHandler = handler
  }

  async connect(input: { host: string; port: number; password: string }): Promise<ConnectedObs> {
    if (input.password.length === 0) throw new CaptureError('auth_failed', EMPTY_PASSWORD_MESSAGE)
    const url = obsWebSocketUrl(input.host, input.port)
    await this.safeDisconnect()
    let sawChallenge = false
    const onHello = (hello: HelloMessage): void => {
      sawChallenge = Boolean(hello.authentication?.challenge && hello.authentication?.salt)
    }
    this.obs.on('Hello', onHello)
    try {
      await withTimeout(
        this.obs.connect(url, input.password, {
          rpcVersion: 1,
          eventSubscriptions: EventSubscription.All,
        }),
        5000,
        new CaptureError('not_connected', 'Timed out connecting to OBS WebSocket.'),
      )
      this.socketUp = true
    } catch (error) {
      this.socketUp = false
      this.compatible = false
      if (error instanceof CaptureError) throw error
      const code = error instanceof OBSWebSocketError ? error.code : 0
      if (code === AUTH_CLOSE_CODE) throw new CaptureError('auth_failed', AUTH_FAILED_MESSAGE)
      const detail = error instanceof Error ? error.message : 'connect failed'
      throw new CaptureError('not_connected', safeText(`Could not connect to OBS. ${detail}`, input.password))
    } finally {
      this.obs.off('Hello', onHello)
    }
    if (!sawChallenge) {
      await this.safeDisconnect()
      throw new CaptureError('auth_required', AUTH_REQUIRED_MESSAGE)
    }
    const version = await this.readVersion()
    const check = checkCompatibility(version)
    if (!check.ok) {
      await this.safeDisconnect()
      throw new CaptureError('incompatible', check.message)
    }
    this.version = {
      obsVersion: version.obsVersion,
      obsWebSocketVersion: version.obsWebSocketVersion,
      rpcVersion: version.rpcVersion,
      platform: version.platform,
      availableRequests: [...version.availableRequests],
    }
    this.compatible = true
    return this.version
  }

  async disconnect(): Promise<void> {
    await this.safeDisconnect()
  }

  async replayActive(): Promise<boolean> {
    const data = await this.call('GetReplayBufferStatus', null, false)
    return Boolean(data && typeof data === 'object' && 'outputActive' in data && data.outputActive)
  }

  async diskFreeMb(): Promise<number | null> {
    const data = await this.call('GetStats', null, false)
    if (!data || typeof data !== 'object' || !('availableDiskSpace' in data)) return null
    const free = data.availableDiskSpace
    return typeof free === 'number' && Number.isFinite(free) ? free : null
  }

  async lastReplayPath(duringSave: boolean): Promise<string | null> {
    const data = await this.call('GetLastReplayBufferReplay', null, duringSave)
    if (!data || typeof data !== 'object' || !('savedReplayPath' in data)) return null
    const filePath = data.savedReplayPath
    return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
  }

  async saveReplay(): Promise<{ eventPath: string | null; lastPath: string | null }> {
    const waiter = this.waitForReplaySaved(this.saveTimeoutMs)
    this.saving = true
    try {
      await this.call('SaveReplayBuffer', null, true)
      const eventPath = await waiter.promise
      if (!this.socketUp) throw new CaptureError('disconnected', DISCONNECTED_SAVE_MESSAGE, true)
      const lastPath = await this.lastReplayPath(true)
      return { eventPath, lastPath }
    } catch (error) {
      waiter.cancel()
      throw error
    } finally {
      this.saving = false
    }
  }

  async startReplayBuffer(consent: ReplayBufferConsent | null): Promise<void> {
    await this.call('StartReplayBuffer', consent, false)
  }

  async readOutputActivity(): Promise<{ streaming: boolean; recording: boolean }> {
    const stream = await this.call('GetStreamStatus', null, false)
    const record = await this.call('GetRecordStatus', null, false)
    return {
      streaming: outputActive(stream),
      recording: outputActive(record),
    }
  }

  async setAudioSubscription(on: boolean): Promise<void> {
    if (!this.socketUp) throw new CaptureError('disconnected', 'OBS is not connected.')
    const eventSubscriptions = on
      ? EventSubscription.All | EventSubscription.InputVolumeMeters
      : EventSubscription.All
    await withTimeout(
      this.obs.reidentify({ eventSubscriptions }),
      3000,
      new CaptureError('obs_error', 'OBS did not confirm the audio meter subscription.'),
    )
  }

  onMeters(listener: (data: { inputs?: unknown }) => void): void {
    this.obs.on('InputVolumeMeters', listener)
  }

  private async readVersion(): Promise<ObsVersionReport & { platform: string }> {
    const data = await this.call('GetVersion', null, false)
    if (!data || typeof data !== 'object') {
      throw new CaptureError('incompatible', 'OBS did not return a version.')
    }
    const record = data as unknown as Record<string, unknown>
    const obsVersion = typeof record.obsVersion === 'string' ? record.obsVersion : ''
    const obsWebSocketVersion = typeof record.obsWebSocketVersion === 'string' ? record.obsWebSocketVersion : ''
    const rpcVersion = typeof record.rpcVersion === 'number' ? record.rpcVersion : 0
    const availableRequests = Array.isArray(record.availableRequests)
      ? record.availableRequests.filter((name): name is string => typeof name === 'string')
      : []
    const platform = typeof record.platform === 'string' ? record.platform : ''
    return { obsVersion, obsWebSocketVersion, rpcVersion, availableRequests, platform }
  }

  private async call(requestType: RequestName, consent: ReplayBufferConsent | null, duringSave: boolean): Promise<unknown> {
    assertObsRequestAllowed(requestType, consent)
    if (!this.socketUp) throw new CaptureError('disconnected', DISCONNECTED_SAVE_MESSAGE, duringSave)
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: CaptureError | null, value?: unknown): void => {
        if (settled) return
        settled = true
        this.obs.off('ConnectionClosed', onClose)
        if (error) reject(error)
        else resolve(value)
      }
      const onClose = (): void => {
        finish(new CaptureError('disconnected', DISCONNECTED_SAVE_MESSAGE, duringSave))
      }
      this.obs.once('ConnectionClosed', onClose)
      this.obs.call(requestType).then(
        (value) => finish(null, value),
        (error: unknown) => finish(this.mapCallError(error, duringSave)),
      )
    })
  }

  private mapCallError(error: unknown, duringSave: boolean): CaptureError {
    if (error instanceof CaptureError) return error
    if (error instanceof OBSWebSocketError && error.code === OUTPUT_NOT_RUNNING) {
      return new CaptureError('replay_off', REPLAY_OFF_MESSAGE, duringSave)
    }
    const message = error instanceof Error ? error.message : 'OBS request failed'
    if (/not connected|socket|closed/i.test(message)) {
      return new CaptureError('disconnected', DISCONNECTED_SAVE_MESSAGE, duringSave)
    }
    return new CaptureError('obs_error', message, duringSave)
  }

  private waitForReplaySaved(timeoutMs: number): { promise: Promise<string | null>; cancel: () => void } {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let handler: (data: { savedReplayPath?: string }) => void = () => undefined
    let finish: (path: string | null) => void = () => undefined
    const promise = new Promise<string | null>((resolve) => {
      finish = (path: string | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.obs.off('ReplayBufferSaved', handler)
        resolve(path)
      }
      handler = (data): void => {
        const filePath = typeof data?.savedReplayPath === 'string' ? data.savedReplayPath : ''
        finish(filePath || null)
      }
      timer = setTimeout(() => finish(null), timeoutMs)
      this.obs.on('ReplayBufferSaved', handler)
    })
    return { promise, cancel: () => finish(null) }
  }

  private async safeDisconnect(): Promise<void> {
    this.socketUp = false
    this.compatible = false
    this.version = null
    await withTimeout(this.obs.disconnect(), 2000, new CaptureError('disconnected', 'Disconnect timed out.')).catch(() => undefined)
  }
}

function outputActive(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { outputActive?: unknown }).outputActive === true
}

function withTimeout<T>(promise: Promise<T>, ms: number, error: CaptureError): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (rejected: unknown) => {
        clearTimeout(timer)
        reject(rejected)
      },
    )
  })
}
