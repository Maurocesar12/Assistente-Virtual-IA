import dns from 'dns/promises'
import net from 'net'
import { ApiError } from './http.js'

const MAX_LINK_BYTES = 1_000_000
const MAX_LINK_CHARS = 30_000

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) return true
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  )
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  return normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized === '::'
}

async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw ApiError.badRequest('URL invalida.', 'INVALID_URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw ApiError.badRequest('Use apenas links HTTP ou HTTPS.', 'INVALID_URL_PROTOCOL')
  }

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) {
    throw ApiError.badRequest('Links locais nao sao permitidos por seguranca.', 'PRIVATE_URL_BLOCKED')
  }

  const directIpVersion = net.isIP(host)
  if (directIpVersion === 4 && isPrivateIPv4(host)) {
    throw ApiError.badRequest('Links privados nao sao permitidos por seguranca.', 'PRIVATE_URL_BLOCKED')
  }
  if (directIpVersion === 6 && isPrivateIPv6(host)) {
    throw ApiError.badRequest('Links privados nao sao permitidos por seguranca.', 'PRIVATE_URL_BLOCKED')
  }

  const addresses = await dns.lookup(host, { all: true }).catch(() => [])
  for (const address of addresses) {
    if (address.family === 4 && isPrivateIPv4(address.address)) {
      throw ApiError.badRequest('Links privados nao sao permitidos por seguranca.', 'PRIVATE_URL_BLOCKED')
    }
    if (address.family === 6 && isPrivateIPv6(address.address)) {
      throw ApiError.badRequest('Links privados nao sao permitidos por seguranca.', 'PRIVATE_URL_BLOCKED')
    }
  }

  return url
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_LINK_BYTES) {
      reader.cancel().catch(() => {})
      throw ApiError.badRequest('Link muito grande para importar. Use um conteudo menor ou cole o trecho principal.', 'LINK_TOO_LARGE')
    }
    chunks.push(value)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function fetchPublicLinkText(rawUrl: string): Promise<string> {
  let url = await assertPublicHttpUrl(rawUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 7000)

  try {
    let response: Response | null = null
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'ZapiensKnowledgeBot/1.0' },
      })

      const location = response.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) break
      url = await assertPublicHttpUrl(new URL(location, url).href)
    }

    if (!response) {
      throw ApiError.badRequest('Nao foi possivel importar o link.', 'LINK_FETCH_FAILED')
    }

    if (!response.ok) {
      throw ApiError.badRequest(`Nao foi possivel importar o link. HTTP ${response.status}.`, 'LINK_FETCH_FAILED')
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_LINK_BYTES) {
      throw ApiError.badRequest('Link muito grande para importar. Use um conteudo menor ou cole o trecho principal.', 'LINK_TOO_LARGE')
    }

    const raw = await readLimitedText(response)
    const contentType = response.headers.get('content-type') ?? ''
    const text = contentType.includes('text/html') ? stripHtml(raw) : raw
    const normalized = text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_CHARS)

    if (normalized.length < 40) {
      throw ApiError.badRequest('Nao foi possivel encontrar texto util neste link. Cole o conteudo manualmente.', 'LINK_TEXT_EXTRACTION_FAILED')
    }

    return normalized
  } finally {
    clearTimeout(timer)
  }
}
