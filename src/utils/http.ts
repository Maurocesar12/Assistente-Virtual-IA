import type { Response } from 'express'

// ─── API Error ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(msg: string, code?: string, data?: unknown) {
    return new ApiError(400, msg, code, data)
  }

  static unauthorized(msg = 'Unauthorized') {
    return new ApiError(401, msg, 'UNAUTHORIZED')
  }

  static forbidden(msg = 'Forbidden', code = 'FORBIDDEN', data?: unknown) {
    return new ApiError(403, msg, code, data)
  }

  static paymentRequired(msg: string, code = 'PAYMENT_REQUIRED', data?: unknown) {
    return new ApiError(402, msg, code, data)
  }

  static notFound(msg: string) {
    return new ApiError(404, msg, 'NOT_FOUND')
  }

  static conflict(msg: string) {
    return new ApiError(409, msg, 'CONFLICT')
  }

  static internal(msg = 'Internal server error') {
    return new ApiError(500, msg, 'INTERNAL_ERROR')
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data })
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201)
}

export function noContent(res: Response) {
  return res.status(204).send()
}
