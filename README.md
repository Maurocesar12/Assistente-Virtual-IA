# ZapGPT v2.0 — WhatsApp AI Automation SaaS

> Automatize atendimento no WhatsApp com GPT-4 e Gemini 2.0. Backend TypeScript clean + Frontend integrado.

---

## 🏗️ Arquitetura

```
zapgpt/
├── src/
│   ├── config/
│   │   └── env.ts              # Variáveis de ambiente validadas com Zod
│   ├── middleware/
│   │   ├── authenticate.ts     # JWT middleware
│   │   ├── errorHandler.ts     # Global error handler
│   │   └── validate.ts         # Zod request validation factory
│   ├── models/
│   │   └── database.ts         # In-memory typed database (swap por Prisma/Postgres)
│   ├── routes/
│   │   ├── auth.ts             # POST /register, POST /login, GET /me
│   │   ├── bots.ts             # CRUD bots + connect/disconnect + SSE
│   │   ├── conversations.ts    # GET conversations + messages
│   │   └── users.ts            # PATCH profile, PATCH api-keys, GET stats
│   ├── service/
│   │   ├── gemini.ts           # Google Gemini session manager
│   │   ├── openai.ts           # OpenAI Assistants API session manager
│   │   └── whatsapp.ts         # WPPConnect multi-session manager
│   ├── utils/
│   │   ├── auth.ts             # bcrypt + JWT helpers
│   │   ├── http.ts             # ApiError class + response helpers
│   │   └── messages.ts         # Split messages + typing delay
│   ├── app.ts                  # Express app factory
│   └── index.ts                # Server entry point
├── public/
│   └── index.html              # Frontend SPA (integrado via REST API)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🚀 Setup

### 1. Clone e instale dependências

```bash
git clone <repo>
cd zapgpt
npm install
```

### 2. Configure o ambiente

```bash
cp .env.example .env
```

Edite `.env`:

```env
JWT_SECRET=uma-chave-secreta-muito-longa-e-segura
FRONTEND_URL=http://localhost:3000
PORT=3000
NODE_ENV=development
```

> **Nota:** As chaves OpenAI e Gemini são configuradas por usuário no painel de Configurações → API Keys, não precisam estar no `.env` global.

### 3. Rode em desenvolvimento

```bash
npm run dev
```

Acesse `http://localhost:3000` — o servidor serve o frontend automaticamente.

---

## 🔌 API REST

### Auth
| Method | Endpoint             | Body                                      | Auth |
|--------|----------------------|-------------------------------------------|------|
| POST   | `/api/auth/register` | `{name, lastName, email, password, plan}` | —    |
| POST   | `/api/auth/login`    | `{email, password}`                       | —    |
| GET    | `/api/auth/me`       | —                                         | JWT  |

### Usuários
| Method | Endpoint                  | Body                            | Auth |
|--------|---------------------------|---------------------------------|------|
| GET    | `/api/users/me/stats`     | —                               | JWT  |
| PATCH  | `/api/users/me`           | `{name?, lastName?}`            | JWT  |
| PATCH  | `/api/users/me/api-keys`  | `{openaiKey?, geminiKey?, ...}` | JWT  |

### Bots
| Method | Endpoint                     | Descrição                        | Auth |
|--------|------------------------------|----------------------------------|------|
| GET    | `/api/bots`                  | Lista todos os bots do usuário   | JWT  |
| POST   | `/api/bots`                  | Cria novo bot                    | JWT  |
| PATCH  | `/api/bots/:id`              | Atualiza bot                     | JWT  |
| DELETE | `/api/bots/:id`              | Exclui bot                       | JWT  |
| POST   | `/api/bots/:id/connect`      | Inicia sessão WhatsApp           | JWT  |
| POST   | `/api/bots/:id/disconnect`   | Encerra sessão WhatsApp          | JWT  |
| GET    | `/api/bots/:id/events`       | SSE: QR code + status updates    | JWT  |
| GET    | `/api/bots/:id/conversations`| Lista conversas do bot           | JWT  |

### Conversas
| Method | Endpoint                          | Auth |
|--------|-----------------------------------|------|
| GET    | `/api/conversations`              | JWT  |
| GET    | `/api/conversations/:id/messages` | JWT  |

---

## 🔄 Fluxo de Conexão WhatsApp

```
Frontend                   Backend                    WPPConnect
   │                          │                           │
   ├─ POST /bots/:id/connect ─►│                           │
   │                          ├─ wppconnect.create() ────►│
   │                          │                           │
   ├─ GET /bots/:id/events ──►│  (SSE connection)         │
   │◄── event: "qr" ─────────┤◄──── QR base64 ───────────┤
   │                          │                           │
   │  [user scans QR]         │                           │
   │                          │◄──── isLogged ────────────┤
   │◄── event: "status" ─────┤                           │
   │◄── event: "bot" ────────┤  (bot.isConnected=true)   │
   │                          │                           │
   │  [incoming WhatsApp msg] │                           │
   │                          │◄──── onMessage ───────────┤
   │                          ├─ callAI() ────────────────►
   │                          │◄─── AI response ──────────
   │                          ├─ sendText() ─────────────►│
```

---

## 🔧 Substituir banco de dados

O `src/models/database.ts` usa um Map em memória. Para usar Postgres/MySQL:

1. Instale o Prisma: `npm install prisma @prisma/client`
2. Defina o schema em `prisma/schema.prisma`
3. Substitua os métodos do `Database` pelas queries do Prisma Client
4. O resto da aplicação não muda — a interface é a mesma

---

## 📦 Build para produção

```bash
npm run build
npm start
```

---

## 🛡️ Segurança

- Senhas com `bcrypt` (12 rounds)
- JWT assinado com segredo configurável
- Rate limiting em todas as rotas
- Validação de inputs com Zod
- API keys dos usuários isoladas por conta
- CORS configurado para o domínio do frontend

---

## 📄 Licença

MIT © Marcus Gonçalves
