# Assistente Virtual IA

Plataforma SaaS para automacao de atendimento no WhatsApp com inteligencia artificial. O projeto permite criar bots personalizados, conectar numeros via QR Code, responder mensagens com OpenAI ou Gemini, acompanhar conversas em tempo real e controlar limites por plano.

## Visao Geral

O Assistente Virtual IA foi desenvolvido para centralizar operacao, configuracao e monitoramento de bots de atendimento em um unico painel. A aplicacao combina:

- automacao de conversas no WhatsApp
- configuracao de prompts por bot
- suporte a modelos Gemini e OpenAI
- painel web com autenticacao e gerenciamento
- controle de assinatura e limite de uso
- persistencia de historico de conversas e mensagens

## Principais Funcionalidades

- Cadastro, login, logout e recuperacao de senha por email
- Criacao e gerenciamento de bots com prompt personalizado
- Conexao de sessoes do WhatsApp via QR Code
- Respostas automaticas com `gemini-2.5-flash`, `gpt-4` e `gpt-3.5-turbo`
- Processamento de audio com transcricao antes de enviar para a IA
- Buffer de mensagens para juntar textos enviados em sequencia
- Pausa manual de conversa e handoff para atendimento humano
- Eventos em tempo real via SSE para QR Code, status, erros e digitacao
- Integracao opcional com Google Agenda para criar eventos automaticamente
- Controle de planos `starter` e `pro`
- Checkout e webhook com AbacatePay
- Dashboard com estatisticas de uso, conversas e mensagens

## Arquitetura

```text
Frontend estatico
    |
    v
Express API (TypeScript)
    |
    +-- Autenticacao JWT + cookies
    +-- Regras de plano e billing
    +-- SSE para eventos em tempo real
    +-- Integracao WhatsApp via WPPConnect
    +-- Integracao IA via OpenAI e Gemini
    +-- Integracao Google Agenda via OAuth 2.0
    |
    v
Prisma ORM
    |
    v
PostgreSQL (Neon)
```

## Stack Tecnologica

- Node.js
- TypeScript
- Express
- Prisma ORM
- PostgreSQL (Neon)
- WPPConnect
- OpenAI API
- Google Gemini API
- Google Calendar API
- Nodemailer
- Zod

## Estrutura do Projeto

```text
.
|-- Back-End/
|   `-- prisma/
|       |-- schema.prisma
|       `-- migrations/
|-- Front-End/
|   `-- public/
|       |-- index.html
|       |-- CSS/
|       `-- JS/
|-- src/
|   |-- config/
|   |-- middleware/
|   |-- models/
|   |-- routes/
|   |-- service/
|   `-- utils/
|-- package.json
`-- README.md
```

## Fluxo do Sistema

1. O usuario cria a conta e faz login no painel.
2. Cadastra um bot com nome, modelo e prompt.
3. Informa suas credenciais de IA nas configuracoes.
4. Conecta um numero do WhatsApp por QR Code.
5. O backend recebe mensagens, processa texto ou audio e envia para a IA escolhida.
6. A resposta e salva no historico e enviada de volta ao contato no WhatsApp.
7. O painel acompanha status da sessao, conversas, erros e limites do plano em tempo real.

## Modelagem Principal

As entidades centrais do projeto sao:

- `User`: dados de acesso, plano, chaves de API e status da assinatura
- `Bot`: configuracao do assistente, modelo, prompt e sessao do WhatsApp
- `Conversation`: resumo do atendimento por contato
- `Message`: historico detalhado de mensagens do usuario e da IA
- `PasswordResetToken`: fluxo de recuperacao de senha
- `GoogleCalendarIntegration`: conexao OAuth do usuario com Google Agenda
- `CalendarEventLog`: registro de eventos criados automaticamente

## Planos e Billing

O sistema possui duas camadas principais de monetizacao:

- `starter`: plano gratuito com limite de mensagens
- `pro`: plano pago com renovacao manual a cada 30 dias

Fluxo de cobranca:

1. O frontend solicita `POST /api/billing/checkout`.
2. A API cria uma cobranca no AbacatePay.
3. O pagamento confirmado dispara o webhook.
4. O usuario e promovido para `pro` por 30 dias.
5. Um scheduler verifica expiracao, envia lembretes e pausa bots vencidos.

