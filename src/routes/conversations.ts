import { Router } from 'express'
import { db } from '../models/database.js'
import { ApiError, ok } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'

export const conversationsRouter = Router()

conversationsRouter.use(authenticate)

// ─── GET /conversations ───────────────────────────────────────────────────────

conversationsRouter.get('/', async (req, res, next) => {  // ✅ async adicionado
  try {
    const conversations = await db.findConversationsByUserId(req.userId)  // ✅ await adicionado
    return ok(res, conversations)
  } catch (err) {
    next(err)
  }
})

// ─── GET /conversations/:id/messages ──────────────────────────────────────────

conversationsRouter.get('/:id/messages', async (req, res, next) => {  // ✅ async adicionado
  try {
    const conversations = await db.findConversationsByUserId(req.userId)  // ✅ await adicionado
    const conversation = conversations.find((c) => c.id === req.params.id)
    if (!conversation) throw ApiError.notFound('Conversation not found')

    const messages = await db.findMessagesByConversationId(conversation.id)  // ✅ await + método agora existe
    return ok(res, messages)
  } catch (err) {
    next(err)
  }
})