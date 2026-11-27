import type { ChatSignal } from './app'

export const SIMULATED_CHAT_SOURCE = 'tippy.simulated-chat.v1'

export interface SimulatedChatEvent extends ChatSignal {
  source: typeof SIMULATED_CHAT_SOURCE
  simulated: true
}

export function simulateChatEvent(input: { phrase?: string; atMs?: number } = {}): SimulatedChatEvent {
  const atMs = input.atMs ?? 0
  return {
    source: SIMULATED_CHAT_SOURCE,
    simulated: true,
    idempotencyKey: `simulated:${atMs}`,
    phrase: input.phrase ?? '!clip',
  }
}
