import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { whatsappManager } from '../service/whatsapp.js'
import { ApiError, ok, created, noContent } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'

export const botsRouter = Router()

botsRouter.use(authenticate)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createBotSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  model: z.enum(['gemini-2.0-flash', 'gpt-4', 'gpt-3.5-turbo']),
  prompt: z.string().min(10, 'Prompt must be at least 10 characters'),
})

const updateBotSchema = z.object({
  name: z.string().min(2).optional(),
  model: z.enum(['gemini-2.0-flash', 'gpt-4', 'gpt-3.5-turbo']).optional(),
  prompt: z.string().min(10).optional(),
  isActive: z.boolean().optional(),
})

// ─── GET /bots ────────────────────────────────────────────────────────────────

botsRouter.get('/', (req, res, next) => {
  try {
    const bots = db.findBotsByUserId(req.userId)
    return ok(res, bots)
  } catch (err) {
    next(err)
  }
})

// ─── GET /bots/:id ────────────────────────────────────────────────────────────

botsRouter.get('/:id', (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    return ok(res, bot)
  } catch (err) {
    next(err)
  }
})

// ─── POST /bots ───────────────────────────────────────────────────────────────

botsRouter.post('/', validate(createBotSchema), (req, res, next) => {
  try {
    const { name, model, prompt } = req.body

    const bot = db.createBot({
      userId: req.userId,
      name,
      model,
      prompt,
      isActive: false,
      isConnected: false,
      sessionName: `zapgpt_${req.userId}_${Date.now()}`,
      messageCount: 0,
    })

    return created(res, bot)
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /bots/:id ──────────────────────────────────────────────────────────

botsRouter.patch('/:id', validate(updateBotSchema), (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    const updated = db.updateBot(req.params.id, req.body)
    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /bots/:id ─────────────────────────────────────────────────────────

botsRouter.delete('/:id', async (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    // Stop WhatsApp session if running
    if (whatsappManager.isRunning(bot.id)) {
      await whatsappManager.stopSession(bot.id)
    }

    db.deleteBot(bot.id)
    return noContent(res)
  } catch (err) {
    next(err)
  }
})

// ─── POST /bots/:id/connect ───────────────────────────────────────────────────

botsRouter.post('/:id/connect', async (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    if (whatsappManager.isRunning(bot.id)) {
      return ok(res, { message: 'Session already running', bot })
    }

    // Start async — QR code is delivered via SSE
    whatsappManager.startSession(bot).catch((err) => {
      console.error(`[Bots] Failed to start session for ${bot.id}:`, err)
      db.updateBot(bot.id, { isConnected: false, isActive: false })
    })

    return ok(res, { message: 'Connection started. Listen to /bots/:id/events for QR code.' })
  } catch (err) {
    next(err)
  }
})

// ─── POST /bots/:id/disconnect ────────────────────────────────────────────────

botsRouter.post('/:id/disconnect', async (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    await whatsappManager.stopSession(bot.id)
    const updated = db.findBotById(bot.id)
    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})

// ─── GET /bots/:id/events (SSE) ───────────────────────────────────────────────

botsRouter.get('/:id/events', (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const unsubQR = whatsappManager.onQRCode((e) => {
      if (e.botId !== bot.id) return
      sendEvent('qr', { qrBase64: e.qrBase64, qrAscii: e.qrAscii })
    })

    const unsubSession = whatsappManager.onSessionUpdate((e) => {
      if (e.botId !== bot.id) return
      sendEvent('status', { status: e.status })
      const updated = db.findBotById(bot.id)
      if (updated) sendEvent('bot', updated)
    })

    req.on('close', () => {
      unsubQR()
      unsubSession()
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /bots/:id/conversations ──────────────────────────────────────────────

botsRouter.get('/:id/conversations', (req, res, next) => {
  try {
    const bot = db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    const conversations = db.findConversationsByBotId(bot.id)
    return ok(res, conversations)
  } catch (err) {
    next(err)
  }
})
