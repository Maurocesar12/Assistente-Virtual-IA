/**
 * routes/billing.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Integração com AbacatePay
 *
 * Rotas:
 *   POST /api/billing/checkout  → cria cobrança e retorna { url }
 *   POST /api/billing/webhook   → recebe notificação de pagamento confirmado
 *   GET  /api/billing/status    → retorna plano atual + histórico de cobranças
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { authenticate } from '../middleware/authenticate.js'
import { validate } from '../middleware/validate.js'
import { ApiError, ok, created } from '../utils/http.js'
import { env } from '../config/env.js'
import crypto from 'crypto'

export const billingRouter = Router()

// ─── AbacatePay SDK helper (sem instalar pacote extra) ────────────────────────

const ABACATE_API = 'https://api.abacatepay.com'

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

  const json = await res.json() as { data: T; error: string | null }

  if (!res.ok || json.error) {
    throw new Error(`AbacatePay error [${res.status}]: ${json.error ?? 'unknown'}`)
  }

  return json.data
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  // CPF/CNPJ é obrigatório pelo AbacatePay para criar customer
  taxId: z.string().min(11, 'CPF/CNPJ inválido').max(18),
  // Telefone opcional mas recomendado
  cellphone: z.string().optional(),
})

// ─── POST /billing/checkout ───────────────────────────────────────────────────
// Cria uma cobrança ONE_TIME no AbacatePay e retorna a URL de pagamento.
// O usuário é redirecionado para pagar via PIX ou cartão.

billingRouter.post('/checkout', authenticate, validate(checkoutSchema), async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    if (user.plan === 'pro' || user.plan === 'enterprise') {
      throw ApiError.badRequest('Você já possui o plano Pro ou superior.', 'ALREADY_PRO')
    }

    const { taxId, cellphone } = req.body
    const frontendUrl = env.FRONTEND_URL.replace(/\/$/, '')

    // Cria a cobrança no AbacatePay
    const billing = await abacateRequest<{
      id: string
      url: string
      status: string
    }>('POST', '/v1/billing/create', {
      frequency: 'ONE_TIME',
      methods: ['PIX', 'CARD'],
      products: [
        {
          externalId: 'zapiens-pro-monthly',
          name: 'Zapiens Pro — Mensalidade',
          description: 'Mensagens ilimitadas · 5 números de WhatsApp · Suporte prioritário',
          quantity: 1,
          price: 999, // R$ 9,99 em centavos
        },
      ],
      returnUrl: `${frontendUrl}/#billing`,
      completionUrl: `${frontendUrl}/#billing?payment=success`,
      customer: {
        name: `${user.name} ${user.lastName}`.trim(),
        email: user.email,
        taxId,
        ...(cellphone ? { cellphone } : {}),
      },
      // Metadados para identificar o usuário no webhook
      metadata: {
        userId: user.id,
        plan: 'pro',
      },
    })

    console.log(`[Billing] Cobrança criada para ${user.email} | billing_id=${billing.id}`)

    return created(res, { url: billing.url, billingId: billing.id })
  } catch (err) {
    next(err)
  }
})

// ─── POST /billing/webhook ────────────────────────────────────────────────────
// Recebe notificações do AbacatePay quando o pagamento é confirmado.
// NÃO usa o middleware authenticate — é chamado pelo AbacatePay, não pelo browser.
// Verifica a assinatura do webhook para garantir autenticidade.

billingRouter.post('/webhook', async (req, res, next) => {
  try {
    // Verificação de assinatura HMAC (se configurada no painel AbacatePay)
    const secret = env.ABACATEPAY_WEBHOOK_SECRET
    if (secret) {
      const signature = req.headers['x-abacatepay-signature'] as string | undefined
      if (!signature) {
        console.warn('[Billing Webhook] Requisição sem assinatura rejeitada')
        return res.status(401).json({ error: 'Missing signature' })
      }

      // AbacatePay usa HMAC-SHA256 com o body em JSON
      const bodyStr = JSON.stringify(req.body)
      const expected = crypto
        .createHmac('sha256', secret)
        .update(bodyStr)
        .digest('hex')

      const valid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      )

      if (!valid) {
        console.warn('[Billing Webhook] Assinatura inválida')
        return res.status(401).json({ error: 'Invalid signature' })
      }
    }

    const event = req.body as {
      event: string
      data: {
        billing?: {
          id: string
          status: string
          metadata?: { userId?: string; plan?: string }
          customer?: { metadata?: { email?: string } }
        }
      }
    }

    console.log(`[Billing Webhook] Evento recebido: ${event.event}`)

    // Evento de cobrança paga
    if (event.event === 'BILLING_PAID' || event.event === 'billing.paid') {
      const billing = event.data?.billing
      if (!billing) {
        console.warn('[Billing Webhook] Payload sem billing')
        return res.status(200).json({ received: true })
      }

      const userId = billing.metadata?.userId
      const plan   = (billing.metadata?.plan ?? 'pro') as 'pro' | 'enterprise'

      if (!userId) {
        console.warn('[Billing Webhook] userId ausente nos metadados da cobrança:', billing.id)
        return res.status(200).json({ received: true })
      }

      const user = await db.findUserById(userId)
      if (!user) {
        console.warn(`[Billing Webhook] Usuário não encontrado: ${userId}`)
        return res.status(200).json({ received: true })
      }

      await db.updateUser(userId, { plan })

      console.log(
        `[Billing Webhook] ✅ Plano atualizado para "${plan}" | ` +
        `userId=${userId} | email=${user.email} | billing_id=${billing.id}`
      )
    }

    // Sempre retornar 200 para o AbacatePay não retentar
    return res.status(200).json({ received: true })
  } catch (err) {
    console.error('[Billing Webhook] Erro:', err)
    // Retorna 200 mesmo em erro interno para evitar reenvios desnecessários
    return res.status(200).json({ received: true })
  }
})

// ─── GET /billing/status ──────────────────────────────────────────────────────
// Retorna o plano atual do usuário + cobranças recentes no AbacatePay

billingRouter.get('/status', authenticate, async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuário não encontrado')

    // Busca cobranças do AbacatePay filtradas pelo email do usuário
    let billings: Array<{
      id: string
      url: string
      amount: number
      status: string
      createdAt: string
    }> = []

    try {
      const result = await abacateRequest<typeof billings>('GET', '/v1/billing/list')
      // Filtra apenas cobranças deste usuário pelos metadados
      billings = (result as any[])
        .filter((b: any) => b.metadata?.userId === user.id)
        .map((b: any) => ({
          id:        b.id,
          url:       b.url,
          amount:    b.amount,
          status:    b.status,
          createdAt: b.createdAt,
        }))
        .slice(0, 10) // últimas 10
    } catch (err) {
      // Se AbacatePay falhar, não quebra o status local
      console.warn('[Billing] Falha ao buscar cobranças:', err)
    }

    return ok(res, {
      plan: user.plan,
      billings,
    })
  } catch (err) {
    next(err)
  }
})