import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { env } from './config/env.js'
import { authRouter } from './routes/auth.js'
import { authResetRouter } from './routes/authReset.js'
import { usersRouter } from './routes/users.js'
import { botsRouter } from './routes/bots.js'
import { conversationsRouter } from './routes/conversations.js'
import { billingRouter } from './routes/billing.js'
import { errorHandler } from './middleware/errorHandler.js'

export function createApp() {
  const app = express()

  app.set('trust proxy', 1)

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }))

  const ALLOWED_ORIGINS = new Set([
    'https://virtualassisente.netlify.app',
  ])

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)
      if (env.NODE_ENV === 'development' && origin.includes('localhost')) {
        return callback(null, true)
      }
      if (ALLOWED_ORIGINS.has(origin) || origin.endsWith('.netlify.app')) {
        return callback(null, true)
      }
      callback(new Error(`CORS: origem não autorizada — ${origin}`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }))

  app.use(cookieParser())

  // ⚠️ O webhook do AbacatePay precisa do body RAW para verificação de assinatura HMAC.
  // Registramos o parser de JSON com uma opção `verify` que salva o raw body
  // antes de parsear, acessível via req.rawBody nos webhooks.
  app.use(express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf },
  }))
  app.use(express.urlencoded({ extended: true }))

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { message: 'Muitas tentativas. Aguarde 15 minutos.', code: 'RATE_LIMITED' },
    },
    skip: () => false,
  })

  const apiLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      if (req.path.endsWith('/events')) return true
      if (req.path === '/health') return true
      if (!req.path.startsWith('/api')) return true
      return false
    },
    message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
  })

  const sseLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.path.endsWith('/events'),
    message: { success: false, error: { message: 'Too many SSE connections', code: 'RATE_LIMITED' } },
  })

  app.use(apiLimiter)
  app.use(sseLimiter)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use('/api/auth', authLimiter, authRouter)
  app.use('/api/auth', authLimiter, authResetRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/bots', botsRouter)
  app.use('/api/conversations', conversationsRouter)
  app.use('/api/billing', billingRouter)

  app.use('*', (_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' })
  })

  app.use(errorHandler)
  return app
}