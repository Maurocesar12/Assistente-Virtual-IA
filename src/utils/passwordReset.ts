import crypto from 'crypto'

// ─── Constants ────────────────────────────────────────────────────────────────

export const RESET_TOKEN_EXPIRES_MINUTES = 15

// ─── Temporary password generator ────────────────────────────────────────────
// Gera senha temporária legível: ex. "Kf7#mQ2x"
// Evita caracteres ambíguos (0/O, 1/l/I) para melhor UX em email

const UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ'  // sem I, O
const LOWER  = 'abcdefghjkmnpqrstuvwxyz'   // sem i, l
const DIGITS = '23456789'                   // sem 0, 1
const SPECIAL = '#@!%'

export function generateTempPassword(length = 10): string {
  const pool = UPPER + LOWER + DIGITS + SPECIAL

  // Garante pelo menos 1 de cada categoria
  const pick = (chars: string) =>
    chars[crypto.randomInt(chars.length)]

  const required = [
    pick(UPPER),
    pick(UPPER),
    pick(LOWER),
    pick(LOWER),
    pick(DIGITS),
    pick(DIGITS),
    pick(SPECIAL),
  ]

  const remaining = Array.from(
    { length: length - required.length },
    () => pool[crypto.randomInt(pool.length)]
  )

  // Fisher-Yates shuffle para não ter padrão previsível
  const all = [...required, ...remaining]
  for (let i = all.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[all[i], all[j]] = [all[j], all[i]]
  }

  return all.join('')
}

// ─── Token (enviado por email / armazenamos o hash) ───────────────────────────

export function generateResetToken(): { raw: string; hash: string } {
  const raw  = crypto.randomBytes(32).toString('hex')          // 64 chars hex
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  return { raw, hash }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function tokenExpiresAt(): Date {
  const d = new Date()
  d.setMinutes(d.getMinutes() + RESET_TOKEN_EXPIRES_MINUTES)
  return d
}