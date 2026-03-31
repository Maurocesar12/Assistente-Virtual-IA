import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { transcribeAudio } from './audio.js'
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

function extractPhoneFromDevice(device: any): string | null {
  if (!device) return null
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
    const digits = str.split('@')[0].replace(/\D/g, '')
    if (digits.length >= 10) return digits
  }
  return null
}

// ═══════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════

const MAX_RETRIES         = 3
const MESSAGE_BUFFER_TIMEOUT = 3_000

// ✅ AUDIO: tipos de mensagem que contêm áudio do WhatsApp
// 'ptt' = push-to-talk (gravado no app)
// 'audio' = arquivo de áudio enviado
const AUDIO_TYPES = new Set(['ptt', 'audio'])

// Mensagens de fallback para o usuário quando o áudio não pode ser processado
const AUDIO_FALLBACK_MESSAGES = {
  no_api_key:          '🎤 Recebi seu áudio! Para que eu possa respondê-lo, você precisa configurar uma chave de API (OpenAI ou Gemini) nas configurações.',
  transcription_failed: '🎤 Recebi seu áudio, mas tive dificuldade em processá-lo. Poderia enviar sua mensagem em texto? 😊',
  empty_audio:         '🎤 Recebi um áudio vazio. Por favor, tente enviar novamente.',
}

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
        session: sessionName,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--no-zygote',
          '--single-process',
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

  private async onSessionConnectedAsync(bot: Bot, client: wppconnect.Whatsapp): Promise<void> {
    this.lastQR.delete(bot.id)
    await db.updateBot(bot.id, { isConnected: true, isActive: true }).catch(() => {})
    console.log(`[WhatsApp] ✅ Bot conectado: ${bot.name}`)

    let phone: string | null = null
    try {
      const rawWid = await client.getWid()
      if (rawWid && typeof rawWid === 'string') {
        const digits = rawWid.replace(/@.*$/, '').replace(/\D/g, '')
        if (digits) {
          phone = digits
          await db.updateBot(bot.id, { phone }).catch(() => {})
          console.log(`[WhatsApp] 📱 Número capturado para ${bot.name}: ${phone}`)
        } else {
          console.warn(`[WhatsApp] WID vazio para ${bot.name}. WID bruto:`, rawWid)
        }
      } else {
        console.warn(`[WhatsApp] getWid() sem retorno para ${bot.name}. Retorno:`, rawWid)
      }
    } catch (err) {
      console.warn(`[WhatsApp] Falha ao capturar número para ${bot.name}:`, err)
    }

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
    client.onMessage(async (message) => {
      console.log(`\n📩 [MSG RECEBIDA] Bot: ${bot.name}`)
      console.log(`   from:      ${message.from}`)
      console.log(`   chatId:    ${message.chatId}`)
      console.log(`   type:      ${message.type}`)
      console.log(`   isGroup:   ${message.isGroupMsg}`)
      console.log(`   body:      ${message.body ?? '(vazio)'}`)

      // Filtros de segurança
      const isGroup  = message.isGroupMsg || String(message.from).includes('@g.us')
      const isStatus = String(message.from).includes('status@broadcast')

      if (isGroup || isStatus) {
        console.log(`   → SKIP: grupo ou status`)
        return
      }

      const chatId = String(message.chatId ?? message.from)
      const from   = String(message.from)
      const type   = String(message.type)

      // ── ✅ ÁUDIO: ptt (gravado no app) ou audio (arquivo enviado) ──────────
      if (AUDIO_TYPES.has(type)) {
        console.log(`   → 🎤 Mensagem de áudio detectada! Iniciando transcrição...`)
        // Processamento de áudio é assíncrono e direto (sem buffer de texto)
        this.handleAudioMessage(bot, client, chatId, from, message)
          .catch(err => console.error(`[Bot:${bot.name}] handleAudioMessage ERRO:`, err))
        return
      }

      // ── Texto normal ─────────────────────────────────────────────────────
      if (!message.body || !message.body.trim()) {
        console.log(`   → SKIP: mensagem sem corpo de texto`)
        return
      }

      console.log(`   → ✅ Texto válido! Enviando para buffer...`)
      this.bufferMessage(bot, client, chatId, message.body, from)
    })
  }

  // ── ✅ NOVO: Processamento de áudio ──────────────────────────────────────

  private async handleAudioMessage(
    bot: Bot,
    client: wppconnect.Whatsapp,
    chatId: string,
    from: string,
    message: any,
  ): Promise<void> {
    // Busca user e bot frescos para ter as apiKeys
    const user = await db.findUserById(bot.userId)
    if (!user) return

    const freshBot = await db.findBotById(bot.id)
    if (!freshBot || !freshBot.isActive) {
      console.log(`[Audio] Bot inativo — áudio ignorado`)
      return
    }

    // Determina o MIME type do áudio
    // wppconnect expõe mimetype na mensagem quando disponível
    const mimeType: string = (message.mimetype ?? message.mimeType ?? 'audio/ogg')
      .split(';')[0]  // remove sufixos como "; codecs=opus"
      .trim()

    console.log(`[Audio] MIME detectado: "${mimeType}"`)

    // Baixa o arquivo de áudio como Buffer
    let audioBuffer: Buffer
    try {
      console.log(`[Audio] Baixando áudio via decryptFile...`)
      const decrypted = await client.decryptFile(message)
      audioBuffer = Buffer.isBuffer(decrypted) ? decrypted : Buffer.from(decrypted as any)
      console.log(`[Audio] ✅ Buffer obtido: ${(audioBuffer.length / 1024).toFixed(1)}KB`)
    } catch (err) {
      console.error(`[Audio] ❌ Falha ao baixar áudio:`, err)
      // Tenta usar base64 embutido na mensagem como fallback
      if (message.body && message.body.length > 100) {
        try {
          audioBuffer = Buffer.from(message.body, 'base64')
          console.log(`[Audio] Usando base64 embutido: ${(audioBuffer.length / 1024).toFixed(1)}KB`)
        } catch (_) {
          await client.sendText(from, AUDIO_FALLBACK_MESSAGES.transcription_failed).catch(() => {})
          await this.persistAudioMessage(bot, client, from, '🎤 [áudio não processado]', null)
          return
        }
      } else {
        await client.sendText(from, AUDIO_FALLBACK_MESSAGES.transcription_failed).catch(() => {})
        await this.persistAudioMessage(bot, client, from, '🎤 [áudio não processado]', null)
        return
      }
    }

    // Transcreve o áudio
    const result = await transcribeAudio(audioBuffer, mimeType, user.apiKeys)

    if (!result.success) {
      console.warn(`[Audio] Transcrição falhou: ${result.reason}`)
      const fallbackMsg = AUDIO_FALLBACK_MESSAGES[result.reason] ?? AUDIO_FALLBACK_MESSAGES.transcription_failed
      await client.sendText(from, fallbackMsg).catch(() => {})
      // Persiste no histórico como áudio não transcrito
      await this.persistAudioMessage(bot, client, from, '🎤 [áudio não transcrito]', null)
      return
    }

    const transcribedText = result.text
    console.log(`[Audio] ✅ Texto transcrito: "${transcribedText}"`)

    // Passa o texto transcrito para o buffer com prefixo visual
    // O prefixo "🎤 " aparece no painel mas a IA recebe o texto puro
    const textForBuffer = transcribedText
    const textForPanel  = `🎤 ${transcribedText}`

    // Envia diretamente para processMessage (sem buffer — áudio é único por natureza)
    await this.processMessage(bot, client, chatId, textForBuffer, from, textForPanel)
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

    console.log(`[Buffer:${bot.name}] "${body}" adicionado. Total: ${buffer.length}. Timer: ${MESSAGE_BUFFER_TIMEOUT}ms`)

    const timer = setTimeout(() => {
      const combined = (this.messageBuffers.get(chatId) ?? []).join(' \n ')
      this.messageBuffers.delete(chatId)
      this.messageTimers.delete(chatId)
      console.log(`[Buffer:${bot.name}] Timer disparou. Processando: "${combined}"`)
      this.processMessage(bot, client, chatId, combined, from)
        .catch(err => console.error(`[Bot:${bot.name}] processMessage ERRO FATAL:`, err))
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
  // panelText: texto exibido no painel/histórico (pode ser diferente do que vai para IA)
  // Se não passado, usa o mesmo `message` para ambos

  private async processMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, message: string, from: string,
    panelText?: string,
  ): Promise<void> {
    console.log(`\n🔄 [PROCESS] Bot: ${bot.name} | chatId: ${chatId} | msg: "${message}"`)

    const user = await db.findUserById(bot.userId)
    if (!user) {
      console.error(`[PROCESS] ❌ Usuário ${bot.userId} não encontrado no banco!`)
      return
    }

    const freshBot = await db.findBotById(bot.id)
    if (!freshBot) {
      console.error(`[PROCESS] ❌ Bot ${bot.id} não encontrado no banco!`)
      return
    }

    console.log(`[PROCESS] Estado: isActive=${freshBot.isActive} | model=${freshBot.model}`)

    if (!freshBot.isActive) {
      console.warn(`[PROCESS] ⚠️ Bot INATIVO — mensagem ignorada.`)
      return
    }

    // ── Plan limit check ──────────────────────────────────────────────────
    const stats = await db.getUserStats(bot.userId)
    if (isMessageLimitReached(user.plan, stats.totalMessages)) {
      const config = getPlanConfig(user.plan)
      console.warn(`[PROCESS] 🚫 Limite de plano atingido (${stats.totalMessages}/${config.messageLimit})`)
      this.planLimitListeners.forEach(l => l({
        botId: bot.id, userId: bot.userId, plan: user.plan,
        totalMessages: stats.totalMessages, messageLimit: config.messageLimit,
      }))
      await this.persistAudioMessage(bot, client, from, panelText ?? message, null)
      return
    }

    // ── Feature 2: intervenção manual do operador ─────────────────────────
    if (freshBot.phone && from === freshBot.phone) {
      const targetConv = await db.findConversationByBotAndPhone(bot.id, chatId)
      if (targetConv && !targetConv.isPaused) {
        const updated = await db.setConversationPaused(targetConv.id, true)
        if (updated) {
          this.pauseListeners.forEach(l => l({
            botId: bot.id, convId: updated.id, contactPhone: chatId,
            isPaused: true, humanHandoff: false, reason: 'manual_override',
          }))
        }
      }
      return
    }

    const conv = await db.findConversationByBotAndPhone(bot.id, from)
    console.log(`[PROCESS] Conversa: ${conv ? conv.id : 'nova'}`)

    // ── Feature 3: Human Handoff ──────────────────────────────────────────
    if (conv && !conv.humanHandoff && detectsHandoffIntent(message)) {
      const updated = await db.setConversationHandoff(conv.id, true)
      if (updated) {
        this.pauseListeners.forEach(l => l({
          botId: bot.id, convId: updated.id, contactPhone: from,
          isPaused: true, humanHandoff: true, reason: 'human_handoff',
        }))
      }
      await client.sendText(from, '👤 Vou transferir você para um de nossos atendentes. Aguarde um momento!').catch(() => {})
      await this.persistAudioMessage(bot, client, from, panelText ?? message, null)
      return
    }

    // ── Feature 2: bot pausado ────────────────────────────────────────────
    if (conv?.isPaused) {
      console.log(`[PROCESS] Bot pausado — mensagem salva sem resposta.`)
      await this.persistAudioMessage(bot, client, from, panelText ?? message, null)
      return
    }

    // ── Typing indicator ──────────────────────────────────────────────────
    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: true,
      }))
    }

    // ── Chamada da IA ─────────────────────────────────────────────────────
    console.log(`[PROCESS] 🤖 Chamando IA (model: ${freshBot.model})...`)

    let answer: string
    try {
      answer = await this.callAIWithRetry(freshBot, user.apiKeys, chatId, message)
      console.log(`[PROCESS] ✅ IA respondeu: "${answer.slice(0, 80)}..."`)
    } catch (raw) {
      const err = raw instanceof AIError ? raw : classifyError(raw)
      console.error(`[PROCESS] ❌ IA falhou [${err.kind}]: ${err.message}`)
      this.emitAIError(bot, err)
      if (conv) {
        this.typingListeners.forEach(l => l({
          botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
        }))
      }
      await this.persistAudioMessage(bot, client, from, panelText ?? message, null)
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
      }))
    }

    // Persiste com o texto do painel (ex: "🎤 texto transcrito")
    await this.persistAudioMessage(bot, client, from, panelText ?? message, answer)
    console.log(`[PROCESS] 📤 Enviando resposta para ${from}...`)
    await sendMessagesWithDelay(client, splitMessages(answer), from)
    console.log(`[PROCESS] ✅ Resposta enviada!`)
  }

  // ── AI with retry ────────────────────────────────────────────────────────

  private async callAIWithRetry(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<string> {
    let lastError: AIError | undefined
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[AI] Tentativa ${attempt}/${MAX_RETRIES} — model: ${bot.model}`)
        return await this.callAI(bot, apiKeys, chatId, message)
      } catch (raw) {
        const err = raw instanceof AIError ? raw : classifyError(raw)
        lastError = err
        console.error(`[AI] Tentativa ${attempt} falhou [${err.kind}]: ${err.message}`)
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
    console.log(`[AI] model: ${bot.model} | geminiKey: ${apiKeys.geminiKey ? '✓' : '✗'} | openaiKey: ${apiKeys.openaiKey ? '✓' : '✗'}`)

    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey) throw new AIError('config', 'Gemini API key não configurada.')
      return geminiManager.sendMessage(chatId, message, {
        apiKey: apiKeys.geminiKey, model: bot.model, systemPrompt: bot.prompt,
      })
    }
    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId) {
      console.error(`[AI] OpenAI: key=${apiKeys.openaiKey ? 'ok' : 'FALTANDO'} | assistantId=${apiKeys.openaiAssistantId ? 'ok' : 'FALTANDO'}`)
      throw new AIError('config', 'Credenciais OpenAI não configuradas.')
    }
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

  // ── persistAudioMessage: versão unificada de persistMessage ──────────────
  // Aceita qualquer texto para o campo user (texto normal ou "🎤 transcrito")

  private async persistAudioMessage(
    bot: Bot,
    client: wppconnect.Whatsapp,
    from: string,
    userText: string,   // o que aparece no painel como mensagem do usuário
    answer: string | null,
  ): Promise<void> {
    let contactName = from
    try {
      const contact = await Promise.race([
        client.getContact(from),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]) as any
      const pushname = contact?.pushname ?? contact?.name ?? contact?.formattedName
      if (pushname && pushname.trim()) contactName = pushname.trim()
    } catch (err) {
      console.warn(`[PERSIST] getContact timeout para ${from}`)
    }

    const conversation = await db.upsertConversation({
      botId:         bot.id,
      userId:        bot.userId,
      contactName,
      contactPhone:  from,
      lastMessage:   answer ?? userText,
      lastMessageAt: new Date(),
      unreadCount:   1,
      messageCount:  1,
    })

    await db.createMessage({
      conversationId: conversation.id,
      role:           'user',
      content:        userText,
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

  // Mantém alias para compatibilidade com chamadas de texto puro
  private async persistMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    from: string, message: string, answer: string | null,
  ): Promise<void> {
    return this.persistAudioMessage(bot, client, from, message, answer)
  }
}

export const whatsappManager = new WhatsAppManager()