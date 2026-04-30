import type { KnowledgeBaseItem } from '../models/database.js'

const MAX_CONTEXT_CHARS = 7_000
const MAX_ITEM_CHARS = 1_600
const MAX_ITEMS = 6

const STOP_WORDS = new Set([
  'para', 'com', 'uma', 'que', 'por', 'como', 'dos', 'das', 'tem', 'mais',
  'qual', 'quais', 'onde', 'quando', 'sobre', 'voce', 'voces', 'isso', 'esse',
  'essa', 'meu', 'minha', 'seu', 'sua', 'the', 'and', 'for', 'with',
])

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
  )
}

function scoreItem(item: KnowledgeBaseItem, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 1
  const haystack = tokens(`${item.title} ${item.question ?? ''} ${item.answer ?? ''} ${item.content}`)
  let score = 0
  for (const token of queryTokens) if (haystack.has(token)) score += 1
  if (item.type === 'faq') score += 0.5
  return score
}

function formatItem(item: KnowledgeBaseItem): string {
  const label = item.type === 'faq'
    ? `FAQ: ${item.question || item.title}`
    : `${item.type.toUpperCase()}: ${item.title}`

  const source = item.sourceUrl ? `\nFonte: ${item.sourceUrl}` : ''
  const body = item.type === 'faq'
    ? `Pergunta: ${item.question || item.title}\nResposta: ${item.answer || item.content}`
    : item.content

  return `### ${label}${source}\n${body.slice(0, MAX_ITEM_CHARS)}`
}

export function buildKnowledgeContext(items: KnowledgeBaseItem[], message: string): string {
  const activeItems = items.filter(item => item.isActive && item.content.trim())
  if (!activeItems.length) return message

  const queryTokens = tokens(message)
  const selected = activeItems
    .map(item => ({ item, score: scoreItem(item, queryTokens) }))
    .filter(entry => entry.score > 0 || queryTokens.size === 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt.getTime() - a.item.updatedAt.getTime())
    .slice(0, MAX_ITEMS)
    .map(entry => entry.item)

  if (!selected.length) return message

  const context = selected.map(formatItem).join('\n\n').slice(0, MAX_CONTEXT_CHARS)

  return [
    'Use a base de conhecimento abaixo como fonte preferencial para responder ao cliente.',
    'Se a resposta nao estiver na base de conhecimento nem no prompt, diga que vai verificar com a equipe em vez de inventar.',
    '',
    '[BASE DE CONHECIMENTO]',
    context,
    '',
    '[MENSAGEM DO CLIENTE]',
    message,
  ].join('\n')
}
