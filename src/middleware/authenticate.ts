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

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    // Prioridade 1: header Authorization: Bearer <token>  (fetch normal)
    // Prioridade 2: query string ?token=  (EventSource/SSE — não suporta headers)
    // Prioridade 3: cookie httpOnly zapgpt_token  (fallback same-origin)
    let token: string | undefined

    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    } else if (typeof req.query.token === 'string' && req.query.token) {
      token = req.query.token
    } else if (req.cookies?.zapgpt_token) {
      token = req.cookies.zapgpt_token
    }

    if (!token) throw ApiError.unauthorized('No token provided')

    const payload = verifyToken(token)

    const user = await db.findUserById(payload.sub)
    if (!user) throw ApiError.unauthorized('User not found')

    req.userId = user.id
    next()
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.unauthorized())
  }
}