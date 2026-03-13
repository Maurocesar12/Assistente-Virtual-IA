import type { Request, Response, NextFunction } from 'express'
import { db } from '../models/database.js'
import { isMessageLimitReached } from '../utils/planLimits.js'
import { ApiError } from '../utils/http.js'

/**
 * Middleware que verifica o limite de mensagens do plano antes de processar
 * qualquer rota que consuma mensagens (ex: resposta de IA via WhatsApp).
 *
 * Uso nas rotas HTTP internas (bots, whatsapp service) — não é um middleware
 * Express de rota, mas uma função utilitária chamada de dentro do serviço.
 */
export async function assertPlanAllowsMessage(userId: string): Promise<void> {
  const user = await db.findUserById(userId)
  if (!user) throw ApiError.unauthorized('Usuário não encontrado')

  const stats = await db.getUserStats(userId)

  if (isMessageLimitReached(user.plan, stats.totalMessages)) {
    throw ApiError.badRequest(
      `Limite de mensagens do plano ${user.plan} atingido. Faça upgrade para continuar.`,
      'PLAN_LIMIT_REACHED'
    )
  }
}

/**
 * Middleware Express para rotas de API que podem ser bloqueadas por limite de plano.
 * Retorna 402 Payment Required com código PLAN_LIMIT_REACHED.
 */
export function checkPlanLimit() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId
      if (!userId) return next()

      const user = await db.findUserById(userId)
      if (!user) return next()

      const stats = await db.getUserStats(userId)

      if (isMessageLimitReached(user.plan, stats.totalMessages)) {
        return res.status(402).json({
          success: false,
          error: {
            message: `Limite de ${stats.totalMessages} mensagens do plano gratuito atingido. Faça upgrade para continuar.`,
            code:    'PLAN_LIMIT_REACHED',
            data: {
              plan:          user.plan,
              totalMessages: stats.totalMessages,
            },
          },
        })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}