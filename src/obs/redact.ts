export function safeText(message: string, secret: string): string {
  if (secret.length < 8 || !message.includes(secret)) return message
  return message.split(secret).join('[redacted]')
}
