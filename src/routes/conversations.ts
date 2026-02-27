import { Router } from 'express'
import { db } from '../models/database.js'
import { ApiError, ok } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'

export const conversationsRouter = Router()

conversationsRouter.use(authenticate)

// ─── GET /conversations ───────────────────────────────────────────────────────

conversationsRouter.get('/', (req, res, next) => {
  try {
    const conversations = db.findConversationsByUserId(req.userId)
    return ok(res, conversations)
  } catch (err) {
    next(err)
  }
})

// ─── GET /conversations/:id/messages ──────────────────────────────────────────

conversationsRouter.get('/:id/messages', (req, res, next) => {
  try {
    const conversations = db.findConversationsByUserId(req.userId)
    const conversation = conversations.find((c) => c.id === req.params.id)
    if (!conversation) throw ApiError.notFound('Conversation not found')

    const messages = db.findMessagesByConversationId(conversation.id)
    return ok(res, messages)
  } catch (err) {
    next(err)
  }
})
