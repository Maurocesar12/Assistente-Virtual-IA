/**
 * routes/users.ts
 */

import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { sanitizeUser } from '../utils/auth.js'
import { ApiError, ok } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { demoReadOnlyGuard } from '../middleware/demoReadOnlyGuard.js'
import { getPlanConfig, remainingMessages, usagePercent, isMessageLimitReached } from '../utils/planLimits.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

function hasPaidAnalytics(user: Awaited<ReturnType<typeof db.findUserById>>) {
  if (!user) return false
  return user.plan === 'pro' || user.plan === 'enterprise'
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  name:     z.string().min(2).optional(),
  lastName: z.string().min(2).optional(),
})

const updateApiKeysSchema = z.object({
  openaiKey:         z.string().max(500).optional(),
  openaiAssistantId: z.string().max(200).optional(),
  geminiKey:         z.string().max(500).optional(),
})

// ─── GET /users/me/stats ──────────────────────────────────────────────────────
// Retorna stats com informações de limite de plano enriquecidas.
// totalMessages agora conta da tabela Message (fonte de verdade) — veja database.ts

usersRouter.get('/me/stats', async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    const stats      = await db.getUserStats(req.userId)
    const planConfig = getPlanConfig(user.plan)

    return ok(res, {
      ...stats,
      plan:              user.plan,
      subscriptionStatus: user.subscriptionStatus,
      analyticsAvailable: hasPaidAnalytics(user),
      planLabel:         planConfig.label,
      planPrice:         planConfig.price,
      messageLimit:      planConfig.messageLimit === Infinity ? null : planConfig.messageLimit,
      remainingMessages: remainingMessages(user.plan, stats.totalMessages),
      usagePercent:      usagePercent(user.plan, stats.totalMessages),
      limitReached:      isMessageLimitReached(user.plan, stats.totalMessages),
    })
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me ──────────────────────────────────────────────────────────

usersRouter.patch('/me', demoReadOnlyGuard, validate(updateProfileSchema), async (req, res, next) => {
  try {
    const updated = await db.updateUser(req.userId, req.body)
    if (!updated) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(updated))
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me/api-keys ─────────────────────────────────────────────────

usersRouter.patch('/me/api-keys', demoReadOnlyGuard, validate(updateApiKeysSchema), async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('User not found')

    const incoming: Partial<typeof user.apiKeys> = {}
    for (const key of ['openaiKey', 'openaiAssistantId', 'geminiKey'] as const) {
      const value = req.body[key]
      if (typeof value === 'string' && value.trim().length > 0) {
        incoming[key] = value.trim()
      }
    }

    if (Object.keys(incoming).length === 0) {
      return ok(res, { apiKeys: sanitizeUser(user).apiKeys, updated: false })
    }

    const updatedKeys = { ...user.apiKeys, ...incoming }
    const updated     = await db.updateUser(req.userId, { apiKeys: updatedKeys })

    return ok(res, { apiKeys: updated ? sanitizeUser(updated).apiKeys : {}, updated: true })
  } catch (err) {
    next(err)
  }
})

usersRouter.get('/me/analytics', async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('UsuÃ¡rio nÃ£o encontrado')
    if (!hasPaidAnalytics(user)) {
      throw ApiError.forbidden('Analytics completo disponivel apenas para usuarios com plano Pro.')
    }

    const analytics = await db.getUserAnalytics(req.userId)
    return ok(res, analytics)
  } catch (err) {
    next(err)
  }
})
