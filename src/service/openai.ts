import OpenAI from 'openai'
import { sleep } from '../utils/messages.js'
import { normalizeUsage, type AITextResponse, type AIUsage } from '../utils/tokenUsage.js'

const MAX_THREAD_CACHE = 300

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenAIOptions {
  apiKey: string
  assistantId: string
}

// ─── Thread Manager ───────────────────────────────────────────────────────────

export class OpenAISessionManager {
  private threads = new Map<string, string>() // chatId → threadId

  private buildClient(apiKey: string): OpenAI {
    return new OpenAI({ apiKey })
  }

  async ensureThread(chatId: string, options: OpenAIOptions): Promise<string> {
    if (this.threads.has(chatId)) return this.threads.get(chatId)!

    const openai = this.buildClient(options.apiKey)
    const thread = await openai.beta.threads.create()
    this.threads.set(chatId, thread.id)
    this.trimThreadCache()
    return thread.id
  }

  async sendMessage(chatId: string, message: string, options: OpenAIOptions): Promise<AITextResponse> {
     console.log(`🤖 Iniciando sessão para chat: ${chatId}`);
    const openai = this.buildClient(options.apiKey)
    const threadId = await this.ensureThread(chatId, options)
      console.log(`🧵 Thread utilizada: ${threadId}`);
    // Retrieve assistant info for instructions
    const assistant = await openai.beta.assistants.retrieve(options.assistantId)
    console.log(`✅ Assistente encontrado: ${assistant.name}`);

    // Add message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message,
    })

    // Create run
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistant.id,
      instructions: assistant.instructions ?? undefined,
    })

    // Poll until complete
    const result = await this.pollRunCompletion(openai, threadId, run.id)

    const latest = result.messages.data[0]
    const block = latest.content[0]

    if (block.type !== 'text') throw new Error('Unexpected response type from OpenAI')

    return {
      text: block.text.value,
      usage: normalizeUsage(result.usage, `${message}\n${block.text.value}`),
    }
  }

  private async pollRunCompletion(
    openai: OpenAI,
    threadId: string,
    runId: string,
    maxAttempts = 30
  ): Promise<{ messages: OpenAI.Beta.Threads.Messages.MessagesPage; usage: AIUsage }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const run = await openai.beta.threads.runs.retrieve(threadId, runId)

      if (run.status === 'completed') {
        const usage = (run as any).usage ?? {}
        return {
          messages: await openai.beta.threads.messages.list(threadId),
          usage: {
            inputTokens:  usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens:  usage.total_tokens,
            source:       usage.total_tokens ? 'provider' : 'estimate',
          },
        }
      }

      if (['failed', 'cancelled', 'expired'].includes(run.status)) {
        throw new Error(`OpenAI run ${run.status}: ${run.last_error?.message ?? 'unknown'}`)
      }

      await sleep(3000)
    }

    throw new Error('OpenAI run timed out')
  }

  clearSession(chatId: string): void {
    this.threads.delete(chatId)
  }

  clearSessionsForBot(botId: string): void {
    const prefix = `${botId}:`
    for (const chatId of this.threads.keys()) {
      if (chatId.startsWith(prefix)) this.threads.delete(chatId)
    }
  }

  private trimThreadCache(): void {
    while (this.threads.size > MAX_THREAD_CACHE) {
      const oldest = this.threads.keys().next().value
      if (!oldest) return
      this.threads.delete(oldest)
    }
  }
}

export const openaiManager = new OpenAISessionManager()
