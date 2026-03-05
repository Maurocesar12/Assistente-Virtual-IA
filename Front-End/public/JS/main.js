'use strict'

const API_URL = window.location.origin + '/api'

const State = {
  token: null, user: null, bots: [], conversations: [],
  stats: null, activeBotId: null, connectBotId: null, sseSource: null,
}

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
    try { localStorage.removeItem('zapgpt_token'); localStorage.removeItem('zapgpt_user') } catch (_) {}
    State.token = null; State.user = null
  },
}

const Api = {
  async request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' }
    if (State.token) headers['Authorization'] = `Bearer ${State.token}`
    const res = await fetch(API_URL + path, {
      method, headers, credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({ success: false, error: { message: 'Erro ao processar resposta do servidor' } }))
    if (!res.ok) {
      const details = json?.error?.details
      const msg = details ? details.map(d => d.message).join(', ') : json?.error?.message ?? `HTTP ${res.status}`
      throw new Error(msg)
    }
    return json.data ?? json
  },
  get:    (path)       => Api.request('GET', path),
  post:   (path, body) => Api.request('POST', path, body),
  patch:  (path, body) => Api.request('PATCH', path, body),
  delete: (path)       => Api.request('DELETE', path),
}

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
    const titles = { overview: 'Visão Geral', bots: 'Meus Bots', convs: 'Conversas', analytics: 'Analytics', settings: 'Configurações', billing: 'Assinatura' }
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
    const btn = document.getElementById(btnId); if (!btn) return
    btn.disabled = loading; btn.classList.toggle('loading', loading)
    if (loading) { btn._orig = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>` }
    else if (btn._orig) { btn.innerHTML = btn._orig; delete btn._orig }
  },
  el:   (id) => document.getElementById(id),
  val:  (id) => document.getElementById(id)?.value?.trim() ?? '',
  html: (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h },
}

function toast(msg, type = 'success') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' }
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `<span class="toast-icon">${icons[type] ?? '💬'}</span><span>${msg}</span>`
  document.getElementById('toasts').appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

const Modals = {
  open(id) { document.getElementById(`m-${id}`)?.classList.add('open'); if (id === 'connect') Connect.start() },
  close(id) { document.getElementById(`m-${id}`)?.classList.remove('open'); if (id === 'connect') Connect.cleanup() },
}
document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open') }))

const Auth = {
  async login() {
    const email = UI.val('l-email'), password = UI.val('l-pass')
    if (!email || !password) { toast('Preencha todos os campos', 'error'); return }
    UI.setLoading('loginBtn', true)
    try {
      const data = await Api.post('/auth/login', { email, password })
      State.token = data.token; State.user = data.user
      if (data.mustChangePassword) State.user = { ...State.user, mustChangePassword: true }
      Store.save(); await Dashboard.enter()
      toast(`Bem-vindo de volta, ${data.user.name}! 👋`, 'success')
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('loginBtn', false) }
  },
  async register() {
    const name = UI.val('r-name'), lastName = UI.val('r-last'), email = UI.val('r-email'), password = UI.val('r-pass'), plan = UI.val('r-plan')
    if (!name || !email || !password) { toast('Preencha todos os campos obrigatórios', 'error'); return }
    if (password.length < 8) { toast('Senha deve ter pelo menos 8 caracteres', 'error'); return }
    UI.setLoading('registerBtn', true)
    try {
      const data = await Api.post('/auth/register', { name, lastName, email, password, plan })
      State.token = data.token; State.user = data.user; Store.save()
      await Dashboard.enter(); toast(`Conta criada! Bem-vindo, ${data.user.name}! 🎉`, 'success')
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('registerBtn', false) }
  },
  async demoLogin() {
    const suffix = Date.now()
    try {
      const data = await Api.post('/auth/register', { name: 'Demo', lastName: 'User', email: `demo_${suffix}@zapgpt.com`, password: 'demo1234', plan: 'pro' })
      State.token = data.token; State.user = data.user; Store.save()
      await Dashboard.enter(); toast('Modo demonstração ativado 🚀', 'info')
    } catch (err) { toast('Erro ao iniciar demo: ' + err.message, 'error') }
  },
  openForgot() {
    const form = UI.el('fp-form'), success = UI.el('fp-success')
    if (form) form.style.display = 'block'; if (success) success.style.display = 'none'
    const input = UI.el('fp-email'); if (input) input.value = ''
    UI.page('forgot')
  },
  checkPasswordStrength(value) {
    const bar = UI.el('modal-cp-strength-bar'), label = UI.el('modal-cp-strength-label')
    if (!bar || !label) return
    let score = 0
    if (value.length >= 8) score++; if (value.length >= 12) score++
    if (/[A-Z]/.test(value)) score++; if (/[0-9]/.test(value)) score++; if (/[^A-Za-z0-9]/.test(value)) score++
    const levels = [
      { w: '20%', color: 'var(--red)',    text: 'Muito fraca' },
      { w: '40%', color: 'var(--red)',    text: 'Fraca' },
      { w: '60%', color: 'var(--yellow)', text: 'Razoável' },
      { w: '80%', color: 'var(--yellow)', text: 'Boa' },
      { w: '100%', color: 'var(--green)', text: 'Forte 💪' },
    ]
    const lvl = levels[Math.min(score, 4)]
    bar.style.width = value.length ? lvl.w : '0%'; bar.style.background = lvl.color
    label.textContent = value.length ? lvl.text : ''
  },
  async forgotPassword() {
    const email = UI.val('fp-email')
    if (!email) { toast('Informe seu email', 'error'); return }
    UI.setLoading('forgotBtn', true)
    try {
      await Api.post('/auth/forgot-password', { email })
      UI.el('fp-success').style.display = 'block'; UI.el('fp-form').style.display = 'none'
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('forgotBtn', false) }
  },
  async changePassword() {
    const current = UI.el('modal-cp-current')?.value?.trim() ?? ''
    const next    = UI.el('modal-cp-new')?.value?.trim()     ?? ''
    const confirm = UI.el('modal-cp-confirm')?.value?.trim() ?? ''
    if (!current || !next || !confirm) { toast('Preencha todos os campos', 'error'); return }
    if (next.length < 8)  { toast('Nova senha deve ter pelo menos 8 caracteres', 'error'); return }
    if (next !== confirm) { toast('As senhas não coincidem', 'error'); return }
    UI.setLoading('modal-changePassBtn', true)
    try {
      await Api.post('/auth/change-password', { currentPassword: current, newPassword: next })
      State.user = { ...State.user, mustChangePassword: false }; Store.save()
      Modals.close('changePassword'); toast('Senha alterada com sucesso! 🔐', 'success')
      if (UI.el('modal-cp-current')) UI.el('modal-cp-current').value = ''
      if (UI.el('modal-cp-new'))     UI.el('modal-cp-new').value     = ''
      if (UI.el('modal-cp-confirm')) UI.el('modal-cp-confirm').value = ''
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('modal-changePassBtn', false) }
  },
  async logout() {
    Connect.cleanup()
    try { await Api.post('/auth/logout') } catch (_) {}
    Store.clear(); State.bots = []; State.conversations = []; State.stats = null
    UI.page('landing'); toast('Até logo! 👋', 'info')
  },
}

const Dashboard = {
  async enter() {
    UI.page('dashboard'); UI.view('overview'); Dashboard.updateSidebar(); await Dashboard.refresh()
    if (State.user?.mustChangePassword) setTimeout(() => Modals.open('changePassword'), 500)
  },
  async refresh() {
    try { await Promise.all([Dashboard.loadStats(), Bots.load(), Conversations.load()]) }
    catch (err) { console.error('Dashboard refresh error:', err) }
  },
  async loadStats() {
    try {
      const stats = await Api.get('/users/me/stats'); State.stats = stats
      UI.el('s-bots').textContent      = stats.activeBots
      UI.el('s-msgs').textContent      = stats.totalMessages.toLocaleString('pt-BR')
      UI.el('s-convs').textContent     = stats.totalConversations
      UI.el('s-tokens').textContent    = stats.tokensUsed.toLocaleString('pt-BR')
      UI.el('s-bots-meta').textContent = `${stats.totalBots} total`
    } catch (_) {}
  },
  updateSidebar() {
    const u = State.user; if (!u) return
    UI.el('sbAvatar').textContent = u.name[0].toUpperCase()
    UI.el('sbName').textContent   = `${u.name} ${u.lastName || ''}`
    UI.el('sbPlan').textContent   = (u.plan ?? 'starter').toUpperCase()
  },
  filterConvs(query) {
    const q = query.toLowerCase()
    document.querySelectorAll('.conv-row').forEach(row => { row.style.display = row.dataset.search?.includes(q) ? '' : 'none' })
  },
}

const MODEL_META = {
  'gemini-2.5-flash': { label: 'Gemini 2.5', cls: 'model-gemini' },
  'gpt-4':            { label: 'GPT-4',       cls: 'model-gpt4'   },
  'gpt-3.5-turbo':    { label: 'GPT-3.5',     cls: 'model-gpt35'  },
}

const Bots = {
  async load() {
    try { const result = await Api.get('/bots'); State.bots = Array.isArray(result) ? result : []; Bots.render(); Bots.renderOverview(); Bots.updateSteps() }
    catch (_) { State.bots = [] }
  },
  render() {
    const el = UI.el('botsList'); if (!el) return
    if (State.bots.length === 0) { el.innerHTML = `<div class="empty"><div class="empty-icon">🤖</div><h3>Nenhum bot criado</h3><p>Clique em "+ Novo Bot" para criar seu assistente</p></div>`; return }
    const rows = State.bots.map(b => {
      const m = MODEL_META[b.model] ?? { label: b.model, cls: '' }
      return `<tr><td><div class="flex-center gap-2"><div style="width:7px;height:7px;border-radius:50%;background:${b.isConnected ? 'var(--green)' : 'var(--text-dim)'};${b.isConnected ? 'box-shadow:0 0 6px var(--green)' : ''}"></div><strong>${Bots.escape(b.name)}</strong></div></td><td><span class="model-tag ${m.cls}">${m.label}</span></td><td class="mono text-sm">${b.phone ? b.phone : '<span class="text-dim">Não conectado</span>'}</td><td><span class="badge ${b.isActive ? 'badge-green' : 'badge-red'}">${b.isActive ? 'Ativo' : 'Inativo'}</span></td><td class="text-muted">${(b.messageCount ?? 0).toLocaleString('pt-BR')}</td><td><div class="flex gap-2"><button class="btn btn-ghost btn-sm" onclick="Connect.open('${b.id}')">📱 Conectar</button><button class="btn btn-ghost btn-sm" onclick="Bots.openEdit('${b.id}')">✏️ Editar</button></div></td></tr>`
    }).join('')
    el.innerHTML = `<table class="table"><thead><tr><th>Nome</th><th>Modelo</th><th>Número</th><th>Status</th><th>Mensagens</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table>`
  },
  renderOverview() {
    const el = UI.el('ov-bots'); if (!el) return
    if (!State.bots.length) { el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">🤖</div><h3>Nenhum bot ainda</h3></div>`; return }
    el.innerHTML = State.bots.slice(0, 4).map(b => { const m = MODEL_META[b.model] ?? { label: b.model, cls: '' }; return `<div class="conv-row"><div class="conv-avatar" style="${b.isConnected ? 'background:var(--green-soft)' : ''}">🤖</div><div class="conv-body"><div class="conv-name">${Bots.escape(b.name)}</div><div class="conv-preview"><span class="model-tag ${m.cls}">${m.label}</span> · ${(b.messageCount ?? 0).toLocaleString('pt-BR')} mensagens</div></div><span class="badge ${b.isActive ? 'badge-green' : 'badge-red'}">${b.isActive ? 'Ativo' : 'Off'}</span></div>` }).join('')
  },
  updateSteps() {
    const hasBots = State.bots.length > 0, hasConnected = State.bots.some(b => b.isConnected), hasMsgs = State.bots.some(b => b.messageCount > 0)
    if (hasBots) { UI.el('step1')?.classList.add('done'); const s2 = UI.el('step2'); if (s2) s2.style.opacity = '1' }
    if (hasConnected) { UI.el('step2')?.classList.add('done'); const s3 = UI.el('step3'); if (s3) s3.style.opacity = '1' }
    if (hasMsgs) UI.el('step3')?.classList.add('done')
  },
  async create() {
    const name = UI.val('bName'), model = UI.val('bModel'), prompt = UI.val('bPrompt')
    if (!name || name.length < 2) { toast('O nome do bot deve ter pelo menos 2 caracteres', 'error'); return }
    if (!prompt || prompt.length < 10) { toast('O prompt deve ter pelo menos 10 caracteres', 'error'); return }
    UI.setLoading('createBotBtn', true)
    try {
      const bot = await Api.post('/bots', { name, model, prompt })
      if (!Array.isArray(State.bots)) State.bots = []
      State.bots.unshift(bot); Modals.close('newBot')
      UI.el('bName').value = ''; UI.el('bPrompt').value = ''
      Bots.render(); Bots.renderOverview(); Bots.updateSteps(); Dashboard.loadStats()
      toast(`Bot "${bot.name}" criado com sucesso! 🤖`, 'success')
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('createBotBtn', false) }
  },
  openEdit(botId) {
    const bot = State.bots.find(b => b.id === botId); if (!bot) return
    State.activeBotId = botId
    const m = MODEL_META[bot.model] ?? { label: bot.model }
    UI.el('eBotTitle').textContent = bot.name
    UI.el('eBotMeta').textContent  = `${m.label} · criado em ${new Date(bot.createdAt).toLocaleDateString('pt-BR')}`
    UI.el('eBotPrompt').value = bot.prompt; UI.el('eBotActive').checked = bot.isActive
    Modals.open('editBot')
  },
  async save() {
    const id = State.activeBotId; if (!id) return
    try {
      const updated = await Api.patch(`/bots/${id}`, { prompt: UI.el('eBotPrompt').value, isActive: UI.el('eBotActive').checked })
      const idx = State.bots.findIndex(b => b.id === id); if (idx >= 0) State.bots[idx] = updated
      Modals.close('editBot'); Bots.render(); Bots.renderOverview(); Bots.updateSteps()
      toast('Bot atualizado!', 'success')
    } catch (err) { toast(err.message, 'error') }
  },
  async delete() {
    const id = State.activeBotId; if (!id) return
    const bot = State.bots.find(b => b.id === id)
    if (!confirm(`Excluir o bot "${bot?.name}"? Esta ação não pode ser desfeita.`)) return
    try {
      await Api.delete(`/bots/${id}`); State.bots = State.bots.filter(b => b.id !== id)
      Modals.close('editBot'); Bots.render(); Bots.renderOverview(); toast('Bot excluído', 'info')
    } catch (err) { toast(err.message, 'error') }
  },
  escape(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
}

