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
import { getPlanConfig, remainingMessages, usagePercent, isMessageLimitReached } from '../utils/planLimits.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  name:     z.string().min(2).optional(),
  lastName: z.string().min(2).optional(),
})

const updateApiKeysSchema = z.object({
  openaiKey:         z.string().optional(),
  openaiAssistantId: z.string().optional(),
  geminiKey:         z.string().optional(),
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

usersRouter.patch('/me', validate(updateProfileSchema), async (req, res, next) => {
  try {
    const updated = await db.updateUser(req.userId, req.body)
    if (!updated) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(updated))
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me/api-keys ─────────────────────────────────────────────────

usersRouter.patch('/me/api-keys', validate(updateApiKeysSchema), async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('User not found')

    const updatedKeys = { ...user.apiKeys, ...req.body }
    const updated     = await db.updateUser(req.userId, { apiKeys: updatedKeys })

    return ok(res, { apiKeys: updated?.apiKeys })
  } catch (err) {
    next(err)
  }
})