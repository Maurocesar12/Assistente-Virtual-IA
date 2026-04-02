/**
 * checkPlanLimit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mantido por retrocompatibilidade. A proteção HTTP canônica foi movida para
 * `middleware/planGuard.ts` que é aplicada diretamente nas rotas.
 *
 * `assertPlanAllowsMessage` ainda é útil para verificações imperativas fora
 * do pipeline Express (ex: testes, scripts de migração).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../models/database.js'
import { isMessageLimitReached, getPlanConfig } from '../utils/planLimits.js'
import { ApiError } from '../utils/http.js'

/**
 * Lança ApiError 402 se o usuário atingiu o limite do plano.
 * Use em código imperativo fora do pipeline de middlewares.
 */
export async function assertPlanAllowsMessage(userId: string): Promise<void> {
  const user = await db.findUserById(userId)
  if (!user) throw ApiError.unauthorized('Usuário não encontrado')

  const stats = await db.getUserStats(userId)

  if (isMessageLimitReached(user.plan, stats.totalMessages)) {
    const config = getPlanConfig(user.plan)
    throw ApiError.badRequest(
      `Limite de ${config.messageLimit} mensagens do plano ${config.label} atingido. Faça upgrade para continuar.`,
      'PLAN_LIMIT_REACHED'
    )
  }
}

// Re-exporta planGuard para quem importava checkPlanLimit como middleware Express
export { planGuard as checkPlanLimit } from '../middleware/planGuard.js'