const Conversations = {
  async load() {
    try { const result = await Api.get('/conversations'); State.conversations = Array.isArray(result) ? result : []; Conversations.render(); Conversations.renderOverview() }
    catch (_) { State.conversations = [] }
  },
  render() {
    const el = UI.el('convsList'); if (!el) return
    if (!State.conversations.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>Nenhuma conversa</h3><p>As conversas aparecerão quando seu bot estiver ativo</p></div>`; return }
    el.innerHTML = State.conversations.map(c => { const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); return `<div class="conv-row" data-search="${Bots.escape(c.contactName?.toLowerCase() ?? '')} ${Bots.escape(c.lastMessage?.toLowerCase() ?? '')}" onclick="toast('Visualização de chat em breve!','info')"><div class="conv-avatar">👤</div><div class="conv-body"><div class="conv-name">${Bots.escape(c.contactName || c.contactPhone)}</div><div class="conv-preview">${Bots.escape(c.lastMessage)}</div></div><div class="conv-right"><div class="conv-time">${time}</div>${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}</div></div>` }).join('')
  },
  renderOverview() {
    const el = UI.el('ov-convs'); if (!el) return
    if (!State.conversations.length) { el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">💬</div><h3>Nenhuma conversa</h3></div>`; return }
    el.innerHTML = State.conversations.slice(0, 4).map(c => { const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); return `<div class="conv-row" onclick="toast('Visualização de chat em breve!','info')"><div class="conv-avatar">👤</div><div class="conv-body"><div class="conv-name">${Bots.escape(c.contactName || c.contactPhone)}</div><div class="conv-preview">${Bots.escape(c.lastMessage)}</div></div><div class="conv-right"><div class="conv-time">${time}</div>${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}</div></div>` }).join('')
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

    Api.post(`/bots/${botId}/connect`).catch(() => {})
    Connect.cleanup()

    const token = State.token || ''
    const source = new EventSource(`${API_URL}/bots/${botId}/events?token=${encodeURIComponent(token)}`)
    State.sseSource = source

    let qrReceived = false, connectedOk = false
    const errorGraceTimer = setTimeout(() => {
      if (!qrReceived && !connectedOk && source.readyState !== EventSource.CLOSED)
        Connect.log('Tempo esgotado aguardando QR Code. Tente novamente.', 'error')
    }, 30_000)

    Connect.log('Iniciando conexão...', 'info')

    source.addEventListener('qr', (e) => {
      qrReceived = true
      clearTimeout(errorGraceTimer)
      const { qrBase64 } = JSON.parse(e.data)
      Connect.renderQR(qrBase64)
      Connect.log('QR Code gerado. Escaneie com o WhatsApp!', 'success')
      UI.el('qrStatus').textContent = 'Escaneie o QR Code acima'
    })

    source.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      Connect.log(`Status: ${data.status}`, 'info')
      if (data.status === 'inChat' || data.status === 'isLogged') {
        connectedOk = true; clearTimeout(errorGraceTimer)
        Connect.log('✓ WhatsApp conectado com sucesso!', 'success')
        UI.el('qrStatus').textContent = '✅ Conectado!'
      }
    })

    source.addEventListener('bot', (e) => {
      const updatedBot = JSON.parse(e.data)
      const idx = State.bots.findIndex(b => b.id === updatedBot.id)
      if (idx >= 0) State.bots[idx] = updatedBot
      Bots.render(); Bots.renderOverview(); Bots.updateSteps()

      // ✅ CONDIÇÃO DUPLA OBRIGATÓRIA:
      // - qrReceived: garante que o QR foi exibido nesta sessão (não sessão restaurada)
      // - connectedOk: garante que o status 'inChat' chegou via evento 'status' (escanou de fato)
      // Sem isso, sessões antigas restauradas pelo wppconnect fecham o modal prematuramente.
      if (updatedBot.isConnected && qrReceived && connectedOk) {
        clearTimeout(errorGraceTimer)
        source.close()
        setTimeout(() => { Modals.close('connect'); toast('Bot conectado ao WhatsApp! 🟢', 'success') }, 1500)
      }
    })

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && !connectedOk)
        Connect.log('Conexão SSE encerrada. Reconectando...', 'info')
    }
  },

  renderQR(base64) {
    const wrap = UI.el('qrWrap') || UI.el('qrCanvas')
    if (!wrap) return

    if (!base64) {
      wrap.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--text-dim)">
          <div class="spinner" style="width:28px;height:28px;border-width:3px"></div>
          <span style="font-size:12px">Gerando QR Code...</span>
        </div>`
      return
    }

    // Remove prefixo duplicado — wppconnect pode enviar "data:image/png;base64," já incluso
    const clean = base64.replace(/^data:image\/[a-z]+;base64,/i, '')

    // FUNDO BRANCO OBRIGATÓRIO — câmera do WhatsApp lê por contraste preto/branco.
    // padding 16px = "quiet zone" exigida pelo padrão QR Code.
    // overflow:hidden no wrapper para a scan-line não aparecer sobre o fundo branco.
    wrap.style.cssText = 'background:transparent;border:none;overflow:visible;'
    wrap.innerHTML = `
      <div style="
        background:#ffffff;
        border-radius:16px;
        padding:16px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        box-shadow:0 0 0 1px rgba(0,0,0,0.08),0 8px 32px rgba(0,0,0,0.4);
        position:relative;
        overflow:hidden;
      ">
        <img
          src="data:image/png;base64,${clean}"
          alt="QR Code WhatsApp"
          width="220"
          height="220"
          style="display:block;image-rendering:pixelated;image-rendering:crisp-edges;"
        >
        <div style="
          position:absolute;left:10px;right:10px;height:2px;
          background:linear-gradient(90deg,transparent,rgba(0,212,106,0.8),transparent);
          box-shadow:0 0 8px rgba(0,212,106,0.6);
          animation:qr-scan 2.2s linear infinite;
        "></div>
      </div>`
  },

  log(msg, type = '') {
    const box = UI.el('connectLog'); if (!box) return
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    box.innerHTML += `<div class="${type ? `log-${type}` : ''}">[${time}] ${msg}</div>`
    box.scrollTop = box.scrollHeight
  },

  cleanup() {
    if (State.sseSource) { State.sseSource.close(); State.sseSource = null }
    const wrap = UI.el('qrWrap')
    if (wrap) {
      wrap.style.cssText = ''
      wrap.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--text-dim)">
          <div class="spinner" style="width:28px;height:28px;border-width:3px"></div>
          <span style="font-size:12px">Gerando QR Code...</span>
        </div>
        <div class="qr-scan-line"></div>`
    }
    const status = UI.el('qrStatus'); if (status) status.textContent = 'Aguardando QR Code...'
    const log = UI.el('connectLog'); if (log) log.innerHTML = ''
  },
}

