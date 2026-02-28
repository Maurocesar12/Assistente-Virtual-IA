import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// ─── Types ──────────────────────────────────────────────────────────────────
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

// ─── Classe Database ─────────────────────────────────────────────────────────
class Database {
  // ── Users ───────────────────────────────────────────────────────────────────
  async createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const user = await prisma.user.create({
      data: {
        name: data.name,
        lastName: data.lastName,
        email: data.email,
        passwordHash: data.passwordHash,
        plan: data.plan,
        apiKeys: JSON.stringify(data.apiKeys || {})
      }
    })
    return this.parseUser(user)
  }

  async findUserById(id: string): Promise<User | null> {
    if (!id || id === 'undefined') return null
    const user = await prisma.user.findUnique({ where: { id } })
    return user ? this.parseUser(user) : null
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const user = await prisma.user.findUnique({ where: { email } })
    return user ? this.parseUser(user) : undefined
  }

  // ── Stats (Exigido por users.ts:30) ─────────────────────────────────────────
  async getUserStats(userId: string) {
    const [bots, conversations] = await Promise.all([
      prisma.bot.findMany({ where: { userId } }),
      prisma.conversation.findMany({ where: { bot: { userId } } })
    ]);

    const totalMessages = bots.reduce((sum, b) => sum + (b.messageCount || 0), 0);

    return {
      activeBots: bots.filter(b => b.isActive).length,
      totalBots: bots.length,
      totalMessages,
      totalConversations: conversations.length,
      tokensUsed: totalMessages * 150 // Estimativa de tokens
    };
  }

  // ── Bots (Nomes ajustados para bots.ts:32 e bots.ts:57) ──────────────────────
  async findBotsByUserId(userId: string) {
    if (!userId || userId === 'undefined') return []
    return await prisma.bot.findMany({
      where: { userId }
    })
  }

  async createBot(data: any) {
    if(!data.userId || data.userId === 'undefined'){
      throw new Error('Não foi possível identificar o usuário. Por favor, saia e faça login novamente.')
    }

    return await prisma.bot.create({
      data: {
        userId: data.userId,
        name: data.name,
        model: data.model,
        prompt: data.prompt,
        isActive: data.isActive ?? false,
        isConnected: data.isConnected ?? false,
        sessionName: data.sessionName || `zapgpt_${data.userId}_${Date.now()}`,
        messageCount: 0
      }
    })
  }

  async findBotById(id: string) {
    return await prisma.bot.findUnique({ where: { id } })
  }

  async updateBot(id: string, data: any) {
    return await prisma.bot.update({ where: { id }, data })
  }

  async deleteBot(id: string) {
    return await prisma.bot.delete({ where: { id } })
  }

  // ── Conversations (Exigido por conversations.ts:14) ─────────────────────────
  async findConversationsByUserId(userId: string) {
     if (!userId || userId === 'undefined') return []
     return await prisma.conversation.findMany({
       where: { bot: { userId } },
       orderBy: { lastMessageAt: 'desc' }
     })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private parseUser(dbUser: any): User {
    return {
      ...dbUser,
      plan: dbUser.plan as Plan,
      apiKeys: typeof dbUser.apiKeys === 'string' ? JSON.parse(dbUser.apiKeys) : (dbUser.apiKeys || {})
    }
  }
}

const instance = new Database()

// EXPORTAÇÃO: Aqui os nomes devem bater IDÊNTICO com o que as rotas pedem
export const db = {
  findUserByEmail: instance.findUserByEmail.bind(instance),
  findUserById: instance.findUserById.bind(instance),
  createUser: instance.createUser.bind(instance),
  getUserStats: instance.getUserStats.bind(instance),
  createBot: instance.createBot.bind(instance),
  updateBot: instance.updateBot.bind(instance),
  deleteBot: instance.deleteBot.bind(instance),
  findBotById: instance.findBotById.bind(instance),
  findBotsByUserId: instance.findBotsByUserId.bind(instance),
  findConversationsByUserId: instance.findConversationsByUserId.bind(instance),
};