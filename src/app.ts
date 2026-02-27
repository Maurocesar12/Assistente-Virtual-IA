import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import path from 'path'
import { fileURLToPath } from 'url'
import { env } from './config/env.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { botsRouter } from './routes/bots.js'
import { conversationsRouter } from './routes/conversations.js'
import { errorHandler } from './middleware/errorHandler.js'

// ─── Dirname helper (ESM) ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── App ──────────────────────────────────────────────────────────────────────

export function createApp() {
  const app = express()

  // ── Global middleware ────────────────────────────────────────────────────

  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
    })
  )

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
    })
  )

  // ── Health check ─────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV })
  })

  // ── API routes ────────────────────────────────────────────────────────────

  app.use('/api/auth', authRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/bots', botsRouter)
  app.use('/api/conversations', conversationsRouter)

  // ── Serve frontend ────────────────────────────────────────────────────────

  const publicDir = path.join(__dirname, '..', 'public')
  app.use(express.static(publicDir))

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' })
    res.sendFile(path.join(publicDir, 'index.html'))
  })

  // ── Error handler (must be last) ──────────────────────────────────────────

  app.use(errorHandler)

  return app
}
