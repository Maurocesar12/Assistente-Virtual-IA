/**
 * routes/billing.ts — Assinatura mensal com AbacatePay
 * ─────────────────────────────────────────────────────────────────────────────
 * Rotas:
 *   POST /api/billing/checkout        → cria assinatura MONTHLY e retorna URL
 *   POST /api/billing/webhook         → processa eventos do AbacatePay
 *   GET  /api/billing/status          → plano + status + cobranças
 *   POST /api/billing/cancel          → cancela assinatura ativa
 *
 * Scheduler (iniciado em startSubscriptionScheduler):
 *   - Roda a cada hora
 *   - Expira contas com planExpiresAt no passado (status → expired, plan → starter)
 *   - Envia email de aviso 5 dias antes do vencimento (1 vez por ciclo)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { db } from '../models/database.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { ApiError, ok, created } from '../utils/http.js'
import { env } from '../config/env.js'
import { sendSubscriptionEmail } from '../service/subscriptionEmail.js'

export const billingRouter = Router()

// ─── AbacatePay helper ────────────────────────────────────────────────────────

const ABACATE_API = 'https://api.abacatepay.com/v2'

async function abacateRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ABACATE_API}${path}`, {
    method,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': `Bearer ${env.ABACATEPAY_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json() as { data: T; error: string | null; success?: boolean }
  if (!res.ok || json.error) {
    throw new Error(`AbacatePay [${res.status}]: ${JSON.stringify(json.error)}`)
  }
  return json.data
}

// ─── Garantir que o produto Pro existe no catálogo AbacatePay ─────────────────
// Criamos uma vez e reutilizamos o externalId em todas as assinaturas

const PRO_PRODUCT_EXTERNAL_ID = 'zapiens-pro-monthly-v1'

let _cachedProductId: string | null = null

async function ensureProProduct(): Promise<string> {
  if (_cachedProductId) return _cachedProductId

  // Tenta buscar o produto já existente
  try {
    const list = await abacateRequest<{ externalId: string; id: string }[]>('GET', '/products/list')
    const existing = list.find(p => p.externalId === PRO_PRODUCT_EXTERNAL_ID)
    if (existing) { _cachedProductId = existing.id; return existing.id }
  } catch (_) {}

  // Cria se não existir
  const product = await abacateRequest<{ id: string }>('POST', '/products/create', {
    externalId:  PRO_PRODUCT_EXTERNAL_ID,
    name:        'Zapiens Pro — Mensalidade',
    description: 'Mensagens ilimitadas · 5 números de WhatsApp · Suporte prioritário',
    price:       999,   // R$ 9,99 em centavos
    currency:    'BRL',
    cycle:       'MONTHLY',
  })
  _cachedProductId = product.id
  return product.id
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  taxId:     z.string().min(11).max(18),
  cellphone: z.string().optional(),
})

// ─── POST /billing/checkout ───────────────────────────────────────────────────

billingRouter.post('/checkout', authenticate, validate(checkoutSchema), async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    if (user.plan === 'pro' && user.subscriptionStatus === 'active') {
      throw ApiError.badRequest('Você já possui uma assinatura Pro ativa.', 'ALREADY_PRO')
    }

    const { taxId, cellphone } = req.body
    const frontendUrl = env.FRONTEND_URL.replace(/\/$/, '')

    const productId = await ensureProProduct()

    // Cria (ou recupera) o customer no AbacatePay
    const customer = await abacateRequest<{ id: string }>('POST', '/customers/create', {
      name:     `${user.name} ${user.lastName}`.trim(),
      email:    user.email,
      taxId,
      ...(cellphone ? { cellphone } : {}),
    })

    // Cria a assinatura MONTHLY
    const subscription = await abacateRequest<{ id: string; url: string }>('POST', '/subscriptions/create', {
      items: [{ id: productId, quantity: 1 }],
      methods:       ['PIX', 'CARD'],
      customerId:    customer.id,
      returnUrl:     `${frontendUrl}/#billing`,
      completionUrl: `${frontendUrl}/#billing?payment=success`,
      metadata: { userId: user.id },
    })

    console.log(`[Billing] Assinatura criada para ${user.email} | sub_id=${subscription.id}`)

    // Salva o ID da assinatura no usuário para rastreamento
    await db.updateUser(user.id, {
      subscriptionId:     subscription.id,
      subscriptionStatus: 'pending',
    } as any)

    return created(res, { url: subscription.url, subscriptionId: subscription.id })
  } catch (err) {
    next(err)
  }
})

// ─── POST /billing/cancel ─────────────────────────────────────────────────────

billingRouter.post('/cancel', authenticate, async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    const subId = (user as any).subscriptionId
    if (!subId) throw ApiError.badRequest('Nenhuma assinatura ativa encontrada.', 'NO_SUBSCRIPTION')

    await abacateRequest('POST', '/subscriptions/cancel', { id: subId })

    await db.updateUser(user.id, {
      subscriptionStatus: 'cancelled',
    } as any)

    console.log(`[Billing] Assinatura cancelada para ${user.email} | sub_id=${subId}`)
    return ok(res, { message: 'Assinatura cancelada com sucesso.' })
  } catch (err) {
    next(err)
  }
})

// ─── POST /billing/webhook ────────────────────────────────────────────────────
// Eventos tratados:
//   subscription.completed  → primeiro pagamento — ativa o pro + define expiração
//   subscription.renewed    → renovação mensal — estende +30 dias
//   subscription.cancelled  → usuário cancelou no painel AbacatePay
//   subscription.expired (fallback) → trata como past_due

billingRouter.post('/webhook', async (req, res) => {
  try {
    // Verificação de assinatura HMAC
    const secret = env.ABACATEPAY_WEBHOOK_SECRET
    if (secret) {
      const sig = req.headers['x-abacatepay-signature'] as string | undefined
      if (!sig) { console.warn('[Webhook] Sem assinatura'); return res.status(401).json({ ok: false }) }
      const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex')
      const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      if (!valid) { console.warn('[Webhook] Assinatura inválida'); return res.status(401).json({ ok: false }) }
    }

    const { event, data } = req.body as {
      event: string
      data: { subscription?: { id: string; status: string; metadata?: { userId?: string } } }
    }

    console.log(`[Webhook] ${event}`)

    const sub = data?.subscription
    if (!sub) return res.status(200).json({ received: true })

    const userId = sub.metadata?.userId
    if (!userId) {
      console.warn('[Webhook] userId ausente na assinatura:', sub.id)
      return res.status(200).json({ received: true })
    }

    const user = await db.findUserById(userId)
    if (!user) { console.warn('[Webhook] Usuário não encontrado:', userId); return res.status(200).json({ received: true }) }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // +30 dias

    if (event === 'subscription.completed') {
      // Primeiro pagamento — ativa Pro
      await db.updateUser(userId, {
        plan:                 'pro',
        subscriptionId:       sub.id,
        subscriptionStatus:   'active',
        planExpiresAt:        expiresAt,
        renewalReminderSentAt: null,
      } as any)
      await sendSubscriptionEmail('activated', user.email, user.name, expiresAt)
      console.log(`[Billing] ✅ Pro ativado para ${user.email} | expira ${expiresAt.toLocaleDateString('pt-BR')}`)

    } else if (event === 'subscription.renewed') {
      // Renovação mensal — estende +30 dias a partir de hoje
      await db.updateUser(userId, {
        plan:                 'pro',
        subscriptionStatus:   'active',
        planExpiresAt:        expiresAt,
        renewalReminderSentAt: null,
      } as any)
      await sendSubscriptionEmail('renewed', user.email, user.name, expiresAt)
      console.log(`[Billing] 🔄 Pro renovado para ${user.email} | novo venc. ${expiresAt.toLocaleDateString('pt-BR')}`)

    } else if (event === 'subscription.cancelled') {
      // Usuário cancelou — mantém Pro até planExpiresAt, não renova mais
      await db.updateUser(userId, {
        subscriptionStatus: 'cancelled',
      } as any)
      const expDate = (user as any).planExpiresAt
      await sendSubscriptionEmail('cancelled', user.email, user.name, expDate)
      console.log(`[Billing] ❌ Assinatura cancelada para ${user.email}`)
    }

    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[Webhook] Erro:', err)
    return res.status(200).json({ received: true })
  }
})

// ─── GET /billing/status ──────────────────────────────────────────────────────

billingRouter.get('/status', authenticate, async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    const u = user as any

    let billings: any[] = []
    if (u.subscriptionId) {
      try {
        const list = await abacateRequest<any[]>('GET', '/subscriptions/list')
        billings = list
          .filter((s: any) => s.metadata?.userId === user.id)
          .map((s: any) => ({
            id:        s.id,
            amount:    999,
            status:    s.status,
            createdAt: s.createdAt,
            url:       s.url ?? null,
          }))
          .slice(0, 10)
      } catch (err) {
        console.warn('[Billing] Falha ao buscar assinaturas:', err)
      }
    }

    // Dias restantes até vencimento
    let daysUntilExpiry: number | null = null
    if (u.planExpiresAt) {
      const msLeft = new Date(u.planExpiresAt).getTime() - Date.now()
      daysUntilExpiry = Math.ceil(msLeft / (1000 * 60 * 60 * 24))
    }

    return ok(res, {
      plan:               user.plan,
      subscriptionStatus: u.subscriptionStatus ?? 'none',
      subscriptionId:     u.subscriptionId ?? null,
      planExpiresAt:      u.planExpiresAt ?? null,
      daysUntilExpiry,
      billings,
    })
  } catch (err) {
    next(err)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER — roda a cada hora, verifica vencimentos e envia avisos
// Importe e chame startSubscriptionScheduler() no src/index.ts
// ─────────────────────────────────────────────────────────────────────────────

export function startSubscriptionScheduler() {
  const HOUR_MS       = 60 * 60 * 1000
  const REMINDER_DAYS = 5   // dias antes do vencimento para enviar aviso
  const GRACE_DAYS    = 0   // dias de carência após vencimento (0 = congela no dia)

  async function runChecks() {
    const now = new Date()
    console.log(`[Scheduler] Verificando assinaturas... ${now.toISOString()}`)

    try {
      // Busca todos os usuários Pro para verificar
      const proUsers = await (db as any).findUsersByPlan('pro')

      for (const user of proUsers) {
        if (!user.planExpiresAt) continue
        const expiresAt = new Date(user.planExpiresAt)
        const msLeft    = expiresAt.getTime() - now.getTime()
        const daysLeft  = msLeft / (1000 * 60 * 60 * 24)

        // ── 1. Conta expirada → congela ───────────────────────────────────
        if (daysLeft <= -GRACE_DAYS && user.subscriptionStatus !== 'expired') {
          await db.updateUser(user.id, {
            plan:               'starter',
            subscriptionStatus: 'expired',
          } as any)
          await sendSubscriptionEmail('expired', user.email, user.name, expiresAt)
          console.log(`[Scheduler] ❄️  Conta congelada: ${user.email}`)
        }

        // ── 2. Aviso 5 dias antes — envia apenas 1 vez por ciclo ─────────
        else if (
          daysLeft > 0 &&
          daysLeft <= REMINDER_DAYS &&
          user.subscriptionStatus === 'active'
        ) {
          const lastReminder = user.renewalReminderSentAt
            ? new Date(user.renewalReminderSentAt)
            : null

          // Só envia se ainda não enviou neste ciclo (evita reenvios a cada hora)
          const shouldSend = !lastReminder || (now.getTime() - lastReminder.getTime() > 20 * 24 * 60 * 60 * 1000)

          if (shouldSend) {
            await sendSubscriptionEmail('reminder', user.email, user.name, expiresAt, Math.ceil(daysLeft))
            await db.updateUser(user.id, { renewalReminderSentAt: now } as any)
            console.log(`[Scheduler] 📧 Aviso de renovação enviado para ${user.email} (${Math.ceil(daysLeft)} dias restantes)`)
          }
        }
      }
    } catch (err) {
      console.error('[Scheduler] Erro:', err)
    }
  }

  // Roda na inicialização e depois a cada hora
  runChecks()
  setInterval(runChecks, HOUR_MS)
  console.log('[Scheduler] ✅ Verificação de assinaturas iniciada (intervalo: 1h)')
}