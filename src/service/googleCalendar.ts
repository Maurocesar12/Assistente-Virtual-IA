import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { db, type CalendarIntegration } from '../models/database.js'
import { ApiError } from '../utils/http.js'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const OAUTH_STATE_PURPOSE = 'google_calendar'
const ACCESS_TOKEN_SKEW_MS = 60_000

interface OAuthStatePayload {
  sub: string
  purpose: typeof OAUTH_STATE_PURPOSE
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

export interface CalendarEventInput {
  summary: string
  description?: string
  startAt: Date
  endAt: Date
  timeZone?: string
}

export interface GoogleCalendarEvent {
  id: string
  htmlLink?: string
}

function requireOAuthConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw ApiError.badRequest(
      'Google Agenda nao configurado no servidor. Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI.',
      'GOOGLE_CALENDAR_NOT_CONFIGURED',
    )
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  }
}

function tokenExpiryDate(expiresIn?: number) {
  if (!expiresIn) return null
  return new Date(Date.now() + expiresIn * 1000)
}

function createState(userId: string) {
  return jwt.sign(
    { sub: userId, purpose: OAUTH_STATE_PURPOSE } satisfies OAuthStatePayload,
    env.JWT_SECRET,
    { expiresIn: '10m' },
  )
}

function readState(state: string) {
  const payload = jwt.verify(state, env.JWT_SECRET) as OAuthStatePayload
  if (payload.purpose !== OAUTH_STATE_PURPOSE || !payload.sub) {
    throw ApiError.badRequest('Estado OAuth invalido.', 'INVALID_OAUTH_STATE')
  }
  return payload.sub
}

function buildTokenBody(values: Record<string, string>) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) body.set(key, value)
  return body
}

async function requestToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const json = await res.json().catch(() => ({})) as GoogleTokenResponse
  if (!res.ok) {
    throw ApiError.badRequest(
      json.error_description || json.error || 'Falha ao autorizar Google Agenda.',
      'GOOGLE_OAUTH_FAILED',
    )
  }

  return json
}

async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const config = requireOAuthConfig()
  return requestToken(buildTokenBody({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  }))
}

async function refreshToken(integration: CalendarIntegration): Promise<CalendarIntegration> {
  const config = requireOAuthConfig()
  const token = await requestToken(buildTokenBody({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: integration.refreshToken,
    grant_type: 'refresh_token',
  }))

  if (!token.access_token) {
    throw ApiError.badRequest('Google nao retornou um access token valido.', 'GOOGLE_TOKEN_REFRESH_FAILED')
  }

  const updated = await db.updateCalendarIntegration(integration.userId, {
    accessToken: token.access_token,
    scope:      token.scope ?? integration.scope,
    tokenType:  token.token_type ?? integration.tokenType,
    expiryDate: tokenExpiryDate(token.expires_in),
  })

  if (!updated) throw ApiError.notFound('Integracao com Google Agenda nao encontrada.')
  return updated
}

async function getFreshIntegration(integration: CalendarIntegration): Promise<CalendarIntegration> {
  if (!integration.expiryDate) return integration
  if (integration.expiryDate.getTime() - Date.now() > ACCESS_TOKEN_SKEW_MS) return integration
  return refreshToken(integration)
}

async function postCalendarEvent(integration: CalendarIntegration, event: CalendarEventInput): Promise<Response> {
  const calendarId = encodeURIComponent(integration.calendarId || 'primary')
  return fetch(`${GOOGLE_CALENDAR_API}/calendars/${calendarId}/events?sendUpdates=none`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${integration.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.startAt.toISOString(), timeZone: event.timeZone ?? env.GOOGLE_CALENDAR_TIMEZONE },
      end:   { dateTime: event.endAt.toISOString(),   timeZone: event.timeZone ?? env.GOOGLE_CALENDAR_TIMEZONE },
    }),
  })
}

export const googleCalendarService = {
  buildAuthUrl(userId: string) {
    const config = requireOAuthConfig()
    const url = new URL(GOOGLE_AUTH_URL)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', config.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', CALENDAR_SCOPE)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', createState(userId))
    return url.toString()
  },

  async handleCallback(code: string, state: string) {
    const userId = readState(state)
    const existing = await db.findCalendarIntegrationByUserId(userId)
    const token = await exchangeCode(code)

    if (!token.access_token) {
      throw ApiError.badRequest('Google nao retornou um access token valido.', 'GOOGLE_OAUTH_FAILED')
    }

    const refreshTokenValue = token.refresh_token ?? existing?.refreshToken
    if (!refreshTokenValue) {
      throw ApiError.badRequest(
        'Google nao retornou refresh token. Tente desconectar e conectar novamente autorizando o acesso offline.',
        'GOOGLE_REFRESH_TOKEN_MISSING',
      )
    }

    return db.saveCalendarIntegration({
      userId,
      enabled: true,
      calendarId: existing?.calendarId ?? 'primary',
      accessToken: token.access_token,
      refreshToken: refreshTokenValue,
      scope: token.scope ?? CALENDAR_SCOPE,
      tokenType: token.token_type ?? 'Bearer',
      expiryDate: tokenExpiryDate(token.expires_in),
    })
  },

  async createEvent(integration: CalendarIntegration, event: CalendarEventInput): Promise<GoogleCalendarEvent> {
    let fresh = await getFreshIntegration(integration)
    let res = await postCalendarEvent(fresh, event)

    if (res.status === 401) {
      fresh = await refreshToken(fresh)
      res = await postCalendarEvent(fresh, event)
    }

    const json = await res.json().catch(() => ({})) as { id?: string; htmlLink?: string; error?: { message?: string } }
    if (!res.ok || !json.id) {
      throw ApiError.badRequest(json.error?.message || 'Nao foi possivel criar o evento no Google Agenda.', 'GOOGLE_EVENT_CREATE_FAILED')
    }

    return { id: json.id, htmlLink: json.htmlLink }
  },

  async revokeAndDelete(userId: string): Promise<void> {
    const integration = await db.findCalendarIntegrationByUserId(userId)
    if (!integration) return

    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(integration.refreshToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => undefined)

    await db.deleteCalendarIntegration(userId)
  },
}

