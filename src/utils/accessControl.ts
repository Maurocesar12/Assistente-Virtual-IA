import type { User } from '../models/database.js'
import { getPlanConfig, isMessageLimitReached } from './planLimits.js'
import { ApiError } from './http.js'

type AccessUser = Pick<User, 'plan' | 'subscriptionStatus'>
type UsageStats = { totalMessages: number }

export type AccessDecision =
  | { allowed: true }
  | {
      allowed: false
      statusCode: 402
      code: 'SUBSCRIPTION_PAST_DUE' | 'SUBSCRIPTION_INACTIVE' | 'PLAN_LIMIT_REACHED' | 'BOT_LIMIT_REACHED'
      message: string
      data: Record<string, unknown>
    }

const PAID_PLANS = new Set(['pro', 'enterprise'])
const BLOCKED_SUBSCRIPTION_STATUSES = new Set(['past_due', 'cancelled'])

function normalizeLimit(value: number) {
  return value === Infinity ? null : value
}

export function isSubscriptionBlocked(user: AccessUser): boolean {
  if (!PAID_PLANS.has(user.plan)) return false
  return BLOCKED_SUBSCRIPTION_STATUSES.has(user.subscriptionStatus || 'none')
}

export function evaluateAutomationAccess(user: AccessUser, stats: UsageStats): AccessDecision {
  if (isSubscriptionBlocked(user)) {
    const code = user.subscriptionStatus === 'past_due'
      ? 'SUBSCRIPTION_PAST_DUE'
      : 'SUBSCRIPTION_INACTIVE'

    return {
      allowed: false,
      statusCode: 402,
      code,
      message: 'Seu plano pago nao esta ativo. Renove a assinatura para reativar os bots.',
      data: {
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
      },
    }
  }

  if (isMessageLimitReached(user.plan, stats.totalMessages)) {
    const config = getPlanConfig(user.plan)

    return {
      allowed: false,
      statusCode: 402,
      code: 'PLAN_LIMIT_REACHED',
      message: [
        `Limite de ${config.messageLimit} mensagens do plano ${config.label} atingido.`,
        'Faca upgrade para continuar.',
      ].join(' '),
      data: {
        plan: user.plan,
        totalMessages: stats.totalMessages,
        messageLimit: normalizeLimit(config.messageLimit),
      },
    }
  }

  return { allowed: true }
}

export function evaluateBotCreationAccess(user: AccessUser, currentBotCount: number): AccessDecision {
  if (isSubscriptionBlocked(user)) {
    return {
      allowed: false,
      statusCode: 402,
      code: user.subscriptionStatus === 'past_due' ? 'SUBSCRIPTION_PAST_DUE' : 'SUBSCRIPTION_INACTIVE',
      message: 'Seu plano pago nao esta ativo. Renove a assinatura antes de criar novos bots.',
      data: {
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
      },
    }
  }

  const config = getPlanConfig(user.plan)
  if (config.botLimit !== Infinity && currentBotCount >= config.botLimit) {
    return {
      allowed: false,
      statusCode: 402,
      code: 'BOT_LIMIT_REACHED',
      message: `Limite de ${config.botLimit} bot${config.botLimit === 1 ? '' : 's'} do plano ${config.label} atingido.`,
      data: {
        plan: user.plan,
        totalBots: currentBotCount,
        botLimit: normalizeLimit(config.botLimit),
      },
    }
  }

  return { allowed: true }
}

export function accessDecisionToError(decision: AccessDecision): ApiError | null {
  if (decision.allowed) return null
  return ApiError.paymentRequired(decision.message, decision.code, decision.data)
}
