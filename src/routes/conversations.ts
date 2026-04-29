import { Router } from 'express'
import { db } from '../models/database.js'
import { whatsappManager } from '../service/whatsapp.js'
import { ApiError, ok, noContent } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'
import { demoReadOnlyGuard } from '../middleware/demoReadOnlyGuard.js'

export const conversationsRouter = Router()

conversationsRouter.use(authenticate)

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveConversation(conversationId: string, userId: string) {
  const conversations = await db.findConversationsByUserId(userId)
  const conv = conversations.find(c => c.id === conversationId)
  if (!conv) throw ApiError.notFound('Conversation not found')
  return conv
}

// ─── GET /conversations ───────────────────────────────────────────────────────

conversationsRouter.get('/', async (req, res, next) => {
  try {
    const conversations = await db.findConversationsByUserId(req.userId)
    return ok(res, conversations)
  } catch (err) {
    next(err)
  }
})

// ─── GET /conversations/:id/messages ──────────────────────────────────────────

conversationsRouter.get('/:id/messages', async (req, res, next) => {
  try {
    await resolveConversation(req.params.id, req.userId)
    const messages = await db.findMessagesByConversationId(req.params.id)
    return ok(res, messages)
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /conversations/:id ─────────────────────────────────────────────────
// Feature 1 — Delete Chat

conversationsRouter.delete('/:id', demoReadOnlyGuard, async (req, res, next) => {
  try {
    await resolveConversation(req.params.id, req.userId)
    await db.deleteConversation(req.params.id)
    return noContent(res)
  } catch (err) {
    next(err)
  }
})

// ─── POST /conversations/:id/pause ────────────────────────────────────────────
// Feature 2 — Manual Override: operador pausa o bot manualmente no painel

conversationsRouter.post('/:id/pause', demoReadOnlyGuard, async (req, res, next) => {
  try {
    const conv = await resolveConversation(req.params.id, req.userId)
    const updated = await db.setConversationPaused(conv.id, true)

    // Usa o método público — nunca acessa propriedades privadas diretamente
    whatsappManager.emitBotPause({
      botId:        conv.botId,
      convId:       conv.id,
      contactPhone: conv.contactPhone,
      isPaused:     true,
      humanHandoff: false,
      reason:       'manual_override',
    })

    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})

// ─── POST /conversations/:id/resume ───────────────────────────────────────────
// Feature 2 — Resume: operador retoma o bot para o chat pausado

conversationsRouter.post('/:id/resume', demoReadOnlyGuard, async (req, res, next) => {
  try {
    const conv = await resolveConversation(req.params.id, req.userId)
    await whatsappManager.resumeBot(conv.botId, conv.id)
    const updated = await db.findConversationById(conv.id)
    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})

// ─── POST /conversations/:id/handoff ─────────────────────────────────────────
// Feature 3 — Human Handoff: operador marca como aguardando atendimento humano

conversationsRouter.post('/:id/handoff', demoReadOnlyGuard, async (req, res, next) => {
  try {
    const conv = await resolveConversation(req.params.id, req.userId)
    const updated = await db.setConversationHandoff(conv.id, true)

    whatsappManager.emitBotPause({
      botId:        conv.botId,
      convId:       conv.id,
      contactPhone: conv.contactPhone,
      isPaused:     true,
      humanHandoff: true,
      reason:       'human_handoff',
    })

    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})
