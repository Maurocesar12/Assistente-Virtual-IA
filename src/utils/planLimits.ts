/**
 * planLimits.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type Plan = 'starter' | 'pro' | 'enterprise'

export interface PlanConfig {
  label:        string
  price:        number    // R$ por mês (0 = grátis)
  messageLimit: number    // Infinity = sem limite
  botLimit:     number    // máx de bots criados
}

export const PLAN_CONFIG: Record<Plan, PlanConfig> = {
  starter: {
    label:        'Starter',
    price:        0,
    messageLimit: 50,
    botLimit:     1,
  },
  pro: {
    label:        'Pro',
    price:        9.99,
    messageLimit: Infinity,
    botLimit:     5,
  },
  enterprise: {
    label:        'Enterprise',
    price:        0,
    messageLimit: Infinity,
    botLimit:     Infinity,
  },
}

/**
 * Papéis de mensagem que contam para o limite do plano.
 *
 * DECISÃO DE DESIGN: contamos apenas 'user' (mensagens recebidas do contato).
 * Isso evita que erros de IA ou reenvios do bot inflem artificialmente o contador.
 * Uma conversa de ida-e-volta (usuário envia, bot responde) conta como 1.
 *
 * Se preferir contar AMBOS os lados, adicione 'assistant' ao array.
 */
export const COUNTABLE_MESSAGE_ROLES: ReadonlyArray<string> = ['user'] as const

// ─── Helpers públicos (sem alteração de assinatura) ───────────────────────────

export function getPlanConfig(plan: string): PlanConfig {
  return PLAN_CONFIG[plan as Plan] ?? PLAN_CONFIG.starter
}

/** Retorna true se o usuário atingiu ou ultrapassou o limite de mensagens. */
export function isMessageLimitReached(plan: string, totalMessages: number): boolean {
  const { messageLimit } = getPlanConfig(plan)
  return messageLimit !== Infinity && totalMessages >= messageLimit
}

/** Retorna quantas mensagens restam (nunca negativo; Infinity para planos ilimitados). */
export function remainingMessages(plan: string, totalMessages: number): number {
  const { messageLimit } = getPlanConfig(plan)
  if (messageLimit === Infinity) return Infinity
  return Math.max(0, messageLimit - totalMessages)
}

/** Porcentagem de uso do plano (0–100). Útil para a barra de progresso no frontend. */
export function usagePercent(plan: string, totalMessages: number): number {
  const { messageLimit } = getPlanConfig(plan)
  if (messageLimit === Infinity) return 0
  return Math.min(100, Math.round((totalMessages / messageLimit) * 100))
}