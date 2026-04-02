/**
 * planGuard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware Express que bloqueia QUALQUER requisição HTTP quando o usuário
 * autenticado atingiu o limite de mensagens do seu plano.
 *
 */

import type { Request, Response, NextFunction } from 'express'
import { db } from '../models/database.js'
import { getPlanConfig, isMessageLimitReached } from '../utils/planLimits.js'

export async function planGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.userId

    // `authenticate` deve rodar antes deste middleware — sem userId não há o
    // que verificar. Deixamos passar e o `authenticate` já teria bloqueado.
    if (!userId) { next(); return }

    const [user, stats] = await Promise.all([
      db.findUserById(userId),
      db.getUserStats(userId),
    ])

    if (!user) { next(); return }

    if (!isMessageLimitReached(user.plan, stats.totalMessages)) { next(); return }

    const config = getPlanConfig(user.plan)

    res.status(402).json({
      success: false,
      error: {
        message: [
          `Limite de ${config.messageLimit} mensagens do plano ${config.label} atingido.`,
          'Faça upgrade para continuar.',
        ].join(' '),
        code: 'PLAN_LIMIT_REACHED',
        data: {
          plan:          user.plan,
          totalMessages: stats.totalMessages,
          messageLimit:  config.messageLimit,
        },
      },
    })
  } catch (err) {
    // Em caso de erro de banco, não bloqueamos — o usuário merece ver o painel.
    // O whatsapp.ts tem sua própria verificação para o fluxo de mensagens.
    console.error('[planGuard] erro ao verificar limite:', err)
    next()
  }
}