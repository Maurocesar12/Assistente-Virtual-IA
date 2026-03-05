import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Pasta onde o wppconnect salva as sessões (padrão: <root>/tokens)
const TOKENS_DIR = path.join(__dirname, '..', '..', 'tokens')

/** Remove arquivos de sessão salva para forçar novo QR Code.
 *  Só deve ser chamado ANTES de iniciar o Chromium (sem processo ativo). */
async function clearSessionFiles(sessionName: string): Promise<void> {
  const sessionDir = path.join(TOKENS_DIR, sessionName)
  if (!fs.existsSync(sessionDir)) return

  // No Windows, alguns arquivos do Chromium ficam bloqueados por alguns segundos
  // após o processo fechar. Tentamos com backoff exponencial.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true })
      console.log(`[WhatsApp] Sessão antiga removida: ${sessionName}`)
      return
    } catch (err: any) {
      const isLocked = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY'
      if (isLocked && attempt < 5) {
        await new Promise(r => setTimeout(r, 1000 * attempt))
      } else {
        // Não bloqueia o fluxo — wppconnect com deleteOnLogout cuida do resto
        console.warn(`[WhatsApp] Sessão antiga não removida (${err?.code}) — continuando...`)
        return
      }
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QRCodeEvent  { botId: string; qrBase64: string; qrAscii: string }
export interface SessionEvent { botId: string; status: string }

type QRListener      = (event: QRCodeEvent) => void
type SessionListener = (event: SessionEvent) => void

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 15_000

// notLogged = estado normal antes do QR aparecer — NÃO é falha
// Só encerra sessão em falhas reais (browser fechado, timeout, desconexão explícita)
const FAILED_STATUSES = new Set([
  'browserClose',
  'qrReadError',
  'autocloseCalled',
  'desconnectedMobile',
  'disconnected',
])

const CONNECTED_STATUSES = new Set(['inChat', 'isLogged'])

// ─── WhatsApp Session Manager ─────────────────────────────────────────────────

export class WhatsAppManager {
  private clients        = new Map<string, wppconnect.Whatsapp>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers  = new Map<string, NodeJS.Timeout>()
  private qrListeners:      QRListener[]      = []
  private sessionListeners: SessionListener[] = []

  // ✅ Cache do último QR por botId — resolve race condition SSE vs catchQR
  private lastQR = new Map<string, { qrBase64: string; qrAscii: string }>()

  // ── Event subscriptions ────────────────────────────────────────────────────

  onQRCode(listener: QRListener): () => void {
    this.qrListeners.push(listener)
    return () => { this.qrListeners = this.qrListeners.filter((l) => l !== listener) }
  }

  // ✅ Versão com replay: passa botId e reenveia o QR cacheado imediatamente se existir
  onQRCodeForBot(botId: string, listener: QRListener): () => void {
    this.qrListeners.push(listener)
    // Se já temos um QR gerado, entrega imediatamente ao novo listener
    const cached = this.lastQR.get(botId)
    if (cached) {
      setTimeout(() => listener({ botId, ...cached }), 50)
    }
    return () => { this.qrListeners = this.qrListeners.filter((l) => l !== listener) }
  }

  onSessionUpdate(listener: SessionListener): () => void {
    this.sessionListeners.push(listener)
    return () => { this.sessionListeners = this.sessionListeners.filter((l) => l !== listener) }
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) {
      console.log(`[WhatsApp] Session already running for bot: ${bot.name}`)
      return
    }

    console.log(`[WhatsApp] Starting session for bot: ${bot.name}`)

    // Gera um nome de sessão único a cada conexão para ignorar tokens antigos
    const sessionName = `${bot.sessionName}_${Date.now()}`

    // Tenta limpar sessão anterior (best-effort — não bloqueia se EBUSY)
    await clearSessionFiles(bot.sessionName)

    try {
      const client = await wppconnect.create({
        session:         sessionName,
        headless:        'new' as any,
        logQR:           false,
        autoClose:       0,
        disableWelcome:  true,
        // ✅ Perfil isolado por bot — evita que sessões antigas sejam restauradas
        puppeteerOptions: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            `--user-data-dir=${path.join(TOKENS_DIR, sessionName)}`,
          ],
        },

        catchQR: (base64Qr: string, asciiQR: string) => {
          console.log(`[WhatsApp] QR Code gerado para bot: ${bot.name}`)
          // ✅ Salva no cache — SSE listeners que chegarem tarde ainda recebem o QR
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach((l) =>
            l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR })
          )
        },

        statusFind: (status: string) => {
          console.log(`[WhatsApp] Bot ${bot.name} — status: ${status}`)
          this.sessionListeners.forEach((l) => l({ botId: bot.id, status }))

          if (CONNECTED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id) // QR não é mais necessário
            db.updateBot(bot.id, { isConnected: true, isActive: true })
              .catch((err) => console.error('[WhatsApp] updateBot error:', err))
            return
          }

          if (FAILED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id)
            this.clients.delete(bot.id)
            setTimeout(() => clearSessionFiles(sessionName).catch(() => {}), 5000)
            db.updateBot(bot.id, { isConnected: false, isActive: false })
              .catch((err) => console.error('[WhatsApp] updateBot error:', err))
          }
        },
      })

      this.clients.set(bot.id, client)
      this.attachMessageListener(bot, client)
      console.log(`[WhatsApp] Session ready for bot: ${bot.name}`)
    } catch (err) {
      this.clients.delete(bot.id)
      await db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
      throw err
    }
  }

  async stopSession(botId: string): Promise<void> {
    const client = this.clients.get(botId)
    if (!client) return

    try {
      await client.close()
    } catch (err) {
      console.warn(`[WhatsApp] Error closing session ${botId}:`, err)
    }

    this.clients.delete(botId)
    this.clearMessageBuffer(botId)

    // Busca bot para limpar arquivos APÓS o Chromium fechar (3s de margem)
    const bot = await db.findBotById(botId).catch(() => null)
    if (bot) {
      setTimeout(() => {
        clearSessionFiles(bot.sessionName)
          .catch((err) => console.warn('[WhatsApp] clearSession error:', err))
      }, 3000)
    }

    await db.updateBot(botId, { isConnected: false, isActive: false })
    console.log(`[WhatsApp] Session stopped for bot: ${botId}`)
  }

  isRunning(botId: string): boolean {
    return this.clients.has(botId)
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private attachMessageListener(bot: Bot, client: wppconnect.Whatsapp): void {
    client.onMessage((message) => {
      const isValid =
        message.type === 'chat'                &&
        !message.isGroupMsg                    &&
        message.chatId !== 'status@broadcast'

      if (!isValid) return

      this.bufferMessage(bot, client, String(message.chatId), message.body ?? '', message.from)
    })
  }

  private bufferMessage(
    bot:    Bot,
    client: wppconnect.Whatsapp,
    chatId: string,
    body:   string,
    from:   string,
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
        .catch((err) => console.error(`[Bot:${bot.name}] processMessage error:`, err))
    }, MESSAGE_BUFFER_TIMEOUT)

    this.messageTimers.set(chatId, timer)
  }

  private clearMessageBuffer(botId: string): void {
    const timer = this.messageTimers.get(botId)
    if (timer) clearTimeout(timer)
    this.messageTimers.delete(botId)
    this.messageBuffers.delete(botId)
  }

  // ── AI processing ──────────────────────────────────────────────────────────

  private async processMessage(
    bot:     Bot,
    client:  wppconnect.Whatsapp,
    chatId:  string,
    message: string,
    from:    string,
  ): Promise<void> {
    console.log(`[Bot:${bot.name}] Processing message from ${from}`)

    const user = await db.findUserById(bot.userId)
    if (!user) {
      console.error(`[Bot:${bot.name}] User ${bot.userId} not found`)
      return
    }

    const answer = await this.callAIWithRetry(bot, user.apiKeys, chatId, message)
    await this.persistConversation(bot, from, message, answer)

    const chunks = splitMessages(answer)
    await sendMessagesWithDelay(client, chunks, from)
  }

  private async callAIWithRetry(
    bot:     Bot,
    apiKeys: import('../models/database.js').ApiKeys,
    chatId:  string,
    message: string,
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callAI(bot, apiKeys, chatId, message)
      } catch (err) {
        console.error(`[Bot:${bot.name}] AI error (attempt ${attempt}/${MAX_RETRIES}):`, err)
        if (attempt === MAX_RETRIES) {
          return 'Desculpe, não consegui processar sua mensagem no momento. Tente novamente.'
        }
      }
    }
    return 'Desculpe, não consegui processar sua mensagem no momento. Tente novamente.'
  }

  private async callAI(
    bot:     Bot,
    apiKeys: import('../models/database.js').ApiKeys,
    chatId:  string,
    message: string,
  ): Promise<string> {
    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey) {
        throw new Error('Gemini API key não configurada. Vá em Configurações → API Keys.')
      }
      return geminiManager.sendMessage(chatId, message, {
        apiKey:       apiKeys.geminiKey,
        model:        bot.model,
        systemPrompt: bot.prompt,
      })
    }

    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId) {
      throw new Error('OpenAI credentials não configuradas. Vá em Configurações → API Keys.')
    }
    return openaiManager.sendMessage(chatId, message, {
      apiKey:      apiKeys.openaiKey,
      assistantId: apiKeys.openaiAssistantId,
    })
  }

  private async persistConversation(
    bot:     Bot,
    from:    string,
    message: string,
    answer:  string,
  ): Promise<void> {
    const conversation = await db.upsertConversation({
      botId:         bot.id,
      userId:        bot.userId,
      contactName:   from,
      contactPhone:  from,
      lastMessage:   answer,
      lastMessageAt: new Date(),
      unreadCount:   1,
      messageCount:  1,
    })

    await Promise.all([
      db.createMessage({ conversationId: conversation.id, role: 'user',      content: message }),
      db.createMessage({ conversationId: conversation.id, role: 'assistant', content: answer  }),
      db.updateBot(bot.id, { messageCount: bot.messageCount + 1 }),
    ])
  }
}

export const whatsappManager = new WhatsAppManager()