import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import type { User } from '../models/database.js'

// ─── Password ─────────────────────────────────────────────────────────────────

const SALT_ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  sub: string   // user id
  email: string
}

export function signToken(user: Pick<User, 'id' | 'email'>): string {
  return jwt.sign(
    { sub: user.id, email: user.email } satisfies TokenPayload,
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  )
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload
}

// ─── Safe user (strip password hash) ─────────────────────────────────────────

export function sanitizeUser(user: User) {
  const { passwordHash: _, ...safe } = user
  return safe
}
