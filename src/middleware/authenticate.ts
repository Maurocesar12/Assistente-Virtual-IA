import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/auth.js'
import { db, type User } from '../models/database.js'
import { ApiError } from '../utils/http.js'

declare global {
  namespace Express {
    interface Request {
      userId: string
      authUser?: User
    }
  }
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
])

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)

  if (req.cookies?.zapgpt_token) return req.cookies.zapgpt_token

  return undefined
}

function canUseTemporaryPasswordSession(req: Request): boolean {
  const path = req.originalUrl.split('?')[0]
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(path)
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractToken(req)
    if (!token) throw ApiError.unauthorized('No token provided')

    const payload = verifyToken(token)
    const user = await db.findUserById(payload.sub)
    if (!user) throw ApiError.unauthorized('User not found')

    if (user.mustChangePassword && !canUseTemporaryPasswordSession(req)) {
      throw ApiError.forbidden(
        'Troque sua senha temporaria antes de continuar.',
        'PASSWORD_CHANGE_REQUIRED',
      )
    }

    req.userId = user.id
    req.authUser = user
    next()
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.unauthorized())
  }
}
