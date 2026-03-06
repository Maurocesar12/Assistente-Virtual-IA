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

// ═════════════════════════════════════════════════════════════════════════════
// AI ERROR — erro interno tipado, NUNCA exposto ao contato do WhatsApp
// ═════════════════════════════════════════════════════════════════════════════

export type AIErrorKind = 'config' | 'quota' | 'network' | 'unknown'

export class AIError extends Error {
  readonly name = 'AIError'
  constructor(public readonly kind: AIErrorKind, message: string) {
    super(message)
  }
}

// Classifica qualquer erro bruto da API em AIError tipado
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

// ═════════════════════════════════════════════════════════════════════════════
// EVENTOS PÚBLICOS
// ═════════════════════════════════════════════════════════════════════════════

export interface QRCodeEvent  { botId: string; qrBase64: string; qrAscii: string }
export interface SessionEvent { botId: string; status: string }
export interface AIErrorEvent {
  botId:   string
  botName: string
  kind:    AIErrorKind
  title:   string   // amigável — exibido no painel do operador
  detail:  string   // técnico  — apenas para o operador, nunca para o contato
  action:  string   // instrução de resolução
}

type QRListener      = (e: QRCodeEvent)  => void
type SessionListener = (e: SessionEvent) => void
type AIErrorListener = (e: AIErrorEvent) => void

// O que o operador vê no painel por tipo de erro
const AI_ERROR_META: Record<AIErrorKind, { title: string; action: string }> = {
  config:  { title: 'Chave de API inválida',  action: 'Vá em Configurações → API Keys e verifique suas credenciais.' },
  quota:   { title: 'Cota da API esgotada',   action: 'Acesse o painel da OpenAI ou Gemini e adicione créditos.' },
  network: { title: 'Falha de rede',           action: 'Verifique sua conexão. O erro pode ser temporário.' },
  unknown: { title: 'Erro inesperado na IA',  action: 'Verifique os logs do servidor para mais detalhes.' },
}

// ═════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═════════════════════════════════════════════════════════════════════════════

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 15_000
const CONNECTED_STATUSES     = new Set(['inChat', 'isLogged'])
const FAILED_STATUSES        = new Set(['browserClose', 'qrReadError', 'autocloseCalled', 'desconnectedMobile', 'disconnected'])

// ═════════════════════════════════════════════════════════════════════════════
// TOKEN CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

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
          if (locked && attempt < 5) await new Promise(r => setTimeout(r, 1200 * attempt))
          else { console.warn(`[WhatsApp] Nao foi possivel remover ${entry}: ${err?.code}`); break }
        }
      }
    }
  } catch (err) {
    console.warn('[WhatsApp] nukeAllBotTokens error:', err)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP MANAGER
// ═════════════════════════════════════════════════════════════════════════════

export class WhatsAppManager {
  private clients        = new Map<string, wppconnect.Whatsapp>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers  = new Map<string, NodeJS.Timeout>()
  private lastQR         = new Map<string, { qrBase64: string; qrAscii: string }>()

  private qrListeners:      QRListener[]      = []
  private sessionListeners: SessionListener[] = []
  private aiErrorListeners: AIErrorListener[] = []

  // ── Subscriptions ────────────────────────────────────────────────────────

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

  onAIError(listener: AIErrorListener): () => void {
    this.aiErrorListeners.push(listener)
    return () => { this.aiErrorListeners = this.aiErrorListeners.filter(l => l !== listener) }
  }

  // ── Session management ───────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) {
      console.log(`[WhatsApp] Sessao ja esta rodando para: ${bot.name}`)
      return
    }

    console.log(`[WhatsApp] Iniciando sessao para: ${bot.name}`)
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
        puppeteerOptions: {
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                 '--disable-gpu', '--disable-extensions', `--user-data-dir=${sessionDir}`],
        },
        catchQR: (base64Qr: string, asciiQR: string) => {
          console.log(`[WhatsApp] QR Code gerado para: ${bot.name}`)
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach(l => l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR }))
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

  // ── Core: processMessage ─────────────────────────────────────────────────
  //
  // SEGURANÇA: erros de IA são capturados aqui e redirecionados ao painel
  // do operador via evento SSE 'ai-error'. O contato do WhatsApp NUNCA
  // recebe mensagens de erro técnico.

  private async processMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, message: string, from: string,
  ): Promise<void> {
    const user = await db.findUserById(bot.userId)
    if (!user) return

    let answer: string

    try {
      answer = await this.callAIWithRetry(bot, user.apiKeys, chatId, message)
    } catch (raw) {
      const err = raw instanceof AIError ? raw : classifyError(raw)

      // Detalhe técnico fica apenas nos logs do servidor
      console.error(`[Bot:${bot.name}] AI error [${err.kind}]: ${err.message}`)

      // Notifica o operador via painel — nunca o contato do WhatsApp
      this.emitAIError(bot, err)

      // Persiste a mensagem recebida sem resposta (histórico íntegro)
      await this.persistMessage(bot, from, message, null)
      return
    }

    await this.persistMessage(bot, from, message, answer)
    await sendMessagesWithDelay(client, splitMessages(answer), from)
  }

  // ── AI call with retry ───────────────────────────────────────────────────
  //
  // Sempre lança AIError — nunca retorna strings de erro.
  // Erros terminais (config/quota) interrompem o retry imediatamente.

  private async callAIWithRetry(
    bot: Bot,
    apiKeys: import('../models/database.js').ApiKeys,
    chatId: string,
    message: string,
  ): Promise<string> {
    let lastError: AIError | undefined

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.callAI(bot, apiKeys, chatId, message)
      } catch (raw) {
        const err = raw instanceof AIError ? raw : classifyError(raw)
        lastError = err

        console.error(`[Bot:${bot.name}] Tentativa ${attempt}/${MAX_RETRIES} — ${err.kind}: ${err.message}`)

        // Erros terminais não melhoram com retry
        if (err.kind === 'config' || err.kind === 'quota') throw err

        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }

    throw lastError ?? new AIError('unknown', 'Falha após múltiplas tentativas.')
  }

  // ── AI dispatch ──────────────────────────────────────────────────────────

  private async callAI(
    bot: Bot,
    apiKeys: import('../models/database.js').ApiKeys,
    chatId: string,
    message: string,
  ): Promise<string> {
    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey)
        throw new AIError('config', 'Gemini API key não configurada.')
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

  // ── Emit AI error event ──────────────────────────────────────────────────

  private emitAIError(bot: Bot, err: AIError): void {
    const meta  = AI_ERROR_META[err.kind]
    const event: AIErrorEvent = {
      botId:   bot.id,
      botName: bot.name,
      kind:    err.kind,
      title:   meta.title,
      detail:  err.message,
      action:  meta.action,
    }
    this.aiErrorListeners.forEach(l => l(event))
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  //
  // answer=null → erro ocorreu. Persiste apenas a mensagem do usuário;
  // o histórico fica íntegro e o painel não mostra resposta do bot nesse turno.

  private async persistMessage(
    bot: Bot, from: string, message: string, answer: string | null,
  ): Promise<void> {
    const conversation = await db.upsertConversation({
      botId:         bot.id,
      userId:        bot.userId,
      contactName:   from,
      contactPhone:  from,
      lastMessage:   answer ?? message,
      lastMessageAt: new Date(),
      unreadCount:   1,
      messageCount:  1,
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