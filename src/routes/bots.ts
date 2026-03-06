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
  model: z.enum(['gemini-2.5-flash', 'gpt-4', 'gpt-3.5-turbo']),
  prompt: z.string().min(10, 'Prompt must be at least 10 characters'),
})

const updateBotSchema = z.object({
  name: z.string().min(2).optional(),
  model: z.enum(['gemini-2.5-flash', 'gpt-4', 'gpt-3.5-turbo']).optional(),
  prompt: z.string().min(10).optional(),
  isActive: z.boolean().optional(),
})

// ─── GET /bots ────────────────────────────────────────────────────────────────

botsRouter.get('/', async (req, res, next) => {
  try {
    const bots = await db.findBotsByUserId(req.userId)
    return ok(res, bots)
  } catch (err) {
    next(err)
  }
})

// ─── GET /bots/:id ────────────────────────────────────────────────────────────

botsRouter.get('/:id', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    return ok(res, bot)
  } catch (err) {
    next(err)
  }
})

// ─── POST /bots ───────────────────────────────────────────────────────────────

botsRouter.post('/', validate(createBotSchema), async (req, res, next) => {
  try {
    const { name, model, prompt } = req.body
    const bot = await db.createBot({
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

botsRouter.patch('/:id', validate(updateBotSchema), async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    const updated = await db.updateBot(req.params.id, req.body)
    return ok(res, updated)
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /bots/:id ─────────────────────────────────────────────────────────

botsRouter.delete('/:id', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    if (whatsappManager.isRunning(bot.id)) {
      await whatsappManager.stopSession(bot.id)
    }
    await db.deleteBot(bot.id)
    return noContent(res)
  } catch (err) {
    next(err)
  }
})

// ─── POST /bots/:id/connect ───────────────────────────────────────────────────

botsRouter.post('/:id/connect', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    // ✅ FIX 1: Para a sessão existente SEMPRE que o usuário pedir conexão.
    //    Sem isso, wppconnect restaura a sessão antiga dos tokens em disco e
    //    emite status 'inChat' imediatamente — sem gerar QR Code.
    if (whatsappManager.isRunning(bot.id)) {
      await whatsappManager.stopSession(bot.id)
    }

    // ✅ FIX 2: Reseta isConnected=false no DB ANTES de iniciar o wppconnect.
    //    Se o DB tinha isConnected=true de sessão anterior, o SSE enviaria um
    //    evento 'bot' com isConnected=true logo na abertura, fechando o modal
    //    de conexão antes do QR aparecer.
    await db.updateBot(bot.id, { isConnected: false, isActive: false })

    // Inicia de forma assíncrona — QR code chegará via SSE
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
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    await whatsappManager.stopSession(bot.id)
    const updated = await db.findBotById(bot.id)
    return ok(res, updated)
  } catch (err) {
    next(err)
  }
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

    // ── Máquina de estado da sessão SSE ──────────────────────────────────────
    //
    // Regras para disparar alerta de erro:
    //
    //   FASE 1 — qrShown=false, everConnected=false (inicializando)
    //     → status de falha como 'notLogged', 'deleteToken' são NORMAIS nesta fase
    //     → IGNORAR — wppconnect emite isso durante bootstrap, antes do QR aparecer
    //
    //   FASE 2 — qrShown=true, everConnected=false (QR visível, aguardando scan)
    //     → se vier falha aqui → QR expirou ou erro real → ALERTAR
    //
    //   FASE 3 — everConnected=true (já conectou ao menos uma vez)
    //     → qualquer falha aqui → sessão caiu → ALERTAR

    let qrShown       = false
    let everConnected = false 

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

    const SESSION_FAILED_KEYS = new Set(Object.keys(SESSION_ERROR_MESSAGES))
    const SESSION_CONNECTED_KEYS = new Set(['inChat', 'isLogged'])

    const unsubQR = whatsappManager.onQRCodeForBot(bot.id, (e) => {
      qrShown = true
      sendEvent('qr', { qrBase64: e.qrBase64, qrAscii: e.qrAscii })
    })

    const unsubSession = whatsappManager.onSessionUpdate(async (e) => {
      if (e.botId !== bot.id) return

      sendEvent('status', { status: e.status })

      if (SESSION_CONNECTED_KEYS.has(e.status)) {
        everConnected = true
      }

      // Só emite alerta se o usuário já viu o QR OU se já esteve conectado.
      // Status como 'notLogged' durante bootstrap (fase 1) são ignorados.
      const shouldAlert = SESSION_FAILED_KEYS.has(e.status) && (qrShown || everConnected)

      if (shouldAlert) {
        const info = SESSION_ERROR_MESSAGES[e.status] ?? {
          title:   'Conexão perdida',
          message: 'Erro inesperado na sessão do WhatsApp.',
          action:  'Clique em "Conectar" para tentar reconectar.',
        }
        sendEvent('error-bot', { ...info, status: e.status, botId: e.botId })
      }

      const updated = await db.findBotById(bot.id)
      if (updated) sendEvent('bot', updated)
    })

    // ── Erros de IA → painel do operador (NUNCA enviados ao contato) ─────────
    const unsubAIError = whatsappManager.onAIError((e) => {
      if (e.botId !== bot.id) return
      // Envia apenas title, action e kind ao front — detail fica nos logs do servidor
      sendEvent('ai-error', {
        botId:   e.botId,
        botName: e.botName,
        kind:    e.kind,
        title:   e.title,
        action:  e.action,
      })
    })

    req.on('close', () => {
      unsubQR()
      unsubSession()
      unsubAIError()
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /bots/:id/conversations ──────────────────────────────────────────────

botsRouter.get('/:id/conversations', async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    const conversations = await db.findConversationsByBotId(bot.id)
    return ok(res, conversations)
  } catch (err) {
    next(err)
  }
})