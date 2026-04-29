import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { authenticate } from '../middleware/authenticate.js'
import { demoReadOnlyGuard } from '../middleware/demoReadOnlyGuard.js'
import { validate } from '../middleware/validate.js'
import { db } from '../models/database.js'
import { googleCalendarService } from '../service/googleCalendar.js'
import { ApiError, ok, noContent } from '../utils/http.js'

export const calendarRouter = Router()

const updateCalendarSchema = z.object({
  enabled: z.boolean().optional(),
  calendarId: z.string()
    .trim()
    .min(1)
    .max(200)
    .refine(value => !/[\/\\\u0000-\u001f]/.test(value), 'Calendar ID invalido')
    .optional(),
})

function frontendRedirect(status: 'connected' | 'error', reason?: string) {
  const url = new URL(env.FRONTEND_URL)
  url.searchParams.set('calendar', status)
  if (reason) url.searchParams.set('reason', reason)
  return url.toString()
}

calendarRouter.get('/google/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthError = typeof req.query.error === 'string' ? req.query.error : ''

  if (oauthError || !code || !state) {
    return res.redirect(frontendRedirect('error', oauthError || 'missing_code'))
  }

  try {
    await googleCalendarService.handleCallback(code, state)
    return res.redirect(frontendRedirect('connected'))
  } catch (err) {
    console.error('[GoogleCalendar] OAuth callback failed:', err)
    return res.redirect(frontendRedirect('error', 'oauth_failed'))
  }
})

calendarRouter.use(authenticate)

calendarRouter.get('/google/status', async (req, res, next) => {
  try {
    const integration = await db.findCalendarIntegrationByUserId(req.userId)
    return ok(res, {
      connected: Boolean(integration),
      enabled: integration?.enabled ?? false,
      calendarId: integration?.calendarId ?? 'primary',
    })
  } catch (err) {
    next(err)
  }
})

calendarRouter.get('/google/connect', demoReadOnlyGuard, async (req, res, next) => {
  try {
    return ok(res, { url: googleCalendarService.buildAuthUrl(req.userId) })
  } catch (err) {
    next(err)
  }
})

calendarRouter.patch('/google', demoReadOnlyGuard, validate(updateCalendarSchema), async (req, res, next) => {
  try {
    const integration = await db.findCalendarIntegrationByUserId(req.userId)
    if (!integration) {
      throw ApiError.badRequest('Conecte o Google Agenda antes de habilitar a automacao.', 'GOOGLE_CALENDAR_NOT_CONNECTED')
    }

    const updated = await db.updateCalendarIntegration(req.userId, {
      enabled: req.body.enabled,
      calendarId: req.body.calendarId,
    })

    return ok(res, {
      connected: true,
      enabled: updated?.enabled ?? false,
      calendarId: updated?.calendarId ?? 'primary',
    })
  } catch (err) {
    next(err)
  }
})

calendarRouter.delete('/google', demoReadOnlyGuard, async (req, res, next) => {
  try {
    await googleCalendarService.revokeAndDelete(req.userId)
    return noContent(res)
  } catch (err) {
    next(err)
  }
})
