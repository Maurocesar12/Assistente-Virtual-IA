import { Router } from 'express'
import { z } from 'zod'
import { db } from '../models/database.js'
import { hashPassword, comparePassword, signToken, sanitizeUser } from '../utils/auth.js'
import { ApiError, ok, created } from '../utils/http.js'
import { validate } from '../middleware/validate.js'
import { authenticate } from '../middleware/authenticate.js'

export const authRouter = Router()

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  plan: z.enum(['starter', 'pro', 'enterprise']).default('starter'),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// ─── POST /auth/register ──────────────────────────────────────────────────────

authRouter.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const { name, lastName, email, password, plan } = req.body

    // 1. ADICIONADO AWAIT
    const existing = await db.findUserByEmail(email)
    if (existing) throw ApiError.conflict('Email already in use')

    const passwordHash = await hashPassword(password)

    // 2. ADICIONADO AWAIT
    const user = await db.createUser({
      name,
      lastName,
      email,
      passwordHash,
      plan,
      apiKeys: {},
    })

    const token = signToken(user)

    return created(res, { user: sanitizeUser(user), token })
  } catch (err) {
    next(err)
  }
})

// ─── POST /auth/login ─────────────────────────────────────────────────────────

authRouter.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body

    // 3. ADICIONADO AWAIT
    const user = await db.findUserByEmail(email)
    if (!user) throw ApiError.unauthorized('Invalid credentials')

    const valid = await comparePassword(password, user.passwordHash)
    if (!valid) throw ApiError.unauthorized('Invalid credentials')

    const token = signToken(user)

    return ok(res, { user: sanitizeUser(user), token })
  } catch (err) {
    next(err)
  }
})

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

// 4. ADICIONADO ASYNC NA FUNÇÃO
authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    // 5. ADICIONADO AWAIT
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('User not found')
    return ok(res, sanitizeUser(user))
  } catch (err) {
    next(err)
  }
})