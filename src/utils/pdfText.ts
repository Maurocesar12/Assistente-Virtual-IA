import zlib from 'zlib'
import { ApiError } from './http.js'

const MAX_PDF_BYTES = 3 * 1024 * 1024
const MAX_EXTRACTED_CHARS = 30_000

function decodePdfLiteral(input: string): string {
  let output = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char !== '\\') {
      output += char
      continue
    }

    const next = input[++i]
    if (!next) break
    if (next === 'n') output += '\n'
    else if (next === 'r') output += '\r'
    else if (next === 't') output += '\t'
    else if (next === 'b') output += '\b'
    else if (next === 'f') output += '\f'
    else if (/[0-7]/.test(next)) {
      let octal = next
      for (let j = 0; j < 2 && /[0-7]/.test(input[i + 1] ?? ''); j++) octal += input[++i]
      output += String.fromCharCode(parseInt(octal, 8))
    } else {
      output += next
    }
  }
  return output
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  if (!clean) return ''
  const even = clean.length % 2 === 0 ? clean : `${clean}0`
  const bytes = Buffer.from(even, 'hex')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes.readUInt16BE(i))
    return text
  }
  return bytes.toString('utf8')
}

function extractStrings(text: string): string[] {
  const chunks: string[] = []
  const literalPattern = /\((?:\\.|[^\\()]){2,}\)/g
  const hexPattern = /(?<!<)<([0-9a-fA-F\s]{4,})>(?!>)/g

  for (const match of text.matchAll(literalPattern)) {
    chunks.push(decodePdfLiteral(match[0].slice(1, -1)))
  }
  for (const match of text.matchAll(hexPattern)) {
    chunks.push(decodeHexString(match[1]))
  }

  return chunks
}

function inflateMaybe(stream: Buffer): Buffer {
  try { return zlib.inflateSync(stream) } catch (_) {}
  try { return zlib.inflateRawSync(stream) } catch (_) {}
  return stream
}

function extractStreamBuffers(pdf: Buffer): Buffer[] {
  const buffers: Buffer[] = []
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  let offset = 0

  while (offset < pdf.length) {
    const start = pdf.indexOf(marker, offset)
    if (start < 0) break
    let contentStart = start + marker.length
    if (pdf[contentStart] === 0x0d && pdf[contentStart + 1] === 0x0a) contentStart += 2
    else if (pdf[contentStart] === 0x0a) contentStart += 1

    const end = pdf.indexOf(endMarker, contentStart)
    if (end < 0) break
    let contentEnd = end
    while (contentEnd > contentStart && [0x0d, 0x0a, 0x20].includes(pdf[contentEnd - 1])) contentEnd--
    buffers.push(pdf.subarray(contentStart, contentEnd))
    offset = end + endMarker.length
  }

  return buffers
}

export function extractPdfTextFromBase64(fileBase64: string): { text: string; sizeBytes: number } {
  const clean = fileBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '')
  const pdf = Buffer.from(clean, 'base64')

  if (pdf.length > MAX_PDF_BYTES) {
    throw ApiError.badRequest('PDF muito grande. Envie um arquivo de ate 3MB.', 'PDF_TOO_LARGE')
  }
  if (!pdf.subarray(0, 8).toString('latin1').includes('%PDF')) {
    throw ApiError.badRequest('Arquivo PDF invalido.', 'INVALID_PDF')
  }

  const pieces: string[] = []
  pieces.push(...extractStrings(pdf.toString('latin1')))

  for (const stream of extractStreamBuffers(pdf)) {
    const decoded = inflateMaybe(stream)
    pieces.push(...extractStrings(decoded.toString('latin1')))
  }

  const text = pieces
    .join(' ')
    .replace(/\u0000/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS)

  if (text.length < 20) {
    throw ApiError.badRequest('Nao foi possivel extrair texto deste PDF. Tente enviar um PDF com texto selecionavel ou cole o conteudo como texto.', 'PDF_TEXT_EXTRACTION_FAILED')
  }

  return { text, sizeBytes: pdf.length }
}
