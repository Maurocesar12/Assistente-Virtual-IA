'use strict'

const API_URL = 'https://assistente-virtual-ia-production.up.railway.app/api'

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

// ── Formata número de telefone para exibição legível ──────────────────────────
function _formatPhone(raw) {
  if (!raw) return raw
  const digits = raw.replace(/@.*$/, '').replace(/\D/g, '')
  if (digits.length === 13) return `+${digits.slice(0,2)} ${digits.slice(2,4)} ${digits.slice(4,9)}-${digits.slice(9)}`
  if (digits.length === 12) return `+${digits.slice(0,2)} ${digits.slice(2,4)} ${digits.slice(4,8)}-${digits.slice(8)}`
  return digits || raw
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN LIMIT
// ─────────────────────────────────────────────────────────────────────────────

const PlanLimit = {
  showBanner(totalMessages, messageLimit) {
    const existing = UI.el('planLimitBanner')
    if (existing) return
    const banner = document.createElement('div')
    banner.id = 'planLimitBanner'
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(90deg,#f05060,#c03040);color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px;font-weight:500;box-shadow:0 2px 16px rgba(240,80,96,0.5);animation:toast-slide 0.3s ease;`
    banner.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">🚫</span><span>Você atingiu o limite de <strong>${messageLimit} mensagens</strong> do plano gratuito. Seu bot está <strong>pausado</strong> — faça upgrade para continuar respondendo.</span></div><button onclick="Billing.openCheckout()" style="background:#fff;color:#c03040;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">⚡ Fazer upgrade →</button>`
    document.body.prepend(banner)
    const main = document.querySelector('.main')
    if (main) main.style.paddingTop = '52px'
  },
  hideBanner() {
    const banner = UI.el('planLimitBanner'); if (banner) banner.remove()
    const main = document.querySelector('.main'); if (main) main.style.paddingTop = ''
  },
  openUpgradeModal() { Modals.open('upgradePlan') },
  applyFromStats(stats) {
    if (stats.limitReached) PlanLimit.showBanner(stats.totalMessages, stats.messageLimit)
    else PlanLimit.hideBanner()
  },
}

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
    Connect.cleanup(); PlanLimit.hideBanner()
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
      PlanLimit.applyFromStats(stats)
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
      // ✅ Formata o número do bot: "5511999...@c.us" → "+55 11 99999-8888"
      const phoneDisplay = b.phone ? _formatPhone(b.phone) : null
      return `<tr><td><div class="flex-center gap-2"><div style="width:7px;height:7px;border-radius:50%;background:${b.isConnected ? 'var(--green)' : 'var(--text-dim)'};${b.isConnected ? 'box-shadow:0 0 6px var(--green)' : ''}"></div><strong>${Bots.escape(b.name)}</strong></div></td><td><span class="model-tag ${m.cls}">${m.label}</span></td><td class="mono text-sm">${phoneDisplay ? phoneDisplay : '<span class="text-dim">Não conectado</span>'}</td><td><span class="badge ${b.isActive ? 'badge-green' : 'badge-red'}">${b.isActive ? 'Ativo' : 'Inativo'}</span></td><td class="text-muted">${(b.messageCount ?? 0).toLocaleString('pt-BR')}</td><td><div class="flex gap-2"><button class="btn btn-ghost btn-sm" onclick="Connect.open('${b.id}')">📱 Conectar</button><button class="btn btn-ghost btn-sm" onclick="Bots.openEdit('${b.id}')">✏️ Editar</button></div></td></tr>`
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
    const name = UI.val('bName'), model = UI.val('bModel'), prompt = UI.val('bPrompt');
    
    // 1. Verifica se escolheu o modelo
    if (!model) { 
        toast('Selecione um modelo', 'error'); 
        return; 
    }
    
    // 2. Regra do Gemini: Prompt é obrigatório E tem que ter no mínimo 10 caracteres
    if (model === 'gemini-2.5-flash' && (!prompt || prompt.length < 10)) { 
        toast('O prompt é obrigatório e deve ter pelo menos 10 caracteres para o modelo Gemini', 'error'); 
        return; // Interrompe a criação aqui
    }
    
    // 3. Regra do GPT: Apenas avisa se estiver vazio (Note os parênteses extras em volta dos modelos)
    if (model === 'GPT-4' || model === 'GPT-3.5-Turbo') {
        toast('O prompt não é obrigatório para GPT, mas recomendamos verificar seu assist da OpenAI', 'info');
        // Não tem o "return", então a criação do bot vai continuar normalmente!
    }
    
    // 4. Verifica o nome
    if (!name || name.length < 2) { 
        toast('O nome do bot deve ter pelo menos 2 caracteres', 'error'); 
        return; 
    }
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
    const connStatus = UI.el('eBotConnStatus'), connectBtn = UI.el('eBotConnectBtn'), disconnBtn = UI.el('eBotDisconnectBtn')
    const phoneFormatted = bot.phone ? ' — ' + _formatPhone(bot.phone) : ''
    if (connStatus) connStatus.textContent = bot.isConnected ? '🟢 Conectado ao WhatsApp' + phoneFormatted : '🔴 Desconectado'
    if (connectBtn) connectBtn.style.display = bot.isConnected ? 'none' : ''
    if (disconnBtn) disconnBtn.style.display  = bot.isConnected ? '' : 'none'
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
  connectFromEdit() { const id = State.activeBotId; if (!id) return; Modals.close('editBot'); Connect.open(id) },
  async disconnectFromEdit() {
    const id = State.activeBotId; if (!id) return
    const bot = State.bots.find(b => b.id === id); if (!bot) return
    if (!confirm(`Desconectar o bot "${bot.name}" do WhatsApp?`)) return
    const btn = UI.el('eBotDisconnectBtn')
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' }
    try {
      await Api.post(`/bots/${id}/disconnect`)
      const idx = State.bots.findIndex(b => b.id === id)
      if (idx >= 0) State.bots[idx] = { ...State.bots[idx], isConnected: false, isActive: false }
      Bots.render(); Bots.renderOverview(); Bots.updateSteps()
      const connStatus = UI.el('eBotConnStatus'), connectBtn = UI.el('eBotConnectBtn')
      if (connStatus) connStatus.textContent = '🔴 Desconectado'
      if (connectBtn) connectBtn.style.display = ''
      if (btn) btn.style.display = 'none'
      toast(`Bot "${bot.name}" desconectado do WhatsApp`, 'info')
    } catch (err) {
      toast('Erro ao desconectar: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.innerHTML = '⏹ Desconectar' }
    }
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
    if (!State.conversations.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>Nenhuma conversa</h3><p>As conversas aparecerão quando seu bot estiver ativo</p></div>`
      return
    }
    el.innerHTML = State.conversations.map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const displayName = (c.contactName && c.contactName !== c.contactPhone)
        ? c.contactName
        : _formatPhone(c.contactPhone)

      // ✅ FIX: flex-shrink:0 nos badges para não comprimirem e não
      // empurrarem o nome para fora da tela
      const pauseBadge = c.humanHandoff
        ? `<span style="flex-shrink:0;font-size:10px;font-weight:700;padding:2px 7px;border-radius:100px;background:rgba(240,179,64,0.15);color:#f0c060;border:1px solid rgba(240,179,64,0.3);white-space:nowrap">👤 Humano</span>`
        : c.isPaused
          ? `<span style="flex-shrink:0;font-size:10px;font-weight:700;padding:2px 7px;border-radius:100px;background:rgba(240,179,64,0.1);color:#f0b340;border:1px solid rgba(240,179,64,0.25);white-space:nowrap">⏸ Pausado</span>`
          : ''

      const pauseBtn = c.isPaused
        ? `<button class="btn btn-ghost btn-sm" title="Retomar bot" onclick="Conversations.resume('${c.id}')" style="padding:3px 7px;font-size:10px;flex-shrink:0">▶ Retomar</button>`
        : `<button class="btn btn-ghost btn-sm" title="Pausar bot" onclick="Conversations.pause('${c.id}')" style="padding:3px 7px;font-size:10px;flex-shrink:0">⏸</button>`
      const unreadBadge = c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''

      return `<div class="conv-row" id="conv-row-${c.id}" data-search="${Bots.escape(displayName.toLowerCase())} ${Bots.escape(c.lastMessage?.toLowerCase() ?? '')}">
          <div class="conv-avatar" style="cursor:pointer;flex-shrink:0"
               onclick="ChatViewer.open('${c.id}','${Bots.escape(displayName)}','${Bots.escape(c.contactPhone)}')">👤</div>

          <!-- ✅ FIX: overflow:hidden no corpo principal impede expansão além do flex -->
          <div style="flex:1;min-width:0;cursor:pointer;overflow:hidden"
               onclick="ChatViewer.open('${c.id}','${Bots.escape(displayName)}','${Bots.escape(c.contactPhone)}')">

            <!-- ✅ FIX: nome com flex:1;min-width:0 trunca antes do badge -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;min-width:0">
              <div style="font-size:13px;font-weight:600;
                          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                          flex:1;min-width:0">
                ${Bots.escape(displayName)}
              </div>
              ${pauseBadge}
            </div>
            <div style="font-size:12px;color:var(--text-muted);
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${Bots.escape(c.lastMessage)}
            </div>
          </div>

          <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-left:8px">
            <div class="conv-time">${time}</div>
            ${unreadBadge}
            <div style="display:flex;gap:4px;margin-top:2px">
              ${pauseBtn}
              <button class="btn btn-ghost btn-sm" title="Excluir conversa"
                      onclick="Conversations.deleteChat('${c.id}')"
                      style="padding:3px 7px;font-size:10px;color:var(--red);flex-shrink:0">🗑</button>
            </div>
          </div>
        </div>`
    }).join('')
  },
  async deleteChat(convId) {
    if (!confirm('Excluir esta conversa? Todas as mensagens serão apagadas permanentemente.')) return
    try {
      await Api.delete(`/conversations/${convId}`)
      State.conversations = State.conversations.filter(c => c.id !== convId)
      Conversations.render(); Conversations.renderOverview(); toast('Conversa excluída', 'info')
    } catch (err) { toast('Erro ao excluir: ' + err.message, 'error') }
  },
  async pause(convId) {
    try {
      const updated = await Api.post(`/conversations/${convId}/pause`)
      const idx = State.conversations.findIndex(c => c.id === convId)
      if (idx >= 0) State.conversations[idx] = { ...State.conversations[idx], ...updated }
      Conversations.render(); ChatViewer.updatePauseStatus(convId, true, false)
      toast('Bot pausado para esta conversa ⏸', 'info')
    } catch (err) { toast('Erro ao pausar: ' + err.message, 'error') }
  },
  async resume(convId) {
    try {
      const updated = await Api.post(`/conversations/${convId}/resume`)
      const idx = State.conversations.findIndex(c => c.id === convId)
      if (idx >= 0) State.conversations[idx] = { ...State.conversations[idx], ...updated }
      Conversations.render(); ChatViewer.updatePauseStatus(convId, false, false)
      toast('Bot retomado ▶', 'success')
    } catch (err) { toast('Erro ao retomar: ' + err.message, 'error') }
  },
  renderOverview() {
    const el = UI.el('ov-convs'); if (!el) return
    if (!State.conversations.length) { el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">💬</div><h3>Nenhuma conversa</h3></div>`; return }
    el.innerHTML = State.conversations.slice(0, 4).map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const name = (c.contactName && c.contactName !== c.contactPhone) ? c.contactName : _formatPhone(c.contactPhone)
      return `<div class="conv-row" style="cursor:pointer" onclick="UI.view('convs')"><div class="conv-avatar">👤</div><div class="conv-body" style="min-width:0"><div class="conv-name">${Bots.escape(name)}</div><div class="conv-preview" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Bots.escape(c.lastMessage)}</div></div><div class="conv-right" style="flex-shrink:0"><div class="conv-time">${time}</div>${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}</div></div>`
    }).join('')
  },
}

