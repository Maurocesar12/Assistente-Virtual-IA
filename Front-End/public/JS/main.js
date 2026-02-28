'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = window.location.origin + '/api';

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

const State = {
  token: null,
  user: null,
  bots: [],
  conversations: [],
  stats: null,
  activeBotId: null,    // for edit modal
  connectBotId: null,   // for connect modal
  sseSource: null,      // EventSource for QR
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const Store = {
  save() {
    try {
      if (State.token) localStorage.setItem('zapgpt_token', State.token)
      if (State.user)  localStorage.setItem('zapgpt_user',  JSON.stringify(State.user))
    } catch (_) {}
  },
  load() {
    try {
      State.token = localStorage.getItem('zapgpt_token')
      const u = localStorage.getItem('zapgpt_user')
      if (u) State.user = JSON.parse(u)
    } catch (_) {}
  },
  clear() {
    try {
      localStorage.removeItem('zapgpt_token')
      localStorage.removeItem('zapgpt_user')
    } catch (_) {}
    State.token = null
    State.user  = null
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// API CLIENT
// ─────────────────────────────────────────────────────────────────────────────

const Api = {
  async request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' }
    if (State.token) headers['Authorization'] = `Bearer ${State.token}`

    const res = await fetch(API_URL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    const json = await res.json().catch(() => ({ success: false, error: { message: 'Parse error' } }))

    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`
      throw new Error(msg)
    }

    return json.data ?? json
  },

  get:    (path)        => Api.request('GET', path),
  post:   (path, body)  => Api.request('POST', path, body),
  patch:  (path, body)  => Api.request('PATCH', path, body),
  delete: (path)        => Api.request('DELETE', path),
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const UI = {
  page(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
    document.getElementById(id)?.classList.add('active')
    window.scrollTo(0, 0)
  },

  view(id, el) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
    document.getElementById(`view-${id}`)?.classList.add('active')
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'))
    if (el) el.classList.add('active')
    else document.querySelector(`[data-view="${id}"]`)?.classList.add('active')

    const titles = { overview:'Visão Geral', bots:'Meus Bots', convs:'Conversas',
                     analytics:'Analytics', settings:'Configurações', billing:'Assinatura' }
    document.getElementById('viewTitle').textContent = titles[id] ?? id

    if (id === 'settings') Settings.load()
    if (id === 'billing')  Billing.render()
    if (id === 'analytics') Analytics.render()
  },

  tab(id, btn) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))
    document.getElementById(id)?.classList.add('active')
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    if (btn) btn.classList.add('active')
  },

  setLoading(btnId, loading) {
    const btn = document.getElementById(btnId)
    if (!btn) return
    btn.disabled = loading
    btn.classList.toggle('loading', loading)
    if (loading) {
      btn._orig = btn.innerHTML
      btn.innerHTML = `<span class="spinner"></span>`
    } else if (btn._orig) {
      btn.innerHTML = btn._orig
    }
  },

  el: (id) => document.getElementById(id),
  val: (id) => document.getElementById(id)?.value?.trim() ?? '',
  html: (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h },
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' }
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `<span class="toast-icon">${icons[type] ?? '💬'}</span><span>${msg}</span>`
  document.getElementById('toasts').appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────────────────────

const Modals = {
  open(id) {
    document.getElementById(`m-${id}`)?.classList.add('open')
    if (id === 'connect') Connect.start()
  },
  close(id) {
    document.getElementById(`m-${id}`)?.classList.remove('open')
    if (id === 'connect') Connect.cleanup()
  },
}

// Close overlay on backdrop click
document.querySelectorAll('.overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open') })
)

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

const Auth = {
  async login() {
    const email = UI.val('l-email')
    const password = UI.val('l-pass')
    if (!email || !password) { toast('Preencha todos os campos', 'error'); return }

    UI.setLoading('loginBtn', true)
    try {
      const data = await Api.post('/auth/login', { email, password })
      State.token = data.token
      State.user  = data.user
      Store.save()
      await Dashboard.enter()
      toast(`Bem-vindo de volta, ${data.user.name}! 👋`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      UI.setLoading('loginBtn', false)
    }
  },

  async register() {
    const name     = UI.val('r-name')
    const lastName = UI.val('r-last')
    const email    = UI.val('r-email')
    const password = UI.val('r-pass')
    const plan     = UI.val('r-plan')

    if (!name || !email || !password) { toast('Preencha todos os campos obrigatórios', 'error'); return }
    if (password.length < 8) { toast('Senha deve ter pelo menos 8 caracteres', 'error'); return }

    UI.setLoading('registerBtn', true)
    try {
      const data = await Api.post('/auth/register', { name, lastName, email, password, plan })
      State.token = data.token
      State.user  = data.user
      Store.save()
      await Dashboard.enter()
      toast(`Conta criada! Bem-vindo, ${data.user.name}! 🎉`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      UI.setLoading('registerBtn', false)
    }
  },

  async demoLogin() {
    // Register + login a demo account server-side
    const suffix = Date.now()
    try {
      const data = await Api.post('/auth/register', {
        name: 'Demo', lastName: 'User',
        email: `demo_${suffix}@zapgpt.com`,
        password: 'demo1234', plan: 'pro',
      })
      State.token = data.token
      State.user  = data.user
      Store.save()
      await Dashboard.enter()
      toast('Modo demonstração ativado 🚀', 'info')
    } catch (err) {
      toast('Erro ao iniciar demo: ' + err.message, 'error')
    }
  },

  logout() {
    Connect.cleanup()
    Store.clear()
    State.bots = []
    State.conversations = []
    State.stats = null
    UI.page('landing')
    toast('Até logo! 👋', 'info')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

const Dashboard = {
  async enter() {
    UI.page('dashboard')
    UI.view('overview')
    Dashboard.updateSidebar()
    await Dashboard.refresh()
  },

  async refresh() {
    try {
      await Promise.all([
        Dashboard.loadStats(),
        Bots.load(),
        Conversations.load(),
      ])
    } catch (err) {
      console.error('Dashboard refresh error:', err)
    }
  },

  async loadStats() {
    try {
      const stats = await Api.get('/users/me/stats')
      State.stats = stats
      UI.el('s-bots').textContent    = stats.activeBots
      UI.el('s-msgs').textContent    = (stats.totalMessages).toLocaleString('pt-BR')
      UI.el('s-convs').textContent   = stats.totalConversations
      UI.el('s-tokens').textContent  = (stats.tokensUsed).toLocaleString('pt-BR')
      UI.el('s-bots-meta').textContent = `${stats.totalBots} total`
    } catch (_) {}
  },

  updateSidebar() {
    const u = State.user
    if (!u) return
    UI.el('sbAvatar').textContent = u.name[0].toUpperCase()
    UI.el('sbName').textContent   = `${u.name} ${u.lastName || ''}`
    UI.el('sbPlan').textContent   = (u.plan ?? 'starter').toUpperCase()
  },

  filterConvs(query) {
    const q = query.toLowerCase()
    document.querySelectorAll('.conv-row').forEach(row => {
      row.style.display = row.dataset.search?.includes(q) ? '' : 'none'
    })
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTS
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_META = {
  'gemini-2.0-flash': { label: 'Gemini 2.0', cls: 'model-gemini' },
  'gpt-4':            { label: 'GPT-4',       cls: 'model-gpt4' },
  'gpt-3.5-turbo':    { label: 'GPT-3.5',     cls: 'model-gpt35' },
}

const Bots = {
  async load() {
    try {
      State.bots = await Api.get('/bots')
      Bots.render()
      Bots.renderOverview()
      Bots.updateSteps()
    } catch (_) {}
  },

  render() {
    const el = UI.el('botsList')
    if (!el) return

    if (State.bots.length === 0) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">🤖</div><h3>Nenhum bot criado</h3><p>Clique em "+ Novo Bot" para criar seu assistente</p></div>`
      return
    }

    const rows = State.bots.map(b => {
      const m = MODEL_META[b.model] ?? { label: b.model, cls: '' }
      return `
        <tr>
          <td>
            <div class="flex-center gap-2">
              <div style="width:7px;height:7px;border-radius:50%;background:${b.isConnected ? 'var(--green)' : 'var(--text-dim)'};${b.isConnected ? 'box-shadow:0 0 6px var(--green)' : ''}"></div>
              <strong>${Bots.escape(b.name)}</strong>
            </div>
          </td>
          <td><span class="model-tag ${m.cls}">${m.label}</span></td>
          <td class="mono text-sm">${b.phone ? b.phone : '<span class="text-dim">Não conectado</span>'}</td>
          <td><span class="badge ${b.isActive ? 'badge-green' : 'badge-red'}">${b.isActive ? 'Ativo' : 'Inativo'}</span></td>
          <td class="text-muted">${b.messageCount.toLocaleString('pt-BR')}</td>
          <td>
            <div class="flex gap-2">
              <button class="btn btn-ghost btn-sm" onclick="Connect.open('${b.id}')">📱 Conectar</button>
              <button class="btn btn-ghost btn-sm" onclick="Bots.openEdit('${b.id}')">✏️ Editar</button>
            </div>
          </td>
        </tr>
      `
    }).join('')

    el.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Nome</th><th>Modelo</th><th>Número</th>
            <th>Status</th><th>Mensagens</th><th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
  },

  renderOverview() {
    const el = UI.el('ov-bots')
    if (!el) return
    if (State.bots.length === 0) {
      el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">🤖</div><h3>Nenhum bot ainda</h3></div>`
      return
    }
    el.innerHTML = State.bots.slice(0, 4).map(b => {
      const m = MODEL_META[b.model] ?? { label: b.model, cls: '' }
      return `
        <div class="conv-row">
          <div class="conv-avatar" style="${b.isConnected ? 'background:var(--green-soft)' : ''}">🤖</div>
          <div class="conv-body">
            <div class="conv-name">${Bots.escape(b.name)}</div>
            <div class="conv-preview"><span class="model-tag ${m.cls}">${m.label}</span> · ${b.messageCount} mensagens</div>
          </div>
          <span class="badge ${b.isActive ? 'badge-green' : 'badge-red'}">${b.isActive ? 'Ativo' : 'Off'}</span>
        </div>`
    }).join('')
  },

  updateSteps() {
    const hasBots      = State.bots.length > 0
    const hasConnected = State.bots.some(b => b.isConnected)
    const hasMsgs      = State.bots.some(b => b.messageCount > 0)

    if (hasBots) {
      UI.el('step1')?.classList.add('done')
      UI.el('step2').style.opacity = '1'
    }
    if (hasConnected) {
      UI.el('step2')?.classList.add('done')
      UI.el('step3').style.opacity = '1'
    }
    if (hasMsgs) {
      UI.el('step3')?.classList.add('done')
    }
  },

async create() {
  const name   = UI.val('bName')
  const model  = UI.val('bModel')
  const prompt = UI.val('bPrompt')

  if (!name) { toast('Dê um nome ao bot', 'error'); return }
  
  // ADICIONE ESTA LINHA DE SEGURANÇA AQUI:
  if (!Array.isArray(State.bots)) State.bots = [];

  UI.setLoading('createBotBtn', true)
  
  try {
    const bot = await Api.post('/bots', { name, model, prompt })
    
    // O erro acontece aqui porque State.bots não era uma lista
    State.bots.unshift(bot) 
    
    Bots.render()
    UI.modal('botModal', false)
    toast('Bot criado com sucesso!')
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    UI.setLoading('createBotBtn', false)
    }
  },

  openEdit(botId) {
    const bot = State.bots.find(b => b.id === botId)
    if (!bot) return
    State.activeBotId = botId
    const m = MODEL_META[bot.model] ?? { label: bot.model }
    UI.el('eBotTitle').textContent    = bot.name
    UI.el('eBotMeta').textContent     = `${m.label} · criado em ${new Date(bot.createdAt).toLocaleDateString('pt-BR')}`
    UI.el('eBotPrompt').value         = bot.prompt
    UI.el('eBotActive').checked       = bot.isActive
    Modals.open('editBot')
  },

  async save() {
    const id = State.activeBotId
    if (!id) return
    try {
      const updated = await Api.patch(`/bots/${id}`, {
        prompt:   UI.el('eBotPrompt').value,
        isActive: UI.el('eBotActive').checked,
      })
      const idx = State.bots.findIndex(b => b.id === id)
      if (idx >= 0) State.bots[idx] = updated
      Modals.close('editBot')
      Bots.render()
      Bots.renderOverview()
      Bots.updateSteps()
      toast('Bot atualizado!', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  },

  async delete() {
    const id = State.activeBotId
    if (!id) return
    const bot = State.bots.find(b => b.id === id)
    if (!confirm(`Excluir o bot "${bot?.name}"? Esta ação não pode ser desfeita.`)) return

    try {
      await Api.delete(`/bots/${id}`)
      State.bots = State.bots.filter(b => b.id !== id)
      Modals.close('editBot')
      Bots.render()
      Bots.renderOverview()
      toast(`Bot excluído`, 'info')
    } catch (err) {
      toast(err.message, 'error')
    }
  },

  escape(str) {
    return String(str).replace(/</g,'&lt;').replace(/>/g,'&gt;')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────────────────────────────────────

const Conversations = {
  async load() {
    try {
      State.conversations = await Api.get('/conversations')
      Conversations.render()
      Conversations.renderOverview()
    } catch (_) {}
  },

  render() {
    const el = UI.el('convsList')
    if (!el) return
    if (State.conversations.length === 0) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>Nenhuma conversa</h3><p>As conversas aparecerão quando seu bot estiver ativo</p></div>`
      return
    }
    el.innerHTML = State.conversations.map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })
      return `
        <div class="conv-row" data-search="${Bots.escape(c.contactName?.toLowerCase())} ${c.lastMessage?.toLowerCase()}" onclick="toast('Visualização de chat em breve!','info')">
          <div class="conv-avatar">👤</div>
          <div class="conv-body">
            <div class="conv-name">${Bots.escape(c.contactName || c.contactPhone)}</div>
            <div class="conv-preview">${Bots.escape(c.lastMessage)}</div>
          </div>
          <div class="conv-right">
            <div class="conv-time">${time}</div>
            ${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}
          </div>
        </div>`
    }).join('')
  },

  renderOverview() {
    const el = UI.el('ov-convs')
    if (!el) return
    if (State.conversations.length === 0) {
      el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">💬</div><h3>Nenhuma conversa</h3></div>`
      return
    }
    el.innerHTML = State.conversations.slice(0, 4).map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })
      return `
        <div class="conv-row" onclick="toast('Visualização de chat em breve!','info')">
          <div class="conv-avatar">👤</div>
          <div class="conv-body">
            <div class="conv-name">${Bots.escape(c.contactName || c.contactPhone)}</div>
            <div class="conv-preview">${Bots.escape(c.lastMessage)}</div>
          </div>
          <div class="conv-right">
            <div class="conv-time">${time}</div>
            ${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}
          </div>
        </div>`
    }).join('')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT WHATSAPP (SSE)
// ─────────────────────────────────────────────────────────────────────────────

const Connect = {
  open(botId) {
    State.connectBotId = botId
    Modals.open('connect')
  },

  start() {
    const botId = State.connectBotId
    if (!botId) return

    // Trigger connection start
    Api.post(`/bots/${botId}/connect`).catch(() => {})

    // Listen for QR + status via SSE
    Connect.cleanup()
    const url = `${API_URL}/bots/${botId}/events`
    const source = new EventSource(url)
    State.sseSource = source

    Connect.log('Iniciando conexão...', 'info')

    source.addEventListener('qr', (e) => {
      const data = JSON.parse(e.data)
      Connect.renderQR()
      Connect.log('QR Code gerado. Escaneie com o WhatsApp!', 'success')
      UI.el('qrStatus').textContent = 'Escaneie o QR Code acima'
    })

    source.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      Connect.log(`Status: ${data.status}`, 'info')
      if (data.status === 'inChat' || data.status === 'isLogged') {
        Connect.log('✓ WhatsApp conectado com sucesso!', 'success')
        UI.el('qrStatus').textContent = '✅ Conectado!'
      }
    })

    source.addEventListener('bot', (e) => {
      const updatedBot = JSON.parse(e.data)
      const idx = State.bots.findIndex(b => b.id === updatedBot.id)
      if (idx >= 0) State.bots[idx] = updatedBot
      Bots.render()
      Bots.renderOverview()
      Bots.updateSteps()
      if (updatedBot.isConnected) {
        setTimeout(() => { Modals.close('connect'); toast('Bot conectado ao WhatsApp! 🟢', 'success') }, 1500)
      }
    })

    source.onerror = () => {
      Connect.log('Erro de conexão. Verifique o servidor.', 'error')
    }
  },

  renderQR() {
    const canvas = UI.el('qrCanvas')
    if (!canvas) return
    // Visual mock QR pattern
    const cells = Array.from({ length: 121 }, (_, i) => {
      const row = Math.floor(i / 11), col = i % 11
      const isCornerTL = row < 3 && col < 3
      const isCornerTR = row < 3 && col > 7
      const isCornerBL = row > 7 && col < 3
      const isFilled = isCornerTL || isCornerTR || isCornerBL || Math.random() > 0.55
      return `<div class="qr-cell" style="background:${isFilled ? '#e8edf5' : 'transparent'}"></div>`
    }).join('')
    canvas.innerHTML = cells
  },

  log(msg, type = '') {
    const box = UI.el('connectLog')
    if (!box) return
    const time = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
    const cls = type ? `log-${type}` : ''
    box.innerHTML += `<div class="${cls}">[${time}] ${msg}</div>`
    box.scrollTop = box.scrollHeight
  },

  cleanup() {
    if (State.sseSource) {
      State.sseSource.close()
      State.sseSource = null
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

const Settings = {
  load() {
    const u = State.user
    if (!u) return
    if (UI.el('sName'))     UI.el('sName').value     = u.name ?? ''
    if (UI.el('sLastName')) UI.el('sLastName').value  = u.lastName ?? ''
    if (UI.el('sEmail'))    UI.el('sEmail').value     = u.email ?? ''
    // Load API keys
    Api.get('/users/me').then(user => {
      State.user = user
      const keys = user.apiKeys ?? {}
      if (UI.el('sOpenAI'))    UI.el('sOpenAI').value    = keys.openaiKey         ?? ''
      if (UI.el('sAssistant')) UI.el('sAssistant').value = keys.openaiAssistantId ?? ''
      if (UI.el('sGemini'))    UI.el('sGemini').value    = keys.geminiKey         ?? ''
    }).catch(() => {})
  },

  async saveProfile() {
    try {
      const updated = await Api.patch('/users/me', {
        name:     UI.val('sName'),
        lastName: UI.val('sLastName'),
      })
      State.user = { ...State.user, ...updated }
      Store.save()
      Dashboard.updateSidebar()
      toast('Perfil atualizado!', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  },

  async saveApiKeys() {
    try {
      await Api.patch('/users/me/api-keys', {
        openaiKey:         UI.val('sOpenAI'),
        openaiAssistantId: UI.val('sAssistant'),
        geminiKey:         UI.val('sGemini'),
      })
      toast('Chaves de API salvas! 🔐', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

const Analytics = {
  render() {
    const s = State.stats
    if (!s) return
    UI.el('an-total').textContent  = s.totalMessages.toLocaleString('pt-BR')
    UI.el('an-avg').textContent    = Math.floor(s.totalMessages / 7).toLocaleString('pt-BR')
    UI.el('an-convs').textContent  = s.totalConversations
    UI.el('an-tokens').textContent = s.tokensUsed.toLocaleString('pt-BR')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// BILLING
// ─────────────────────────────────────────────────────────────────────────────

const Billing = {
  render() {
    const u = State.user
    if (!u) return
    const plan = u.plan ?? 'starter'
    const planLabels = { starter:'Starter', pro:'Pro', enterprise:'Enterprise' }
    const planPills  = { starter:'GRÁTIS', pro:'PRO', enterprise:'ENTERPRISE' }
    const limits     = { starter: 500, pro: Infinity, enterprise: Infinity }
    const msgs       = State.stats?.totalMessages ?? 0
    const limit      = limits[plan] ?? 500

    UI.el('bilPlan').textContent = planLabels[plan]
    const pill = UI.el('bilPill')
    pill.textContent  = planPills[plan]
    pill.className    = `plan-pill ${plan}`

    UI.el('bilUsage').textContent = `${msgs.toLocaleString('pt-BR')} / ${limit === Infinity ? '∞' : limit}`
    UI.el('bilBar').style.width   = limit === Infinity ? '8%' : `${Math.min(100, (msgs/limit)*100)}%`
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'))
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    // Cmd/Ctrl+Enter on login
    if (document.getElementById('login').classList.contains('active')) Auth.login()
    if (document.getElementById('register').classList.contains('active')) Auth.register()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

;(async () => {
  Store.load()

  if (State.token && State.user) {
    try {
      // Verify token is still valid
      const me = await Api.get('/auth/me')
      State.user = me
      Store.save()
      await Dashboard.enter()
    } catch (_) {
      // Token expired — show landing
      Store.clear()
      UI.page('landing')
    }
  } else {
    UI.page('landing')
  }
})()