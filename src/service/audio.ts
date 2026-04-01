import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { type ApiKeys } from '../models/database.js'

// ═══════════════════════════════════════════════════════
// AUDIO TRANSCRIPTION SERVICE
// ═══════════════════════════════════════════════════════
//
// Prioridade:
//   1. Whisper (OpenAI) — mais preciso para PT-BR, aceita ogg/opus nativo
//   2. Gemini 1.5 Flash  — áudio inline base64, não precisa de arquivo
//   3. Fallback amigável — avisa o usuário no WhatsApp

export type TranscriptionResult =
  | { success: true;  text: string }
  | { success: false; reason: 'no_api_key' | 'transcription_failed' | 'empty_audio' }

// ── Whisper (OpenAI) ──────────────────────────────────────────────────────────

async function transcribeWithWhisper(
  audioBuffer: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const openai = new OpenAI({ apiKey })

  // Determina extensão pelo mime type
  // O WhatsApp envia ptt como ogg/opus — Whisper aceita sem conversão
  const ext = mimeType.includes('ogg')  ? 'ogg'
             : mimeType.includes('mp4') ? 'mp4'
             : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
             : 'ogg' // fallback — WhatsApp usa ogg/opus

  const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType })

  const response = await openai.audio.transcriptions.create({
    file,
    model:    'whisper-1',
    language: 'pt-br',   // força português → melhor precisão
  })

  const text = response.text?.trim()
  if (!text) throw new Error('Whisper retornou transcrição vazia')
  return text
}

// ── Gemini 1.5 Flash (Google) ─────────────────────────────────────────────────

async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey)
  // gemini-1.5-flash suporta áudio inline até 20MB
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

  const base64Audio = audioBuffer.toString('base64')

  const result = await model.generateContent([
    {
      inlineData: {
        data:     base64Audio,
        mimeType: mimeType as any,
      },
    },
    // Instrução direta: só transcrever, sem comentários extras
    'Transcreva exatamente o que está sendo dito neste áudio em português. ' +
    'Retorne apenas o texto transcrito, sem explicações ou comentários adicionais.',
  ])

  const text = result.response.text()?.trim()
  if (!text) throw new Error('Gemini retornou transcrição vazia')
  return text
}

// ── Função principal exportada ────────────────────────────────────────────────

/**
 * Transcreve um Buffer de áudio usando Whisper ou Gemini.
 *
 * @param audioBuffer  Bytes do arquivo de áudio
 * @param mimeType     MIME type (ex: "audio/ogg; codecs=opus")
 * @param apiKeys      Chaves de API do usuário
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  apiKeys: ApiKeys,
): Promise<TranscriptionResult> {
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn('[Audio] Buffer de áudio vazio')
    return { success: false, reason: 'empty_audio' }
  }

  // Normaliza o MIME type — WhatsApp usa variações e sufixos de codec
  const normalizedMime = mimeType.includes('ogg')
    ? 'audio/ogg'
    : mimeType.includes('mp4') || mimeType.includes('m4a')
    ? 'audio/mp4'
    : mimeType.includes('mpeg') || mimeType.includes('mp3')
    ? 'audio/mpeg'
    : 'audio/ogg'  // padrão para ptt do WhatsApp

  console.log(`[Audio] Tamanho: ${(audioBuffer.length / 1024).toFixed(1)}KB | MIME: ${normalizedMime}`)

  // 1. Tenta Whisper se houver chave OpenAI
  if (apiKeys.openaiKey) {
    try {
      console.log('[Audio] Tentando Whisper (OpenAI)...')
      const text = await transcribeWithWhisper(audioBuffer, normalizedMime, apiKeys.openaiKey)
      console.log(`[Audio] ✅ Whisper transcreveu: "${text.slice(0, 80)}"`)
      return { success: true, text }
    } catch (err) {
      console.warn('[Audio] Whisper falhou:', (err as any)?.message)
    }
  }

  // 2. Tenta Gemini se houver chave Gemini
  if (apiKeys.geminiKey) {
    try {
      console.log('[Audio] Tentando Gemini Flash...')
      const text = await transcribeWithGemini(audioBuffer, normalizedMime, apiKeys.geminiKey)
      console.log(`[Audio] ✅ Gemini transcreveu: "${text.slice(0, 80)}"`)
      return { success: true, text }
    } catch (err) {
      console.warn('[Audio] Gemini falhou:', (err as any)?.message)
    }
  }

  // 3. Sem chaves disponíveis
  if (!apiKeys.openaiKey && !apiKeys.geminiKey) {
    console.warn('[Audio] Nenhuma chave de API configurada para transcrição')
    return { success: false, reason: 'no_api_key' }
  }

  return { success: false, reason: 'transcription_failed' }
}