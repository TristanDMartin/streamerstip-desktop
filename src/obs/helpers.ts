// @vitest-environment node
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TippyApp } from './app'
import { MockObs, type MockObsOptions } from './mockObs'

export const PASSWORD = 'tippy-obs-password-9f3c'

export async function statLocalFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return null
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

export interface ObsFixture {
  server: MockObs
  app: TippyApp
  port: number
  file: string
  dir: string
}

export async function withObs(
  options: MockObsOptions,
  run: (fixture: ObsFixture) => Promise<void>,
  appOptions: ConstructorParameters<typeof TippyApp>[0] = {},
): Promise<void> {
  const server = new MockObs({ password: PASSWORD, ...options })
  const dir = await mkdtemp(join(tmpdir(), 'tippy-obs-'))
  const file = join(dir, 'replay.mkv')
  await writeFile(file, Buffer.from('replay-bytes'))
  server.replayPath = file
  const port = await server.start()
  const app = new TippyApp({ deviceId: 'pc-test', hostname: 'rig', statFile: statLocalFile, ...appOptions })
  try {
    await run({ server, app, port, file, dir })
  } finally {
    await app.disconnect()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

export async function connect(fixture: ObsFixture, password = PASSWORD): Promise<{ ok: boolean; message: string }> {
  return fixture.app.connect({ host: '127.0.0.1', port: fixture.port, password })
}

export function saveCount(server: MockObs): number {
  return server.requests.filter((name) => name === 'SaveReplayBuffer').length
}

export function assertAllowlist(server: MockObs): void {
  const allowed = new Set([
    'GetVersion',
    'GetStats',
    'GetReplayBufferStatus',
    'GetLastReplayBufferReplay',
    'SaveReplayBuffer',
    'StartReplayBuffer',
  ])
  for (const name of server.requests) assert.ok(allowed.has(name), name)
}
