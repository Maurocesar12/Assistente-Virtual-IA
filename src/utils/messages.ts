import type { Whatsapp } from '@wppconnect-team/wppconnect'

// ─── Split AI response into natural message chunks ────────────────────────────

const COMPLEX_PATTERN =
  /(http[s]?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+@[^\s]+\.[^\s]+)|(["'].*?["'])|(\b\d+\.\s)|(\w+\.\w+)/g

export function splitMessages(text: string): string[] {
  const matches = (text.match(COMPLEX_PATTERN) ?? []) as string[]
  const PLACEHOLDER = 'PLACEHOLDER_'
  let idx = 0

  const withPlaceholders = text.replace(COMPLEX_PATTERN, () => `${PLACEHOLDER}${idx++}`)

  const splitPattern = /(?<!\b\d+\.\s)(?<!\w+\.\w+)[^.?!]+(?:[.?!]+["']?|$)/g
  let parts = (withPlaceholders.match(splitPattern) ?? [text]) as string[]

  if (matches.length > 0) {
    parts = parts.map((part) =>
      matches.reduce((acc, val, i) => acc.replace(`${PLACEHOLDER}${i}`, val), part)
    )
  }

  return parts.map((p) => p.trimStart()).filter(Boolean)
}

// ─── Send messages with human-like typing delay ───────────────────────────────

const CHARS_PER_MS = 100  // roughly simulates typing speed

export async function sendMessagesWithDelay(
  client: Whatsapp,
  messages: string[],
  targetNumber: string
): Promise<void> {
  for (const msg of messages) {
    const delay = msg.length * CHARS_PER_MS
    await sleep(delay)

    await client.sendText(targetNumber, msg).catch((err: unknown) => {
      console.error(`[WhatsApp] Failed to send message to ${targetNumber}:`, err)
    })
  }
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
