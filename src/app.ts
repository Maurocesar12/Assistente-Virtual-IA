import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
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

  // ✅ CORS com credentials: true — necessário para cookies funcionarem em
  //    requests cross-origin (ex.: front separado do back no futuro)
  app.use(cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }))

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))

  // ✅ Cookie parser — deve vir ANTES das rotas para req.cookies estar disponível
  //    no middleware authenticate (usado pelo SSE/EventSource)
  app.use(cookieParser())

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

  // Auth routes (públicas + autenticadas)
  app.use('/api/auth', authRouter)
  app.use('/api/auth', authResetRouter)

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