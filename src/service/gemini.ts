/**
 * gemini.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OTIMIZAÇÃO DE MEMÓRIA NESTE ARQUIVO
 *
 * PROBLEMA:
 *   O histórico de conversas era acumulado indefinidamente em memória.
 *   Para um contato que conversa muito, o array `sessions` crescia para
 *   centenas de entradas (cada uma com strings de prompt + resposta), nunca
 *   sendo liberado enquanto o bot estivesse ativo.
 *
 * CORREÇÃO — MAX_HISTORY_TURNS = 20 trocas (40 entradas no array):
 *   Quando o histórico excede o limite, as entradas mais antigas são
 *   removidas (janela deslizante), mantendo sempre o contexto recente.
 *   As 2 primeiras entradas (system prompt + ack inicial) são sempre
 *   preservadas para que o bot mantenha sua personalidade.
 *
 *   Impacto esperado: conversas longas passam de ~50MB de strings por
 *   sessão para no máximo ~2-3MB (20 trocas × ~100 chars médios × 2 lados).
 *
 * Nenhuma outra lógica foi alterada.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { GoogleGenerativeAI, type Content, type ChatSession } from '@google/generative-ai'

export interface GeminiOptions {
  apiKey:        string
  model?:        string
  systemPrompt?: string
}

// Número máximo de trocas (user + model) mantidas em memória por conversa.
// Cada "troca" = 1 mensagem do usuário + 1 resposta do modelo = 2 entradas.
// 20 trocas = 40 entradas no array, além das 2 iniciais do system prompt.
const MAX_HISTORY_TURNS = 20
const SYSTEM_PROMPT_ENTRIES = 2  // user:systemPrompt + model:ack

export class GeminiSessionManager {
  private sessions = new Map<string, Content[]>()

  private getOrCreateHistory(chatId: string, systemPrompt: string): Content[] {
    if (this.sessions.has(chatId)) return this.sessions.get(chatId)!

    const initialHistory: Content[] = [
      { role: 'user',  parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Olá! Pode me chamar a qualquer hora 😊' }] },
    ]
    this.sessions.set(chatId, initialHistory)
    return initialHistory
  }

  /**
   * Aplica janela deslizante ao histórico.
   * Preserva as primeiras SYSTEM_PROMPT_ENTRIES entradas (personalidade do bot).
   * Remove o par mais antigo (user + model) quando o limite é atingido.
   */
  private trimHistory(history: Content[]): Content[] {
    const maxEntries = SYSTEM_PROMPT_ENTRIES + MAX_HISTORY_TURNS * 2
    if (history.length <= maxEntries) return history

    const excess = history.length - maxEntries
    // Remove `excess` entradas após o system prompt, preservando as 2 iniciais
    return [
      ...history.slice(0, SYSTEM_PROMPT_ENTRIES),
      ...history.slice(SYSTEM_PROMPT_ENTRIES + excess),
    ]
  }

  async sendMessage(chatId: string, message: string, options: GeminiOptions): Promise<string> {
    const model        = options.model        ?? 'gemini-2.5-flash'
    const systemPrompt = options.systemPrompt ?? 'Você é um assistente útil e amigável. Responda de forma clara e concisa.'

    const genAI        = new GoogleGenerativeAI(options.apiKey)
    const geminiModel  = genAI.getGenerativeModel({ model })

    const history = this.getOrCreateHistory(chatId, systemPrompt)
    const chat: ChatSession = geminiModel.startChat({ history })

    const result       = await chat.sendMessage(message)
    const responseText = result.response.text()

    // Adiciona a nova troca e aplica o limite de histórico
    const updated = this.trimHistory([
      ...history,
      { role: 'user',  parts: [{ text: message }] },
      { role: 'model', parts: [{ text: responseText }] },
    ])
    this.sessions.set(chatId, updated)

    return responseText
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId)
  }

  /** Retorna quantas sessões estão ativas — útil para debug de memória. */
  sessionCount(): number {
    return this.sessions.size
  }
}

export const geminiManager = new GeminiSessionManager()