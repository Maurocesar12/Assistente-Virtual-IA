import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKENS_DIR = path.join(__dirname, '..', '..', 'tokens')

// ─── Limpa TODOS os tokens do bot antes de iniciar ────────────────────────────
// Sem isso, wppconnect restaura sessão antiga e NUNCA gera QR Code.

async function nukeAllBotTokens(botId: string): Promise<void> {
  if (!fs.existsSync(TOKENS_DIR)) return
  try {
    const entries = fs.readdirSync(TOKENS_DIR)
    for (const entry of entries) {
      if (!entry.includes(botId)) continue
      const fullPath = path.join(TOKENS_DIR, entry)
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true })
          console.log(`[WhatsApp] Tokens removidos: ${entry}`)
          break
        } catch (err: any) {
          const locked = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY'
          if (locked && attempt < 5) {
            await new Promise(r => setTimeout(r, 1200 * attempt))
          } else {
            console.warn(`[WhatsApp] Nao foi possivel remover ${entry}: ${err?.code}`)
            break
          }
        }
      }
    }
  } catch (err) {
    console.warn('[WhatsApp] nukeAllBotTokens error:', err)
  }
}

export interface QRCodeEvent  { botId: string; qrBase64: string; qrAscii: string }
export interface SessionEvent { botId: string; status: string }

type QRListener      = (event: QRCodeEvent) => void
type SessionListener = (event: SessionEvent) => void

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 15_000

const FAILED_STATUSES = new Set([
  'browserClose', 'qrReadError', 'autocloseCalled',
  'desconnectedMobile', 'disconnected',
])

const CONNECTED_STATUSES = new Set(['inChat', 'isLogged'])

export class WhatsAppManager {
  private clients        = new Map<string, wppconnect.Whatsapp>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers  = new Map<string, NodeJS.Timeout>()
  private qrListeners:      QRListener[]      = []
  private sessionListeners: SessionListener[] = []
  private lastQR = new Map<string, { qrBase64: string; qrAscii: string }>()

  onQRCode(listener: QRListener): () => void {
    this.qrListeners.push(listener)
    return () => { this.qrListeners = this.qrListeners.filter(l => l !== listener) }
  }

  onQRCodeForBot(botId: string, listener: QRListener): () => void {
    this.qrListeners.push(listener)
    const cached = this.lastQR.get(botId)
    if (cached) setTimeout(() => listener({ botId, ...cached }), 50)
    return () => { this.qrListeners = this.qrListeners.filter(l => l !== listener) }
  }

  onSessionUpdate(listener: SessionListener): () => void {
    this.sessionListeners.push(listener)
    return () => { this.sessionListeners = this.sessionListeners.filter(l => l !== listener) }
  }

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) {
      console.log(`[WhatsApp] Sessao ja esta rodando para: ${bot.name}`)
      return
    }

    console.log(`[WhatsApp] Iniciando sessao para: ${bot.name}`)

    // PASSO 1: Remove TODOS os tokens deste bot para forcar novo QR
    await nukeAllBotTokens(bot.id)

    const sessionName = `zapgpt_${bot.id}_${Date.now()}`
    const sessionDir  = path.join(TOKENS_DIR, sessionName)

    try {
      const client = await wppconnect.create({
        session:        sessionName,
        headless:       'new' as any,
        logQR:          false,
        autoClose:      0,
        disableWelcome: true,

        // PASSO 2: user-data-dir vazio e isolado — sem perfil Chrome antigo
        puppeteerOptions: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            `--user-data-dir=${sessionDir}`,
          ],
        },

        catchQR: (base64Qr: string, asciiQR: string) => {
          console.log(`[WhatsApp] QR Code gerado para: ${bot.name}`)
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach(l =>
            l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR })
          )
        },

        statusFind: (status: string) => {
          console.log(`[WhatsApp] ${bot.name} — status: ${status}`)
          this.sessionListeners.forEach(l => l({ botId: bot.id, status }))

          if (CONNECTED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id)
            db.updateBot(bot.id, { isConnected: true, isActive: true })
              .catch(err => console.error('[WhatsApp] updateBot error:', err))
            return
          }

          if (FAILED_STATUSES.has(status)) {
            this.lastQR.delete(bot.id)
            this.clients.delete(bot.id)
            setTimeout(() => nukeAllBotTokens(bot.id).catch(() => {}), 3000)
            db.updateBot(bot.id, { isConnected: false, isActive: false })
              .catch(err => console.error('[WhatsApp] updateBot error:', err))
          }
        },
      })

      this.clients.set(bot.id, client)
      this.attachMessageListener(bot, client)
      console.log(`[WhatsApp] Sessao pronta para: ${bot.name}`)
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
    console.log(`[WhatsApp] Sessao encerrada: ${botId}`)
  }

  isRunning(botId: string): boolean {
    return this.clients.has(botId)
  }

  private attachMessageListener(bot: Bot, client: wppconnect.Whatsapp): void {
    client.onMessage(message => {
      const isValid =
        message.type === 'chat' && !message.isGroupMsg &&
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

  private async processMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, message: string, from: string,
  ): Promise<void> {
    const user = await db.findUserById(bot.userId)
    if (!user) return
    const answer = await this.callAIWithRetry(bot, user.apiKeys, chatId, message)
    await this.persistConversation(bot, from, message, answer)
    const chunks = splitMessages(answer)
    await sendMessagesWithDelay(client, chunks, from)
  }

  private async callAIWithRetry(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try { return await this.callAI(bot, apiKeys, chatId, message) }
      catch (err) {
        if (attempt === MAX_RETRIES)
          return 'Desculpe, nao consegui processar sua mensagem no momento.'
      }
    }
    return 'Desculpe, nao consegui processar sua mensagem no momento.'
  }

  private async callAI(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<string> {
    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey) throw new Error('Gemini API key nao configurada.')
      return geminiManager.sendMessage(chatId, message, {
        apiKey: apiKeys.geminiKey, model: bot.model, systemPrompt: bot.prompt,
      })
    }
    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId)
      throw new Error('OpenAI credentials nao configurados.')
    return openaiManager.sendMessage(chatId, message, {
      apiKey: apiKeys.openaiKey, assistantId: apiKeys.openaiAssistantId,
    })
  }

  private async persistConversation(
    bot: Bot, from: string, message: string, answer: string,
  ): Promise<void> {
    const conversation = await db.upsertConversation({
      botId: bot.id, userId: bot.userId,
      contactName: from, contactPhone: from,
      lastMessage: answer, lastMessageAt: new Date(),
      unreadCount: 1, messageCount: 1,
    })
    await Promise.all([
      db.createMessage({ conversationId: conversation.id, role: 'user',      content: message }),
      db.createMessage({ conversationId: conversation.id, role: 'assistant', content: answer  }),
      db.updateBot(bot.id, { messageCount: bot.messageCount + 1 }),
    ])
  }
}

export const whatsappManager = new WhatsAppManager()