const Settings = {
  load() {
    const u = State.user; if (!u) return
    if (UI.el('sName'))     UI.el('sName').value     = u.name ?? ''
    if (UI.el('sLastName')) UI.el('sLastName').value  = u.lastName ?? ''
    if (UI.el('sEmail'))    UI.el('sEmail').value     = u.email ?? ''
    Api.get('/auth/me').then(user => {
      State.user = user; Store.save()
      const keys = user.apiKeys ?? {}
      if (UI.el('sOpenAI'))    UI.el('sOpenAI').value    = keys.openaiKey         ?? ''
      if (UI.el('sAssistant')) UI.el('sAssistant').value = keys.openaiAssistantId ?? ''
      if (UI.el('sGemini'))    UI.el('sGemini').value    = keys.geminiKey         ?? ''
    }).catch(() => {})
  },
  async saveProfile() {
    try {
      const updated = await Api.patch('/users/me', { name: UI.val('sName'), lastName: UI.val('sLastName') })
      State.user = { ...State.user, ...updated }; Store.save(); Dashboard.updateSidebar()
      toast('Perfil atualizado!', 'success')
    } catch (err) { toast(err.message, 'error') }
  },
  async saveApiKeys() {
    try {
      await Api.patch('/users/me/api-keys', { openaiKey: UI.val('sOpenAI'), openaiAssistantId: UI.val('sAssistant'), geminiKey: UI.val('sGemini') })
      toast('Chaves de API salvas! 🔐', 'success')
    } catch (err) { toast(err.message, 'error') }
  },
  async changePassword() {
    const current = UI.el('cp-current')?.value?.trim() ?? '', next = UI.el('cp-new')?.value?.trim() ?? '', confirm = UI.el('cp-confirm')?.value?.trim() ?? ''
    if (!current || !next || !confirm) { toast('Preencha todos os campos', 'error'); return }
    if (next.length < 8)  { toast('Nova senha deve ter pelo menos 8 caracteres', 'error'); return }
    if (next !== confirm) { toast('As senhas não coincidem', 'error'); return }
    UI.setLoading('changePassBtn', true)
    try {
      await Api.post('/auth/change-password', { currentPassword: current, newPassword: next })
      toast('Senha alterada com sucesso! 🔐', 'success')
      if (UI.el('cp-current')) UI.el('cp-current').value = ''
      if (UI.el('cp-new'))     UI.el('cp-new').value     = ''
      if (UI.el('cp-confirm')) UI.el('cp-confirm').value = ''
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('changePassBtn', false) }
  },
}

