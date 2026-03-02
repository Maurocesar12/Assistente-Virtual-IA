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
import { authenticate } from './middleware/authenticate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp() {
  const app = express()

  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
  }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV })
  })

  // Auth routes (públicas + reset)
  app.use('/api/auth', authRouter)
  app.use('/api/auth', authResetRouter)

  // Rota change-password precisa de autenticação
  app.post('/api/auth/change-password', authenticate, (req, res, next) => {
    // A lógica fica no authResetRouter mas o middleware authenticate é aplicado aqui
    // O router já tem a rota, então o authenticate é injetado via app.ts
    next()
  })

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