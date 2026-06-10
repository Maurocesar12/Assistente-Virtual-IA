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
import { demoReadOnlyGuard } from '../middleware/demoReadOnlyGuard.js'
import { extractPdfTextFromBase64 } from '../utils/pdfText.js'
import { fetchPublicLinkText } from '../utils/linkContent.js'
import {
  accessDecisionToError,
  evaluateAutomationAccess,
  evaluateBotCreationAccess,
} from '../utils/accessControl.js'

export const botsRouter = Router()

botsRouter.use(authenticate)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const MAX_KNOWLEDGE_CONTENT_CHARS = 30_000
const MAX_KNOWLEDGE_FILE_BASE64_CHARS = 4_500_000
const MAX_KNOWLEDGE_ITEMS_PER_BOT = 100

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

// ─── Knowledge base schemas/helpers ───────────────────────────────────────────

const knowledgeTypeSchema = z.enum(['text', 'faq', 'link', 'pdf'])

const createKnowledgeSchema = z.object({
  type:       knowledgeTypeSchema,
  title:      z.string().trim().min(2).max(140),
  content:    z.string().trim().max(MAX_KNOWLEDGE_CONTENT_CHARS).optional(),
  sourceUrl:  z.string().trim().url().max(2048).optional(),
  question:   z.string().trim().max(500).optional(),
  answer:     z.string().trim().max(MAX_KNOWLEDGE_CONTENT_CHARS).optional(),
  fileName:   z.string().trim().max(180).optional(),
  mimeType:   z.string().trim().max(120).optional(),
  fileBase64: z.string().max(MAX_KNOWLEDGE_FILE_BASE64_CHARS).optional(),
})

const updateKnowledgeSchema = z.object({
  title:     z.string().trim().min(2).max(140).optional(),
  content:   z.string().trim().min(1).max(MAX_KNOWLEDGE_CONTENT_CHARS).optional(),
  sourceUrl: z.string().trim().url().max(2048).nullable().optional(),
  question:  z.string().trim().max(500).nullable().optional(),
  answer:    z.string().trim().max(MAX_KNOWLEDGE_CONTENT_CHARS).nullable().optional(),
  isActive:  z.boolean().optional(),
})

function compactKnowledgeContent(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_KNOWLEDGE_CONTENT_CHARS)
}

async function resolveOwnedBot(botId: string, userId: string) {
  const bot = await db.findBotById(botId)
  if (!bot || bot.userId !== userId) throw ApiError.notFound('Bot not found')
  return bot
}

async function assertCanCreateBot(userId: string) {
  const [user, bots] = await Promise.all([
    db.findUserById(userId),
    db.findBotsByUserId(userId),
  ])

  if (!user) throw ApiError.notFound('Usuario nao encontrado')

  const error = accessDecisionToError(evaluateBotCreationAccess(user, bots.length))
  if (error) throw error
}

async function assertCanActivateBot(userId: string) {
  const [user, stats] = await Promise.all([
    db.findUserById(userId),
    db.getUserStats(userId),
  ])

  if (!user) throw ApiError.notFound('Usuario nao encontrado')

  const error = accessDecisionToError(evaluateAutomationAccess(user, stats))
  if (error) throw error
}

async function resolveOwnedKnowledgeItem(botId: string, itemId: string, userId: string) {
  const [bot, item] = await Promise.all([
    db.findBotById(botId),
    db.findKnowledgeBaseItemById(itemId),
  ])
  if (!bot || bot.userId !== userId) throw ApiError.notFound('Bot not found')
  if (!item || item.botId !== bot.id || item.userId !== userId) {
    throw ApiError.notFound('Knowledge item not found')
  }
  return { bot, item }
}

async function buildKnowledgePayload(botId: string, userId: string, body: z.infer<typeof createKnowledgeSchema>) {
  if (body.type === 'faq') {
    const question = compactKnowledgeContent(body.question ?? '')
    const answer = compactKnowledgeContent(body.answer ?? '')
    if (!question || !answer) {
      throw ApiError.badRequest('Informe pergunta e resposta para cadastrar um FAQ.', 'KNOWLEDGE_FAQ_REQUIRED')
    }
    return {
      botId, userId,
      type: body.type,
      title: body.title,
      content: `Pergunta: ${question}\nResposta: ${answer}`,
      question,
      answer,
      sourceUrl: null,
    }
  }

  if (body.type === 'link') {
    if (!body.sourceUrl) {
      throw ApiError.badRequest('Informe a URL para importar um link.', 'KNOWLEDGE_LINK_REQUIRED')
    }
    const content = compactKnowledgeContent(body.content ?? await fetchPublicLinkText(body.sourceUrl))
    if (!content) {
      throw ApiError.badRequest('Nao foi possivel importar conteudo util deste link.', 'KNOWLEDGE_EMPTY_CONTENT')
    }
    return {
      botId, userId,
      type: body.type,
      title: body.title,
      content,
      sourceUrl: body.sourceUrl,
      question: null,
      answer: null,
    }
  }

  if (body.type === 'pdf') {
    if (!body.fileBase64) {
      throw ApiError.badRequest('Envie um arquivo PDF para importar.', 'KNOWLEDGE_PDF_REQUIRED')
    }
    const extracted = extractPdfTextFromBase64(body.fileBase64)
    return {
      botId, userId,
      type: body.type,
      title: body.title,
      content: compactKnowledgeContent(extracted.text),
      sourceUrl: null,
      question: null,
      answer: null,
      fileName: body.fileName ?? null,
      mimeType: body.mimeType ?? 'application/pdf',
      sizeBytes: extracted.sizeBytes,
    }
  }

  const content = compactKnowledgeContent(body.content ?? '')
  if (!content) {
    throw ApiError.badRequest('Informe o conteudo de texto da base de conhecimento.', 'KNOWLEDGE_TEXT_REQUIRED')
  }
  return {
    botId, userId,
    type: body.type,
    title: body.title,
    content,
    sourceUrl: null,
    question: null,
    answer: null,
    fileName: body.fileName ?? null,
    mimeType: body.mimeType ?? null,
  }
}

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

