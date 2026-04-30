/**
 * whatsapp.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import wppconnect from '@wppconnect-team/wppconnect'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, type Bot, type Conversation, type User } from '../models/database.js'
import { geminiManager } from './gemini.js'
import { openaiManager } from './openai.js'
import { transcribeAudio } from './audio.js'
import { calendarConfirmation, tryScheduleCalendarEvent } from './calendarAutomation.js'
import { splitMessages, sendMessagesWithDelay } from '../utils/messages.js'
import { isMessageLimitReached, getPlanConfig } from '../utils/planLimits.js'
import type { AITextResponse, AIUsage } from '../utils/tokenUsage.js'
import { buildKnowledgeContext } from '../utils/knowledgeContext.js'

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

export interface QRCodeEvent      { botId: string; qrBase64: string; qrAscii: string }
export interface SessionEvent     { botId: string; status: string }
export interface AIErrorEvent     { botId: string; botName: string; kind: AIErrorKind; title: string; detail: string; action: string }
export interface BotPauseEvent {
  botId: string; convId: string; contactPhone: string
  isPaused: boolean; humanHandoff: boolean
  reason: 'manual_override' | 'human_handoff' | 'resumed'
}
export interface TypingEvent        { botId: string; convId: string; contactPhone: string; isTyping: boolean }
export interface ContactTypingEvent { botId: string; contactPhone: string; isTyping: boolean }
export interface PlanLimitEvent     { botId: string; userId: string; plan: string; totalMessages: number; messageLimit: number }

type QRListener            = (e: QRCodeEvent)        => void
type SessionListener       = (e: SessionEvent)       => void
type AIErrorListener       = (e: AIErrorEvent)       => void
type PauseListener         = (e: BotPauseEvent)      => void
type TypingListener        = (e: TypingEvent)        => void
type ContactTypingListener = (e: ContactTypingEvent) => void
type PlanLimitListener     = (e: PlanLimitEvent)     => void

const AI_ERROR_META: Record<AIErrorKind, { title: string; action: string }> = {
  config:  { title: 'Chave de API invalida', action: 'Abra Configuracoes > API Keys e revise as credenciais.' },
  quota:   { title: 'Creditos da IA esgotados', action: 'Adicione creditos/tokens na OpenAI ou Gemini e reative o bot.' },
  network: { title: 'Falha de rede com a IA', action: 'Aguarde alguns minutos e tente novamente.' },
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
const CONTACT_FETCH_TIMEOUT  = 3_000  // reduzido de 5s → economiza tempo em contatos sem pushname
const MAX_LISTENERS          = 50     // proteção contra memory leak de arrays de listeners SSE
const MAX_AUDIO_BYTES        = 10 * 1024 * 1024

const TEXT_TYPE   = 'chat'
const AUDIO_TYPES = new Set(['ptt', 'audio'])

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
  'browserClose', 'qrReadError', 'autocloseCalled', 'disconnected', 'deleteToken',
])

// ═══════════════════════════════════════════════════════
// FLAGS DO CHROMIUM — otimizadas para servidor com RAM limitada
// ═══════════════════════════════════════════════════════

/**
 * Flags do Chromium para baixo consumo de memória em ambiente de servidor.
 *
 * FLAGS REMOVIDAS (causavam quebra silenciosa do onMessage):
 *   --single-process         → interfere no IPC do Puppeteer; page.exposeFunction
 *                              para de entregar callbacks para o Node.js
 *   --disable-notifications  → bloqueia o canal de notificações interno usado pelo
 *                              wppconnect para disparar eventos de nova mensagem
 *   --disable-permissions-api → idem; impede que a página solicite permissões
 *                              de notificação necessárias para o listener funcionar
 *   IsolateOrigins           → conflitava com --single-process removido
 *
 * Economia de RAM mantida: ~200-250MB vs. configuração padrão do wppconnect.
 */
