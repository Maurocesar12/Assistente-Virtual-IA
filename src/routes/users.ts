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

usersRouter.get('/me/stats', (req, res, next) => {
  try {
    const stats = db.getUserStats(req.userId)
    return ok(res, stats)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me ──────────────────────────────────────────────────────────

usersRouter.patch('/me', validate(updateProfileSchema), (req, res, next) => {
  try {
    const updated = db.updateUser(req.userId, req.body)
    if (!updated) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(updated))
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /users/me/api-keys ─────────────────────────────────────────────────

usersRouter.patch('/me/api-keys', validate(updateApiKeysSchema), (req, res, next) => {
  try {
    const user = db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('User not found')

    const updatedKeys = { ...user.apiKeys, ...req.body }
    const updated = db.updateUser(req.userId, { apiKeys: updatedKeys })

    return ok(res, { apiKeys: updated?.apiKeys })
  } catch (err) {
    next(err)
  }
})
