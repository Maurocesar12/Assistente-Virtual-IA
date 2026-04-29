import type { Request, Response, NextFunction } from 'express'
import { db } from '../models/database.js'
import { ApiError } from '../utils/http.js'
import { DEMO_READ_ONLY_ERROR, isDemoUser } from '../utils/demoUser.js'

export async function demoReadOnlyGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await db.findUserById(req.userId)
    if (!user) throw ApiError.notFound('Usuario nao encontrado')
    if (isDemoUser(user)) throw ApiError.forbidden(DEMO_READ_ONLY_ERROR)
    next()
  } catch (err) {
    next(err)
  }
}
