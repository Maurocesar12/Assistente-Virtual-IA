import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { db } from '../models/database.js'
import { hashPassword } from '../utils/auth.js'
import { ApiError, ok } from '../utils/http.js'
import { validate } from '../middleware/validate.js'
import { authenticate } from '../middleware/authenticate.js'
import {
  generateTempPassword,
  generateResetToken,
  hashToken,
  tokenExpiresAt,
  RESET_TOKEN_EXPIRES_MINUTES,
} from '../utils/passwordReset.js'
import { sendPasswordResetEmail } from '../service/email.js'

export const authResetRouter = Router()

// ─── Rate limit específico para esta rota ─────────────────────────────────────
// Máximo 5 tentativas por IP a cada 60 minutos — evita abuso/enumeração
const forgotRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: 'Muitas solicitações. Aguarde 1 hora e tente novamente.',
      code: 'RATE_LIMITED',
    },
  },
})

// ─── Schemas ──────────────────────────────────────────────────────────────────

const forgotSchema = z.object({
  email: z.string().email('Email inválido'),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Senha atual obrigatória'),
  newPassword:     z.string().min(8, 'Nova senha deve ter pelo menos 8 caracteres'),
})

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// SEGURANÇA: sempre responde com sucesso, mesmo se o email não existir
// Isso evita enumeração de emails cadastrados (user enumeration attack)

authResetRouter.post(
  '/forgot-password',
  forgotRateLimit,
  validate(forgotSchema),
  async (req, res, next) => {
    try {
      const { email } = req.body

      // Resposta idêntica para email existente e não existente
      const genericOk = () =>
        ok(res, {
          message:
            'Se este email estiver cadastrado, você receberá a senha temporária em instantes.',
        })

      const user = await db.findUserByEmail(email)
      if (!user) return genericOk() // Não revela que email não existe

      // Invalida tokens anteriores não utilizados do mesmo usuário
      await db.invalidatePreviousResetTokens(user.id)

      // Gera senha temporária (o usuário vai usá-la para fazer login)
      const tempPassword = generateTempPassword()
      const tempPasswordHash = await hashPassword(tempPassword)

      // Salva token de rastreamento (hash) para invalidação após uso
      const { hash: tokenHash } = generateResetToken()
      const expiresAt = tokenExpiresAt()

      await db.createPasswordResetToken({
        userId:       user.id,
        tokenHash,
        expiresAt,
        tempPasswordHash,
      })

      // Envia email com a senha temporária em texto puro
      await sendPasswordResetEmail({
        to:             user.email,
        userName:       user.name,
        tempPassword,
        expiresMinutes: RESET_TOKEN_EXPIRES_MINUTES,
      })

      console.log(`[Auth] Password reset requested for ${user.email}`)
      return genericOk()
    } catch (err) {
      // Nunca expõe detalhes de erro nesta rota
      console.error('[Auth] forgot-password error:', err)
      next(err)
    }
  }
)

// ─── POST /auth/change-password ───────────────────────────────────────────────
// Rota autenticada — usuário logado com senha temporária troca para permanente

authResetRouter.post(
  '/change-password',
  authenticate,               // ✅ JWT obrigatório — injeta req.userId
  validate(changePasswordSchema),
  async (req, res, next) => {
    try {
      const userId = (req as any).userId
      if (!userId) throw ApiError.unauthorized()

      const { currentPassword, newPassword } = req.body

      const user = await db.findUserById(userId)
      if (!user) throw ApiError.notFound('Usuário não encontrado')

      // Verifica senha atual
      const { comparePassword } = await import('../utils/auth.js')
      const valid = await comparePassword(currentPassword, user.passwordHash)
      if (!valid) throw ApiError.badRequest('Senha atual incorreta', 'WRONG_PASSWORD')

      if (currentPassword === newPassword) {
        throw ApiError.badRequest(
          'A nova senha não pode ser igual à senha atual',
          'SAME_PASSWORD'
        )
      }

      // Atualiza para a nova senha
      const newHash = await hashPassword(newPassword)
      await db.updateUser(userId, { passwordHash: newHash, mustChangePassword: false })

      // Invalida qualquer token de reset pendente
      await db.invalidatePreviousResetTokens(userId)

      console.log(`[Auth] Password changed for user ${userId}`)
      return ok(res, { message: 'Senha alterada com sucesso!' })
    } catch (err) {
      next(err)
    }
  }
)