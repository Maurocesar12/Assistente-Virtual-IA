/**
 * routes/auth.ts — atualizado
 * Mudança: register aceita o plano escolhido, mas SEMPRE cria o usuário
 * como 'starter'. Se o usuário escolheu 'pro', o upgrade acontece
 * via AbacatePay após o pagamento (webhook). Isso evita que alguém
 * se registre como pro sem pagar simplesmente alterando o body da requisição.
 */

import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { hashPassword, comparePassword, signToken, sanitizeUser } from '../utils/auth.js'
import { ApiError, ok, created } from '../utils/http.js'
import { validate } from '../middleware/validate.js'
import { authenticate } from '../middleware/authenticate.js'
import { env } from '../config/env.js'

export const authRouter = Router()

const COOKIE_NAME = 'zapgpt_token'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function setAuthCookie(res: import('express').Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
}

const registerSchema = z.object({
  name:     z.string().min(2),
  lastName: z.string().min(2).default(''),
  email:    z.string().email(),
  password: z.string().min(8),
  // O plano escolhido é registrado como metadado, mas o usuário
  // sempre começa como 'starter'. O upgrade é feito via pagamento.
  planIntent: z.enum(['starter', 'pro']).default('starter'),
})

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

// ─── POST /auth/register ──────────────────────────────────────────────────────

authRouter.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { name, lastName, email, password, planIntent } = req.body
    const existing = await db.findUserByEmail(email)
    if (existing) throw ApiError.conflict('Email já cadastrado')

    const passwordHash = await hashPassword(password)
    // Sempre cria como starter — pagamento ativa pro via webhook
    const user = await db.createUser({
      name, lastName, email, passwordHash,
      plan: 'starter',
      apiKeys: {},
      mustChangePassword: false,
      subscriptionStatus: ''
    })

    const token = signToken(user)
    setAuthCookie(res, token)

    return created(res, {
      user: sanitizeUser(user),
      token,
      // Informa ao front se o usuário quis o pro, para abrir o checkout
      pendingUpgrade: planIntent === 'pro',
    })
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

    const validNormal = await comparePassword(password, user.passwordHash)

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
    setAuthCookie(res, token)

    return ok(res, {
      user: sanitizeUser(freshUser),
      token,
      mustChangePassword: freshUser.mustChangePassword,
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', (_req, res) => {
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