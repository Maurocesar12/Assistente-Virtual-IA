import { v4 as uuid } from 'uuid'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AIModel = 'gemini-2.0-flash' | 'gpt-4' | 'gpt-3.5-turbo'
export type Plan = 'starter' | 'pro' | 'enterprise'

export interface User {
  id: string
  name: string
  lastName: string
  email: string
  passwordHash: string
  plan: Plan
  apiKeys: ApiKeys
  createdAt: Date
  updatedAt: Date
}

export interface ApiKeys {
  openaiKey?: string
  openaiAssistantId?: string
  geminiKey?: string
}

export interface Bot {
  id: string
  userId: string
  name: string
  model: AIModel
  prompt: string
  isActive: boolean
  isConnected: boolean
  phone?: string
  sessionName: string
  messageCount: number
  createdAt: Date
  updatedAt: Date
}

export interface Conversation {
  id: string
  botId: string
  userId: string
  contactName: string
  contactPhone: string
  lastMessage: string
  lastMessageAt: Date
  unreadCount: number
  messageCount: number
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
}

// ─── In-memory store ──────────────────────────────────────────────────────────

class Database {
  private users = new Map<string, User>()
  private bots = new Map<string, Bot>()
  private conversations = new Map<string, Conversation>()
  private messages = new Map<string, Message>()

  // ── Users ──────────────────────────────────────────────────────────────────

  createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): User {
    const user: User = {
      ...data,
      id: uuid(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.users.set(user.id, user)
    return user
  }

  findUserById(id: string): User | undefined {
    return this.users.get(id)
  }

  findUserByEmail(email: string): User | undefined {
    return [...this.users.values()].find((u) => u.email === email)
  }

  updateUser(id: string, data: Partial<Omit<User, 'id' | 'createdAt'>>): User | undefined {
    const user = this.users.get(id)
    if (!user) return undefined
    const updated = { ...user, ...data, updatedAt: new Date() }
    this.users.set(id, updated)
    return updated
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  createBot(data: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>): Bot {
    const bot: Bot = {
      ...data,
      id: uuid(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.bots.set(bot.id, bot)
    return bot
  }

  findBotById(id: string): Bot | undefined {
    return this.bots.get(id)
  }

  findBotsByUserId(userId: string): Bot[] {
    return [...this.bots.values()].filter((b) => b.userId === userId)
  }

  updateBot(id: string, data: Partial<Omit<Bot, 'id' | 'userId' | 'createdAt'>>): Bot | undefined {
    const bot = this.bots.get(id)
    if (!bot) return undefined
    const updated = { ...bot, ...data, updatedAt: new Date() }
    this.bots.set(id, updated)
    return updated
  }

  deleteBot(id: string): boolean {
    return this.bots.delete(id)
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  upsertConversation(data: Omit<Conversation, 'id'> & { id?: string }): Conversation {
    const existing = [...this.conversations.values()].find(
      (c) => c.botId === data.botId && c.contactPhone === data.contactPhone
    )

    if (existing) {
      const updated = { ...existing, ...data }
      this.conversations.set(existing.id, updated)
      return updated
    }

    const conversation: Conversation = { ...data, id: uuid() }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  findConversationsByUserId(userId: string): Conversation[] {
    return [...this.conversations.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
  }

  findConversationsByBotId(botId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) => c.botId === botId)
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  createMessage(data: Omit<Message, 'id' | 'createdAt'>): Message {
    const message: Message = { ...data, id: uuid(), createdAt: new Date() }
    this.messages.set(message.id, message)
    return message
  }

  findMessagesByConversationId(conversationId: string): Message[] {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getUserStats(userId: string) {
    const bots = this.findBotsByUserId(userId)
    const conversations = this.findConversationsByUserId(userId)
    const totalMessages = bots.reduce((sum, b) => sum + b.messageCount, 0)
    const activeBots = bots.filter((b) => b.isActive && b.isConnected).length

    return {
      totalBots: bots.length,
      activeBots,
      totalConversations: conversations.length,
      totalMessages,
      tokensUsed: totalMessages * 142,
    }
  }
}

export const db = new Database()