## Seguranca

- Senhas com hash via `bcryptjs`
- Autenticacao com JWT
- Cookies `httpOnly`
- Rate limit em rotas sensiveis
- Validacao de payload com `zod`
- CORS configurado por ambiente
- Verificacao de assinatura HMAC no webhook de pagamento
- Chaves de API e tokens do Google armazenados com criptografia
- OAuth `state` assinado para proteger o callback do Google Agenda

## API Principal

Rotas mais importantes:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `PATCH /api/users/me`
- `PATCH /api/users/me/api-keys`
- `GET /api/users/me/stats`
- `GET /api/bots`
- `POST /api/bots`
- `POST /api/bots/:id/connect`
- `GET /api/bots/:id/events`
- `GET /api/conversations`
- `GET /api/conversations/:id/messages`
- `POST /api/billing/checkout`
- `POST /api/billing/webhook`
- `GET /api/billing/status`
- `GET /api/calendar/google/status`
- `GET /api/calendar/google/connect`
- `GET /api/calendar/google/callback`
- `PATCH /api/calendar/google`
- `DELETE /api/calendar/google`

## Como Executar Localmente

### 1. Clonar o projeto

```bash
git clone <url-do-repositorio>
cd Assistente-Virtual-IA
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variaveis de ambiente

Crie um arquivo `.env` com base no `.env.example`.

Exemplo minimo:

```env
DATABASE_URL="postgresql://usuario:senha@ep-seu-endpoint.neon.tech/neondb?sslmode=require"
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:3000

JWT_SECRET=troque_por_uma_chave_segura_com_pelo_menos_32_caracteres
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY=hex_de_64_caracteres

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seuemail@gmail.com
SMTP_PASS=sua_senha_de_app
SMTP_FROM="Assistente Virtual IA <seuemail@gmail.com>"

ABACATEPAY_API_KEY=sua_chave_abacatepay
ABACATEPAY_WEBHOOK_SECRET=seu_secret_opcional

GOOGLE_CLIENT_ID=seu_client_id_google
GOOGLE_CLIENT_SECRET=seu_client_secret_google
GOOGLE_REDIRECT_URI=http://localhost:3000/api/calendar/google/callback
GOOGLE_CALENDAR_TIMEZONE=America/Sao_Paulo
```

Observacao: o Neon usa PostgreSQL. Mantenha a `DATABASE_URL` no formato fornecido pelo Neon e preserve `sslmode=require` quando a conexao exigir SSL.

### 4. Gerar cliente Prisma

```bash
npm run prisma:generate
```

### 5. Aplicar migracoes

```bash
npx prisma migrate deploy --schema Back-End/prisma/schema.prisma
```

### 6. Iniciar o projeto

```bash
npm run dev
```

## Deploy

O projeto foi estruturado para funcionar bem em ambientes de deploy com Node.js, banco relacional e variaveis de ambiente, como Railway ou plataformas equivalentes. Para producao, recomenda-se:

- usar PostgreSQL, como Neon ou equivalente
- configurar `NODE_ENV=production`
- definir `FRONTEND_URL` com a URL publica do painel
- configurar `GOOGLE_REDIRECT_URI` com a URL publica do backend, por exemplo `https://seu-backend.up.railway.app/api/calendar/google/callback`
- configurar credenciais SMTP validas
- configurar credenciais da AbacatePay
- expor `JWT_SECRET` e `ENCRYPTION_KEY` fortes

## Casos de Uso

- atendimento automatico para pequenos negocios
- triagem inicial de leads via WhatsApp
- suporte comercial com fallback humano
- operacao com multiplos numeros em um unico painel
- validacao rapida de uma oferta SaaS de atendimento com IA

## Melhorias Futuras

- separacao mais clara entre frontend e backend em deploy
- testes automatizados para rotas e servicos
- observabilidade e logs estruturados
- fila para processamento assincrono de mensagens
- suporte a mais provedores de IA
- dashboard com relatorios mais avancados

## Autor

**Mauro Cesar Guimaraes**

- Email: `mauroguima080@hotmail.com`

## Licenca

Este projeto esta sob a licenca MIT.
