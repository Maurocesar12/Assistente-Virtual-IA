import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const TOKENS_DIR = path.join(__dirname, '..', '..', 'tokens')

// ═══════════════════════════════════════════════════════
// AI ERROR
// ═══════════════════════════════════════════════════════

export type AIErrorKind = 'config' | 'quota' | 'network' | 'unknown'

export class AIError extends Error {
  readonly name = 'AIError'
  constructor(public readonly kind: AIErrorKind, message: string) { super(message) }
}

function classifyError(raw: unknown): AIError {
  const msg = String((raw as any)?.message ?? raw).toLowerCase()
  const is  = (signals: string[]) => signals.some(s => msg.includes(s))
  if (is(['api key', 'invalid api key', 'api_key_invalid', 'permission_denied', 'nao configurad', 'not configured']))
    return new AIError('config', 'Credenciais de API inválidas ou não configuradas.')
  if (is(['quota', 'resource_exhausted', 'insufficient_quota', 'billing', 'exceeded your current quota', '429']))
    return new AIError('quota', 'Cota ou limite de uso da API atingido.')
  if (is(['fetch', 'econnrefused', 'enotfound', 'network', 'timeout', 'socket']))
    return new AIError('network', 'Falha de rede ao contatar a API de IA.')
  return new AIError('unknown', 'Erro inesperado ao processar a mensagem.')
}

// ═══════════════════════════════════════════════════════
// EVENTOS
// ═══════════════════════════════════════════════════════

export interface QRCodeEvent  { botId: string; qrBase64: string; qrAscii: string }
export interface SessionEvent { botId: string; status: string }
export interface AIErrorEvent { botId: string; botName: string; kind: AIErrorKind; title: string; detail: string; action: string }

// Feature 2 + 3 — pausa do bot
export interface BotPauseEvent {
  botId:        string
  convId:       string
  contactPhone: string
  isPaused:     boolean
  humanHandoff: boolean
  reason:       'manual_override' | 'human_handoff' | 'resumed'
}

// Feature 4 — typing indicator
export interface TypingEvent {
  botId:        string
  convId:       string
  contactPhone: string
  isTyping:     boolean
}

type QRListener      = (e: QRCodeEvent)   => void
type SessionListener = (e: SessionEvent)  => void
type AIErrorListener = (e: AIErrorEvent)  => void
type PauseListener   = (e: BotPauseEvent) => void
type TypingListener  = (e: TypingEvent)   => void

const AI_ERROR_META: Record<AIErrorKind, { title: string; action: string }> = {
  config:  { title: 'Chave de API inválida', action: 'Vá em Configurações → API Keys e verifique suas credenciais.' },
  quota:   { title: 'Cota da API esgotada',  action: 'Acesse o painel da OpenAI ou Gemini e adicione créditos.' },
  network: { title: 'Falha de rede',          action: 'Verifique sua conexão. O erro pode ser temporário.' },
  unknown: { title: 'Erro inesperado na IA', action: 'Verifique os logs do servidor para mais detalhes.' },
}

// ═══════════════════════════════════════════════════════
// Feature 3 — Human Handoff intent detection
// ═══════════════════════════════════════════════════════

const HANDOFF_PHRASES = [
  'quero falar com um humano', 'quero falar com uma pessoa', 'quero falar com atendente',
  'quero um atendente', 'falar com humano', 'falar com pessoa', 'atendimento humano',
  'atendente humano', 'sem ser bot', 'nao quero falar com bot', 'nao quero bot',
  'me transfere', 'me transferir', 'transferir para humano', 'falar com suporte', 'atendimento real',
]

function detectsHandoffIntent(message: string): boolean {
  const normalized = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return HANDOFF_PHRASES.some(phrase => normalized.includes(phrase))
}

// ═══════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 15_000
const CONNECTED_STATUSES     = new Set(['inChat', 'isLogged'])
const FAILED_STATUSES        = new Set(['browserClose', 'qrReadError', 'autocloseCalled', 'desconnectedMobile', 'disconnected'])

