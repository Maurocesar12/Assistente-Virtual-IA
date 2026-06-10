import type { Request, Response, NextFunction } from 'express'
import { ApiError } from '../utils/http.js'
import { env } from '../config/env.js'

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        code:    err.code,
        ...(err.data ? { data: err.data } : {}),
      },
    })
  }

  if (err instanceof Error && err.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      error: {
        message: 'Validation error',
        code:    'VALIDATION_ERROR',
        details: (err as any).errors,
      },
    })
  }

  if (err instanceof Error && err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: { message: 'Invalid token', code: 'INVALID_TOKEN' },
    })
  }

  // [SEC-5] NUNCA expõe detalhes internos em produção.
  // Em desenvolvimento, loga o erro completo mas não envia ao cliente.
  console.error('[Unhandled Error]', err)

  return res.status(500).json({
    success: false,
    error: {
      // Mensagem genérica sempre — independente do NODE_ENV
      // Stack traces e detalhes de implementação nunca chegam ao cliente
      message: 'Internal server error',
      code:    'INTERNAL_ERROR',
    },
  })
}
