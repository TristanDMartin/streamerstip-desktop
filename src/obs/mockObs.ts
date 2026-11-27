// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export interface MockObsOptions {
  password?: string
  requireAuth?: boolean
  obsVersion?: string
  obsWebSocketVersion?: string
  replayActive?: boolean
  availableDiskSpaceMb?: number
  closeOnSave?: boolean
  commitThenClose?: boolean
  omitRequests?: string[]
  platform?: string
}

interface RequestPayload {
  requestId?: string
  requestType?: string
}

const DEFAULT_REQUESTS = [
  'GetVersion',
  'GetStats',
  'GetReplayBufferStatus',
  'SaveReplayBuffer',
  'GetLastReplayBufferReplay',
  'StartReplayBuffer',
]

export class MockObs {
  readonly requests: string[] = []
  connectionCount = 0
  authenticated = false
  password: string
  requireAuth: boolean
  obsVersion: string
  obsWebSocketVersion: string
  replayActive: boolean
  availableDiskSpaceMb: number
  replayPath = ''
  closeOnSave: boolean
  commitThenClose: boolean
  platform: string
  private readonly omit: Set<string>
  private readonly salt = randomBytes(16).toString('base64')
  private readonly challenge = randomBytes(16).toString('base64')
  private lastPath = ''
  private readonly sockets = new Set<WebSocket>()
  private readonly http: Server
  private readonly wss: WebSocketServer

  constructor(options: MockObsOptions = {}) {
    this.password = options.password ?? 'correct-password'
    this.requireAuth = options.requireAuth ?? true
    this.obsVersion = options.obsVersion ?? '33.0.3'
    this.obsWebSocketVersion = options.obsWebSocketVersion ?? '5.5.2'
    this.replayActive = options.replayActive ?? true
    this.availableDiskSpaceMb = options.availableDiskSpaceMb ?? 100_000
    this.closeOnSave = options.closeOnSave ?? false
    this.commitThenClose = options.commitThenClose ?? false
    this.platform = options.platform ?? 'linux'
    this.omit = new Set(options.omitRequests ?? [])
    this.http = createServer()
    this.wss = new WebSocketServer({
      server: this.http,
      handleProtocols: (protocols) => protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false,
    })
    this.wss.on('connection', (socket) => this.onConnection(socket))
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.http.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.http.address()
    if (!address || typeof address === 'string') throw new Error('mock OBS has no port')
    return address.port
  }

  dropClients(): void {
    for (const socket of this.sockets) socket.terminate()
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    if (this.http.listening) {
      await new Promise<void>((resolve, reject) => {
        this.http.close((error) => error ? reject(error) : resolve())
      })
    }
  }

  emitMeters(inputs: unknown[]): void {
    const message = JSON.stringify({
      op: 5,
      d: {
        eventType: 'InputVolumeMeters',
        eventIntent: 65536,
        eventData: { inputs },
      },
    })
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message)
    }
  }

  private onConnection(socket: WebSocket): void {
    this.connectionCount += 1
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.send(JSON.stringify(this.hello()))
    socket.on('message', (data) => {
      this.onMessage(socket, JSON.parse(String(data)) as { op?: number; d?: RequestPayload & { authentication?: string } })
    })
  }

  private hello(): unknown {
    const data: Record<string, unknown> = {
      obsStudioVersion: this.obsVersion,
      obsWebSocketVersion: this.obsWebSocketVersion,
      rpcVersion: 1,
    }
    if (this.requireAuth) data.authentication = { challenge: this.challenge, salt: this.salt }
    return { op: 0, d: data }
  }

  private onMessage(socket: WebSocket, message: { op?: number; d?: RequestPayload & { authentication?: string } }): void {
    if (message.op === 1) {
      if (this.requireAuth) {
        const expected = obsAuth(this.password, this.salt, this.challenge)
        if (message.d?.authentication !== expected) {
          socket.close(4009, 'Authentication failed.')
          return
        }
      }
      this.authenticated = true
      socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }))
      return
    }
    if (message.op === 3) {
      socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }))
      return
    }
    if (message.op === 6 && message.d?.requestType) this.onRequest(socket, message.d)
  }

  private onRequest(socket: WebSocket, request: RequestPayload): void {
    const requestType = request.requestType ?? ''
    this.requests.push(requestType)
    if (requestType === 'GetVersion') {
      this.respond(socket, request, true, 100, undefined, {
        obsVersion: this.obsVersion,
        obsWebSocketVersion: this.obsWebSocketVersion,
        rpcVersion: 1,
        availableRequests: DEFAULT_REQUESTS.filter((name) => !this.omit.has(name)),
        supportedImageFormats: ['png'],
        platform: this.platform,
        platformDescription: this.platform,
      })
      return
    }
    if (requestType === 'GetStats') {
      this.respond(socket, request, true, 100, undefined, {
        cpuUsage: 1,
        memoryUsage: 1,
        availableDiskSpace: this.availableDiskSpaceMb,
        activeFps: 60,
        averageFrameRenderTime: 1,
        renderSkippedFrames: 0,
        renderTotalFrames: 1,
        outputSkippedFrames: 0,
        outputTotalFrames: 1,
        webSocketSessionIncomingMessages: 1,
        webSocketSessionOutgoingMessages: 1,
      })
      return
    }
    if (requestType === 'GetReplayBufferStatus') {
      this.respond(socket, request, true, 100, undefined, { outputActive: this.replayActive })
      return
    }
    if (requestType === 'GetLastReplayBufferReplay') {
      this.respond(socket, request, true, 100, undefined, { savedReplayPath: this.lastPath })
      return
    }
    if (requestType === 'StartReplayBuffer') {
      this.replayActive = true
      this.respond(socket, request, true, 100)
      return
    }
    if (requestType === 'SaveReplayBuffer') {
      if (this.closeOnSave) {
        socket.close(4000, 'dropped')
        return
      }
      if (this.commitThenClose) {
        this.lastPath = this.replayPath
        socket.close(4000, 'dropped')
        return
      }
      if (!this.replayActive) {
        this.respond(socket, request, false, 501, 'OutputNotRunning')
        return
      }
      this.lastPath = this.replayPath
      this.respond(socket, request, true, 100)
      queueMicrotask(() => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(JSON.stringify({
          op: 5,
          d: {
            eventType: 'ReplayBufferSaved',
            eventIntent: 64,
            eventData: { savedReplayPath: this.replayPath },
          },
        }))
      })
      return
    }
    this.respond(socket, request, false, 205, 'Unexpected request')
  }

  private respond(
    socket: WebSocket,
    request: RequestPayload,
    ok: boolean,
    code: number,
    comment?: string,
    responseData?: unknown,
  ): void {
    const requestStatus: Record<string, unknown> = { result: ok, code }
    if (comment) requestStatus.comment = comment
    const payload: Record<string, unknown> = {
      requestType: request.requestType,
      requestId: request.requestId,
      requestStatus,
    }
    if (responseData !== undefined) payload.responseData = responseData
    socket.send(JSON.stringify({ op: 7, d: payload }))
  }
}

function obsAuth(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64')
  return createHash('sha256').update(secret + challenge).digest('base64')
}
