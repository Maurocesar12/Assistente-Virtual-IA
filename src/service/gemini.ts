import { GoogleGenerativeAI, type Content, type ChatSession } from '@google/generative-ai'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeminiOptions {
  apiKey: string
  model?: string
  systemPrompt?: string
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export class GeminiSessionManager {
  private sessions = new Map<string, Content[]>()

  private buildClient(apiKey: string, model: string) {
    const genAI = new GoogleGenerativeAI(apiKey)
    return genAI.getGenerativeModel({ model })
  }

  private getOrCreateHistory(chatId: string, systemPrompt: string): Content[] {
    if (this.sessions.has(chatId)) {
      return this.sessions.get(chatId)!
    }

    const initialHistory: Content[] = [
      {
        role: 'user',
        parts: [{ text: systemPrompt }],
      },
      {
        role: 'model',
        parts: [{ text: 'Olá! Pode me chamar a qualquer hora 😊' }],
      },
    ]

    this.sessions.set(chatId, initialHistory)
    return initialHistory
  }

  async sendMessage(chatId: string, message: string, options: GeminiOptions): Promise<string> {
    const model = options.model ?? 'gemini-2.0-flash'
    const systemPrompt = options.systemPrompt ?? 'Você é um assistente prestativo.'

    const genAI = new GoogleGenerativeAI(options.apiKey)
    const geminiModel = genAI.getGenerativeModel({ model })

    const history = this.getOrCreateHistory(chatId, systemPrompt)
    const chat: ChatSession = geminiModel.startChat({ history })

    const result = await chat.sendMessage(message)
    const responseText = result.response.text()

    // Persist the new exchange to history
    this.sessions.set(chatId, [
      ...history,
      { role: 'user', parts: [{ text: message }] },
      { role: 'model', parts: [{ text: responseText }] },
    ])

    return responseText
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId)
  }
}

export const geminiManager = new GeminiSessionManager()
