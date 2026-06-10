import type { Request, Response, NextFunction } from 'express'
import { db } from '../models/database.js'
import { evaluateAutomationAccess } from '../utils/accessControl.js'

export async function planGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.userId
    if (!userId) { next(); return }

    const [user, stats] = await Promise.all([
      db.findUserById(userId),
      db.getUserStats(userId),
    ])

    if (!user) { next(); return }

    const decision = evaluateAutomationAccess(user, stats)
    if (decision.allowed) { next(); return }

    res.status(decision.statusCode).json({
      success: false,
      error: {
        message: decision.message,
        code:    decision.code,
        data:    decision.data,
      },
    })
  } catch (err) {
    console.error('[planGuard] erro ao verificar limite:', err)
    next()
  }
}
