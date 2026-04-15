/**
 * encrypt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * P
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH  = 12  // 96 bits — recomendado pelo NIST para GCM
const TAG_LENGTH = 16  // 128 bits — tamanho padrão da GCM authentication tag

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw || raw.length !== 64) {
    throw new Error(
      '[Encryption] ENCRYPTION_KEY deve ser um hex de 64 caracteres (32 bytes).\n' +
      'Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return Buffer.from(raw, 'hex')
}

/**
 * Criptografa uma string com AES-256-GCM.
 * Retorna: "<iv_hex>:<tag_hex>:<ciphertext_hex>"
 * Todos os componentes necessários para descriptografar ficam juntos.
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext

  const key = getKey()
  const iv  = crypto.randomBytes(IV_LENGTH)

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Descriptografa um valor criado por encrypt().
 * Verifica a authentication tag — detecta adulteração.
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext

  // Se não está no formato esperado, assumir texto legado (não criptografado)
  // Isso permite migração gradual sem quebrar dados existentes
  if (!ciphertext.includes(':')) return ciphertext

  const parts = ciphertext.split(':')
  if (parts.length !== 3) return ciphertext  // formato inválido — retorna como está

  const [ivHex, tagHex, encryptedHex] = parts

  try {
    const key       = getKey()
    const iv        = Buffer.from(ivHex, 'hex')
    const tag       = Buffer.from(tagHex, 'hex')
    const encrypted = Buffer.from(encryptedHex, 'hex')

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
  } catch (err) {
    // Tag inválida = dados adulterados ou chave errada
    throw new Error('[Encryption] Falha ao descriptografar — dados corrompidos ou chave inválida')
  }
}

/**
 * Criptografa todas as API keys de um objeto ApiKeys.
 * Apenas strings não-vazias são criptografadas.
 */
export function encryptApiKeys(keys: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(keys)) {
    if (v && typeof v === 'string' && v.trim()) {
      result[k] = encrypt(v)
    }
  }
  return result
}

/**
 * Descriptografa todas as API keys de um objeto.
 * Valores que não estão no formato criptografado são retornados como estão
 * (compatibilidade com dados legados não criptografados).
 */
export function decryptApiKeys(keys: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(keys)) {
    if (v && typeof v === 'string') {
      result[k] = decrypt(v)
    }
  }
  return result
}