// ═══════════════════════════════════════════════════════
// TOKEN CLEANUP
// ═══════════════════════════════════════════════════════

async function nukeAllBotTokens(botId: string): Promise<void> {
  if (!fs.existsSync(TOKENS_DIR)) return
  try {
    const entries = fs.readdirSync(TOKENS_DIR)
    for (const entry of entries) {
      if (!entry.includes(botId)) continue
      const fullPath = path.join(TOKENS_DIR, entry)
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { fs.rmSync(fullPath, { recursive: true, force: true }); break }
        catch (err: any) {
          const locked = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY'
          if (locked && attempt < 5) await new Promise(r => setTimeout(r, 1200 * attempt))
          else break
        }
      }
    }
  } catch (err) { console.warn('[WhatsApp] nukeAllBotTokens error:', err) }
}

// ═══════════════════════════════════════════════════════
// WHATSAPP MANAGER
// ═══════════════════════════════════════════════════════

export class WhatsAppManager {
  private clients        = new Map<string, wppconnect.Whatsapp>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers  = new Map<string, NodeJS.Timeout>()
  private lastQR         = new Map<string, { qrBase64: string; qrAscii: string }>()

  private qrListeners:      QRListener[]      = []
  private sessionListeners: SessionListener[] = []
  private aiErrorListeners: AIErrorListener[] = []
  private pauseListeners:   PauseListener[]   = []
  private typingListeners:  TypingListener[]  = []

  // ── Subscriptions ────────────────────────────────────────────────────────

  onQRCode(l: QRListener): () => void {
    this.qrListeners.push(l)
    return () => { this.qrListeners = this.qrListeners.filter(x => x !== l) }
  }

  onQRCodeForBot(botId: string, l: QRListener): () => void {
    this.qrListeners.push(l)
    const cached = this.lastQR.get(botId)
    if (cached) setTimeout(() => l({ botId, ...cached }), 50)
    return () => { this.qrListeners = this.qrListeners.filter(x => x !== l) }
  }

  onSessionUpdate(l: SessionListener): () => void {
    this.sessionListeners.push(l)
    return () => { this.sessionListeners = this.sessionListeners.filter(x => x !== l) }
  }

  onAIError(l: AIErrorListener): () => void {
    this.aiErrorListeners.push(l)
    return () => { this.aiErrorListeners = this.aiErrorListeners.filter(x => x !== l) }
  }

  onBotPause(l: PauseListener): () => void {
    this.pauseListeners.push(l)
    return () => { this.pauseListeners = this.pauseListeners.filter(x => x !== l) }
  }

  onTyping(l: TypingListener): () => void {
    this.typingListeners.push(l)
    return () => { this.typingListeners = this.typingListeners.filter(x => x !== l) }
  }

  // Método público para rotas HTTP dispararem eventos SSE de pausa/retomada
  // sem precisar acessar pauseListeners diretamente (que é private).
  emitBotPause(event: Parameters<PauseListener>[0]): void {
    this.pauseListeners.forEach(l => l(event))
  }

  // ── Session management ───────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) return

    console.log(`[WhatsApp] Iniciando sessao para: ${bot.name}`)
    await nukeAllBotTokens(bot.id)

    const sessionName = `zapgpt_${bot.id}_${Date.now()}`
    const sessionDir  = path.join(TOKENS_DIR, sessionName)

