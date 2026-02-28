import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { sanitizeUser } from '../utils/auth.js'
import { ApiError, ok } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'

export const usersRouter = Router()

usersRouter.use(authenticate)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  lastName: z.string().min(2).optional(),
})

const updateApiKeysSchema = z.object({
  openaiKey: z.string().optional(),
  openaiAssistantId: z.string().optional(),
  geminiKey: z.string().optional(),
})

// ─── GET /users/me/stats ──────────────────────────────────────────────────────

usersRouter.get('/me/stats', async (req, res, next) => {  // ✅ async adicionado
  try {
    const stats = await db.getUserStats(req.userId)  // ✅ await adicionado
    return ok(res, stats)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me ──────────────────────────────────────────────────────────

usersRouter.patch('/me', validate(updateProfileSchema), async (req, res, next) => {  // ✅ async adicionado
  try {
    const updated = await db.updateUser(req.userId, req.body)  // ✅ await adicionado
    if (!updated) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(updated))
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me/api-keys ─────────────────────────────────────────────────

usersRouter.patch('/me/api-keys', validate(updateApiKeysSchema), async (req, res, next) => {  // ✅ async adicionado
  try {
    const user = await db.findUserById(req.userId)  // ✅ await adicionado
    if (!user) throw ApiError.notFound('User not found')

    const updatedKeys = { ...user.apiKeys, ...req.body }
    const updated = await db.updateUser(req.userId, { apiKeys: updatedKeys })  // ✅ await adicionado

    return ok(res, { apiKeys: updated?.apiKeys })
  } catch (err) {
    next(err)
  }
})