const BotAlerts = {
  _alerts: new Map(),
  show(botId, botName, kind, title, message, action) {
    const key = `${botId}:${kind}`
    if (BotAlerts._alerts.has(key)) BotAlerts.dismiss(key)
    const container = UI.el('botAlertsContainer'); if (!container) return
    const STYLES = {
      connection: { color: 'var(--red)',    bg: 'rgba(240,80,96,0.08)',    border: 'rgba(240,80,96,0.3)',    icon: '📵', btnLabel: '📱 Reconectar', btnAction: `Connect.open('${botId}')` },
      config:     { color: 'var(--red)',    bg: 'rgba(240,80,96,0.08)',    border: 'rgba(240,80,96,0.3)',    icon: '🔑', btnLabel: '⚙️ API Keys',   btnAction: `UI.view('settings')` },
      quota:      { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '💳', btnLabel: '💳 Assinatura', btnAction: `UI.view('billing')` },
      network:    { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '🌐', btnLabel: null, btnAction: null },
      unknown:    { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '⚠️', btnLabel: null, btnAction: null },
    }
    const s = STYLES[kind] ?? STYLES.unknown
    const alertEl = document.createElement('div')
    alertEl.dataset.botAlert = key
    alertEl.style.cssText = `display:flex;align-items:flex-start;gap:14px;padding:16px 18px;margin-bottom:10px;background:${s.bg};border:1px solid ${s.border};border-left:4px solid ${s.color};border-radius:10px;animation:toast-slide 0.3s ease;`
    const msgHtml   = message   ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;line-height:1.5">${Bots.escape(message)}</div>` : ''
    const actionBtn = s.btnLabel ? `<button class="btn btn-sm" onclick="${s.btnAction}" style="background:${s.color};color:${kind==='connection'?'#fff':'#000'};font-size:11px;padding:5px 10px;border-radius:6px;white-space:nowrap">${s.btnLabel}</button>` : ''
    alertEl.innerHTML = `<div style="font-size:22px;flex-shrink:0;margin-top:1px">${s.icon}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:${s.color};margin-bottom:3px">${Bots.escape(botName)} — ${Bots.escape(title)}</div>${msgHtml}<div style="font-size:12px;color:#f0c060;font-weight:500">👉 ${Bots.escape(action)}</div></div><div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end">${actionBtn}<button class="btn btn-ghost btn-sm" onclick="BotAlerts.dismiss('${key}')" style="font-size:11px;padding:5px 10px">✕</button></div>`
    container.appendChild(alertEl)
    BotAlerts._alerts.set(key, alertEl)
  },
  dismiss(key) { const el = BotAlerts._alerts.get(key); if (el) el.remove(); BotAlerts._alerts.delete(key) },
  dismissByBotId(botId) { BotAlerts._alerts.forEach((_, key) => { if (key.startsWith(`${botId}:`)) BotAlerts.dismiss(key) }) },
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT WHATSAPP (SSE)
// ─────────────────────────────────────────────────────────────────────────────

const Connect = {
  open(botId) { State.connectBotId = botId; Modals.open('connect') },

  start() {
    const botId = State.connectBotId; if (!botId) return
    Api.post(`/bots/${botId}/connect`).catch(() => {})
    Connect.cleanup()

    const token  = State.token || ''
    const source = new EventSource(`${API_URL}/bots/${botId}/events?token=${encodeURIComponent(token)}`)
    State.sseSource = source

    let qrReceived = false, connectedOk = false

    const errorGraceTimer = setTimeout(() => {
      if (!qrReceived && !connectedOk && source.readyState !== EventSource.CLOSED) {
        Connect.log('Tempo esgotado aguardando QR Code. Tente fechar e reconectar.', 'error')
        UI.el('qrStatus').textContent = '⚠️ Tempo esgotado — tente novamente'
      }
    }, 35_000)

    Connect.log('Iniciando conexão...', 'info')

    source.addEventListener('qr', (e) => {
      qrReceived = true; clearTimeout(errorGraceTimer)
      const { qrBase64 } = JSON.parse(e.data)
      Connect.renderQR(qrBase64)
      Connect.log('QR Code gerado. Escaneie com o WhatsApp!', 'success')
      UI.el('qrStatus').textContent = 'Aponte o WhatsApp para o QR Code acima'
    })

    source.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      const HANDSHAKE_NOISE = ['notLogged', 'desconnectedMobile', 'disconnectedMobile', 'disconnected', 'deleteToken']
      if (!qrReceived && HANDSHAKE_NOISE.includes(data.status)) return
      Connect.log(`Status: ${data.status}`, 'info')
      if (data.status === 'inChat' || data.status === 'isLogged') { connectedOk = true; clearTimeout(errorGraceTimer) }
    })

    source.addEventListener('connected_with_phone', () => {
      connectedOk = true; clearTimeout(errorGraceTimer); Connect.showConnectedScreen()
    })

    source.addEventListener('error-bot', (e) => {
      const { title, message, action, botId: errBotId } = JSON.parse(e.data)
      const bot = State.bots.find(b => b.id === errBotId)
      BotAlerts.show(errBotId, bot?.name ?? 'Bot', 'connection', title, message, action)
      Connect.log(`⚠️ ${title}: ${message}`, 'error')
    })

    source.addEventListener('ai-error', (e) => {
      const { botId: errBotId, botName, kind, title, action } = JSON.parse(e.data)
      BotAlerts.show(errBotId, botName, kind, title, null, action)
    })

    source.addEventListener('plan-limit', (e) => {
      const { totalMessages, messageLimit } = JSON.parse(e.data)
      PlanLimit.showBanner(totalMessages, messageLimit)
      Dashboard.loadStats()
      toast(`Limite de ${messageLimit} mensagens atingido. Bot pausado.`, 'warning')
    })

    source.addEventListener('bot', (e) => {
      const updatedBot = JSON.parse(e.data)
      const idx = State.bots.findIndex(b => b.id === updatedBot.id)
      if (idx >= 0) State.bots[idx] = updatedBot
      Bots.render(); Bots.renderOverview(); Bots.updateSteps()
      if (updatedBot.isConnected && connectedOk) {
        clearTimeout(errorGraceTimer); source.close(); BotAlerts.dismissByBotId(botId)
        setTimeout(() => { Modals.close('connect'); toast(`Bot conectado ao WhatsApp! 🟢`, 'success') }, 2500)
      }
    })

    source.addEventListener('bot-pause', (e) => {
      const { convId, contactPhone, isPaused, humanHandoff, reason } = JSON.parse(e.data)
      const idx = State.conversations.findIndex(c => c.id === convId)
      if (idx >= 0) { State.conversations[idx] = { ...State.conversations[idx], isPaused, humanHandoff }; Conversations.render(); Conversations.renderOverview() }
      if (reason === 'human_handoff')        toast(`👤 ${contactPhone} solicitou atendimento humano`, 'warning')
      else if (reason === 'manual_override') toast(`⏸ Bot pausado para ${contactPhone}`, 'info')
      else if (reason === 'resumed')         toast(`▶ Bot retomado para ${contactPhone}`, 'success')
      ChatViewer.updatePauseStatus(convId, isPaused, humanHandoff)
    })

    // ✦ Feature 4 — bot-typing: IA gerando resposta
    source.addEventListener('bot-typing', (e) => {
      const { convId, isTyping } = JSON.parse(e.data)
      ChatViewer.setTypingIndicator(convId, isTyping)
    })

    // ✦ NOVO — contact-typing: cliente digitando no WhatsApp
    source.addEventListener('contact-typing', (e) => {
      const { contactPhone, isTyping } = JSON.parse(e.data)
      ChatViewer.setContactTypingIndicator(contactPhone, isTyping)
    })

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && !connectedOk) Connect.log('Conexão SSE encerrada.', 'info')
    }
  },

  showConnectedScreen() {
    Connect.log('✅ WhatsApp conectado com sucesso!', 'success')
    const wrap = UI.el('qrWrap')
    if (wrap) {
      wrap.style.cssText = 'background:transparent;border:none;overflow:visible;'
      wrap.innerHTML = `<div style="background:rgba(0,212,106,0.08);border:1px solid rgba(0,212,106,0.25);border-radius:16px;padding:32px 40px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-width:220px;animation:fade-up 0.3s ease;"><div style="font-size:52px;line-height:1">✅</div><div style="font-size:16px;font-weight:700;color:var(--green)">Conectado!</div><div style="font-size:12px;color:var(--text-muted);text-align:center;line-height:1.5">WhatsApp vinculado com sucesso.<br>O bot já está pronto para responder.</div></div>`
    }
    const status = UI.el('qrStatus'); if (status) status.textContent = '🟢 Bot ativo e respondendo'
  },

  renderQR(base64) {
    const wrap = UI.el('qrWrap') || UI.el('qrCanvas'); if (!wrap) return
    if (!base64) { wrap.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--text-dim)"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><span style="font-size:12px">Gerando QR Code...</span></div>`; return }
    const clean = base64.replace(/^data:image\/[a-z]+;base64,/i, '')
    wrap.style.cssText = 'background:transparent;border:none;overflow:visible;'
    wrap.innerHTML = `<div style="background:#ffffff;border-radius:16px;padding:16px;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px rgba(0,0,0,0.08),0 8px 32px rgba(0,0,0,0.4);position:relative;overflow:hidden;"><img src="data:image/png;base64,${clean}" alt="QR Code WhatsApp" width="220" height="220" style="display:block;image-rendering:pixelated;image-rendering:crisp-edges;"><div style="position:absolute;left:10px;right:10px;height:2px;background:linear-gradient(90deg,transparent,rgba(0,212,106,0.8),transparent);box-shadow:0 0 8px rgba(0,212,106,0.6);animation:qr-scan 2.2s linear infinite;"></div></div>`
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
      wrap.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--text-dim)"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><span style="font-size:12px">Gerando QR Code...</span></div><div class="qr-scan-line"></div>`
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
  async render() {
    const u = State.user; if (!u) return
    const s = State.stats, plan = u.plan ?? 'starter'
    const planLabels = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' }
    const planPills  = { starter: 'GRÁTIS',  pro: 'PRO', enterprise: 'ENTERPRISE' }
    const msgs = s?.totalMessages ?? 0, limit = s?.messageLimit ?? null
    const remaining = s?.remainingMessages, percent = s?.usagePercent ?? 0
    const limitReached = s?.limitReached ?? false
 
    UI.el('bilPlan').textContent = planLabels[plan]
    const pill = UI.el('bilPill')
    if (pill) { pill.textContent = planPills[plan]; pill.className = `plan-pill ${plan}` }
 
    const usageEl = UI.el('bilUsage')
    if (usageEl) usageEl.textContent = `${msgs.toLocaleString('pt-BR')} / ${limit === null ? '∞' : limit.toLocaleString('pt-BR')}`
 
    const barEl = UI.el('bilBar')
    if (barEl) {
      barEl.style.width = limit === null ? '4%' : `${percent}%`
      barEl.style.background = limitReached ? 'var(--red)' : percent >= 80 ? 'var(--yellow)' : 'var(--green)'
    }
 
    const usageAlertEl = UI.el('bilUsageAlert')
    if (usageAlertEl) {
      if (limitReached) {
        usageAlertEl.style.display = ''
        usageAlertEl.innerHTML = `<div style="background:rgba(240,80,96,0.08);border:1px solid rgba(240,80,96,0.3);border-left:4px solid var(--red);border-radius:8px;padding:12px 16px;margin-top:12px;font-size:13px;color:var(--text-muted)">🚫 <strong style="color:var(--red)">Limite atingido!</strong> Seu bot está pausado. Faça upgrade para continuar respondendo.</div>`
      } else if (percent >= 80 && limit !== null) {
        usageAlertEl.style.display = ''
        usageAlertEl.innerHTML = `<div style="background:rgba(240,179,64,0.08);border:1px solid rgba(240,179,64,0.3);border-left:4px solid var(--yellow);border-radius:8px;padding:12px 16px;margin-top:12px;font-size:13px;color:var(--text-muted)">⚠️ <strong style="color:var(--yellow)">Atenção:</strong> Você usou ${percent}% do seu limite mensal. Restam <strong style="color:var(--text)">${remaining?.toLocaleString('pt-BR') ?? 0} mensagens</strong>.</div>`
      } else {
        usageAlertEl.style.display = 'none'
      }
    }
 
    const upgradeBtn = UI.el('bilUpgradeBtn')
    if (upgradeBtn) upgradeBtn.style.display = (plan === 'pro' || plan === 'enterprise') ? 'none' : ''
 
    // Carrega histórico de cobranças
    Billing.loadHistory()
  },
 
  async loadHistory() {
    const container = UI.el('bilInvoices'); if (!container) return
    try {
      const data = await Api.get('/billing/status')
      const billings = data.billings ?? []
      if (!billings.length) {
        container.innerHTML = `<div class="empty"><div class="empty-icon">🧾</div><h3>Nenhuma cobrança ainda</h3><p>Suas cobranças aparecerão aqui após o primeiro pagamento</p></div>`
        return
      }
      const statusLabel = {
        PENDING:   { label: 'Pendente',   cls: 'badge-yellow' },
        PAID:      { label: 'Pago',       cls: 'badge-green'  },
        EXPIRED:   { label: 'Expirado',   cls: 'badge-red'    },
        CANCELLED: { label: 'Cancelado',  cls: 'badge-red'    },
      }
      container.innerHTML = billings.map((b) => {
        const st = statusLabel[b.status] ?? { label: b.status, cls: 'badge-yellow' }
        const date = new Date(b.createdAt).toLocaleDateString('pt-BR')
        const amount = (b.amount / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        return `<tr>
          <td class="mono text-sm">${b.id}</td>
          <td>${date}</td>
          <td>${amount}</td>
          <td><span class="badge ${st.cls}">${st.label}</span></td>
          <td>${b.status === 'PENDING' ? `<a href="${b.url}" target="_blank" class="btn btn-ghost btn-sm">Pagar →</a>` : '—'}</td>
        </tr>`
      }).join('')
    } catch (err) {
      container.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px">Não foi possível carregar o histórico</td></tr>`
    }
  },
 
  // Abre modal de checkout do AbacatePay
  openCheckout() {
    Modals.open('checkoutPro')
  },
 
  // Chama a API e redireciona para a página de pagamento do AbacatePay
  async startCheckout() {
    const taxId     = UI.val('checkoutTaxId')
    const cellphone = UI.val('checkoutPhone')
 
    const cleanTaxId = taxId.replace(/\D/g, '')
    if (cleanTaxId.length < 11) {
      toast('Informe um CPF ou CNPJ válido', 'error'); return
    }
 
    UI.setLoading('checkoutBtn', true)
    try {
      const data = await Api.post('/billing/checkout', {
        taxId:     taxId.trim(),
        cellphone: cellphone || undefined,
      })
      // Abre a página de pagamento do AbacatePay em nova aba
      window.open(data.url, '_blank', 'noopener,noreferrer')
      Modals.close('checkoutPro')
      toast('Página de pagamento aberta! Complete o pagamento para ativar o Pro. 🎉', 'info')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      UI.setLoading('checkoutBtn', false)
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// ✦ CHAT VIEWER — versão corrigida com ordem, typing do contato e nomes
// ─────────────────────────────────────────────────────────────────────────────

const ChatViewer = {
  _activeConvId:    null,
  _activeConvPhone: null,

  async open(convId, contactName, contactPhone) {
    ChatViewer._activeConvId    = convId
    ChatViewer._activeConvPhone = contactPhone

    const conv = State.conversations.find(c => c.id === convId)
    const bot  = conv ? State.bots.find(b => b.id === conv.botId) : null

    // Nome legível do contato
    const displayName = (contactName && contactName !== contactPhone)
      ? contactName
      : _formatPhone(contactPhone)

    UI.el('chatContactName').textContent  = displayName
    UI.el('chatContactPhone').textContent = _formatPhone(contactPhone)

    // Nome do bot no badge
    const badge = UI.el('chatBotBadge')
    if (badge) badge.textContent = bot ? `🤖 ${bot.name}` : '🤖 Bot'

    ChatViewer.updatePauseStatus(convId, conv?.isPaused ?? false, conv?.humanHandoff ?? false)
    document.getElementById('m-chat')?.classList.add('open')

    UI.el('chatMessages').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:13px">
        <span class="spinner" style="margin-right:8px"></span> Carregando mensagens...
      </div>`
    UI.el('chatMsgCount').textContent = '...'

    try {
      const messages = await Api.get(`/conversations/${convId}/messages`)
      ChatViewer.render(messages, bot, displayName)
    } catch (_) {
      UI.el('chatMessages').innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--red);font-size:13px">
          ⚠️ Erro ao carregar mensagens
        </div>`
    }
  },

  /**
   * Renderiza mensagens com:
   * - Ordem garantida por createdAt ASC (vem do DB nesta ordem)
   * - Nome do remetente acima de cada bloco de mensagens (agrupa consecutivas)
   * - Bot → alinhado à direita em verde; Cliente → alinhado à esquerda em cinza
   */
  render(messages, bot, contactDisplayName) {
    const container = UI.el('chatMessages')
    const count     = UI.el('chatMsgCount')
    if (!container) return

    const botName     = bot?.name ?? 'Bot'
    const contactName = contactDisplayName ?? 'Cliente'

    if (!messages || messages.length === 0) {
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:13px">
          Nenhuma mensagem ainda
        </div>`
      if (count) count.textContent = '0 mensagens'
      return
    }

    if (count) count.textContent = `${messages.length} mensagem${messages.length !== 1 ? 's' : ''}`

    container.innerHTML = messages.map((m, idx) => {
      const isUser      = m.role === 'user'
      const isError     = m.role === 'assistant' && m.content.startsWith('⚠️')
      const time        = new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const text        = Bots.escape(m.content)
      const senderName  = isUser ? contactName : botName
      const senderEmoji = isUser ? '👤' : '🤖'
      const senderColor = isUser ? 'var(--text-dim)' : 'var(--green)'

      // Label do remetente só quando muda em relação à mensagem anterior
      const prevMsg    = messages[idx - 1]
      const sameRole   = prevMsg && prevMsg.role === m.role
      const showLabel  = !sameRole

      const labelHtml = showLabel
        ? `<div style="font-size:10px;font-weight:700;color:${senderColor};margin-bottom:3px;padding:0 4px">
             ${senderEmoji} ${Bots.escape(senderName)}
           </div>`
        : ''

      return `
        <div style="display:flex;flex-direction:column;
                    align-items:${isUser ? 'flex-start' : 'flex-end'};
                    gap:1px;margin-top:${showLabel && idx > 0 ? '10px' : '2px'}">
          ${labelHtml}
          <div style="max-width:78%;padding:9px 13px;
                      border-radius:${isUser ? '4px 14px 14px 14px' : '14px 4px 14px 14px'};
                      font-size:13px;line-height:1.55;word-break:break-word;
                      ${isUser
                        ? 'background:var(--surface3);color:var(--text);border:1px solid var(--border2);'
                        : isError
                          ? 'background:rgba(240,80,96,0.12);color:#f07080;border:1px solid rgba(240,80,96,0.25);'
                          : 'background:rgba(0,212,106,0.12);color:var(--text);border:1px solid rgba(0,212,106,0.2);'
                      }">${text}</div>
          <span style="font-size:10px;color:var(--text-dim);padding:0 4px">${time}</span>
        </div>`
    }).join('')

    setTimeout(() => { container.scrollTop = container.scrollHeight }, 50)
  },

  updatePauseStatus(convId, isPaused, humanHandoff) {
    if (ChatViewer._activeConvId !== convId) return
    const statusEl = UI.el('chatPauseStatus'); if (!statusEl) return
    if (humanHandoff) {
      statusEl.innerHTML = `<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;background:rgba(240,179,64,0.15);color:#f0c060;border:1px solid rgba(240,179,64,0.3)">👤 Aguardando humano</span><button class="btn btn-ghost btn-sm" onclick="ChatViewer.resumeCurrentChat()" style="padding:3px 8px;font-size:10px">▶ Retomar</button>`
    } else if (isPaused) {
      statusEl.innerHTML = `<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;background:rgba(240,179,64,0.1);color:#f0b340;border:1px solid rgba(240,179,64,0.25)">⏸ Bot pausado</span><button class="btn btn-ghost btn-sm" onclick="ChatViewer.resumeCurrentChat()" style="padding:3px 8px;font-size:10px">▶ Retomar</button>`
    } else {
      statusEl.innerHTML = `<span style="font-size:11px;padding:3px 10px;border-radius:100px;background:rgba(0,212,106,0.08);color:var(--green);border:1px solid rgba(0,212,106,0.2)">🤖 Bot ativo</span><button class="btn btn-ghost btn-sm" onclick="ChatViewer.pauseCurrentChat()" style="padding:3px 8px;font-size:10px">⏸ Pausar</button>`
    }
  },

  async pauseCurrentChat()  { const id = ChatViewer._activeConvId; if (id) await Conversations.pause(id) },
  async resumeCurrentChat() { const id = ChatViewer._activeConvId; if (id) await Conversations.resume(id) },

  // ── ✦ Feature 4 — IA digitando (bot-typing) ──────────────────────────────

  setTypingIndicator(convId, isTyping) {
    if (ChatViewer._activeConvId !== convId) return
    const container = UI.el('chatMessages'); if (!container) return
    const existing = container.querySelector('#typing-indicator-bot')

    if (isTyping && !existing) {
      const conv = State.conversations.find(c => c.id === convId)
      const bot  = conv ? State.bots.find(b => b.id === conv.botId) : null
      const name = bot?.name ?? 'Bot'

      const el = document.createElement('div')
      el.id = 'typing-indicator-bot'
      el.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:2px;animation:fade-up 0.2s ease;margin-top:10px'
      el.innerHTML =
        `<div style="font-size:10px;font-weight:700;color:var(--green);margin-bottom:3px;padding:0 4px">🤖 ${Bots.escape(name)}</div>` +
        `<div style="padding:10px 16px;border-radius:14px 4px 14px 14px;background:rgba(0,212,106,0.08);border:1px solid rgba(0,212,106,0.15);display:inline-flex;align-items:center;gap:5px;">` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0s"></span>` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0.2s"></span>` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0.4s"></span>` +
        `</div><span style="font-size:10px;color:var(--text-dim);padding:0 4px">digitando...</span>`
      container.appendChild(el)
      container.scrollTop = container.scrollHeight
    } else if (!isTyping && existing) {
      existing.remove()
    }
  },

  // ── ✦ NOVO — cliente digitando no WhatsApp (contact-typing) ──────────────

  setContactTypingIndicator(contactPhone, isTyping) {
    if (ChatViewer._activeConvPhone !== contactPhone) return
    const container = UI.el('chatMessages'); if (!container) return
    const existing = container.querySelector('#typing-indicator-contact')

    if (isTyping && !existing) {
      const conv = State.conversations.find(
        c => c.contactPhone === contactPhone && c.id === ChatViewer._activeConvId
      )
      const name = (conv?.contactName && conv.contactName !== contactPhone)
        ? conv.contactName
        : _formatPhone(contactPhone)

      const el = document.createElement('div')
      el.id = 'typing-indicator-contact'
      el.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:2px;animation:fade-up 0.2s ease;margin-top:10px'
      el.innerHTML =
        `<div style="font-size:10px;font-weight:700;color:var(--text-dim);margin-bottom:3px;padding:0 4px">👤 ${Bots.escape(name)}</div>` +
        `<div style="padding:10px 16px;border-radius:4px 14px 14px 14px;background:var(--surface3);border:1px solid var(--border2);display:inline-flex;align-items:center;gap:5px;">` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0s"></span>` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0.2s"></span>` +
        `<span style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);display:inline-block;animation:typing-dot 1.2s infinite;animation-delay:0.4s"></span>` +
        `</div><span style="font-size:10px;color:var(--text-dim);padding:0 4px">digitando...</span>`
      container.appendChild(el)
      container.scrollTop = container.scrollHeight
    } else if (!isTyping && existing) {
      existing.remove()
    }
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