    try {
      const client = await wppconnect.create({
        session: sessionName, headless: 'new' as any,
        logQR: false, autoClose: 0, disableWelcome: true,
        puppeteerOptions: {
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                 '--disable-gpu', '--disable-extensions', `--user-data-dir=${sessionDir}`],
        },
        catchQR: (base64Qr: string, asciiQR: string) => {
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach(l => l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR }))
        },
        statusFind: (status: string) => {
          this.sessionListeners.forEach(l => l({ botId: bot.id, status }))
          if (CONNECTED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id)
            db.updateBot(bot.id, { isConnected: true, isActive: true }).catch(() => {})
            // Captura o número do próprio bot para detectar override manual
            client.getHostDevice().then((device: any) => {
              const phone = device?.wid?.user ?? device?.id?.user
              if (phone) db.updateBot(bot.id, { phone: `${phone}@c.us` }).catch(() => {})
            }).catch(() => {})
            return
          }
          if (FAILED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id)
            this.clients.delete(bot.id)
            setTimeout(() => nukeAllBotTokens(bot.id).catch(() => {}), 3000)
            db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
          }
        },
      })

      this.clients.set(bot.id, client)
      this.attachMessageListener(bot, client)
    } catch (err) {
      this.clients.delete(bot.id)
      await db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
      throw err
    }
  }

  async stopSession(botId: string): Promise<void> {
    const client = this.clients.get(botId)
    if (!client) return
    try { await client.close() } catch (_) {}
    this.clients.delete(botId)
    this.lastQR.delete(botId)
    this.clearMessageBuffer(botId)
    await db.updateBot(botId, { isConnected: false, isActive: false })
    setTimeout(() => nukeAllBotTokens(botId).catch(() => {}), 3000)
  }

  isRunning(botId: string): boolean { return this.clients.has(botId) }

  // ── Feature 2 — Resume bot after manual override ─────────────────────────

  async resumeBot(botId: string, convId: string): Promise<void> {
    await db.setConversationHandoff(convId, false)  // também limpa isPaused
    const conv = await db.findConversationById(convId)
    if (!conv) return
    this.pauseListeners.forEach(l => l({
      botId, convId, contactPhone: conv.contactPhone,
      isPaused: false, humanHandoff: false, reason: 'resumed',
    }))
  }

  // ── Message pipeline ─────────────────────────────────────────────────────

  private attachMessageListener(bot: Bot, client: wppconnect.Whatsapp): void {
    client.onMessage(message => {
      const isValid =
        message.type === 'chat' &&
        !message.isGroupMsg &&
        message.chatId !== 'status@broadcast'
      if (!isValid) return
      this.bufferMessage(bot, client, String(message.chatId), message.body ?? '', message.from)
    })
  }

  private bufferMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, body: string, from: string,
  ): void {
    const buffer = this.messageBuffers.get(chatId) ?? []
    buffer.push(body)
    this.messageBuffers.set(chatId, buffer)

    const existing = this.messageTimers.get(chatId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const combined = (this.messageBuffers.get(chatId) ?? []).join(' \n ')
      this.messageBuffers.delete(chatId)
      this.messageTimers.delete(chatId)
      this.processMessage(bot, client, chatId, combined, from)
        .catch(err => console.error(`[Bot:${bot.name}] processMessage error:`, err))
    }, MESSAGE_BUFFER_TIMEOUT)

    this.messageTimers.set(chatId, timer)
  }

  private clearMessageBuffer(botId: string): void {
    const timer = this.messageTimers.get(botId)
    if (timer) clearTimeout(timer)
    this.messageTimers.delete(botId)
    this.messageBuffers.delete(botId)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core: processMessage
  // ─────────────────────────────────────────────────────────────────────────

  private async processMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, message: string, from: string,
  ): Promise<void> {
    const user = await db.findUserById(bot.userId)
    if (!user) return

    // ── Feature 2: detecta intervenção manual do operador (mensagem do próprio número) ──
    const freshBot = await db.findBotById(bot.id)
    if (freshBot?.phone && from === freshBot.phone) {
      // O chatId aqui é o número do cliente (destino da mensagem do operador)
      const targetConv = await db.findConversationByBotAndPhone(bot.id, chatId)
      if (targetConv && !targetConv.isPaused) {
        const updated = await db.setConversationPaused(targetConv.id, true)
        if (updated) {
          this.pauseListeners.forEach(l => l({
            botId: bot.id, convId: updated.id, contactPhone: chatId,
            isPaused: true, humanHandoff: false, reason: 'manual_override',
          }))
          console.log(`[Bot:${bot.name}] Override manual — bot pausado para: ${chatId}`)
        }
      }
      return
    }

    const conv = await db.findConversationByBotAndPhone(bot.id, from)

    // ── Feature 3: Human Handoff intent ──────────────────────────────────
    if (conv && !conv.humanHandoff && detectsHandoffIntent(message)) {
      const updated = await db.setConversationHandoff(conv.id, true)
      if (updated) {
        this.pauseListeners.forEach(l => l({
          botId: bot.id, convId: updated.id, contactPhone: from,
          isPaused: true, humanHandoff: true, reason: 'human_handoff',
        }))
      }
      await client.sendText(from, '👤 Vou transferir você para um de nossos atendentes. Aguarde um momento!')
        .catch(() => {})
      await this.persistMessage(bot, from, message, null)
      return
    }

    // ── Feature 2: bot pausado por override manual ────────────────────────
    if (conv?.isPaused) {
      await this.persistMessage(bot, from, message, null)
      return
    }

    // ── Feature 4: Typing indicator — emite antes de chamar a IA ─────────
    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: true,
      }))
    }

    let answer: string

    try {
      answer = await this.callAIWithRetry(bot, user.apiKeys, chatId, message)
    } catch (raw) {
      const err = raw instanceof AIError ? raw : classifyError(raw)
      console.error(`[Bot:${bot.name}] AI error [${err.kind}]: ${err.message}`)
      this.emitAIError(bot, err)
      if (conv) {
        this.typingListeners.forEach(l => l({
          botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
        }))
      }
      await this.persistMessage(bot, from, message, null)
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
      }))
    }

    await this.persistMessage(bot, from, message, answer)
    await sendMessagesWithDelay(client, splitMessages(answer), from)
  }

  // ── AI with retry ────────────────────────────────────────────────────────

  private async callAIWithRetry(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<string> {
    let lastError: AIError | undefined

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callAI(bot, apiKeys, chatId, message)
      } catch (raw) {
        const err = raw instanceof AIError ? raw : classifyError(raw)
        lastError = err
        if (err.kind === 'config' || err.kind === 'quota') throw err
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }

    throw lastError ?? new AIError('unknown', 'Falha após múltiplas tentativas.')
  }

  private async callAI(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<string> {
    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey) throw new AIError('config', 'Gemini API key não configurada.')
      return geminiManager.sendMessage(chatId, message, {
        apiKey: apiKeys.geminiKey, model: bot.model, systemPrompt: bot.prompt,
      })
    }
    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId)
      throw new AIError('config', 'Credenciais OpenAI não configuradas.')
    return openaiManager.sendMessage(chatId, message, {
      apiKey: apiKeys.openaiKey, assistantId: apiKeys.openaiAssistantId,
    })
  }

  private emitAIError(bot: Bot, err: AIError): void {
    const meta = AI_ERROR_META[err.kind]
    this.aiErrorListeners.forEach(l => l({
      botId: bot.id, botName: bot.name, kind: err.kind,
      title: meta.title, detail: err.message, action: meta.action,
    }))
  }

  private async persistMessage(
    bot: Bot, from: string, message: string, answer: string | null,
  ): Promise<void> {
    const conversation = await db.upsertConversation({
      botId: bot.id, userId: bot.userId,
      contactName: from, contactPhone: from,
      lastMessage:   answer ?? message,
      lastMessageAt: new Date(),
      unreadCount: 1, messageCount: 1,
    })

    await Promise.all([
      db.createMessage({ conversationId: conversation.id, role: 'user', content: message }),
      db.updateBot(bot.id, { messageCount: bot.messageCount + 1 }),
      ...(answer !== null
        ? [db.createMessage({ conversationId: conversation.id, role: 'assistant', content: answer })]
        : []
      ),
    ])
  }
}

export const whatsappManager = new WhatsAppManager()