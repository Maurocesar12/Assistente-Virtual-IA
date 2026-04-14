/**
 * routes/bots.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { whatsappManager } from '../service/whatsapp.js'
import { ApiError, ok, created, noContent } from '../utils/http.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { planGuard } from '../middleware/planGuard.js'

export const botsRouter = Router()

botsRouter.use(authenticate)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createBotSchema = z.object({
  name:   z.string().min(2, 'Name must be at least 2 characters'),
  model:  z.enum(['gemini-2.5-flash', 'gpt-4', 'gpt-3.5-turbo']),
  prompt: z.string().optional(), 
      }).superRefine((data, ctx) => {
        // Fazemos a validação condicional aqui fora
        if (data.model === 'gemini-2.5-flash') {
          if (!data.prompt || data.prompt.trim().length < 10) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Prompt must be at least 10 characters for Gemini',
              path: ['prompt'], // Isso faz o erro apontar para o campo certinho
      });
    }
  }
});

const updateBotSchema = z.object({
  name:     z.string().min(2).optional(),
  model:    z.enum(['gemini-2.5-flash', 'gpt-4', 'gpt-3.5-turbo']).optional(),
  // Removemos o .min(10) daqui também
  prompt:   z.string().optional(),
  isActive: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Na atualização, verificamos se o usuário está mudando para o Gemini
  // e enviando um prompt muito curto ao mesmo tempo.
  if (data.model === 'gemini-2.5-flash' && data.prompt !== undefined) {
    if (data.prompt.trim().length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Prompt must be at least 10 characters for Gemini',
        path: ['prompt'],
      });
    }
  }
});

// ─── GET /bots ────────────────────────────────────────────────────────────────

botsRouter.get('/', async (req, res, next) => {
  try {
    const bots = await db.findBotsByUserId(req.userId)
    return ok(res, bots)
  } catch (err) { next(err) }
})

// ─── GET /bots/:id ────────────────────────────────────────────────────────────

botsRouter.get('/:id', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    return ok(res, bot)
  } catch (err) { next(err) }
})

// ─── POST /bots ───────────────────────────────────────────────────────────────

botsRouter.post('/', validate(createBotSchema), async (req, res, next) => {
  try {
    const { name, model, prompt } = req.body
    const bot = await db.createBot({
      userId:       req.userId,
      name,
      model,
      prompt,
      isActive:     false,
      isConnected:  false,
      sessionName:  `zapgpt_${req.userId}_${Date.now()}`,
      messageCount: 0,
    })
    return created(res, bot)
  } catch (err) { next(err) }
})

// ─── PATCH /bots/:id ──────────────────────────────────────────────────────────

botsRouter.patch('/:id', validate(updateBotSchema), async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    const updated = await db.updateBot(req.params.id, req.body)
    return ok(res, updated)
  } catch (err) { next(err) }
})

// ─── DELETE /bots/:id ─────────────────────────────────────────────────────────

botsRouter.delete('/:id', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    if (whatsappManager.isRunning(bot.id)) await whatsappManager.stopSession(bot.id)
    await db.deleteBot(bot.id)
    return noContent(res)
  } catch (err) { next(err) }
})

// ─── POST /bots/:id/connect ───────────────────────────────────────────────────
// planGuard: impede conexão de bot quando limite do plano foi atingido.
// Sem isso, um atacante com JWT válido poderia conectar bots via API direta.

botsRouter.post('/:id/connect', planGuard, async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    if (whatsappManager.isRunning(bot.id)) await whatsappManager.stopSession(bot.id)
    await db.updateBot(bot.id, { isConnected: false, isActive: false })

    const freshBot = await db.findBotById(bot.id)
    if (!freshBot) throw ApiError.notFound('Bot not found after reset')

    whatsappManager.startSession(freshBot).catch((err) => {
      console.error(`[Bots] Failed to start session for ${freshBot.id}:`, err)
      db.updateBot(freshBot.id, { isConnected: false, isActive: false })
    })

    return ok(res, { message: 'Connection started. Listen to /bots/:id/events for QR code.' })
  } catch (err) { next(err) }
})

// ─── POST /bots/:id/disconnect ────────────────────────────────────────────────

botsRouter.post('/:id/disconnect', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    await whatsappManager.stopSession(bot.id)
    const updated = await db.findBotById(bot.id)
    return ok(res, updated)
  } catch (err) { next(err) }
})

// ─── GET /bots/:id/events (SSE) ───────────────────────────────────────────────

botsRouter.get('/:id/events', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let qrShown       = false
    let everConnected = false
    // Flag: QR foi lido com sucesso — ignora status de desconexão do handshake
    let qrScanned     = false

    const SESSION_ERROR_MESSAGES: Record<string, { title: string; message: string; action: string }> = {
      browserClose:       { title: 'Navegador fechado',     message: 'O navegador interno foi fechado inesperadamente.',        action: 'Clique em "Conectar" para reconectar o bot.' },
      qrReadError:        { title: 'QR Code não lido',      message: 'O QR Code expirou sem ser escaneado.',                   action: 'Clique em "Conectar" e escaneie o QR novamente.' },
      autocloseCalled:    { title: 'Conexão encerrada',     message: 'A sessão foi encerrada automaticamente por inatividade.', action: 'Clique em "Conectar" para reconectar.' },
      desconnectedMobile: { title: 'Desconectado pelo app', message: 'O WhatsApp foi desconectado pelo celular.',               action: 'Abra o WhatsApp → Dispositivos Conectados e reconecte.' },
      disconnected:       { title: 'Conexão perdida',       message: 'A conexão com o WhatsApp foi perdida.',                  action: 'Clique em "Conectar" para reconectar.' },
      notLogged:          { title: 'Sessão expirada',       message: 'Sua sessão do WhatsApp expirou.',                        action: 'Clique em "Conectar" e escaneie o QR Code novamente.' },
      serverClose:        { title: 'Servidor encerrou',     message: 'O servidor do WhatsApp encerrou a conexão.',             action: 'Aguarde alguns minutos e clique em "Conectar".' },
      deleteToken:        { title: 'Sessão removida',       message: 'Os dados de sessão foram removidos.',                   action: 'Clique em "Conectar" para iniciar nova sessão.' },
    }

    const SESSION_FAILED_KEYS    = new Set(Object.keys(SESSION_ERROR_MESSAGES))
    const SESSION_CONNECTED_KEYS = new Set(['inChat', 'isLogged'])
    const CONNECTED_WITH_PHONE   = 'connected_with_phone'

    const unsubQR = whatsappManager.onQRCodeForBot(bot.id, (e) => {
      qrShown = true
      sendEvent('qr', { qrBase64: e.qrBase64, qrAscii: e.qrAscii })
    })

    const unsubSession = whatsappManager.onSessionUpdate(async (e) => {
      if (e.botId !== bot.id) return

      // Marca QR como escaneado — ignora erros de handshake a partir daqui
      if (e.status === 'qrReadSuccess') {
        qrScanned = true
        return
      }

      if (e.status === CONNECTED_WITH_PHONE) {
        everConnected = true
        sendEvent('connected', { botId: e.botId, status: e.status })
        const updatedWithPhone = await db.findBotById(bot.id)
        if (updatedWithPhone) sendEvent('bot', updatedWithPhone)
        return
      }

      sendEvent('status', { status: e.status })

      if (SESSION_CONNECTED_KEYS.has(e.status) && qrShown) {
        everConnected = true
        sendEvent('connected', { botId: e.botId, status: e.status })
      }

      const isFailure   = SESSION_FAILED_KEYS.has(e.status)
      const isAfterQR   = qrShown || everConnected
      // Ignora notLogged/disconnectedMobile durante handshake (antes do QR ser escaneado)
      const isHandshakeNoise = !qrScanned && ['notLogged', 'desconnectedMobile', 'disconnectedMobile'].includes(e.status)
      const shouldAlert = isFailure && isAfterQR && !isHandshakeNoise

      if (shouldAlert) {
        const info = SESSION_ERROR_MESSAGES[e.status] ?? {
          title: 'Conexão perdida', message: 'Erro inesperado na sessão do WhatsApp.',
          action: 'Clique em "Conectar" para tentar reconectar.',
        }
        sendEvent('error-bot', { ...info, status: e.status, botId: e.botId })
      }

      const updated = await db.findBotById(bot.id)
      if (updated) sendEvent('bot', updated)
    })

    const unsubAIError = whatsappManager.onAIError((e) => {
      if (e.botId !== bot.id) return
      sendEvent('ai-error', {
        botId: e.botId, botName: e.botName, kind: e.kind, title: e.title, action: e.action,
      })
    })

    const unsubPlanLimit = whatsappManager.onPlanLimit((e) => {
      if (e.botId !== bot.id) return
      sendEvent('plan-limit', e)
    })

    const unsubPause = whatsappManager.onBotPause((e) => {
      if (e.botId !== bot.id) return
      sendEvent('bot-pause', {
        convId: e.convId, contactPhone: e.contactPhone,
        isPaused: e.isPaused, humanHandoff: e.humanHandoff, reason: e.reason,
      })
    })

    const unsubTyping = whatsappManager.onTyping((e) => {
      if (e.botId !== bot.id) return
      sendEvent('bot-typing', {
        convId: e.convId, contactPhone: e.contactPhone, isTyping: e.isTyping,
      })
    })

    const unsubContactTyping = whatsappManager.onContactTyping((e) => {
      if (e.botId !== bot.id) return
      sendEvent('contact-typing', {
        contactPhone: e.contactPhone,
        isTyping:     e.isTyping,
      })
    })

    req.on('close', () => {
      unsubQR()
      unsubSession()
      unsubAIError()
      unsubPlanLimit()
      unsubPause()
      unsubTyping()
      unsubContactTyping()
    })
  } catch (err) { next(err) }
})

// ─── GET /bots/:id/conversations ──────────────────────────────────────────────

botsRouter.get('/:id/conversations', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    const conversations = await db.findConversationsByBotId(bot.id)
    return ok(res, conversations)
  } catch (err) { next(err) }
})