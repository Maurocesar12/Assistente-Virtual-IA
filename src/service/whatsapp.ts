import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'
import { isMessageLimitReached, getPlanConfig } from '../utils/planLimits.js'

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

export interface BotPauseEvent {
  botId:        string
  convId:       string
  contactPhone: string
  isPaused:     boolean
  humanHandoff: boolean
  reason:       'manual_override' | 'human_handoff' | 'resumed'
}

export interface TypingEvent {
  botId:        string
  convId:       string
  contactPhone: string
  isTyping:     boolean
}

export interface ContactTypingEvent {
  botId:        string
  contactPhone: string
  isTyping:     boolean
}

export interface PlanLimitEvent {
  botId:         string
  userId:        string
  plan:          string
  totalMessages: number
  messageLimit:  number
}

type QRListener            = (e: QRCodeEvent)        => void
type SessionListener       = (e: SessionEvent)       => void
type AIErrorListener       = (e: AIErrorEvent)       => void
type PauseListener         = (e: BotPauseEvent)      => void
type TypingListener        = (e: TypingEvent)        => void
type ContactTypingListener = (e: ContactTypingEvent) => void
type PlanLimitListener     = (e: PlanLimitEvent)     => void

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
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Extrai o número de telefone do objeto device retornado por getHostDevice().
 * wppconnect pode retornar estruturas diferentes dependendo da versão:
 *   - device.wid.user          (mais comum)
 *   - device.wid._serialized   ("5511...@c.us")
 *   - device.id._serialized    (versões antigas)
 *   - device.id.user
 *   - device.me.user
 *   - device.jid
 */
function extractPhoneFromDevice(device: any): string | null {
  if (!device) return null

  // Tenta todos os campos conhecidos, nessa ordem de prioridade
  const candidates = [
    device?.wid?.user,
    device?.wid?._serialized,
    device?.id?.user,
    device?.id?._serialized,
    device?.me?.user,
    device?.jid,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    const str = String(candidate).trim()
    if (!str) continue
    // Extrai só os dígitos antes de "@" — descarta sufixo "@c.us"
    const digits = str.split('@')[0].replace(/\D/g, '')
    if (digits.length >= 10) return digits  // mínimo DDD + 8 dígitos
  }

  return null
}

// ═══════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 15_000

const CONFIRMED_CONNECTED_STATUSES = new Set(['inChat'])
const MAYBE_CONNECTED_STATUSES     = new Set(['isLogged'])
const FAILED_STATUSES              = new Set([
  'browserClose', 'qrReadError', 'autocloseCalled',
  'desconnectedMobile', 'disconnected', 'notLogged', 'deleteToken',
])

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
  private qrWasShown     = new Map<string, boolean>()

  private qrListeners:            QRListener[]            = []
  private sessionListeners:       SessionListener[]       = []
  private aiErrorListeners:       AIErrorListener[]       = []
  private pauseListeners:         PauseListener[]         = []
  private typingListeners:        TypingListener[]        = []
  private contactTypingListeners: ContactTypingListener[] = []
  private planLimitListeners:     PlanLimitListener[]     = []

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

  onContactTyping(l: ContactTypingListener): () => void {
    this.contactTypingListeners.push(l)
    return () => { this.contactTypingListeners = this.contactTypingListeners.filter(x => x !== l) }
  }

  onPlanLimit(l: PlanLimitListener): () => void {
    this.planLimitListeners.push(l)
    return () => { this.planLimitListeners = this.planLimitListeners.filter(x => x !== l) }
  }

  emitBotPause(event: Parameters<PauseListener>[0]): void {
    this.pauseListeners.forEach(l => l(event))
  }

  // ── Session management ───────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id)) return

    console.log(`[WhatsApp] Iniciando sessão para: ${bot.name} (id: ${bot.id})`)
    this.qrWasShown.delete(bot.id)
    this.lastQR.delete(bot.id)
    await nukeAllBotTokens(bot.id)

    const sessionName = `zapgpt_${bot.id}_${Date.now()}`
    const sessionDir  = path.join(TOKENS_DIR, sessionName)

    try {
      const sessionPromise = wppconnect.create({
        session:        sessionName,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // O MAIS IMPORTANTE: Impede o crash por falta de memória compartilhada
          '--disable-extensions',
          '--no-zygote',
          '--single-process' // Faz o navegador usar apenas um processo, economizando RAM
        ],
        headless:       'new' as any,
        logQR:          false,
        autoClose:      0,
        disableWelcome: true,
        puppeteerOptions: {
          args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--disable-extensions', `--user-data-dir=${sessionDir}`,
          ],
        },

        catchQR: (base64Qr: string, asciiQR: string) => {
          this.qrWasShown.set(bot.id, true)
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach(l => l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR }))
          console.log(`[WhatsApp] QR gerado para: ${bot.name}`)
        },

        statusFind: (status: string) => {
          console.log(`[WhatsApp] Status [${bot.name}]: ${status}`)
          this.sessionListeners.forEach(l => l({ botId: bot.id, status }))

          if (CONFIRMED_CONNECTED_STATUSES.has(status)) {
            // ✅ Chama versão async — captura phone ANTES de emitir evento SSE final
            sessionPromise.then((resolvedClient) => {
              this.onSessionConnectedAsync(bot, resolvedClient).catch(err =>
                console.error(`[WhatsApp] onSessionConnectedAsync error:`, err)
              )
            })
            return
          }
          
          if (MAYBE_CONNECTED_STATUSES.has(status)) {
            if (this.qrWasShown.get(bot.id) === true) {
              sessionPromise.then((resolvedClient) => {
                this.onSessionConnectedAsync(bot, resolvedClient).catch(err =>
                  console.error(`[WhatsApp] onSessionConnectedAsync error:`, err)
                )
              })
            } else {
              console.warn(`[WhatsApp] 'isLogged' sem QR para ${bot.name} — forçando reset`)
              this.onSessionFailed(bot)
            }
            return
          }

          if (FAILED_STATUSES.has(status)) {
            this.onSessionFailed(bot)
          }
        },
      })
      const client = await sessionPromise

      this.clients.set(bot.id, client)
      this.attachMessageListener(bot, client)
      this.attachPresenceListener(bot, client)
    } catch (err) {
      this.clients.delete(bot.id)
      this.qrWasShown.delete(bot.id)
      await db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
      throw err
    }
  }

  /**
   * ✅ FIX: versão async de onSessionConnected.
   *
   * ANTES: getHostDevice() era chamado com .then() fire-and-forget.
   * O evento 'bot' SSE era emitido no statusFind, ANTES do getHostDevice completar.
   * O frontend recebia phone=null mesmo após o bot conectar.
   *
   * AGORA: esperamos o getHostDevice(), salvamos o phone no DB,
   * depois emitimos o evento SSE com o bot já atualizado (incluindo phone).
   */
