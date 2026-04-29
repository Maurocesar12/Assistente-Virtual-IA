export interface AIUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  source?: 'provider' | 'estimate'
}

export interface AITextResponse {
  text: string
  usage: AIUsage
}

function cleanTokenValue(value: unknown): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.ceil(parsed)
}

export function estimateTokenCount(text: string): number {
  const clean = String(text ?? '').trim()
  if (!clean) return 0

  const words = clean.split(/\s+/).filter(Boolean).length
  const byChars = Math.ceil(clean.length / 4)
  const byWords = Math.ceil(words * 1.35)

  return Math.max(1, byChars, byWords)
}

export function normalizeUsage(usage: AIUsage | undefined, fallbackText = ''): AIUsage {
  const inputTokens = cleanTokenValue(usage?.inputTokens)
  const outputTokens = cleanTokenValue(usage?.outputTokens)
  const totalTokens = cleanTokenValue(usage?.totalTokens)
    ?? (inputTokens || outputTokens ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)

  if (totalTokens) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      source: usage?.source ?? 'provider',
    }
  }

  return {
    totalTokens: estimateTokenCount(fallbackText),
    source: 'estimate',
  }
}

export function tokenCountForStorage(usage: AIUsage | undefined, fallbackText: string): number {
  return normalizeUsage(usage, fallbackText).totalTokens ?? 0
}
