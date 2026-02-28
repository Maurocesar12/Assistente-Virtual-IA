import wppconnect from '@wppconnect-team/wppconnect'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QRCodeEvent {
  botId: string
  qrBase64: string
  qrAscii: string
}

export interface SessionEvent {
  botId: string
  status: string
}

type QRListener = (event: QRCodeEvent) => void
type SessionListener = (event: SessionEvent) => void

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3
const MESSAGE_BUFFER_TIMEOUT_MS = 15_000

// ─── WhatsApp Session Manager ─────────────────────────────────────────────────

export class WhatsAppManager {
  private clients = new Map<string, wppconnect.Whatsapp>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers = new Map<string, NodeJS.Timeout>()

  private qrListeners: QRListener[] = []
  private sessionListeners: SessionListener[] = []

  // ── Public event subscriptions ─────────────────────────────────────────────

  onQRCode(listener: QRListener) {
    this.qrListeners.push(listener)
    return () => {
      this.qrListeners = this.qrListeners.filter((l) => l !== listener)
    }
  }

  onSessionUpdate(listener: SessionListener) {
    this.sessionListeners.push(listener)
    return () => {
      this.sessionListeners = this.sessionListeners.filter((l) => l !== listener)
    }
  }

  // ── Start / stop ───────────────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) {
      console.log(`[WhatsApp] Session for bot ${bot.id} already running`)
      return
    }

    console.log(`[WhatsApp] Starting session for bot: ${bot.name}`)

    const client = await wppconnect.create({
      session: bot.sessionName,
      catchQR: (base64: string, ascii: string) => {
        this.qrListeners.forEach((l) =>
          l({ botId: bot.id, qrBase64: base64, qrAscii: ascii })
        )
      },
      statusFind: (status: string) => {
        console.log(`[WhatsApp] Bot ${bot.name} — status: ${status}`)
        this.sessionListeners.forEach((l) =>
          l({ botId: bot.id, status })
        )

        // ✅ Fire-and-forget com tratamento de erro (não pode usar await direto aqui)
        if (status === 'inChat' || status === 'isLogged') {
          db.updateBot(bot.id, { isConnected: true, isActive: true }).catch((err) =>
            console.error('[WhatsApp] updateBot error:', err)
          )
        }

        if (status === 'notLogged' || status === 'browserClose') {
          db.updateBot(bot.id, { isConnected: false, isActive: false }).catch((err) =>
            console.error('[WhatsApp] updateBot error:', err)
          )
        }
      },
      headless: 'new' as any,
      logQR: false,
    })

    this.clients.set(bot.id, client)
    this.attachMessageListener(bot, client)
    console.log(`[WhatsApp] Session ready for bot: ${bot.name}`)
  }

  async stopSession(botId: string): Promise<void> {
    const client = this.clients.get(botId)
    if (!client) return

    await client.close()
    this.clients.delete(botId)

    const timer = this.messageTimers.get(botId)
    if (timer) clearTimeout(timer)
    this.messageTimers.delete(botId)
    this.messageBuffers.delete(botId)

    await db.updateBot(botId, { isConnected: false, isActive: false })  // ✅ await adicionado
    console.log(`[WhatsApp] Session stopped for bot: ${botId}`)
  }

  isRunning(botId: string): boolean {
    return this.clients.has(botId)
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private attachMessageListener(bot: Bot, client: wppconnect.Whatsapp) {
    client.onMessage((message) => {
      if (
        message.type !== 'chat' ||
        message.isGroupMsg ||
        message.chatId === 'status@broadcast'
      )
        return

      const chatId = String(message.chatId)
      this.bufferMessage(bot, client, chatId, message.body ?? '', message.from)
    })
  }

  private bufferMessage(
    bot: Bot,
    client: wppconnect.Whatsapp,
    chatId: string,
    body: string,
    from: string
  ) {
    const buffer = this.messageBuffers.get(chatId) ?? []
    buffer.push(body)
    this.messageBuffers.set(chatId, buffer)

    const existing = this.messageTimers.get(chatId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const combined = (this.messageBuffers.get(chatId) ?? []).join(' \n ')
      this.messageBuffers.delete(chatId)
      this.messageTimers.delete(chatId)
      // ✅ processMessage é async — capturamos erros aqui
      this.processMessage(bot, client, chatId, combined, from).catch((err) =>
        console.error(`[Bot:${bot.name}] processMessage error:`, err)
      )
    }, MESSAGE_BUFFER_TIMEOUT_MS)

    this.messageTimers.set(chatId, timer)
  }

  private async processMessage(
    bot: Bot,
    client: wppconnect.Whatsapp,
    chatId: string,
    message: string,
    from: string
  ): Promise<void> {
    console.log(`[Bot:${bot.name}] Processing message from ${from}`)

    const user = await db.findUserById(bot.userId)  // ✅ await adicionado
    if (!user) {
      console.error(`[Bot:${bot.name}] User ${bot.userId} not found`)
      return
    }

    let answer = ''
    let attempt = 0

    while (attempt < MAX_RETRIES) {
      try {
        answer = await this.callAI(bot, user.apiKeys, chatId, message)
        break
      } catch (err) {
        attempt++
        console.error(`[Bot:${bot.name}] AI error (attempt ${attempt}):`, err)
        if (attempt === MAX_RETRIES) {
          answer = 'Desculpe, não consegui processar sua mensagem no momento. Tente novamente.'
        }
      }
    }

    // ✅ Todos os db calls agora aguardados corretamente
    const conversation = await db.upsertConversation({
      botId: bot.id,
      userId: bot.userId,
      contactName: from,
      contactPhone: from,
      lastMessage: answer,
      lastMessageAt: new Date(),
      unreadCount: 1,
      messageCount: 1,
    })

    await db.createMessage({ conversationId: conversation.id, role: 'user', content: message })
    await db.createMessage({ conversationId: conversation.id, role: 'assistant', content: answer })
    await db.updateBot(bot.id, { messageCount: bot.messageCount + 1 })

    const chunks = splitMessages(answer)
    await sendMessagesWithDelay(client, chunks, from)
  }

  private async callAI(
    bot: Bot,
    apiKeys: import('../models/database.js').ApiKeys,
    chatId: string,
    message: string
  ): Promise<string> {
    if (bot.model === 'gemini-2.0-flash') {
      const key = apiKeys.geminiKey
      if (!key) throw new Error('Gemini API key not configured. Configure em Configurações → API Keys.')
      return geminiManager.sendMessage(chatId, message, {
        apiKey: key,
        model: bot.model,
        systemPrompt: bot.prompt,
      })
    }

    // GPT variants
    const key = apiKeys.openaiKey
    const assistantId = apiKeys.openaiAssistantId
    if (!key || !assistantId) {
      throw new Error('OpenAI credentials not configured. Configure em Configurações → API Keys.')
    }
    return openaiManager.sendMessage(chatId, message, { apiKey: key, assistantId })
  }
}

export const whatsappManager = new WhatsAppManager()