private async onSessionConnectedAsync(bot: Bot, client: wppconnect.Whatsapp): Promise<void> {
    this.lastQR.delete(bot.id)

    // 1. Marca como conectado imediatamente (sem phone ainda)
    await db.updateBot(bot.id, { isConnected: true, isActive: true }).catch(() => {})
    console.log(`[WhatsApp] ✅ Bot conectado: ${bot.name}`)
      
    // 2. Captura o número do bot com fallbacks robustos
    let phone: string | null = null
    try {
      // CORREÇÃO 1: Nome da variável ajustado para rawWid (sem 'n')
      let rawWid = await client.getWid() 
      
      if (rawWid && typeof rawWid === 'string') {
        // Limpa tudo, tirando o "@c.us" e deixando apenas números
        const digits = rawWid.replace(/@.*$/, '').replace(/\D/g, '');

        if (digits) {
          phone = digits; // Salva LIMPO, sem @c.us (fundamental para o Front-end não quebrar)
          await db.updateBot(bot.id, { phone }).catch(() => {})
          console.log(`[WhatsApp] 📱 Número capturado para ${bot.name}: ${phone}`)  
        } else {
          // CORREÇÃO 2: Removida a chamada à variável 'device', pois ela não existe mais aqui
          console.warn(`[WhatsApp] O WID estava vazio ou inválido para ${bot.name}. WID bruto:`, rawWid)
        }
      } else {
        console.warn(`[WhatsApp] wppconnect não retornou o WID para ${bot.name}. Retorno bruto:`, rawWid)
      }

    } catch (err) {
      console.warn(`[WhatsApp] Falha ao capturar o número para ${bot.name}:`, err)
    }
    
    // 3. Emite sessionListeners com 'connected_with_phone' para que o SSE
    //    do bots.ts busque o bot ATUALIZADO (já com phone) e envie ao frontend.
    //    Usamos um status especial que o bots.ts reconhece.
    this.sessionListeners.forEach(l => l({ botId: bot.id, status: 'connected_with_phone' }))
  }

  private onSessionFailed(bot: Bot): void {
    this.lastQR.delete(bot.id)
    this.qrWasShown.delete(bot.id)
    this.clients.delete(bot.id)
    setTimeout(() => nukeAllBotTokens(bot.id).catch(() => {}), 3000)
    db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
    console.log(`[WhatsApp] ❌ Sessão encerrada/falhou: ${bot.name}`)
  }

  async stopSession(botId: string): Promise<void> {
    const client = this.clients.get(botId)
    if (client) { try { await client.close() } catch (_) {} }
    this.clients.delete(botId)
    this.lastQR.delete(botId)
    this.qrWasShown.delete(botId)
    this.clearMessageBuffer(botId)
    await db.updateBot(botId, { isConnected: false, isActive: false })
    setTimeout(() => nukeAllBotTokens(botId).catch(() => {}), 3000)
    console.log(`[WhatsApp] 🛑 Sessão parada manualmente: ${botId}`)
  }

  isRunning(botId: string): boolean { return this.clients.has(botId) }

  async resumeBot(botId: string, convId: string): Promise<void> {
    await db.setConversationHandoff(convId, false)
    const conv = await db.findConversationById(convId)
    if (!conv) return
    this.pauseListeners.forEach(l => l({
      botId, convId, contactPhone: conv.contactPhone,
      isPaused: false, humanHandoff: false, reason: 'resumed',
    }))
  }

  private attachPresenceListener(bot: Bot, client: wppconnect.Whatsapp): void {
    try {
      client.onPresenceChanged((presence: any) => {
        const contactPhone = presence?.id?._serialized ?? presence?.chatId
        if (!contactPhone) return
        db.findBotById(bot.id).then(freshBot => {
          if (freshBot?.phone && contactPhone === freshBot.phone) return
          const isTyping = presence.type === 'composing' || presence.type === 'recording'
          this.contactTypingListeners.forEach(l => l({ botId: bot.id, contactPhone, isTyping }))
        }).catch(() => {})
      })
    } catch (err) {
      console.warn(`[WhatsApp] onPresenceChanged não disponível para ${bot.name}:`, err)
    }
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

  private async processMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, message: string, from: string,
  ): Promise<void> {
    const user = await db.findUserById(bot.userId)
    if (!user) return

    // Busca estado fresco do bot — única query, usada em todas as verificações abaixo
    const freshBot = await db.findBotById(bot.id)
    if (!freshBot) return

    // ✅ Respeita isActive — bot desativado no painel não responde
    if (!freshBot.isActive) {
      console.log(`[Bot:${freshBot.name}] Mensagem ignorada — bot desativado (isActive=false)`)
      return
    }

    // ── Plan limit check ──────────────────────────────────────────────────
    const stats = await db.getUserStats(bot.userId)
    if (isMessageLimitReached(user.plan, stats.totalMessages)) {
      const config = getPlanConfig(user.plan)
      console.warn(`[Bot:${freshBot.name}] Limite de plano atingido (${stats.totalMessages}/${config.messageLimit})`)
      this.planLimitListeners.forEach(l => l({
        botId: bot.id, userId: bot.userId, plan: user.plan,
        totalMessages: stats.totalMessages, messageLimit: config.messageLimit,
      }))
      await this.persistMessage(bot, client, from, message, null)
      return
    }

    // ── Feature 2: detecta intervenção manual do operador ────────────────
    if (freshBot.phone && from === freshBot.phone) {
      const targetConv = await db.findConversationByBotAndPhone(bot.id, chatId)
      if (targetConv && !targetConv.isPaused) {
        const updated = await db.setConversationPaused(targetConv.id, true)
        if (updated) {
          this.pauseListeners.forEach(l => l({
            botId: bot.id, convId: updated.id, contactPhone: chatId,
            isPaused: true, humanHandoff: false, reason: 'manual_override',
          }))
          console.log(`[Bot:${freshBot.name}] Override manual — bot pausado para: ${chatId}`)
        }
      }
      return
    }

    const conv = await db.findConversationByBotAndPhone(bot.id, from)

    // ── Feature 3: Human Handoff intent ───────────────────────────────────
    if (conv && !conv.humanHandoff && detectsHandoffIntent(message)) {
      const updated = await db.setConversationHandoff(conv.id, true)
      if (updated) {
        this.pauseListeners.forEach(l => l({
          botId: bot.id, convId: updated.id, contactPhone: from,
          isPaused: true, humanHandoff: true, reason: 'human_handoff',
        }))
      }
      await client.sendText(from, '👤 Vou transferir você para um de nossos atendentes. Aguarde um momento!').catch(() => {})
      await this.persistMessage(bot, client, from, message, null)
      return
    }

    // ── Feature 2: bot pausado ────────────────────────────────────────────
    if (conv?.isPaused) {
      await this.persistMessage(bot, client, from, message, null)
      return
    }

    // ── Feature 4: Typing indicator ───────────────────────────────────────
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
      console.error(`[Bot:${freshBot.name}] AI error [${err.kind}]: ${err.message}`)
      this.emitAIError(bot, err)
      if (conv) {
        this.typingListeners.forEach(l => l({
          botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
        }))
      }
      await this.persistMessage(bot, client, from, message, null)
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
      }))
    }

    await this.persistMessage(bot, client, from, message, answer)
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
    bot: Bot,
    client: wppconnect.Whatsapp,
    from: string,
    message: string,
    answer: string | null,
  ): Promise<void> {
    let contactName = from
    try {
      const contact = await client.getContact(from)
      const pushname = contact?.pushname ?? contact?.name ?? contact?.formattedName
      if (pushname && pushname.trim()) contactName = pushname.trim()
    } catch (_) {}

    const userCreatedAt = new Date()

    const conversation = await db.upsertConversation({
      botId:         bot.id,
      userId:        bot.userId,
      contactName,
      contactPhone:  from,
      lastMessage:   answer ?? message,
      lastMessageAt: new Date(),
      unreadCount:   1,
      messageCount:  1,
    })

    await db.createMessage({
      conversationId: conversation.id,
      role:           'user',
      content:        message,
    })

    await db.updateBot(bot.id, { messageCount: bot.messageCount + 1 })

    if (answer !== null) {
      await db.createMessage({
        conversationId: conversation.id,
        role:           'assistant',
        content:        answer,
      })
    }
  }
}

export const whatsappManager = new WhatsAppManager()