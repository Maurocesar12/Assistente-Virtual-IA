// ─── Plan Definitions ─────────────────────────────────────────────────────────
// Fonte única de verdade para regras de plano.
// Para mudar limites, altere APENAS aqui.

export type Plan = 'starter' | 'pro' | 'enterprise'

export interface PlanConfig {
  label:          string
  price:          number        // R$ por mês (0 = grátis)
  messageLimit:   number        // Infinity = sem limite
  botLimit:       number        // máx de bots criados
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
    price:        10.99,
    messageLimit: Infinity,
    botLimit:     5,
  },
  enterprise: {
    label:        'Enterprise',
    price:        0,           // custom / faturamento separado
    messageLimit: Infinity,
    botLimit:     Infinity,
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getPlanConfig(plan: string): PlanConfig {
  return PLAN_CONFIG[plan as Plan] ?? PLAN_CONFIG.starter
}

/**
 * Retorna true se o usuário atingiu ou ultrapassou o limite de mensagens.
 */
export function isMessageLimitReached(plan: string, totalMessages: number): boolean {
  const { messageLimit } = getPlanConfig(plan)
  return messageLimit !== Infinity && totalMessages >= messageLimit
}

/**
 * Retorna quantas mensagens restam (nunca negativo).
 */
export function remainingMessages(plan: string, totalMessages: number): number {
  const { messageLimit } = getPlanConfig(plan)
  if (messageLimit === Infinity) return Infinity
  return Math.max(0, messageLimit - totalMessages)
}

/**
 * Porcentagem de uso do plano (0–100). Útil para a barra de progresso.
 */
export function usagePercent(plan: string, totalMessages: number): number {
  const { messageLimit } = getPlanConfig(plan)
  if (messageLimit === Infinity) return 0
  return Math.min(100, Math.round((totalMessages / messageLimit) * 100))
}