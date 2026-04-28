import crypto from 'crypto'
import { env } from '../config/env.js'
import { db, type Bot, type User } from '../models/database.js'
import { extractCalendarIntent, type CalendarIntent } from './calendarIntent.js'
import { googleCalendarService } from './googleCalendar.js'

export interface CalendarAutomationResult {
  created: boolean
  title?: string
  startAt?: Date
  endAt?: Date
  htmlLink?: string
  duplicate?: boolean
}

function sourceHash(botId: string, contactPhone: string, message: string) {
  return crypto
    .createHash('sha256')
    .update(`${botId}:${contactPhone}:${message.trim().toLowerCase().replace(/\s+/g, ' ')}`)
    .digest('hex')
}

function buildEventDescription(bot: Bot, contactPhone: string, message: string, intent: CalendarIntent) {
  const parts = [
    'Criado automaticamente pelo Zapiens a partir de uma conversa no WhatsApp.',
    `Bot: ${bot.name}`,
    `Contato: ${contactPhone}`,
  ]

  if (intent.description) parts.push(`Detalhes: ${intent.description}`)
  parts.push(`Mensagem original: ${message.slice(0, 1000)}`)
  return parts.join('\n\n')
}

function formatWhen(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

export function calendarConfirmation(result: CalendarAutomationResult, timeZone = env.GOOGLE_CALENDAR_TIMEZONE) {
  if (!result.created || !result.startAt || !result.title) return ''
  return `\n\n[Agenda] ${result.title} marcado no Google Agenda para ${formatWhen(result.startAt, timeZone)}.`
}

export async function tryScheduleCalendarEvent(
  user: User,
  bot: Bot,
  contactPhone: string,
  message: string,
): Promise<CalendarAutomationResult | null> {
  const integration = await db.findCalendarIntegrationByUserId(user.id)
  if (!integration?.enabled) return null

  const hash = sourceHash(bot.id, contactPhone, message)
  if (await db.hasCalendarEventLog(bot.id, contactPhone, hash)) {
    return { created: false, duplicate: true }
  }

  const intent = await extractCalendarIntent(message, {
    apiKeys: user.apiKeys,
    botName: bot.name,
    contactPhone,
    timeZone: env.GOOGLE_CALENDAR_TIMEZONE,
  })
  if (!intent) return null

  const event = await googleCalendarService.createEvent(integration, {
    summary: intent.title,
    description: buildEventDescription(bot, contactPhone, message, intent),
    startAt: intent.startAt,
    endAt: intent.endAt,
    timeZone: intent.timeZone,
  })

  await db.createCalendarEventLog({
    userId: user.id,
    botId: bot.id,
    contactPhone,
    sourceMessageHash: hash,
    googleEventId: event.id,
    googleHtmlLink: event.htmlLink ?? null,
    title: intent.title,
    startAt: intent.startAt,
    endAt: intent.endAt,
  })

  return {
    created: true,
    title: intent.title,
    startAt: intent.startAt,
    endAt: intent.endAt,
    htmlLink: event.htmlLink,
  }
}

