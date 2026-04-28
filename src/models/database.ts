/**
 * database.ts — com criptografia de API keys [SEC-6]
 */

import { PrismaClient } from '@prisma/client'
import { COUNTABLE_MESSAGE_ROLES } from '../utils/planLimits.js'
import { encrypt, decrypt, encryptApiKeys, decryptApiKeys } from '../utils/encrypt.js'

const prisma = new PrismaClient()

export type AIModel = 'gemini-2.5-flash' | 'gpt-4' | 'gpt-3.5-turbo'
export type Plan    = 'starter' | 'pro' | 'enterprise'

export interface ApiKeys {
  openaiKey?:         string
  openaiAssistantId?: string
  geminiKey?:         string
}

export interface User {
  id:                 string
  name:               string
  lastName:           string
  email:              string
  passwordHash:       string
  plan:               Plan
  apiKeys:            ApiKeys
  mustChangePassword: boolean
  subscriptionId?:        string | null
  subscriptionStatus:     string    // 'none' | 'active' | 'past_due' | 'expired' | 'cancelled'
  planExpiresAt?:         Date | null
  renewalReminderSentAt?: Date | null
  createdAt:          Date
  updatedAt:          Date
}

export interface Bot {
  id:           string
  userId:       string
  name:         string
  model:        AIModel
  prompt:       string
  isActive:     boolean
  isConnected:  boolean
  phone?:       string | null
  sessionName:  string
  messageCount: number
  createdAt:    Date
  updatedAt:    Date
}

export interface Conversation {
  id:            string
  botId:         string
  userId:        string
  contactName:   string
  contactPhone:  string
  lastMessage:   string
  lastMessageAt: Date
  unreadCount:   number
  messageCount:  number
  isPaused:      boolean
  humanHandoff:  boolean
}

export interface CreateMessageParams {
  conversationId:    string
  role:              'user' | 'assistant'
  content:           string
  incrementBotCount?: boolean
  botId?:            string
}

export interface CalendarIntegration {
  id:           string
  userId:       string
  enabled:      boolean
  calendarId:   string
  accessToken:  string
  refreshToken: string
  scope?:       string | null
  tokenType?:   string | null
  expiryDate?:  Date | null
  createdAt:    Date
  updatedAt:    Date
}

export interface SaveCalendarIntegrationParams {
  userId:       string
  enabled?:     boolean
  calendarId?:  string
  accessToken:  string
  refreshToken: string
  scope?:       string | null
  tokenType?:   string | null
  expiryDate?:  Date | null
}

export interface UpdateCalendarIntegrationParams {
  enabled?:      boolean
  calendarId?:   string
  accessToken?:  string
  refreshToken?: string
  scope?:        string | null
  tokenType?:    string | null
  expiryDate?:   Date | null
}

export interface CalendarEventLogParams {
  userId:            string
  botId:             string
  contactPhone:      string
  sourceMessageHash: string
  googleEventId:     string
  googleHtmlLink?:   string | null
  title:             string
  startAt:           Date
  endAt:             Date
}

class Database {

  // ── Users ──────────────────────────────────────────────────────────────────

  async createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    // [SEC-6] Criptografa as API keys antes de salvar
    const encryptedKeys = encryptApiKeys(data.apiKeys as Record<string, string>)

