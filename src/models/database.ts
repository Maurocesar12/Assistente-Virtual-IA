import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// ─── Types ────────────────────────────────────────────────────────────────────

export type AIModel = 'gemini-2.0-flash' | 'gpt-4' | 'gpt-3.5-turbo'
export type Plan = 'starter' | 'pro' | 'enterprise'

export interface ApiKeys {
  openaiKey?: string
  openaiAssistantId?: string
  geminiKey?: string
}

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

export interface Bot {
  id: string
  userId: string
  name: string
  model: AIModel
  prompt: string
  isActive: boolean
  isConnected: boolean
  phone?: string | null
  sessionName: string
  messageCount: number
  createdAt: Date
  updatedAt: Date
}

// ─── Database ─────────────────────────────────────────────────────────────────

class Database {

  // ── Users ──────────────────────────────────────────────────────────────────

  async createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const user = await prisma.user.create({
      data: {
        name: data.name,
        lastName: data.lastName,
        email: data.email,
        passwordHash: data.passwordHash,
        plan: data.plan,
        apiKeys: JSON.stringify(data.apiKeys ?? {}),
      },
    })
    return this.parseUser(user)
  }

  async findUserById(id: string): Promise<User | null> {
    if (!id || id === 'undefined') return null
    const user = await prisma.user.findUnique({ where: { id } })
    return user ? this.parseUser(user) : null
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const user = await prisma.user.findUnique({ where: { email } })
    return user ? this.parseUser(user) : null
  }

  async updateUser(id: string, data: Partial<Omit<User, 'id' | 'createdAt'>>): Promise<User | null> {
    const payload: Record<string, unknown> = { ...data }

    // Serialize apiKeys if present
    if (data.apiKeys !== undefined) {
      payload.apiKeys = JSON.stringify(data.apiKeys)
    }

    const user = await prisma.user.update({
      where: { id },
      data: payload,
    })
    return this.parseUser(user)
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  async createBot(data: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>): Promise<Bot> {
    if (!data.userId || data.userId === 'undefined') {
      throw new Error('Não foi possível identificar o usuário. Por favor, saia e faça login novamente.')
    }

    return prisma.bot.create({
      data: {
        userId: data.userId,
        name: data.name,
        model: data.model,
        prompt: data.prompt,
        isActive: data.isActive ?? false,
        isConnected: data.isConnected ?? false,
        phone: data.phone ?? null,
        sessionName: data.sessionName,
        messageCount: data.messageCount ?? 0,
      },
    }) as Promise<Bot>
  }

  async findBotById(id: string): Promise<Bot | null> {
    if (!id) return null
    const bot = await prisma.bot.findUnique({ where: { id } })
    return bot ? this.parseBot(bot) : null
  }

  async findBotsByUserId(userId: string): Promise<Bot[]> {
    if (!userId || userId === 'undefined') return []
    const bots = await prisma.bot.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    return bots.map((bot) => this.parseBot(bot))
  }

  async updateBot(id: string, data: Partial<Omit<Bot, 'id' | 'userId' | 'createdAt'>>): Promise<Bot | null> {
    const bot = await prisma.bot.update({ where: { id }, data })
    return this.parseBot(bot)
  }

  async deleteBot(id: string): Promise<void> {
    // Delete related conversations + messages first (if no cascade in schema)
    await prisma.message.deleteMany({
      where: { conversation: { botId: id } },
    })
    await prisma.conversation.deleteMany({ where: { botId: id } })
    await prisma.bot.delete({ where: { id } })
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  async upsertConversation(data: {
    botId: string
    userId: string
    contactName: string
    contactPhone: string
    lastMessage: string
    lastMessageAt: Date
    unreadCount: number
    messageCount: number
  }) {
    return prisma.conversation.upsert({
      where: {
        botId_contactPhone: {
          botId: data.botId,
          contactPhone: data.contactPhone,
        },
      },
      update: {
        lastMessage: data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount: { increment: data.unreadCount },
        messageCount: { increment: data.messageCount },
      },
      create: {
        botId: data.botId,
        userId: data.userId,
        contactName: data.contactName,
        contactPhone: data.contactPhone,
        lastMessage: data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount: data.unreadCount,
        messageCount: data.messageCount,
      },
    })
  }

  async findConversationsByUserId(userId: string) {
    if (!userId || userId === 'undefined') return []
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: { lastMessageAt: 'desc' },
    })
  }

  async findConversationsByBotId(botId: string) {
    return prisma.conversation.findMany({
      where: { botId },
      orderBy: { lastMessageAt: 'desc' },
    })
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async createMessage(data: { conversationId: string; role: 'user' | 'assistant'; content: string }) {
    return prisma.message.create({ data })
  }

  async findMessagesByConversationId(conversationId: string) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    })
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getUserStats(userId: string) {
    const [bots, conversations] = await Promise.all([
      prisma.bot.findMany({ where: { userId } }),
      prisma.conversation.findMany({ where: { userId } }),
    ])

    const totalMessages = bots.reduce((sum, b) => sum + (b.messageCount ?? 0), 0)

    return {
      totalBots: bots.length,
      activeBots: bots.filter((b) => b.isActive && b.isConnected).length,
      totalConversations: conversations.length,
      totalMessages,
      tokensUsed: totalMessages * 142,
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private parseUser(dbUser: any): User {
    return {
      ...dbUser,
      plan: dbUser.plan as Plan,
      apiKeys:
        typeof dbUser.apiKeys === 'string'
          ? JSON.parse(dbUser.apiKeys)
          : (dbUser.apiKeys ?? {}),
    }
  }

  private parseBot(dbBot: any): Bot {
    return {
      ...dbBot,
      model: dbBot.model as AIModel,
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

const instance = new Database()

export const db = {
  // Users
  createUser:                instance.createUser.bind(instance),
  findUserById:              instance.findUserById.bind(instance),
  findUserByEmail:           instance.findUserByEmail.bind(instance),
  updateUser:                instance.updateUser.bind(instance),
  // Bots
  createBot:                 instance.createBot.bind(instance),
  findBotById:               instance.findBotById.bind(instance),
  findBotsByUserId:          instance.findBotsByUserId.bind(instance),
  updateBot:                 instance.updateBot.bind(instance),
  deleteBot:                 instance.deleteBot.bind(instance),
  // Conversations
  upsertConversation:        instance.upsertConversation.bind(instance),
  findConversationsByUserId: instance.findConversationsByUserId.bind(instance),
  findConversationsByBotId:  instance.findConversationsByBotId.bind(instance),
  // Messages
  createMessage:                  instance.createMessage.bind(instance),
  findMessagesByConversationId:   instance.findMessagesByConversationId.bind(instance),
  // Stats
  getUserStats: instance.getUserStats.bind(instance),
}