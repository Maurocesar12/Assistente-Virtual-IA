/**
 * routes/billing.ts — Cobrança manual a cada 30 dias
 * ─────────────────────────────────────────────────────────────────────────────
 * Fluxo:
 *   1. Usuário clica "Assinar Pro" → POST /billing/checkout
 *      → Cria cobrança ONE_TIME no AbacatePay → retorna URL de pagamento
 *   2. Usuário paga → AbacatePay dispara webhook billing.paid
 *      → plan = 'pro', planExpiresAt = hoje + 30 dias, status = 'active'
 *   3. Scheduler roda a cada hora:
 *      → 5 dias antes: email + registra para exibir banner/toast
 *      → No vencimento: bots pausados, status = 'past_due' (dados preservados)
 *   4. Usuário renova → mesmo fluxo do passo 1-2
 *      → planExpiresAt estendido +30 dias, banner some
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router }         from 'express'
import { z }              from 'zod'
import crypto             from 'crypto'
import { db }             from '../models/database.js'
import { authenticate }   from '../middleware/authenticate.js'
import { demoReadOnlyGuard } from '../middleware/demoReadOnlyGuard.js'
import { validate }       from '../middleware/validate.js'
import { ApiError, ok, created } from '../utils/http.js'
import { env }            from '../config/env.js'
import { sendBillingEmail } from '../service/subscriptionEmail.js'
import { whatsappManager } from '../service/whatsapp.js'

export const billingRouter = Router()

// ─── AbacatePay helper ────────────────────────────────────────────────────────

const ABACATE_API = 'https://api.abacatepay.com'

async function abacateRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ABACATE_API}${path}`, {
    method,
    headers: {
      'accept':        'application/json',
      'content-type':  'application/json',
      'authorization': `Bearer ${env.ABACATEPAY_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json() as { data: T; error: string | null }
  if (!res.ok || json.error) {
    throw new Error(`AbacatePay [${res.status}]: ${JSON.stringify(json.error)}`)
  }
  return json.data
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  taxId:     z.string().min(11, 'CPF/CNPJ inválido').max(18),
  cellphone: z.string().optional(),
})

// ─── POST /billing/checkout ───────────────────────────────────────────────────
// Gera uma cobrança ONE_TIME de R$9,99.
// Funciona tanto para primeira assinatura quanto para renovações manuais.

billingRouter.post('/checkout', authenticate, demoReadOnlyGuard, validate(checkoutSchema), async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    const { taxId, cellphone } = req.body
    const frontendUrl = env.FRONTEND_URL.replace(/\/$/, '')

    const billing = await abacateRequest<{ id: string; url: string }>('POST', '/v1/billing/create', {
      frequency: 'ONE_TIME',
      methods:   ['PIX', 'CARD'],
      products: [{
        externalId:  'zapiens-pro-monthly',
        name:        'Zapiens Pro — 30 dias',
        description: 'Mensagens ilimitadas · 5 números de WhatsApp · Suporte prioritário',
        quantity:    1,
        price:       999, // R$ 9,99 em centavos
      }],
      returnUrl:     `${frontendUrl}/#billing`,
      completionUrl: `${frontendUrl}/#billing?payment=success`,
      customer: {
        name:     `${user.name} ${user.lastName}`.trim(),
        email:    user.email,
        taxId,
        ...(cellphone ? { cellphone } : {}),
      },
      // userId nos metadados para identificar no webhook
      metadata: { userId: user.id },
    })

    console.log(`[Billing] Cobrança criada | userId=${user.id} | billing_id=${billing.id}`)
    return created(res, { url: billing.url, billingId: billing.id })
  } catch (err) {
    next(err)
  }
})

// ─── POST /billing/webhook ────────────────────────────────────────────────────
// Evento esperado: BILLING_PAID (ou billing.paid)
// Ativa o Pro por 30 dias e reseta o estado de vencimento.

billingRouter.post('/webhook', async (req, res) => {
  try {
    // Verificação de assinatura HMAC
    const secret = env.ABACATEPAY_WEBHOOK_SECRET
    if (secret) {
      const sig = req.headers['x-abacatepay-signature'] as string | undefined
      if (!sig) {
        console.warn('[Webhook] Sem assinatura')
        return res.status(401).json({ ok: false })
      }
      const rawBody = (req as any).rawBody
      const bodyForSignature = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(JSON.stringify(req.body))

      const expected = crypto
        .createHmac('sha256', secret)
        .update(bodyForSignature)
        .digest('hex')
      const normalizedSig = sig.replace(/^sha256=/i, '').trim()
      const sigBuffer = Buffer.from(normalizedSig, 'hex')
      const expectedBuffer = Buffer.from(expected, 'hex')
      const valid = sigBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(sigBuffer, expectedBuffer)
      if (!valid) {
        console.warn('[Webhook] Assinatura inválida')
        return res.status(401).json({ ok: false })
      }
    }

    const { event, data } = req.body as {
      event: string
      data:  { billing?: { id: string; status: string; metadata?: { userId?: string } } }
    }

    console.log(`[Webhook] Evento: ${event}`)

    if (event !== 'BILLING_PAID' && event !== 'billing.paid') {
      return res.status(200).json({ received: true })
    }

    const billing = data?.billing
    if (!billing) return res.status(200).json({ received: true })

    const userId = billing.metadata?.userId
    if (!userId) {
      console.warn('[Webhook] userId ausente nos metadados:', billing.id)
      return res.status(200).json({ received: true })
    }

    const user = await db.findUserById(userId)
    if (!user) {
      console.warn('[Webhook] Usuário não encontrado:', userId)
      return res.status(200).json({ received: true })
    }

    // Calcula nova data de expiração:
    // Se já tem Pro ativo e o usuário está renovando antes do vencimento,
    // estende a partir da data atual de expiração (não perde dias pagos).
    const currentExpiry = (user as any).planExpiresAt
    const baseDate = (currentExpiry && new Date(currentExpiry) > new Date())
      ? new Date(currentExpiry)
      : new Date()
    const newExpiry = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000)

    const wasExpired = (user as any).subscriptionStatus === 'past_due'

    await db.updateUser(userId, {
      plan:                  'pro',
      subscriptionStatus:    'active',
      planExpiresAt:         newExpiry,
      renewalReminderSentAt: null, // reseta para próximo ciclo
    } as any)

    // Se estava pausado por vencimento, reativa os bots
    if (wasExpired) {
      const bots = await db.findBotsByUserId(userId)
      for (const bot of bots) {
        if (!bot.isConnected) continue
        await db.updateBot(bot.id, { isActive: true })
      }
      console.log(`[Billing] Bots reativados para ${user.email}`)
    }

    const isRenewal = !!currentExpiry
    await sendBillingEmail(
      isRenewal ? 'renewed' : 'activated',
      user.email,
      user.name,
      newExpiry,
    )

    console.log(
      `[Billing] ✅ Pro ${isRenewal ? 'renovado' : 'ativado'} para ${user.email} | ` +
      `expira ${newExpiry.toLocaleDateString('pt-BR')}`,
    )

    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[Webhook] Erro:', err)
    return res.status(200).json({ received: true })
  }
})

// ─── GET /billing/status ──────────────────────────────────────────────────────
// Retorna dados de assinatura usados pelo front-end para exibir banners/toasts.

billingRouter.get('/status', authenticate, async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    const u = user as any

    // Dias restantes calculados no servidor (fonte única de verdade)
    let daysUntilExpiry: number | null = null
    if (u.planExpiresAt) {
      const msLeft = new Date(u.planExpiresAt).getTime() - Date.now()
      daysUntilExpiry = Math.ceil(msLeft / (1000 * 60 * 60 * 24))
    }

    // Histórico de cobranças do AbacatePay (melhor esforço)
    let billings: any[] = []
    try {
      const result = await abacateRequest<any[]>('GET', '/v1/billing/list')
      billings = (result as any[])
        .filter((b: any) => b.metadata?.userId === user.id)
        .map((b: any) => ({
          id:        b.id,
          amount:    b.amount,
          status:    b.status,
          createdAt: b.createdAt,
          url:       b.url ?? null,
        }))
        .slice(0, 10)
    } catch (_) {}

    return ok(res, {
      plan:               user.plan,
      subscriptionStatus: u.subscriptionStatus  ?? 'none',
      planExpiresAt:      u.planExpiresAt        ?? null,
      daysUntilExpiry,
      billings,
    })
  } catch (err) {
    next(err)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER — verifica vencimentos, pausa bots, envia avisos
// Chame startBillingScheduler() no src/index.ts após app.listen()
// ─────────────────────────────────────────────────────────────────────────────

export function startBillingScheduler() {
  const INTERVAL_MS   = 60 * 60 * 1000  // 1 hora
  const REMINDER_DAYS = 5               // dias antes para enviar aviso

  async function runChecks() {
    const now = new Date()
    console.log(`[Scheduler] Rodando verificação de assinaturas | ${now.toISOString()}`)

    try {
      const proUsers = await (db as any).findProUsersExpiring()

      for (const user of proUsers) {
        const u = user as any
        if (!u.planExpiresAt) continue

        const expiresAt = new Date(u.planExpiresAt)
        const msLeft    = expiresAt.getTime() - now.getTime()
        const daysLeft  = msLeft / (1000 * 60 * 60 * 24)

        // ── VENCIDO: pausa bots, preserva dados ──────────────────────────
        if (daysLeft <= 0 && u.subscriptionStatus === 'active') {
          // Atualiza status — plan continua 'pro' para preservar dados,
          // mas subscriptionStatus = 'past_due' bloqueia as respostas
          await db.updateUser(user.id, {
            subscriptionStatus: 'past_due',
          } as any)

          // Pausa todos os bots do usuário (isActive = false)
          const bots = await db.findBotsByUserId(user.id)
          for (const bot of bots) {
            if (bot.isActive) {
              await db.updateBot(bot.id, { isActive: false })
            }
          }

          await sendBillingEmail('expired', user.email, user.name, expiresAt)
          console.log(`[Scheduler] ❄️  Bots pausados por vencimento: ${user.email}`)
        }

        // ── AVISO 5 DIAS ANTES: email + marca para banner/toast ──────────
        else if (
          daysLeft > 0 &&
          daysLeft <= REMINDER_DAYS &&
          u.subscriptionStatus === 'active'
        ) {
          // Verifica se já enviou aviso neste ciclo (evita reenvios a cada hora)
          const lastReminder = u.renewalReminderSentAt
            ? new Date(u.renewalReminderSentAt)
            : null
          // Considera novo ciclo se não enviou ou se faz mais de 25 dias
          const isNewCycle = !lastReminder ||
            (now.getTime() - lastReminder.getTime() > 25 * 24 * 60 * 60 * 1000)

          if (isNewCycle) {
            await sendBillingEmail('reminder', user.email, user.name, expiresAt, Math.ceil(daysLeft))
            await db.updateUser(user.id, { renewalReminderSentAt: now } as any)
            console.log(`[Scheduler] 📧 Aviso de vencimento para ${user.email} (${Math.ceil(daysLeft)} dias)`)
          }
        }
      }
    } catch (err) {
      console.error('[Scheduler] Erro:', err)
    }
  }

  // Executa imediatamente na inicialização e depois a cada hora
  runChecks()
  setInterval(runChecks, INTERVAL_MS)
  console.log('[Scheduler] ✅ Verificador de assinaturas ativo (intervalo: 1h)')
}