const Analytics = {
  render() {
    const s = State.stats; if (!s) return
    UI.el('an-total').textContent  = s.totalMessages.toLocaleString('pt-BR')
    UI.el('an-avg').textContent    = Math.floor(s.totalMessages / 7).toLocaleString('pt-BR')
    UI.el('an-convs').textContent  = s.totalConversations
    UI.el('an-tokens').textContent = s.tokensUsed.toLocaleString('pt-BR')
  },
}

const Billing = {
  render() {
    const u = State.user; if (!u) return
    const plan = u.plan ?? 'starter'
    const planLabels = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' }
    const planPills  = { starter: 'GRÁTIS',  pro: 'PRO', enterprise: 'ENTERPRISE' }
    const limits     = { starter: 500, pro: Infinity, enterprise: Infinity }
    const msgs = State.stats?.totalMessages ?? 0, limit = limits[plan] ?? 500
    UI.el('bilPlan').textContent = planLabels[plan]
    const pill = UI.el('bilPill'); pill.textContent = planPills[plan]; pill.className = `plan-pill ${plan}`
    UI.el('bilUsage').textContent = `${msgs.toLocaleString('pt-BR')} / ${limit === Infinity ? '∞' : limit}`
    UI.el('bilBar').style.width   = limit === Infinity ? '8%' : `${Math.min(100, (msgs / limit) * 100)}%`
  },
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'))
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (document.getElementById('login').classList.contains('active'))    Auth.login()
    if (document.getElementById('register').classList.contains('active')) Auth.register()
  }
})

;(async () => {
  Store.load()
  if (State.token && State.user) {
    try { const me = await Api.get('/auth/me'); State.user = me; Store.save(); await Dashboard.enter() }
    catch (_) { Store.clear(); UI.page('landing') }
  } else { UI.page('landing') }
})()