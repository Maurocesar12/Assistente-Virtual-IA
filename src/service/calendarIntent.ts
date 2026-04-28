import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { env } from '../config/env.js'
import type { ApiKeys } from '../models/database.js'

const MIN_CONFIDENCE = 0.72
const DEFAULT_DURATION_MINUTES = 60
const MAX_MESSAGE_CHARS = 1800
const MAX_TITLE_CHARS = 120
const MAX_FUTURE_DAYS = 370

export interface CalendarIntent {
  title: string
  description?: string
  startAt: Date
  endAt: Date
  confidence: number
  timeZone: string
}

export interface CalendarIntentContext {
  apiKeys: ApiKeys
  botName: string
  contactPhone: string
  now?: Date
  timeZone?: string
}

interface RawCalendarIntent {
  shouldSchedule?: boolean
  confidence?: number
  title?: string
  description?: string
  startAt?: string
  endAt?: string
  timezone?: string
}

const SCHEDULING_WORDS = [
  'agenda', 'agendar', 'marcar', 'reuniao', 'meeting', 'call', 'meet', 'zoom',
  'horario', 'compromisso', 'consulta', 'entrevista', 'conversar', 'nos falar',
]

const DATE_OR_TIME_SIGNALS = [
  'hoje', 'amanha', 'depois de amanha', 'segunda', 'terca', 'quarta',
  'quinta', 'sexta', 'sabado', 'domingo',
]

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
}

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasDateOrTimeSignal(normalized: string) {
  if (/\b\d{1,2}[/:]\d{1,2}\b/.test(normalized)) return true
  if (/\b\d{1,2}h(?:\d{2})?\b/.test(normalized)) return true
  if (/\b(?:as|a|para)\s+\d{1,2}\b/.test(normalized)) return true
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(normalized)) return true
  if (/\bdia\s+\d{1,2}\b/.test(normalized)) return true
  return DATE_OR_TIME_SIGNALS.some(signal => normalized.includes(signal))
}

export function hasSchedulingSignal(message: string) {
  const normalized = normalizeText(message)
  return SCHEDULING_WORDS.some(word => normalized.includes(word)) && hasDateOrTimeSignal(normalized)
}

function promptFor(message: string, context: Required<Pick<CalendarIntentContext, 'botName' | 'contactPhone' | 'timeZone'>> & { now: Date }) {
  return [
    'Voce extrai pedidos de agendamento de reuniao de mensagens de WhatsApp.',
    'Responda somente JSON valido, sem markdown.',
    'Marque shouldSchedule=true apenas quando existir uma intencao concreta de marcar reuniao/consulta/call e houver data e horario.',
    'Se faltar data ou horario, use shouldSchedule=false.',
    `Agora: ${context.now.toISOString()}. Timezone do usuario: ${context.timeZone}.`,
    `Bot: ${context.botName}. Contato: ${context.contactPhone}.`,
    'Formato obrigatorio:',
    '{"shouldSchedule":boolean,"confidence":number,"title":string,"description":string,"startAt":"ISO-8601","endAt":"ISO-8601","timezone":string}',
    `Se a duracao nao for informada, use ${DEFAULT_DURATION_MINUTES} minutos.`,
    'Mensagem:',
    message.slice(0, MAX_MESSAGE_CHARS),
  ].join('\n')
}

function extractJson(text: string): RawCalendarIntent | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(text.slice(start, end + 1)) as RawCalendarIntent
  } catch {
    return null
  }
}

async function extractWithGemini(message: string, context: CalendarIntentContext): Promise<RawCalendarIntent | null> {
  if (!context.apiKeys.geminiKey) return null
  const model = new GoogleGenerativeAI(context.apiKeys.geminiKey)
    .getGenerativeModel({ model: 'gemini-2.5-flash' })
  const result = await model.generateContent(promptFor(message, {
    botName: context.botName,
    contactPhone: context.contactPhone,
    now: context.now ?? new Date(),
    timeZone: context.timeZone ?? env.GOOGLE_CALENDAR_TIMEZONE,
  }))
  return extractJson(result.response.text())
}

async function extractWithOpenAI(message: string, context: CalendarIntentContext): Promise<RawCalendarIntent | null> {
  if (!context.apiKeys.openaiKey) return null
  const openai = new OpenAI({ apiKey: context.apiKeys.openaiKey })
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Voce extrai agendamentos e responde apenas JSON valido.' },
      {
        role: 'user',
        content: promptFor(message, {
          botName: context.botName,
          contactPhone: context.contactPhone,
          now: context.now ?? new Date(),
          timeZone: context.timeZone ?? env.GOOGLE_CALENDAR_TIMEZONE,
        }),
      },
    ],
  } as any)

  return extractJson(completion.choices[0]?.message?.content ?? '')
}

function cleanText(value: string | undefined, fallback: string, maxLength: number) {
  const clean = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, maxLength) || fallback
}