const CHROMIUM_LOW_MEMORY_ARGS: string[] = [
  // Sandbox
  '--no-sandbox',
  '--disable-setuid-sandbox',

  // Limite de processos renderer (sem --single-process que quebra IPC do Puppeteer)
  '--renderer-process-limit=1',

  // Heap V8 interno do Chromium
  '--js-flags=--max-old-space-size=250',

  // GPU — WhatsApp Web não usa aceleração gráfica
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-gpu-rasterization',
  '--disable-gpu-sandbox',
  '--ignore-gpu-blocklist',

  // /dev/shm — crítico em containers Linux sem tmpfs adequado (Railway, Render)
  '--disable-dev-shm-usage',

  // Cache zerado — evita uso de disco e RAM desnecessários
  '--disable-cache',
  '--disable-application-cache',
  '--disable-offline-load-stale-cache',
  '--disk-cache-size=0',
  '--media-cache-size=0',
  '--aggressive-cache-discard',

  // Features pesadas sem impacto no recebimento de mensagens
  '--disable-extensions',
  '--disable-plugins',
  '--disable-plugins-discovery',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-domain-reliability',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-speech-api',
  '--disable-sync',
  '--disable-translate',

  // Features do Blink (sem IsolateOrigins — conflitava com single-process removido)
  '--disable-features=TranslateUI,BlinkGenPropertyTrees,AudioServiceOutOfProcess,MediaRouter,DialMediaRouteProvider',

  // UX sem impacto funcional no WhatsApp Web
  '--hide-scrollbars',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--password-store=basic',
  '--use-mock-keychain',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
]

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
  private starting       = new Set<string>()
  private connectedOnce  = new Set<string>()
  private messageBuffers = new Map<string, string[]>()
  private messageTimers  = new Map<string, NodeJS.Timeout>()
  private botOutboundMessages = new Map<string, Map<string, number>>()
  private lastQR         = new Map<string, { qrBase64: string; qrAscii: string }>()
  private qrWasShown     = new Map<string, boolean>()

  private qrListeners:            QRListener[]            = []
  private sessionListeners:       SessionListener[]       = []
  private aiErrorListeners:       AIErrorListener[]       = []
  private pauseListeners:         PauseListener[]         = []
  private typingListeners:        TypingListener[]        = []
  private contactTypingListeners: ContactTypingListener[] = []
  private planLimitListeners:     PlanLimitListener[]     = []

  // ── Registro de listeners — usa splice por índice (O(1) na remoção) ─────

  /**
   * Adiciona listener e retorna função de remoção eficiente (splice por índice,
   * não cria novo array como filter).
   * Cap de MAX_LISTENERS protege contra leaks quando SSEs são abertas/fechadas
   * sem cleanup correto (ex: browser refresca a tab repetidamente).
   */
  private addListener<T>(arr: T[], l: T): () => void {
    arr.push(l)
    if (arr.length > MAX_LISTENERS) {
      console.warn(`[WhatsApp] listener array atingiu ${arr.length} — verificar leak de SSE`)
      arr.splice(0, arr.length - MAX_LISTENERS) // descarta os mais antigos
    }
    return () => {
      const idx = arr.indexOf(l)
      if (idx >= 0) arr.splice(idx, 1)
    }
  }

  onQRCode(l: QRListener): () => void              { return this.addListener(this.qrListeners, l) }
  onSessionUpdate(l: SessionListener): () => void   { return this.addListener(this.sessionListeners, l) }
  onAIError(l: AIErrorListener): () => void          { return this.addListener(this.aiErrorListeners, l) }
  onBotPause(l: PauseListener): () => void            { return this.addListener(this.pauseListeners, l) }
  onTyping(l: TypingListener): () => void              { return this.addListener(this.typingListeners, l) }
  onContactTyping(l: ContactTypingListener): () => void { return this.addListener(this.contactTypingListeners, l) }
  onPlanLimit(l: PlanLimitListener): () => void          { return this.addListener(this.planLimitListeners, l) }

  onQRCodeForBot(botId: string, l: QRListener): () => void {
    const unsub  = this.addListener(this.qrListeners, l)
    const cached = this.lastQR.get(botId)
    if (cached) setTimeout(() => l({ botId, ...cached }), 50)
    return unsub
  }

  emitBotPause(event: Parameters<PauseListener>[0]): void {
    this.pauseListeners.forEach(l => l(event))
  }

  private outboundKey(botId: string, contactPhone: string): string {
    return `${botId}:${contactPhone}`
  }

  private normalizeOutboundText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  private markBotOutbound(botId: string, contactPhone: string, text: string): void {
    const normalized = this.normalizeOutboundText(text)
    if (!normalized) return

    const key = this.outboundKey(botId, contactPhone)
    const bucket = this.botOutboundMessages.get(key) ?? new Map<string, number>()
    bucket.set(normalized, (bucket.get(normalized) ?? 0) + 1)
    this.botOutboundMessages.set(key, bucket)

    setTimeout(() => {
      const current = this.botOutboundMessages.get(key)
      if (!current) return
      const count = current.get(normalized) ?? 0
      if (count <= 1) current.delete(normalized)
      else current.set(normalized, count - 1)
      if (current.size === 0) this.botOutboundMessages.delete(key)
    }, 60_000).unref?.()
  }

  private consumeBotOutbound(botId: string, contactPhone: string, text: string): boolean {
    const normalized = this.normalizeOutboundText(text)
    if (!normalized) return false

    const key = this.outboundKey(botId, contactPhone)
    const bucket = this.botOutboundMessages.get(key)
    if (!bucket) return false

    const count = bucket.get(normalized) ?? 0
    if (count <= 0) return false
    if (count === 1) bucket.delete(normalized)
    else bucket.set(normalized, count - 1)
    if (bucket.size === 0) this.botOutboundMessages.delete(key)
    return true
  }

  private async sendBotText(
    client: wppconnect.Whatsapp,
    bot: Bot,
    target: string,
    text: string,
  ): Promise<void> {
    this.markBotOutbound(bot.id, target, text)
    await client.sendText(target, text).catch((err: unknown) => {
      console.error(`[WhatsApp] Failed to send message to ${target}:`, err)
    })
  }

  // ── Session management ───────────────────────────────────────────────────

  async startSession(bot: Bot): Promise<void> {
    if (this.clients.has(bot.id) || this.starting.has(bot.id)) return

    console.log(`[WhatsApp] Iniciando sessão para: ${bot.name} (id: ${bot.id})`)
    this.starting.add(bot.id)
    this.connectedOnce.delete(bot.id)
    this.qrWasShown.delete(bot.id)
    this.lastQR.delete(bot.id)
    await nukeAllBotTokens(bot.id)

    const sessionName = `zapgpt_${bot.id}_${Date.now()}`
    const sessionDir  = path.join(TOKENS_DIR, sessionName)

    // Flag local: QR foi lido com sucesso pelo celular (qrReadSuccess)
    // Impede que status como 'notLogged' — que chegam ANTES do sessionPromise
    // resolver — disparem onSessionFailed e removam o cliente do Map
    // enquanto a conexão ainda está se estabelecendo.
    let qrScanned = false

    try {
      const sessionPromise = wppconnect.create({
        session: sessionName,

        puppeteerOptions: {
          // Flags de baixo consumo de memória definidas acima
          args: [...CHROMIUM_LOW_MEMORY_ARGS, `--user-data-dir=${sessionDir}`],
        },

        headless:       'new' as any,
        logQR:          false,
        autoClose:      0,
        disableWelcome: true,

        catchQR: (base64Qr: string, asciiQR: string) => {
          this.qrWasShown.set(bot.id, true)
          this.lastQR.set(bot.id, { qrBase64: base64Qr, qrAscii: asciiQR })
          this.qrListeners.forEach(l => l({ botId: bot.id, qrBase64: base64Qr, qrAscii: asciiQR }))
          console.log(`[WhatsApp] QR gerado para: ${bot.name}`)
        },

        statusFind: (status: string) => {
          console.log(`[WhatsApp] Status [${bot.name}]: ${status}`)

          // Marca que o QR foi lido — a partir daqui erros de sessão são pós-conexão
          if (status === 'qrReadSuccess') {
            qrScanned = true
            this.sessionListeners.forEach(l => l({ botId: bot.id, status }));
            return;
          }
          // 2. FILTRO "ANTI-MENSAGEM FALSA" (A CORREÇÃO ENTRA AQUI)
          // Se o QR ainda NÃO foi escaneado, o wppconnect joga eventos de 
          // "desconectado" apenas porque está limpando a sessão velha.
          // Ignoramos isso para não assustar o frontend nem acionar falhas prematuras.
          if (!qrScanned && ['notLogged', 'disconnected', 'desconnectedMobile', 'deleteToken'].includes(status)) {
            console.log(`[WhatsApp] Preparando QR... ignorando alerta falso de: ${status}`);
            return;
          }
          // Envia o status para o frontend (somente os eventos reais que passarem do filtro)
          this.sessionListeners.forEach(l => l({ botId: bot.id, status }));

          if (CONFIRMED_CONNECTED_STATUSES.has(status)) {
            sessionPromise.then(resolvedClient => {
              this.onSessionConnectedAsync(bot, resolvedClient).catch(err =>
                console.error(`[WhatsApp] onSessionConnectedAsync error:`, err)
              )
            });
            return;
          }

          // 4. SUCESSO PARCIAL (isLogged)
          if (MAYBE_CONNECTED_STATUSES.has(status)) {
            if (this.qrWasShown.get(bot.id) === true) {
              sessionPromise.then(resolvedClient => {
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

        // 5. FALHA REAL (Crash do navegador, etc)
          if (FAILED_STATUSES.has(status)) {
          console.warn(`[WhatsApp] Falha fatal detectada (${status}) para ${bot.name}`);
            this.onSessionFailed(bot);
          }
          return;
        },
      })

      const client = await sessionPromise

      this.clients.set(bot.id, client)
      this.starting.delete(bot.id)
      this.attachMessageListener(bot, client)
      this.attachPresenceListener(bot, client)
      this.scheduleMemoryCleanup(bot.id)
    } catch (err) {
      this.starting.delete(bot.id)
      this.connectedOnce.delete(bot.id)
      this.clients.delete(bot.id)
      this.qrWasShown.delete(bot.id)
      await db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
      throw err
    }
  }

  // ── Limpeza periódica de memória ─────────────────────────────────────────

  private memoryCleanupTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Intervalo reduzido de 30min → 10min.
   * Após a conexão o RSS ainda está alto — ciclos mais frequentes permitem
   * ao GC recuperar strings e buffers não mais referenciados mais cedo.
   */
  private scheduleMemoryCleanup(botId: string): void {
    const existing = this.memoryCleanupTimers.get(botId)
    if (existing) clearInterval(existing)

    const timer = setInterval(() => {
      const used = process.memoryUsage()
      const mb   = (b: number) => (b / 1024 / 1024).toFixed(1)
      console.log(
        `[Memory] heapUsed:${mb(used.heapUsed)}MB | ` +
        `rss:${mb(used.rss)}MB | external:${mb(used.external)}MB`
      )
      if (typeof (global as any).gc === 'function') {
        ;(global as any).gc()
        console.log('[Memory] GC periódico executado')
      }
    }, 10 * 60 * 1000) // 10 minutos

    this.memoryCleanupTimers.set(botId, timer)
  }

  private async onSessionConnectedAsync(bot: Bot, client: wppconnect.Whatsapp): Promise<void> {
    if (this.connectedOnce.has(bot.id)) return
    this.connectedOnce.add(bot.id)

    // Libera o base64 do QR imediatamente — é a string mais pesada em memória
    this.lastQR.delete(bot.id)

    await db.updateBot(bot.id, { isConnected: true, isActive: true }).catch(() => {})
    console.log(`[WhatsApp] ✅ Bot conectado: ${bot.name}`)

    // GC imediato 5s após a conexão — momento de maior RSS
    if (typeof (global as any).gc === 'function') {
      setTimeout(() => {
        ;(global as any).gc()
        console.log('[Memory] GC pós-conexão executado')
      }, 5_000)
    }

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
    this.starting.delete(bot.id)
    this.connectedOnce.delete(bot.id)
    this.clients.delete(bot.id)
    this.clearMessageBuffer(bot.id)
    geminiManager.clearSessionsForBot(bot.id)
    openaiManager.clearSessionsForBot(bot.id)

    const cleanupTimer = this.memoryCleanupTimers.get(bot.id)
    if (cleanupTimer) { clearInterval(cleanupTimer); this.memoryCleanupTimers.delete(bot.id) }

    setTimeout(() => nukeAllBotTokens(bot.id).catch(() => {}), 3000)
    db.updateBot(bot.id, { isConnected: false, isActive: false }).catch(() => {})
    console.log(`[WhatsApp] ❌ Sessão encerrada/falhou: ${bot.name}`)
  }

  async stopSession(botId: string): Promise<void> {
    const client = this.clients.get(botId)
    if (client) { try { await client.close() } catch (_) {} }
    this.starting.delete(botId)
    this.connectedOnce.delete(botId)
    this.clients.delete(botId)
    this.lastQR.delete(botId)
    this.qrWasShown.delete(botId)
    this.clearMessageBuffer(botId)
    geminiManager.clearSessionsForBot(botId)
    openaiManager.clearSessionsForBot(botId)

    const cleanupTimer = this.memoryCleanupTimers.get(botId)
    if (cleanupTimer) { clearInterval(cleanupTimer); this.memoryCleanupTimers.delete(botId) }

    await db.updateBot(botId, { isConnected: false, isActive: false })
    setTimeout(() => nukeAllBotTokens(botId).catch(() => {}), 3000)
    console.log(`[WhatsApp] 🛑 Sessão parada: ${botId}`)
  }

  isRunning(botId: string): boolean { return this.clients.has(botId) }

  async sendManualReply(
    bot: Bot,
    conversation: Conversation,
    content: string,
  ): Promise<{ conversation: Conversation | null; message: unknown }> {
    const client = this.clients.get(bot.id)
    if (!client) throw new Error('Bot nao esta conectado ao WhatsApp.')

    const text = content.trim()
    if (!text) throw new Error('Mensagem vazia.')

    this.markBotOutbound(bot.id, conversation.contactPhone, text)
    await client.sendText(conversation.contactPhone, text)

    const message = await db.createMessage({
      conversationId:    conversation.id,
      role:              'human',
      content:           text,
      incrementBotCount: false,
      tokenCount:        0,
    })

    const updated = await db.updateConversationAfterManualReply(conversation.id, text)
    return { conversation: updated, message }
  }

  async resumeBot(botId: string, convId: string): Promise<void> {
    await db.setConversationHandoff(convId, false)
    const conv = await db.findConversationById(convId)
    if (!conv) return
    this.pauseListeners.forEach(l => l({
      botId, convId, contactPhone: conv.contactPhone,
      isPaused: false, humanHandoff: false, reason: 'resumed',
    }))
  }

  // ── Presence (contact typing) ─────────────────────────────────────────────

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
    console.log(`[WhatsApp] 🎧 Registrando onMessage para: ${bot.name}`)
    client.onMessage(async (message) => {
      const type   = String(message.type ?? '')
      const from   = String(message.from ?? '')
      const chatId = String(message.chatId ?? message.from ?? '')

      // Log compacto — não imprime base64 para não alocar strings gigantes na heap
      const bodyLen     = String(message.body ?? '').length
      const bodyPreview = (IGNORED_TYPES.has(type) || AUDIO_TYPES.has(type))
        ? `[${type}:${bodyLen}b]`
        : String(message.body ?? '').slice(0, 50)

      console.log(`📩 [MSG] fromMe=${message.fromMe}|${type}|${from.slice(0, 25)}|${bodyPreview}`)

      // fromMe pode ser resposta manual do atendente ou mensagem automatica do bot.
      // Tratamos antes do pipeline de entrada para evitar loop de auto-resposta.
      if (message.fromMe) {
        await this.handleOutboundMessage(bot, message).catch(err => {
          console.error('[WhatsApp] erro ao tratar mensagem manual do atendente:', err)
        })
        return
      }

      const isGroup  = message.isGroupMsg || from.includes('@g.us')
      const isStatus = from.includes('status@broadcast')
      if (isGroup || isStatus) return

      if (AUDIO_TYPES.has(type)) {
        console.log(`   → 🎤 Áudio (${type})`)
        this.handleAudioMessage(bot, client, chatId, from, message)
          .catch(err => console.error(`[Audio] ERRO:`, err))
        return
      }

      if (IGNORED_TYPES.has(type)) return

      if (type !== TEXT_TYPE) {
        console.log(`   → SKIP: tipo desconhecido "${type}"`)
        return
      }

      const bodyText = String(message.body ?? '').trim()
      if (!bodyText) return

      console.log(`   → ✅ Texto: "${bodyText.slice(0, 60)}"`)
      this.bufferMessage(bot, client, chatId, bodyText, from)
    })
  }

  // ── Processamento de áudio ────────────────────────────────────────────────

  private samePhone(left: string, right?: string | null): boolean {
    if (!right) return false
    return left.replace(/@.*$/, '') === right.replace(/@.*$/, '')
  }

  private outgoingTarget(bot: Bot, message: any): string {
    const candidates = [message.chatId, message.to, message.from]
      .map(value => String(value ?? '').trim())
      .filter(Boolean)
    return candidates.find(value => value.includes('@c.us') && !this.samePhone(value, bot.phone))
      ?? candidates.find(value => value.includes('@c.us'))
      ?? candidates[0]
      ?? ''
  }

  private async handleOutboundMessage(bot: Bot, message: any): Promise<void> {
    const type = String(message.type ?? '')
    const target = this.outgoingTarget(bot, message)
    if (!target || target.includes('@g.us') || target.includes('status@broadcast')) return

    const bodyText = String(message.body ?? '').trim()
    if (bodyText && this.consumeBotOutbound(bot.id, target, bodyText)) return
    if (IGNORED_TYPES.has(type) && !bodyText) return

    const conversation = await db.findConversationByBotAndPhone(bot.id, target)
    if (!conversation || conversation.isPaused) return

    const updated = await db.setConversationPaused(conversation.id, true)
    if (!updated) return

    this.pauseListeners.forEach(l => l({
      botId: bot.id,
      convId: updated.id,
      contactPhone: target,
      isPaused: true,
      humanHandoff: false,
      reason: 'manual_override',
    }))

    console.log(`[WhatsApp] Bot pausado automaticamente por resposta manual | bot=${bot.id} | contato=${target}`)
  }

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

    const declaredSize = Number(message.size ?? message.fileSize ?? 0)
    if (declaredSize > MAX_AUDIO_BYTES) {
      await this.sendBotText(client, bot, from, AUDIO_FALLBACK_MESSAGES.transcription_failed)
      await this.persistMessage(bot, client, from, '[audio muito grande para processar]', null)
      return
    }

    let audioBuffer: Buffer
    try {
      const decrypted = await client.decryptFile(message)
      audioBuffer = Buffer.isBuffer(decrypted) ? decrypted : Buffer.from(decrypted as any)
      console.log(`[Audio] ${(audioBuffer.length / 1024).toFixed(1)}KB | MIME:${mimeType}`)
      if (audioBuffer.length > MAX_AUDIO_BYTES) {
        audioBuffer = Buffer.alloc(0)
        await this.sendBotText(client, bot, from, AUDIO_FALLBACK_MESSAGES.transcription_failed)
        await this.persistMessage(bot, client, from, '[audio muito grande para processar]', null)
        return
      }
    } catch (err) {
      console.error(`[Audio] decryptFile falhou:`, err)
      const bodyStr = String(message.body ?? '')
      if (bodyStr.length > 100) {
        try { audioBuffer = Buffer.from(bodyStr, 'base64') }
        catch (_) {
          await this.sendBotText(client, bot, from, AUDIO_FALLBACK_MESSAGES.transcription_failed)
          await this.persistMessage(bot, client, from, '🎤 [áudio não processado]', null)
          return
        }
      } else {
        await this.sendBotText(client, bot, from, AUDIO_FALLBACK_MESSAGES.transcription_failed)
        await this.persistMessage(bot, client, from, '🎤 [áudio não processado]', null)
        return
      }
    }

    const result = await transcribeAudio(audioBuffer, mimeType, user.apiKeys)
    // Substitui referência por buffer vazio — permite GC coletar o áudio mais cedo
    audioBuffer = Buffer.alloc(0)

    if (!result.success) {
      const fallbackMsg = AUDIO_FALLBACK_MESSAGES[result.reason] ?? AUDIO_FALLBACK_MESSAGES.transcription_failed
      await this.sendBotText(client, bot, from, fallbackMsg)
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
    const bufferKey = `${bot.id}:${chatId}`
    const buffer = this.messageBuffers.get(bufferKey) ?? []
    buffer.push(body)
    this.messageBuffers.set(bufferKey, buffer)

    const existing = this.messageTimers.get(bufferKey)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const combined = (this.messageBuffers.get(bufferKey) ?? []).join(' \n ')
      this.messageBuffers.delete(bufferKey)
      this.messageTimers.delete(bufferKey)
      this.processMessage(bot, client, chatId, combined, from)
        .catch(err => console.error(`[processMessage] ERRO:`, err))
    }, MESSAGE_BUFFER_TIMEOUT)

    this.messageTimers.set(bufferKey, timer)
  }

  private clearMessageBuffer(botId: string): void {
    const prefix = `${botId}:`
    for (const [key, timer] of this.messageTimers.entries()) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(timer)
      this.messageTimers.delete(key)
      this.messageBuffers.delete(key)
    }
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

    // Lê bot do banco uma única vez para não fazer queries repetidas
    const freshBot = await db.findBotById(bot.id)
    if (!freshBot) return
    if (!freshBot.isActive) return

    // Verificação de limite — getUserStats faz 3 queries paralelas,
    // só chamamos quando o bot está efetivamente ativo e processando
    const stats = await db.getUserStats(bot.userId)
    if (isMessageLimitReached(user.plan, stats.totalMessages)) {
      const config = getPlanConfig(user.plan)
      console.log(
        `[PlanLimit] Limite atingido | userId=${bot.userId} | ` +
        `plano=${user.plan} | ${stats.totalMessages}/${config.messageLimit}`
      )
      this.planLimitListeners.forEach(l => l({
        botId: bot.id, userId: bot.userId, plan: user.plan,
        totalMessages: stats.totalMessages, messageLimit: config.messageLimit,
      }))
      // Grava a mensagem para o operador ver no painel, sem contar como consumo
      await this.persistMessage(bot, client, from, panelText ?? message, null, false)
      return
    }

    // Bloqueio de mensagens do próprio número do bot
    // from vem como "5521999@c.us"; phone salvo sem sufixo — normaliza antes de comparar
    const fromDigits = from.replace(/@.*$/, '')
    if (freshBot.phone && fromDigits === freshBot.phone) {
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

    // Human handoff detection
    const conv = await db.findConversationByBotAndPhone(bot.id, from)

    if (conv && !conv.humanHandoff && detectsHandoffIntent(message)) {
      const updated = await db.setConversationHandoff(conv.id, true)
      if (updated) {
        this.pauseListeners.forEach(l => l({
          botId: bot.id, convId: updated.id, contactPhone: from,
          isPaused: true, humanHandoff: true, reason: 'human_handoff',
        }))
      }
      await this.sendBotText(client, bot, from, '👤 Vou transferir você para um de nossos atendentes. Aguarde um momento!')
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

    if (conv?.isPaused) {
      await this.persistMessage(bot, client, from, panelText ?? message, null)
      return
    }

    // Indicador de digitação (IA processando)
    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: true,
      }))
    }

    let aiResponse: AITextResponse
    let answer: string
    try {
      const aiInput = await this.withKnowledgeContext(freshBot, message)
      aiResponse = await this.callAIWithRetry(freshBot, user.apiKeys, chatId, aiInput)
      answer = aiResponse.text
      const calendarResult = await this.tryScheduleFromMessage(user, freshBot, from, message)
      if (calendarResult?.created) {
        answer += calendarConfirmation(calendarResult)
      }
      console.log(`✅ IA respondeu: "${answer.slice(0, 60)}"`)
    } catch (raw) {
      const err = raw instanceof AIError ? raw : classifyError(raw)
      console.error(`❌ IA [${err.kind}]: ${err.message}`)
      this.emitAIError(bot, err)
      if (err.kind === 'config' || err.kind === 'quota') {
        await db.updateBot(bot.id, { isActive: false }).catch(() => {})
      }
      if (conv) {
        this.typingListeners.forEach(l => l({
          botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
        }))
      }
      await this.persistMessage(bot, client, from, panelText ?? message, this.panelAIErrorMessage(err))
      return
    }

    if (conv) {
      this.typingListeners.forEach(l => l({
        botId: bot.id, convId: conv.id, contactPhone: from, isTyping: false,
      }))
    }

    await this.persistMessage(bot, client, from, panelText ?? message, answer, true, aiResponse.usage)
    await sendMessagesWithDelay(
      client,
      splitMessages(answer),
      from,
      messagePart => this.markBotOutbound(bot.id, from, messagePart),
    )
    console.log(`📤 Enviado para ${from.slice(0, 25)}`)
  }

  // ── AI ────────────────────────────────────────────────────────────────────

  private async withKnowledgeContext(bot: Bot, message: string): Promise<string> {
    try {
      const items = await db.findActiveKnowledgeBaseItemsByBotId(bot.id)
      return buildKnowledgeContext(items, message)
    } catch (err) {
      console.warn('[KnowledgeBase] Falha ao montar contexto:', err)
      return message
    }
  }

  private async tryScheduleFromMessage(
    user: User,
    bot: Bot,
    contactPhone: string,
    message: string,
  ) {
    try {
      return await tryScheduleCalendarEvent(user, bot, contactPhone, message)
    } catch (err) {
      console.warn('[GoogleCalendar] Falha ao criar evento automaticamente:', err)
      return null
    }
  }

  private async callAIWithRetry(
    bot: Bot, apiKeys: import('../models/database.js').ApiKeys,
    chatId: string, message: string,
  ): Promise<AITextResponse> {
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
  ): Promise<AITextResponse> {
    const sessionKey = `${bot.id}:${chatId}`
    if (bot.model === 'gemini-2.5-flash' as any) {
      if (!apiKeys.geminiKey) throw new AIError('config', 'Gemini API key não configurada.')
      return geminiManager.sendMessage(sessionKey, message, {
        apiKey: apiKeys.geminiKey, model: bot.model, systemPrompt: bot.prompt,
      })
    }
    if (!apiKeys.openaiKey || !apiKeys.openaiAssistantId) {
      throw new AIError('config', 'Credenciais OpenAI não configuradas.')
    }
    return openaiManager.sendMessage(sessionKey, message, {
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

  // ── Persist message ───────────────────────────────────────────────────────

  private panelAIErrorMessage(err: AIError): string {
    if (err.kind === 'quota') {
      return '[ALERTA] Os creditos/tokens da chave de IA acabaram. Adicione creditos na OpenAI ou Gemini, confira a chave em Configuracoes > API Keys e reative o bot.'
    }
    if (err.kind === 'config') {
      return '[ALERTA] A chave de IA esta ausente ou invalida. Revise as credenciais em Configuracoes > API Keys e reative o bot.'
    }
    if (err.kind === 'network') {
      return '[ALERTA] Houve uma falha temporaria ao falar com a IA. A mensagem foi registrada para acompanhamento.'
    }
    return '[ALERTA] A IA nao conseguiu responder agora. Verifique os logs do servidor.'
  }

  private async persistMessage(
    bot: Bot, client: wppconnect.Whatsapp,
    from: string, userText: string, answer: string | null,
    incrementBotCount = true,
    aiUsage?: AIUsage,
  ): Promise<void> {
    let contactName = from
    try {
      // Timeout reduzido de 5s → 3s para não bloquear o pipeline
      const contact = await Promise.race([
        client.getContact(from),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), CONTACT_FETCH_TIMEOUT)),
      ]) as any
      const pushname = contact?.pushname ?? contact?.name ?? contact?.formattedName
      if (pushname && pushname.trim()) contactName = pushname.trim()
    } catch (_) {}

    const conversation = await db.upsertConversation({
      botId: bot.id, userId: bot.userId,
      contactName, contactPhone: from,
      lastMessage:   answer ?? userText,
      lastMessageAt: new Date(),
      unreadCount:   1,
      messageCount:  1,
    })

    // Mensagem do contato — incremento atômico via Prisma { increment: 1 }
    await db.createMessage({
      conversationId:    conversation.id,
      role:              'user',
      content:           userText,
      incrementBotCount,
      botId:             bot.id,
      tokenCount:        aiUsage?.totalTokens ? 0 : undefined,
    })

    // Resposta da IA — nunca incrementa (apenas mensagens 'user' contam para limite)
    if (answer !== null) {
      await db.createMessage({
        conversationId:    conversation.id,
        role:              'assistant',
        content:           answer,
        incrementBotCount: false,
        tokenCount:        aiUsage?.totalTokens,
      })
    }
  }
}

export const whatsappManager = new WhatsAppManager()