botsRouter.post('/', demoReadOnlyGuard, validate(createBotSchema), async (req, res, next) => {
  try {
    const { name, model, prompt } = req.body
    await assertCanCreateBot(req.userId)

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

botsRouter.patch('/:id', demoReadOnlyGuard, validate(updateBotSchema), async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')

    if (req.body.isActive === true) {
      if (!bot.isConnected) {
        throw ApiError.conflict('Conecte o bot ao WhatsApp antes de ativa-lo.')
      }
      await assertCanActivateBot(req.userId)
    }

    const updated = await db.updateBot(req.params.id, req.body)
    if (req.body.model !== undefined || req.body.prompt !== undefined) {
      whatsappManager.clearBotContext(bot.id)
    }

    return ok(res, updated)
  } catch (err) { next(err) }
})

// ─── DELETE /bots/:id ─────────────────────────────────────────────────────────

botsRouter.delete('/:id', demoReadOnlyGuard, async (req, res, next) => {
  try {
    const bot = await db.findBotById(req.params.id)
    if (!bot || bot.userId !== req.userId) throw ApiError.notFound('Bot not found')
    if (whatsappManager.isRunning(bot.id)) await whatsappManager.stopSession(bot.id)
    await db.deleteBot(bot.id)
    return noContent(res)
  } catch (err) { next(err) }
})

// Base de conhecimento por bot

botsRouter.get('/:id/knowledge', async (req, res, next) => {
  try {
    const bot = await resolveOwnedBot(req.params.id, req.userId)
    const items = await db.findKnowledgeBaseItemsByBotId(bot.id)
    return ok(res, items)
  } catch (err) { next(err) }
})

botsRouter.post('/:id/knowledge', demoReadOnlyGuard, validate(createKnowledgeSchema), async (req, res, next) => {
  try {
    const bot = await resolveOwnedBot(req.params.id, req.userId)
    const currentItems = await db.countKnowledgeBaseItemsByBotId(bot.id)
    if (currentItems >= MAX_KNOWLEDGE_ITEMS_PER_BOT) {
      throw ApiError.badRequest('Este bot atingiu o limite de itens na base de conhecimento.', 'KNOWLEDGE_LIMIT_REACHED')
    }

    const payload = await buildKnowledgePayload(bot.id, req.userId, req.body)
    const item = await db.createKnowledgeBaseItem(payload)
    return created(res, item)
  } catch (err) { next(err) }
})

botsRouter.patch('/:id/knowledge/:itemId', demoReadOnlyGuard, validate(updateKnowledgeSchema), async (req, res, next) => {
  try {
    const { item } = await resolveOwnedKnowledgeItem(req.params.id, req.params.itemId, req.userId)
    const body = req.body
    const payload: import('../models/database.js').UpdateKnowledgeBaseItemParams = {}

    if (body.title !== undefined) payload.title = body.title
    if (body.content !== undefined) payload.content = compactKnowledgeContent(body.content)
    if (body.sourceUrl !== undefined) payload.sourceUrl = body.sourceUrl
    if (body.question !== undefined) payload.question = body.question === null ? null : compactKnowledgeContent(body.question)
    if (body.answer !== undefined) payload.answer = body.answer === null ? null : compactKnowledgeContent(body.answer)
    if (body.isActive !== undefined) payload.isActive = body.isActive

    if (item.type === 'faq' && (body.question !== undefined || body.answer !== undefined)) {
      const question = String(payload.question ?? item.question ?? item.title).trim()
      const answer = String(payload.answer ?? item.answer ?? item.content).trim()
      if (!question || !answer) {
        throw ApiError.badRequest('FAQ precisa manter pergunta e resposta.', 'KNOWLEDGE_FAQ_REQUIRED')
      }
      payload.content = `Pergunta: ${question}\nResposta: ${answer}`
    }

    const updated = await db.updateKnowledgeBaseItem(item.id, payload)
    return ok(res, updated)
  } catch (err) { next(err) }
})

botsRouter.delete('/:id/knowledge/:itemId', demoReadOnlyGuard, async (req, res, next) => {
  try {
    const { item } = await resolveOwnedKnowledgeItem(req.params.id, req.params.itemId, req.userId)
    await db.deleteKnowledgeBaseItem(item.id)
    return noContent(res)
  } catch (err) { next(err) }
})

// ─── POST /bots/:id/connect ───────────────────────────────────────────────────
// planGuard: impede conexão de bot quando limite do plano foi atingido.
// Sem isso, um atacante com JWT válido poderia conectar bots via API direta.

botsRouter.post('/:id/connect', demoReadOnlyGuard, planGuard, async (req, res, next) => {
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

botsRouter.post('/:id/disconnect', demoReadOnlyGuard, async (req, res, next) => {
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