function validateRawIntent(raw: RawCalendarIntent | null, context: CalendarIntentContext): CalendarIntent | null {
  if (!raw?.shouldSchedule) return null

  const confidence = Number(raw.confidence ?? 0)
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null

  const startAt = raw.startAt ? new Date(raw.startAt) : null
  if (!startAt || Number.isNaN(startAt.getTime())) return null

  let endAt = raw.endAt ? new Date(raw.endAt) : null
  if (!endAt || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    endAt = new Date(startAt.getTime() + DEFAULT_DURATION_MINUTES * 60_000)
  }

  const now = context.now ?? new Date()
  if (startAt.getTime() < now.getTime() - 15 * 60_000) return null
  if (startAt.getTime() > now.getTime() + MAX_FUTURE_DAYS * 24 * 60 * 60_000) return null

  return {
    title: cleanText(raw.title, 'Reuniao', MAX_TITLE_CHARS),
    description: cleanText(raw.description, '', 600),
    startAt,
    endAt,
    confidence,
    timeZone: raw.timezone || context.timeZone || env.GOOGLE_CALENDAR_TIMEZONE,
  }
}

function getZonedDateParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function getZonedWeekday(now: Date, timeZone: string) {
  const value = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now).toLowerCase()
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(value)
}

function addDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function buildDate(parts: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string) {
  const yyyy = String(parts.year).padStart(4, '0')
  const mm = String(parts.month).padStart(2, '0')
  const dd = String(parts.day).padStart(2, '0')
  const hh = String(hour).padStart(2, '0')
  const mi = String(minute).padStart(2, '0')
  const offset = timeZone === 'America/Sao_Paulo' ? '-03:00' : ''
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00${offset}`)
}

function parseTime(normalized: string): { hour: number; minute: number } | null {
  const match = normalized.match(/\b(\d{1,2})(?:h|:)(\d{2})?\b/)
    ?? normalized.match(/\b(\d{1,2})\s*horas?\b/)
    ?? normalized.match(/\b(?:as|a|para)\s+(\d{1,2})\b/)
  if (!match) return null

  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function parseDate(normalized: string, now: Date, timeZone: string, time?: { hour: number; minute: number }) {
  const current = getZonedDateParts(now, timeZone)

  const explicit = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)
  if (explicit) {
    const day = Number(explicit[1])
    const month = Number(explicit[2])
    const year = explicit[3] ? Number(explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3]) : current.year
    return { year, month, day }
  }

  const monthName = normalized.match(/\b(\d{1,2})\s+de\s+([a-z]+)\b/)
  if (monthName && MONTHS[monthName[2]]) {
    const day = Number(monthName[1])
    const month = MONTHS[monthName[2]]
    const year = month < current.month ? current.year + 1 : current.year
    return { year, month, day }
  }

  if (normalized.includes('depois de amanha')) return addDays(current, 2)
  if (normalized.includes('amanha')) return addDays(current, 1)
  if (normalized.includes('hoje')) return current

  const dayOnly = normalized.match(/\bdia\s+(\d{1,2})\b/)
  if (dayOnly) {
    const day = Number(dayOnly[1])
    let month = current.month
    let year = current.year
    if (day < current.day) {
      month += 1
      if (month > 12) { month = 1; year += 1 }
    }
    return { year, month, day }
  }

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!normalized.includes(name)) continue
    const currentWeekday = getZonedWeekday(now, timeZone)
    let daysAhead = (weekday - currentWeekday + 7) % 7
    if (daysAhead === 0 && time) {
      const candidate = buildDate(current, time.hour, time.minute, timeZone)
      if (candidate.getTime() <= now.getTime() + 15 * 60_000) daysAhead = 7
    }
    return addDays(current, daysAhead)
  }

  return null
}

function extractWithHeuristics(message: string, context: CalendarIntentContext): CalendarIntent | null {
  const normalized = normalizeText(message)
  const timeZone = context.timeZone ?? env.GOOGLE_CALENDAR_TIMEZONE
  const now = context.now ?? new Date()
  const time = parseTime(normalized)
  if (!time) return null

  const date = parseDate(normalized, now, timeZone, time)
  if (!date) return null

  const startAt = buildDate(date, time.hour, time.minute, timeZone)
  const endAt = new Date(startAt.getTime() + DEFAULT_DURATION_MINUTES * 60_000)
  return validateRawIntent({
    shouldSchedule: true,
    confidence: 0.78,
    title: 'Reuniao',
    description: message.slice(0, 600),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone: timeZone,
  }, context)
}

export async function extractCalendarIntent(message: string, context: CalendarIntentContext): Promise<CalendarIntent | null> {
  if (!hasSchedulingSignal(message)) return null

  let raw: RawCalendarIntent | null = null
  try {
    raw = await extractWithGemini(message, context)
  } catch (err) {
    console.warn('[CalendarIntent] Gemini extraction failed:', err)
  }

  if (!raw) {
    try {
      raw = await extractWithOpenAI(message, context)
    } catch (err) {
      console.warn('[CalendarIntent] OpenAI extraction failed:', err)
    }
  }

  const intent = validateRawIntent(raw, context)
  if (intent) return intent

  return extractWithHeuristics(message, context)
}
