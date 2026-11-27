export interface TokenVault {
  save(account: string, secret: string): Promise<void>
  load(account: string): Promise<string | null>
  clear(account: string): Promise<void>
}

const SERVICE = 'com.streamerstip.desktop'

export function createMemoryVault(): TokenVault & { writes: string[] } {
  const values = new Map<string, string>()
  const writes: string[] = []
  return {
    writes,
    async save(account, secret) {
      values.set(account, secret)
      writes.push(`memory:${account}`)
    },
    async load(account) {
      return values.get(account) ?? null
    },
    async clear(account) {
      values.delete(account)
    },
  }
}

export function createKeychainVault(invoke: (command: string, args: Record<string, string>) => Promise<unknown>): TokenVault {
  return {
    async save(account, secret) {
      await invoke('keychain_save', { service: SERVICE, account, secret })
    },
    async load(account) {
      const value = await invoke('keychain_load', { service: SERVICE, account })
      return typeof value === 'string' && value.length > 0 ? value : null
    },
    async clear(account) {
      await invoke('keychain_clear', { service: SERVICE, account })
    },
  }
}

export function secretLeakedInto(storage: { snapshot: () => string }, secret: string): boolean {
  return secret.length >= 8 && storage.snapshot().includes(secret)
}
