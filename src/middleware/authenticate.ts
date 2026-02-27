import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/auth.js'
import { db } from '../models/database.js'
import { ApiError } from '../utils/http.js'

// ─── Extend Express Request ───────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      userId: string
    }
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer')) throw ApiError.unauthorized('No token provided')

    const token = authHeader.slice(7)
    const payload = verifyToken(token)

    const user = db.findUserById(payload.sub)
    if (!user) throw ApiError.unauthorized('User not found')

    req.userId = user.id
    next()
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.unauthorized())
  }
}
