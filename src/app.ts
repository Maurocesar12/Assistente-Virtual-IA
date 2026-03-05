import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import path from 'path'
import { fileURLToPath } from 'url'
import { env } from './config/env.js'
import { authRouter } from './routes/auth.js'
import { authResetRouter } from './routes/authReset.js'
import { usersRouter } from './routes/users.js'
import { botsRouter } from './routes/bots.js'
import { conversationsRouter } from './routes/conversations.js'
import { errorHandler } from './middleware/errorHandler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp() {
  const app = express()

  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  // ── Rate limit em camadas ───────────────────────────────────────────────────
  // SSE (/bots/:id/events) e health ficam isentos — são conexões longas/keep-alive
  // que não representam abuso e disparariam o limite rapidamente.
  // Rotas de auth têm limite próprio mais restritivo.
  // Demais rotas API: 2000 req / 15min por IP (generoso para uso real do dashboard).

  const apiLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // Isenta SSE (conexão permanente), health check, e arquivos estáticos
      if (req.path.endsWith('/events')) return true
      if (req.path === '/health') return true
      if (!req.path.startsWith('/api')) return true
      return false
    },
    message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
  })
  app.use(apiLimiter)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV })
  })

  // Auth routes (públicas + autenticadas)
  app.use('/api/auth', authRouter)
  app.use('/api/auth', authResetRouter) // change-password já tem authenticate interno

  app.use('/api/users', usersRouter)
  app.use('/api/bots', botsRouter)
  app.use('/api/conversations', conversationsRouter)

  // Frontend estático
  const publicDir = path.join(__dirname, '..', '/Front-End/public')
  app.use(express.static(publicDir))
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' })
    res.sendFile(path.join(publicDir, 'index.html'))
  })

  app.use(errorHandler)
  return app
}