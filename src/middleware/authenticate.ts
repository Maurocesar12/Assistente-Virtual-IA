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

export async function authenticate(req: Request, _res: Response, next: NextFunction) {  // ✅ async adicionado
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) throw ApiError.unauthorized('No token provided')  // ✅ espaço após Bearer

    const token = authHeader.slice(7)
    const payload = verifyToken(token)

    const user = await db.findUserById(payload.sub)  // ✅ await adicionado
    if (!user) throw ApiError.unauthorized('User not found')

    req.userId = user.id
    next()
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.unauthorized())
  }
}