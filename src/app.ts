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
import { errorHandler } from './middleware/errorHandler.js'

export function createApp() {
  const app = express()

  app.set('trust proxy', 1)

  // ── [SEC-1] Helmet — headers de segurança HTTP ──────────────────────────────
  // Protege contra: clickjacking (X-Frame-Options), MIME sniffing,
  // XSS reflection, Strict-Transport-Security, e dezenas de outros vetores.
  // Remove também o header X-Powered-By que expõe a tecnologia do servidor.
  app.use(helmet({
    contentSecurityPolicy: false, // API REST pura — CSP seria para HTML servido pelo backend
    crossOriginEmbedderPolicy: false,
  }))

  // ── [SEC-2] CORS sem localhost em produção ───────────────────────────────────
  // localhost só é permitido em desenvolvimento.
  // Em produção, apenas o domínio Netlify registrado tem acesso.
  const ALLOWED_ORIGINS = new Set([
    'https://virtualassisente.netlify.app',
    // Adicione outros domínios de produção aqui se necessário
  ])

  app.use(cors({
    origin: (origin, callback) => {
      // Sem origin = ferramentas como Postman/curl — permitido (útil para testes internos)
      if (!origin) return callback(null, true)

      // Em desenvolvimento: permite localhost
      if (env.NODE_ENV === 'development' && origin.includes('localhost')) {
        return callback(null, true)
      }

      // Em produção: apenas origens explicitamente autorizadas
      if (ALLOWED_ORIGINS.has(origin) || origin.endsWith('.netlify.app')) {
        return callback(null, true)
      }

      callback(new Error(`CORS: origem não autorizada — ${origin}`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }))

  // ── [SEC-3] Cookie-parser — necessário para req.cookies funcionar ────────────
  // Sem este middleware, req.cookies é sempre undefined e a autenticação
  // via cookie httpOnly falha silenciosamente.
  app.use(cookieParser())

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))

  // ── [SEC-4] Rate limits em camadas ──────────────────────────────────────────

  // Rate limit estrito para rotas de autenticação — previne brute force e spam
  // de criação de contas. Mais restritivo que o limite global.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 20,                   // 20 tentativas por IP a cada 15min
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { message: 'Muitas tentativas. Aguarde 15 minutos.', code: 'RATE_LIMITED' },
    },
    // Ignora IPs internos/confiáveis se necessário
    skip: (req) => {
      // Não pular nada em produção — todos submetem ao rate limit
      return false
    },
  })

  // Rate limit geral para a API
  const apiLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // SSE (conexão permanente) e health check ficam isentos
      if (req.path.endsWith('/events')) return true
      if (req.path === '/health') return true
      if (!req.path.startsWith('/api')) return true
      return false
    },
    message: { success: false, error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
  })

  // Rate limit específico para SSE — evita flood de conexões abertas
  const sseLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minuto
    max: 10,              // máx 10 conexões SSE por IP por minuto
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.path.endsWith('/events'),
    message: { success: false, error: { message: 'Too many SSE connections', code: 'RATE_LIMITED' } },
  })

  app.use(apiLimiter)
  app.use(sseLimiter)

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
    // [SEC-5] Removido env.NODE_ENV do health check — não expor info do ambiente
  })

  // Auth routes — com rate limit estrito
  app.use('/api/auth', authLimiter, authRouter)
  app.use('/api/auth', authLimiter, authResetRouter)

  app.use('/api/users', usersRouter)
  app.use('/api/bots', botsRouter)
  app.use('/api/conversations', conversationsRouter)

  app.use('*', (_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' })
  })

  app.use(errorHandler)
  return app
}