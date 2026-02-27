import OpenAI from 'openai'
import { sleep } from '../utils/messages.js'

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
    return thread.id
  }

  async sendMessage(chatId: string, message: string, options: OpenAIOptions): Promise<string> {
    const openai = this.buildClient(options.apiKey)
    const threadId = await this.ensureThread(chatId, options)

    // Retrieve assistant info for instructions
    const assistant = await openai.beta.assistants.retrieve(options.assistantId)

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
    const messages = await this.pollRunCompletion(openai, threadId, run.id)

    const latest = messages.data[0]
    const block = latest.content[0]

    if (block.type !== 'text') throw new Error('Unexpected response type from OpenAI')

    return block.text.value
  }

  private async pollRunCompletion(
    openai: OpenAI,
    threadId: string,
    runId: string,
    maxAttempts = 30
  ): Promise<OpenAI.Beta.Threads.Messages.MessagesPage> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const run = await openai.beta.threads.runs.retrieve(threadId, runId)

      if (run.status === 'completed') {
        return openai.beta.threads.messages.list(threadId)
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
}

export const openaiManager = new OpenAISessionManager()
