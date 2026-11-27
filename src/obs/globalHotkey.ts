export interface ShortcutEvent {
  state: string
}

export type RegisterShortcut = (
  accelerator: string,
  handler: (event: ShortcutEvent) => void,
) => Promise<void>

export function acceleratorFor(spec: string): string {
  return spec
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.toLowerCase() === 'ctrl' || part.toLowerCase() === 'control' ? 'CommandOrControl' : part))
    .join('+')
}

export async function bindGlobalHotkey(
  spec: string,
  onFire: () => void,
  register: RegisterShortcut = registerWithOperatingSystem,
): Promise<{ scope: 'global'; accelerator: string; unbind: () => Promise<void> }> {
  const accelerator = acceleratorFor(spec)
  await register(accelerator, (event) => {
    if (event.state === 'Pressed') onFire()
  })
  return {
    scope: 'global',
    accelerator,
    unbind: async () => {
      const plugin = await import('@tauri-apps/plugin-global-shortcut')
      await plugin.unregister(accelerator)
    },
  }
}

async function registerWithOperatingSystem(
  accelerator: string,
  handler: (event: ShortcutEvent) => void,
): Promise<void> {
  const plugin = await import('@tauri-apps/plugin-global-shortcut')
  await plugin.register(accelerator, (event) => {
    handler({ state: event.state })
  })
}
