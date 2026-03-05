import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { hashPassword, comparePassword, signToken, sanitizeUser } from '../utils/auth.js'
import { ApiError, ok, created } from '../utils/http.js'
import { validate } from '../middleware/validate.js'
import { authenticate } from '../middleware/authenticate.js'
import { env } from '../config/env.js'

export const authRouter = Router()

// ─── Cookie helper ────────────────────────────────────────────────────────────

const COOKIE_NAME = 'zapgpt_token'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 dias em ms

function setAuthCookie(res: import('express').Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,                                    // ✅ JS do front NÃO consegue ler
    secure: env.NODE_ENV === 'production',             // ✅ HTTPS apenas em prod
    sameSite: 'lax',                                   // ✅ Protege contra CSRF básico
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name:     z.string().min(2),
  lastName: z.string().min(2),
  email:    z.string().email(),
  password: z.string().min(8),
  plan:     z.enum(['starter', 'pro', 'enterprise']).default('starter'),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

// ─── POST /auth/register ──────────────────────────────────────────────────────

authRouter.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { name, lastName, email, password, plan } = req.body
    const existing = await db.findUserByEmail(email)
    if (existing) throw ApiError.conflict('Email already in use')

    const passwordHash = await hashPassword(password)
    const user = await db.createUser({
      name, lastName, email, passwordHash, plan,
      apiKeys: {}, mustChangePassword: false,
    })

    const token = signToken(user)

    // ✅ Seta cookie httpOnly — EventSource vai enviá-lo automaticamente
    setAuthCookie(res, token)

    return created(res, { user: sanitizeUser(user), token })
  } catch (err) {
    next(err)
  }
})

// ─── POST /auth/login ─────────────────────────────────────────────────────────

authRouter.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body

    const user = await db.findUserByEmail(email)
    if (!user) throw ApiError.unauthorized('Credenciais inválidas')

    // 1. Tenta senha normal
    const validNormal = await comparePassword(password, user.passwordHash)

    // 2. Tenta senha temporária
    let loginViaTempPassword = false
    if (!validNormal) {
      const pendingTokens = await db.findPendingResetTokensForUser(user.id)
      for (const t of pendingTokens) {
        const validTemp = await comparePassword(password, t.tempPasswordHash)
        if (validTemp) {
          await db.markResetTokenUsed(t.id)
          await db.updateUser(user.id, { passwordHash: t.tempPasswordHash, mustChangePassword: true })
          loginViaTempPassword = true
          break
        }
      }
    }

    if (!validNormal && !loginViaTempPassword) {
      throw ApiError.unauthorized('Credenciais inválidas')
    }

    const freshUser = await db.findUserById(user.id)
    if (!freshUser) throw ApiError.unauthorized('Usuário não encontrado')

    const token = signToken(freshUser)

    // ✅ Seta cookie httpOnly
    setAuthCookie(res, token)

    return ok(res, {
      user:               sanitizeUser(freshUser),
      token,
      mustChangePassword: freshUser.mustChangePassword,
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', (_req, res) => {
  // ✅ Limpa o cookie de autenticação
  res.clearCookie(COOKIE_NAME, { path: '/' })
  return ok(res, { message: 'Logged out' })
})

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(user))
  } catch (err) {
    next(err)
  }
})