    const user = await prisma.user.create({
      data: {
        name:               data.name,
        lastName:           data.lastName,
        email:              data.email.toLowerCase().trim(), // [SEC-7] normalizar email
        passwordHash:       data.passwordHash,
        plan:               data.plan,
        apiKeys:            JSON.stringify(encryptedKeys),
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
    // [SEC-7] normalizar email na busca também
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } })
    return user ? this.parseUser(user) : null
  }

  async updateUser(id: string, data: Partial<Omit<User, 'id' | 'createdAt'>>): Promise<User | null> {
    const payload: Record<string, unknown> = { ...data }

    // [SEC-6] Criptografar API keys ao atualizar
    if (data.apiKeys !== undefined) {
      const encryptedKeys = encryptApiKeys(data.apiKeys as Record<string, string>)
      payload.apiKeys = JSON.stringify(encryptedKeys)
    }

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
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    })
  }

  async markResetTokenUsed(id: string) {
    return prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } })
  }

  async findPendingResetTokensForUser(userId: string) {
    return prisma.passwordResetToken.findMany({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    })
  }

  async invalidatePreviousResetTokens(userId: string) {
    return prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data:  { usedAt: new Date() },
    })
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  async createBot(data: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>): Promise<Bot> {
    if (!data.userId || data.userId === 'undefined')
      throw new Error('Não foi possível identificar o usuário. Saia e faça login novamente.')

    const bot = await prisma.bot.create({
      data: {
        userId:       data.userId,
        name:         data.name,
        model:        data.model,
        prompt:       data.prompt ?? '',
        isActive:     data.isActive    ?? false,
        isConnected:  data.isConnected ?? false,
        phone:        data.phone       ?? null,
        sessionName:  data.sessionName,
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
    return bots.map((b: any) => this.parseBot(b))
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
    botId:         string
    userId:        string
    contactName:   string
    contactPhone:  string
    lastMessage:   string
    lastMessageAt: Date
    unreadCount:   number
    messageCount:  number
  }) {
    return prisma.conversation.upsert({
      where:  { botId_contactPhone: { botId: data.botId, contactPhone: data.contactPhone } },
      update: {
        lastMessage:   data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount:   { increment: data.unreadCount },
        messageCount:  { increment: data.messageCount },
      },
      create: {
        botId:         data.botId,
        userId:        data.userId,
        contactName:   data.contactName,
        contactPhone:  data.contactPhone,
        lastMessage:   data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount:   data.unreadCount,
        messageCount:  data.messageCount,
      },
    })
  }

  async findConversationsByUserId(userId: string): Promise<Conversation[]> {
    if (!userId || userId === 'undefined') return []
    const rows = await prisma.conversation.findMany({
      where:   { userId },
      orderBy: { lastMessageAt: 'desc' },
    })
    return rows.map((r: any) => this.parseConversation(r))
  }

  async findConversationsByBotId(botId: string): Promise<Conversation[]> {
    const rows = await prisma.conversation.findMany({
      where:   { botId },
      orderBy: { lastMessageAt: 'desc' },
    })
    return rows.map((r: any) => this.parseConversation(r))
  }

  async findConversationById(id: string): Promise<Conversation | null> {
    const row = await prisma.conversation.findUnique({ where: { id } })
    return row ? this.parseConversation(row) : null
  }

  async deleteConversation(id: string): Promise<void> {
    await prisma.message.deleteMany({ where: { conversationId: id } })
    await prisma.conversation.delete({ where: { id } })
  }

  async setConversationPaused(id: string, isPaused: boolean): Promise<Conversation | null> {
    const row = await prisma.conversation.update({ where: { id }, data: { isPaused } })
    return this.parseConversation(row)
  }

  async setConversationHandoff(id: string, humanHandoff: boolean): Promise<Conversation | null> {
    const row = await prisma.conversation.update({
      where: { id },
      data:  { humanHandoff, isPaused: humanHandoff },
    })
    return this.parseConversation(row)
  }

  async findConversationByBotAndPhone(botId: string, contactPhone: string): Promise<Conversation | null> {
    const row = await prisma.conversation.findUnique({
      where: { botId_contactPhone: { botId, contactPhone } },
    })
    return row ? this.parseConversation(row) : null
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async createMessage(params: CreateMessageParams) {
    const { conversationId, role, content, incrementBotCount = true, botId } = params

    const message = await prisma.message.create({
      data: { conversationId, role, content },
    })

    if (incrementBotCount && botId) {
      await prisma.bot.update({
        where: { id: botId },
        data:  { messageCount: { increment: 1 } },
      })
    }

    return message
  }

  async findMessagesByConversationId(conversationId: string) {
    return prisma.message.findMany({
      where:   { conversationId },
      orderBy: { createdAt: 'asc' },
    })
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getUserStats(userId: string) {
    if (!userId || userId === 'undefined') {
      return { totalBots: 0, activeBots: 0, totalConversations: 0, totalMessages: 0, tokensUsed: 0 }
    }

    const [bots, conversations, messageCount] = await Promise.all([
      prisma.bot.findMany({ where: { userId } }),
      prisma.conversation.findMany({ where: { userId } }),
      prisma.message.count({
        where: {
          role: { in: [...COUNTABLE_MESSAGE_ROLES] },
          conversation: { userId },
        },
      }),
    ])

    return {
      totalBots:          bots.length,
      activeBots:         bots.filter((b: any) => b.isActive && b.isConnected).length,
      totalConversations: conversations.length,
      totalMessages:      messageCount,
      tokensUsed:         messageCount * 142,
    }
  }
  async findUsersByPlan(plan: string): Promise<User[]> {
    const users = await prisma.user.findMany({ where: { plan } })
    return users.map((u: any) => this.parseUser(u))
  }

  // ── Helpers privados ───────────────────────────────────────────────────────

  async findCalendarIntegrationByUserId(userId: string): Promise<CalendarIntegration | null> {
    if (!userId || userId === 'undefined') return null
    const row = await prisma.googleCalendarIntegration.findUnique({ where: { userId } })
    return row ? this.parseCalendarIntegration(row) : null
  }

  async saveCalendarIntegration(data: SaveCalendarIntegrationParams): Promise<CalendarIntegration> {
    const row = await prisma.googleCalendarIntegration.upsert({
      where: { userId: data.userId },
      update: {
        enabled:      data.enabled ?? true,
        calendarId:   data.calendarId ?? 'primary',
        accessToken:  encrypt(data.accessToken),
        refreshToken: encrypt(data.refreshToken),
        scope:        data.scope ?? null,
        tokenType:    data.tokenType ?? null,
        expiryDate:   data.expiryDate ?? null,
      },
      create: {
        userId:       data.userId,
        enabled:      data.enabled ?? true,
        calendarId:   data.calendarId ?? 'primary',
        accessToken:  encrypt(data.accessToken),
        refreshToken: encrypt(data.refreshToken),
        scope:        data.scope ?? null,
        tokenType:    data.tokenType ?? null,
        expiryDate:   data.expiryDate ?? null,
      },
    })

    return this.parseCalendarIntegration(row)
  }

  async updateCalendarIntegration(userId: string, data: UpdateCalendarIntegrationParams): Promise<CalendarIntegration | null> {
    const payload: Record<string, unknown> = { ...data }
    if (data.accessToken) payload.accessToken = encrypt(data.accessToken)
    if (data.refreshToken) payload.refreshToken = encrypt(data.refreshToken)

    const row = await prisma.googleCalendarIntegration.update({ where: { userId }, data: payload })
    return this.parseCalendarIntegration(row)
  }

  async deleteCalendarIntegration(userId: string): Promise<void> {
    await prisma.googleCalendarIntegration.deleteMany({ where: { userId } })
  }

  async hasCalendarEventLog(botId: string, contactPhone: string, sourceMessageHash: string): Promise<boolean> {
    const count = await prisma.calendarEventLog.count({ where: { botId, contactPhone, sourceMessageHash } })
    return count > 0
  }

  async createCalendarEventLog(data: CalendarEventLogParams): Promise<void> {
    await prisma.calendarEventLog.create({ data })
  }

  // Helpers privados

  private parseUser(u: any): User {
    let apiKeys: ApiKeys = {}
    try {
      const raw = typeof u.apiKeys === 'string' ? JSON.parse(u.apiKeys) : (u.apiKeys ?? {})
      // [SEC-6] Descriptografa ao ler do banco
      apiKeys = decryptApiKeys(raw) as ApiKeys
    } catch {
      apiKeys = {}
    }

    return {
      ...u,
      plan:                  u.plan as Plan,
      mustChangePassword:    u.mustChangePassword ?? false,
      subscriptionId:        u.subscriptionId     ?? null,
      subscriptionStatus:    u.subscriptionStatus ?? 'none',
      planExpiresAt:         u.planExpiresAt       ?? null,
      renewalReminderSentAt: u.renewalReminderSentAt ?? null,
      apiKeys,
    }
  }

  async findProUsersExpiring(): Promise<User[]> {
    const users = await prisma.user.findMany({
      where: {
        plan: 'pro',
        planExpiresAt: { not: null },
      },
    })
    return users.map((u: any) => this.parseUser(u))
  }

  private parseBot(b: any): Bot {
    return { ...b, model: b.model as AIModel }
  }

  private parseConversation(c: any): Conversation {
    return {
      ...c,
      isPaused:     c.isPaused     ?? false,
      humanHandoff: c.humanHandoff ?? false,
    }
  }

  private parseCalendarIntegration(row: any): CalendarIntegration {
    return {
      ...row,
      accessToken:  decrypt(row.accessToken),
      refreshToken: decrypt(row.refreshToken),
    }
  }
}

const instance = new Database()

export const db = {
  createUser:                    instance.createUser.bind(instance),
  findUserById:                  instance.findUserById.bind(instance),
  findUserByEmail:               instance.findUserByEmail.bind(instance),
  updateUser:                    instance.updateUser.bind(instance),
  createPasswordResetToken:      instance.createPasswordResetToken.bind(instance),
  findValidResetToken:           instance.findValidResetToken.bind(instance),
  markResetTokenUsed:            instance.markResetTokenUsed.bind(instance),
  invalidatePreviousResetTokens: instance.invalidatePreviousResetTokens.bind(instance),
  findPendingResetTokensForUser: instance.findPendingResetTokensForUser.bind(instance),
  createBot:                     instance.createBot.bind(instance),
  findBotById:                   instance.findBotById.bind(instance),
  findBotsByUserId:              instance.findBotsByUserId.bind(instance),
  updateBot:                     instance.updateBot.bind(instance),
  deleteBot:                     instance.deleteBot.bind(instance),
  upsertConversation:            instance.upsertConversation.bind(instance),
  findConversationsByUserId:     instance.findConversationsByUserId.bind(instance),
  findConversationsByBotId:      instance.findConversationsByBotId.bind(instance),
  findConversationById:          instance.findConversationById.bind(instance),
  deleteConversation:            instance.deleteConversation.bind(instance),
  setConversationPaused:         instance.setConversationPaused.bind(instance),
  setConversationHandoff:        instance.setConversationHandoff.bind(instance),
  findConversationByBotAndPhone: instance.findConversationByBotAndPhone.bind(instance),
  createMessage:                 instance.createMessage.bind(instance),
  findMessagesByConversationId:  instance.findMessagesByConversationId.bind(instance),
  getUserStats:                  instance.getUserStats.bind(instance),
  findUsersByPlan:                 instance.findUsersByPlan.bind(instance),
  findProUsersExpiring:            instance.findProUsersExpiring.bind(instance),
  findCalendarIntegrationByUserId: instance.findCalendarIntegrationByUserId.bind(instance),
  saveCalendarIntegration:         instance.saveCalendarIntegration.bind(instance),
  updateCalendarIntegration:       instance.updateCalendarIntegration.bind(instance),
  deleteCalendarIntegration:       instance.deleteCalendarIntegration.bind(instance),
  hasCalendarEventLog:             instance.hasCalendarEventLog.bind(instance),
  createCalendarEventLog:          instance.createCalendarEventLog.bind(instance),
}
