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
// CONSTANTES
// ═══════════════════════════════════════════════════════

const MAX_RETRIES            = 3
const MESSAGE_BUFFER_TIMEOUT = 3_000

// Tipos aceitos
const TEXT_TYPE   = 'chat'
const AUDIO_TYPES = new Set(['ptt', 'audio'])

// Tipos ignorados silenciosamente — body pode conter base64 pesado
const IGNORED_TYPES = new Set([
  'image', 'video', 'document', 'sticker',
  'location', 'contact', 'contact_card',
  'notification_template', 'e2e_notification',
  'call_log', 'protocol', 'revoked', 'unknown',
])

const AUDIO_FALLBACK_MESSAGES = {
  no_api_key:           '🎤 Recebi seu áudio! Configure uma chave de API (OpenAI ou Gemini) nas configurações para eu processar áudios.',
  transcription_failed: '🎤 Recebi seu áudio, mas tive dificuldade em processá-lo. Poderia enviar em texto? 😊',
  empty_audio:          '🎤 Recebi um áudio vazio. Por favor, tente novamente.',
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

        // ✅ FIX MEMÓRIA #1: Flags do Chromium otimizados para RAM limitada.
        //
        // REMOVIDO --single-process: causava instabilidade severa com leaks de
        // memória porque um vazamento em qualquer contexto comprometia o processo
        // inteiro. O Chromium ficava crescendo indefinidamente até o OOM killer
        // matar o processo.
        //
        // ADICIONADO flags de economia de memória:
        //   --disable-dev-shm-usage    → usa /tmp em vez de /dev/shm (evita crash no Railway)
        //   --disable-gpu              → desativa GPU (WhatsApp Web não precisa)
        //   --js-flags=--max-old-space-size=200 → limita heap V8 dentro do Chromium
        //   --memory-pressure-off      → desativa throttling por pressão de memória
        //   --disable-background-networking → para downloads em background
        //   --disable-default-apps     → não carrega apps padrão do Chrome
        //   --disable-sync             → desativa sincronização
        //   --disable-translate        → desativa tradutor
        //   --no-first-run             → pula setup inicial
        //   --disable-features=...     → desativa features que consomem memória

        puppeteerOptions: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            '--password-store=basic',
            '--use-mock-keychain',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
            '--js-flags=--max-old-space-size=150',
            `--user-data-dir=${sessionDir}`,
          ],
        },

        headless:       'new' as any,
        logQR:          false,
        // ✅ FIX MEMÓRIA #2: autoClose definido explicitamente como número positivo.
        // O wppconnect ignora autoClose: 0 e usa o default de 180s no modo QR,
        // mas com sessão conectada não fecha nunca.
        // Usando false para desabilitar completamente — o bot gerencia o ciclo de vida.
        autoClose:      false as any,
        disableWelcome: true,

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

      // ✅ FIX MEMÓRIA #3: Limpeza periódica de memória a cada 30 minutos.
      // O Chromium acumula cache de imagens de stories e grupos ao longo do tempo.
      // Forçar GC do Node.js + limpar buffers internos previne crescimento contínuo.
      this.scheduleMemoryCleanup(bot.id)
    } catch (err) {
      this.clients.delete(bot.id)
      this.qrWasShown.delete(bot.id)
      await db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
      throw err
    }
  }

  // ── Limpeza periódica de memória ─────────────────────────────────────────

  private memoryCleanupTimers = new Map<string, NodeJS.Timeout>()

  private scheduleMemoryCleanup(botId: string): void {
    const existing = this.memoryCleanupTimers.get(botId)
    if (existing) clearInterval(existing)

    // A cada 30 minutos, força o GC do Node.js e loga o uso de memória
    const timer = setInterval(() => {
      const used = process.memoryUsage()
      const mb   = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
      console.log(`[Memory] heapUsed:${mb(used.heapUsed)}MB | rss:${mb(used.rss)}MB | external:${mb(used.external)}MB`)

      // Força coleta de lixo se disponível (requer --expose-gc no Node)
      if (typeof (global as any).gc === 'function') {
        ;(global as any).gc()
        console.log('[Memory] GC forçado')
      }
    }, 30 * 60 * 1000) // 30 minutos

    this.memoryCleanupTimers.set(botId, timer)
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
          console.log(`[WhatsApp] 📱 Número: ${phone}`)
        } else {
          console.warn(`[WhatsApp] WID vazio para ${bot.name}:`, rawWid)
        }
      } else {
        console.warn(`[WhatsApp] getWid() sem retorno para ${bot.name}:`, rawWid)
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
    // Para o timer de limpeza de memória
    const cleanupTimer = this.memoryCleanupTimers.get(bot.id)
    if (cleanupTimer) { clearInterval(cleanupTimer); this.memoryCleanupTimers.delete(bot.id) }
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
    // Para o timer de limpeza de memória
    const cleanupTimer = this.memoryCleanupTimers.get(botId)
    if (cleanupTimer) { clearInterval(cleanupTimer); this.memoryCleanupTimers.delete(botId) }
    await db.updateBot(botId, { isConnected: false, isActive: false })
    setTimeout(() => nukeAllBotTokens(botId).catch(() => {}), 3000)
    console.log(`[WhatsApp] 🛑 Sessão parada: ${botId}`)
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
      const type   = String(message.type ?? '')
      const from   = String(message.from ?? '')
      const chatId = String(message.chatId ?? message.from ?? '')

      // ✅ FIX MEMÓRIA #4: Log compacto — NÃO imprime base64.
      // O base64 de imagens/vídeos pode ter milhares de chars. Imprimir no log
      // cria strings gigantes na heap do Node.js que demoram para ser coletadas.
      const bodyLen = String(message.body ?? '').length
      const bodyPreview = (IGNORED_TYPES.has(type) || AUDIO_TYPES.has(type))
        ? `[${type}:${bodyLen}b]`
        : String(message.body ?? '').slice(0, 50)

      console.log(`📩 [MSG] ${type}|${from.slice(0, 25)}|${bodyPreview}`)

      // ── Filtros básicos ───────────────────────────────────────────────────
      const isGroup  = message.isGroupMsg || from.includes('@g.us')
      const isStatus = from.includes('status@broadcast')

      if (isGroup || isStatus) return  // sem log extra para não poluir

      // ── Roteamento por type ───────────────────────────────────────────────
      if (AUDIO_TYPES.has(type)) {
        console.log(`   → 🎤 Áudio (${type})`)
        this.handleAudioMessage(bot, client, chatId, from, message)
          .catch(err => console.error(`[Audio] ERRO:`, err))
        return
      }

      if (IGNORED_TYPES.has(type)) return  // mídia — ignorar sem log

      if (type !== TEXT_TYPE) {
        console.log(`   → SKIP: tipo desconhecido "${type}"`)
        return
      }

      // ── Texto puro ────────────────────────────────────────────────────────
      const bodyText = String(message.body ?? '').trim()
      if (!bodyText) return

      console.log(`   → ✅ Texto: "${bodyText.slice(0, 60)}"`)
      this.bufferMessage(bot, client, chatId, bodyText, from)
    })
  }

  // ── Processamento de áudio ────────────────────────────────────────────────

  private async handleAudioMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    chatId: string, from: string, message: any,
  ): Promise<void> {
    const user = await db.findUserById(bot.userId)
    if (!user) return

    const freshBot = await db.findBotById(bot.id)
    if (!freshBot || !freshBot.isActive) return

    const mimeType: string = String(message.mimetype ?? message.mimeType ?? 'audio/ogg')
      .split(';')[0].trim()

    let audioBuffer: Buffer
    try {
      const decrypted = await client.decryptFile(message)
      audioBuffer = Buffer.isBuffer(decrypted) ? decrypted : Buffer.from(decrypted as any)
      console.log(`[Audio] ${(audioBuffer.length / 1024).toFixed(1)}KB | MIME:${mimeType}`)
    } catch (err) {
      console.error(`[Audio] decryptFile falhou:`, err)
      const bodyStr = String(message.body ?? '')
      if (bodyStr.length > 100) {
        try {
          audioBuffer = Buffer.from(bodyStr, 'base64')
        } catch (_) {
          await client.sendText(from, AUDIO_FALLBACK_MESSAGES.transcription_failed).catch(() => {})
          await this.persistMessage(bot, client, from, '🎤 [áudio não processado]', null)
          return
        }
      } else {
        await client.sendText(from, AUDIO_FALLBACK_MESSAGES.transcription_failed).catch(() => {})
        await this.persistMessage(bot, client, from, '🎤 [áudio não processado]', null)
        return
      }
    }

    const result = await transcribeAudio(audioBuffer, mimeType, user.apiKeys)

    // ✅ FIX MEMÓRIA #5: Libera o buffer de áudio explicitamente após transcrição.
    // Buffers grandes ficam na heap até o GC rodar. Com áudios frequentes,
    // podem se acumular causando crescimento contínuo da memória.
    audioBuffer = Buffer.alloc(0)  // substitui referência por buffer vazio

    if (!result.success) {
      const fallbackMsg = AUDIO_FALLBACK_MESSAGES[result.reason] ?? AUDIO_FALLBACK_MESSAGES.transcription_failed
      await client.sendText(from, fallbackMsg).catch(() => {})
      await this.persistMessage(bot, client, from, '🎤 [áudio não transcrito]', null)
      return
    }

    console.log(`[Audio] ✅ Transcrito: "${result.text.slice(0, 80)}"`)
    await this.processMessage(bot, client, chatId, result.text, from, `🎤 ${result.text}`)
  }

  // ── Buffer de texto ───────────────────────────────────────────────────────

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
        .catch(err => console.error(`[processMessage] ERRO:`, err))
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
    panelText?: string,
  ): Promise<void> {
    console.log(`🔄 [PROCESS] ${bot.name} | "${message.slice(0, 60)}"`)

    const user = await db.findUserById(bot.userId)
    if (!user) return

    const freshBot = await db.findBotById(bot.id)
    if (!freshBot) return

    if (!freshBot.isActive) return

    const stats = await db.getUserStats(bot.userId)
    if (isMessageLimitReached(user.plan, stats.totalMessages)) {
      const config = getPlanConfig(user.plan)
      this.planLimitListeners.forEach(l => l({
        botId: bot.id, userId: bot.userId, plan: user.plan,
        totalMessages: stats.totalMessages, messageLimit: config.messageLimit,
      }))
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

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

    if (conv && !conv.humanHandoff && detectsHandoffIntent(message)) {
      const updated = await db.setConversationHandoff(conv.id, true)
      if (updated) {
        this.pauseListeners.forEach(l => l({
          botId: bot.id, convId: updated.id, contactPhone: from,
          isPaused: true, humanHandoff: true, reason: 'human_handoff',
        }))
      }
      await client.sendText(from, '👤 Vou transferir você para um de nossos atendentes. Aguarde um momento!').catch(() => {})
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

    if (conv?.isPaused) {
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: true,
      }))
    }

    let answer: string
    try {
      answer = await this.callAIWithRetry(freshBot, user.apiKeys, chatId, message)
      console.log(`✅ IA respondeu: "${answer.slice(0, 60)}"`)
    } catch (raw) {
      const err = raw instanceof AIError ? raw : classifyError(raw)
      console.error(`❌ IA [${err.kind}]: ${err.message}`)
      this.emitAIError(bot, err)
      if (conv) {
        this.typingListeners.forEach(l => l({
          botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
        }))
      }
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
      }))
    }

    await this.persistMessage(bot, client, from, panelText ?? message, answer)
    await sendMessagesWithDelay(client, splitMessages(answer), from)
    console.log(`📤 Enviado para ${from.slice(0, 25)}`)
  }

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
    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId) {
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

  private async persistMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    from: string, userText: string, answer: string | null,
  ): Promise<void> {
    let contactName = from
    try {
      const contact = await Promise.race([
        client.getContact(from),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]) as any
      const pushname = contact?.pushname ?? contact?.name ?? contact?.formattedName
      if (pushname && pushname.trim()) contactName = pushname.trim()
    } catch (_) {}

    const conversation = await db.upsertConversation({
      botId: bot.id, userId: bot.userId,
      contactName, contactPhone: from,
      lastMessage: answer ?? userText,
      lastMessageAt: new Date(),
      unreadCount: 1, messageCount: 1,
    })

    await db.createMessage({ conversationId: conversation.id, role: 'user', content: userText })
    await db.updateBot(bot.id, { messageCount: bot.messageCount + 1 })

    if (answer !== null) {
      await db.createMessage({ conversationId: conversation.id, role: 'assistant', content: answer })
    }
  }
}

export const whatsappManager = new WhatsAppManager()
