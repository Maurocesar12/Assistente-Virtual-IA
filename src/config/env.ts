import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  FRONTEND_URL: z.string().url().default('https://virtualassisente.netlify.app/'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // [SEC-6] Chave de criptografia para API keys dos usuários
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY deve ser um hex de 64 caracteres (32 bytes)'),

  OPENAI_KEY: z.string().optional(),
  OPENAI_ASSISTANT: z.string().optional(),
  GEMINI_KEY: z.string().optional(),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().default(2000),

  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().min(1, 'SMTP_USER é obrigatório'),
  SMTP_PASS: z.string().min(1, 'SMTP_PASS é obrigatório'),
  SMTP_FROM: z.string().optional(),

  // ── AbacatePay ────────────────────────────────────────────────────────────
  // Obtenha em: https://app.abacatepay.com → Configurações → API Keys
  ABACATEPAY_API_KEY: z.string().min(1, 'ABACATEPAY_API_KEY é obrigatória'),

  // Opcional — assina os webhooks para verificação de autenticidade.
  // Configure em: https://app.abacatepay.com → Webhooks → Secret
  ABACATEPAY_WEBHOOK_SECRET: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌  Variáveis de ambiente inválidas:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env