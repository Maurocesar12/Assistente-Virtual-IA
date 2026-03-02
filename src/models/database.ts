import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

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
  mustChangePassword: boolean
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

class Database {
  // ── Users ──────────────────────────────────────────────────────────────────

  async createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const user = await prisma.user.create({
      data: {
        name:               data.name,
        lastName:           data.lastName,
        email:              data.email,
        passwordHash:       data.passwordHash,
        plan:               data.plan,
        apiKeys:            JSON.stringify(data.apiKeys ?? {}),
        mustChangePassword: data.mustChangePassword ?? false,
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
    if (data.apiKeys !== undefined) payload.apiKeys = JSON.stringify(data.apiKeys)
    const user = await prisma.user.update({ where: { id }, data: payload })
    return this.parseUser(user)
  }

  // ── Password Reset Tokens ──────────────────────────────────────────────────

  async createPasswordResetToken(data: {
    userId:           string
    tokenHash:        string
    tempPasswordHash: string
    expiresAt:        Date
  }) {
    return prisma.passwordResetToken.create({ data })
  }

  async findValidResetToken(tokenHash: string) {
    return prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt:    null,
        expiresAt: { gt: new Date() },
      },
    })
  }

  async markResetTokenUsed(id: string) {
    return prisma.passwordResetToken.update({
      where: { id },
      data:  { usedAt: new Date() },
    })
  }

  async findPendingResetTokensForUser(userId: string) {
    return prisma.passwordResetToken.findMany({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    })
  }

  async invalidatePreviousResetTokens(userId: string) {
    return prisma.passwordResetToken.updateMany({
      where:  { userId, usedAt: null },
      data:   { usedAt: new Date() },
    })
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  async createBot(data: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>): Promise<Bot> {
    if (!data.userId || data.userId === 'undefined') {
      throw new Error('Não foi possível identificar o usuário. Saia e faça login novamente.')
    }
    const bot = await prisma.bot.create({
      data: {
        userId:      data.userId,
        name:        data.name,
        model:       data.model,
        prompt:      data.prompt,
        isActive:    data.isActive    ?? false,
        isConnected: data.isConnected ?? false,
        phone:       data.phone       ?? null,
        sessionName: data.sessionName,
        messageCount: data.messageCount ?? 0,
      },
    })
    return this.parseBot(bot)
  }

  async findBotById(id: string): Promise<Bot | null> {
    if (!id) return null
    const bot = await prisma.bot.findUnique({ where: { id } })
    return bot ? this.parseBot(bot) : null
  }

  async findBotsByUserId(userId: string): Promise<Bot[]> {
    if (!userId || userId === 'undefined') return []
    const bots = await prisma.bot.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    return bots.map(b => this.parseBot(b))
  }

  async updateBot(id: string, data: Partial<Omit<Bot, 'id' | 'userId' | 'createdAt'>>): Promise<Bot | null> {
    const bot = await prisma.bot.update({ where: { id }, data })
    return this.parseBot(bot)
  }

  async deleteBot(id: string): Promise<void> {
    await prisma.message.deleteMany({ where: { conversation: { botId: id } } })
    await prisma.conversation.deleteMany({ where: { botId: id } })
    await prisma.bot.delete({ where: { id } })
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  async upsertConversation(data: {
    botId: string; userId: string; contactName: string; contactPhone: string
    lastMessage: string; lastMessageAt: Date; unreadCount: number; messageCount: number
  }) {
    return prisma.conversation.upsert({
      where:  { botId_contactPhone: { botId: data.botId, contactPhone: data.contactPhone } },
      update: { lastMessage: data.lastMessage, lastMessageAt: data.lastMessageAt, unreadCount: { increment: data.unreadCount }, messageCount: { increment: data.messageCount } },
      create: { ...data },
    })
  }

  async findConversationsByUserId(userId: string) {
    if (!userId || userId === 'undefined') return []
    return prisma.conversation.findMany({ where: { userId }, orderBy: { lastMessageAt: 'desc' } })
  }

  async findConversationsByBotId(botId: string) {
    return prisma.conversation.findMany({ where: { botId }, orderBy: { lastMessageAt: 'desc' } })
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async createMessage(data: { conversationId: string; role: 'user' | 'assistant'; content: string }) {
    return prisma.message.create({ data })
  }

  async findMessagesByConversationId(conversationId: string) {
    return prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } })
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getUserStats(userId: string) {
    const [bots, conversations] = await Promise.all([
      prisma.bot.findMany({ where: { userId } }),
      prisma.conversation.findMany({ where: { userId } }),
    ])
    const totalMessages = bots.reduce((s, b) => s + (b.messageCount ?? 0), 0)
    return {
      totalBots: bots.length,
      activeBots: bots.filter(b => b.isActive && b.isConnected).length,
      totalConversations: conversations.length,
      totalMessages,
      tokensUsed: totalMessages * 142,
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private parseUser(u: any): User {
    return {
      ...u,
      plan: u.plan as Plan,
      mustChangePassword: u.mustChangePassword ?? false,
      apiKeys: typeof u.apiKeys === 'string' ? JSON.parse(u.apiKeys) : (u.apiKeys ?? {}),
    }
  }

  private parseBot(b: any): Bot {
    return { ...b, model: b.model as AIModel }
  }
}

const instance = new Database()

export const db = {
  createUser:                      instance.createUser.bind(instance),
  findUserById:                    instance.findUserById.bind(instance),
  findUserByEmail:                 instance.findUserByEmail.bind(instance),
  updateUser:                      instance.updateUser.bind(instance),
  createPasswordResetToken:        instance.createPasswordResetToken.bind(instance),
  findValidResetToken:             instance.findValidResetToken.bind(instance),
  markResetTokenUsed:              instance.markResetTokenUsed.bind(instance),
  invalidatePreviousResetTokens:   instance.invalidatePreviousResetTokens.bind(instance),
  findPendingResetTokensForUser:         instance.findPendingResetTokensForUser.bind(instance),
  createBot:                       instance.createBot.bind(instance),
  findBotById:                     instance.findBotById.bind(instance),
  findBotsByUserId:                instance.findBotsByUserId.bind(instance),
  updateBot:                       instance.updateBot.bind(instance),
  deleteBot:                       instance.deleteBot.bind(instance),
  upsertConversation:              instance.upsertConversation.bind(instance),
  findConversationsByUserId:       instance.findConversationsByUserId.bind(instance),
  findConversationsByBotId:        instance.findConversationsByBotId.bind(instance),
  createMessage:                   instance.createMessage.bind(instance),
  findMessagesByConversationId:    instance.findMessagesByConversationId.bind(instance),
  getUserStats:                    instance.getUserStats.bind(instance),
}