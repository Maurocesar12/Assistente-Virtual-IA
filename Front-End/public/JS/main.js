'use strict'

const API_URL = 'https://assistente-virtual-ia-production.up.railway.app/api'

const State = {
  token: null, user: null, bots: [], conversations: [],
  stats: null, calendar: null, billingStatus: null, activeBotId: null, connectBotId: null, sseSource: null,
  isDemo: false,
}

const Store = {
  save() {
    try {
      if (State.token) localStorage.setItem('zapgpt_token', State.token)
      if (State.user)  localStorage.setItem('zapgpt_user',  JSON.stringify(State.user))
      if (State.isDemo) localStorage.setItem('zapgpt_demo', '1')
      else localStorage.removeItem('zapgpt_demo')
    } catch (_) {}
  },
  load() {
    try {
      State.token = localStorage.getItem('zapgpt_token')
      State.isDemo = localStorage.getItem('zapgpt_demo') === '1'
      const u = localStorage.getItem('zapgpt_user')
      if (u) State.user = JSON.parse(u)
      if (State.user && State.isDemo) State.user = { ...State.user, isDemo: true }
    } catch (_) {}
  },
  clear() {
    try { localStorage.removeItem('zapgpt_token'); localStorage.removeItem('zapgpt_user'); localStorage.removeItem('zapgpt_demo') } catch (_) {}
    State.token = null; State.user = null; State.isDemo = false
  },
}

const Api = {
  async request(method, path, body = null) {
    if (Demo.blocksMutation(method, path)) {
      const err = new Error(DEMO_READ_ONLY_MESSAGE)
      err.status = 403
      err.code = 'DEMO_READ_ONLY'
      throw err
    }
    const headers = { 'Content-Type': 'application/json' }
    if (State.token) headers['Authorization'] = `Bearer ${State.token}`
    let res
    try {
      res = await fetch(API_URL + path, {
        method, headers, credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (_) {
      throw new Error('Nao foi possivel conectar ao servidor. Verifique sua internet e tente novamente.')
    }
    const json = await res.json().catch(() => ({ success: false, error: { message: 'Erro ao processar resposta do servidor' } }))
    if (!res.ok) {
      const details = json?.error?.details
      const msg = details ? details.map(d => d.message).join(', ') : json?.error?.message ?? `HTTP ${res.status}`
      const err = new Error(msg)
      err.status = res.status
      err.code = json?.error?.code
      err.data = json?.error?.data
      throw err
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
    if (id === 'analytics') Analytics.load()
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
  const icons = { success: 'OK', error: 'ERRO', info: 'INFO', warning: 'AVISO' }
  const el = document.createElement('div')
  el.className = `toast ${type}`
  const icon = document.createElement('span')
  icon.className = 'toast-icon'
  icon.textContent = icons[type] ?? 'INFO'
  const text = document.createElement('span')
  text.textContent = String(msg ?? '')
  el.append(icon, text)
  document.getElementById('toasts')?.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

function toastError(err, fallback = 'Nao foi possivel concluir a acao. Tente novamente.') {
  toast(err?.message || fallback, 'error')
}

const DEMO_READ_ONLY_MESSAGE = 'Esta demonstracao e somente leitura. Registre sua conta para criar, editar ou conectar recursos.'

const Demo = {
  isDemoEmail(email) {
    return /^demo_\d+@zapgpt\.com$/i.test(String(email || ''))
  },

  isActive(user = State.user) {
    return Boolean(State.isDemo || user?.isDemo || Demo.isDemoEmail(user?.email))
  },

  blocksMutation(method, path) {
    if (!Demo.isActive()) return false
    if (method === 'GET') return false
    return !['/auth/logout', '/auth/login', '/auth/register', '/auth/forgot-password'].includes(path)
  },

  requireRealAccount() {
    if (!Demo.isActive()) return true
    toast(DEMO_READ_ONLY_MESSAGE, 'warning')
    return false
  },

  start() {
    Store.clear()
    State.isDemo = true
    State.token = null
    State.user = {
      id: 'demo-local',
      name: 'Demo',
      lastName: 'User',
      email: 'demo@zapiens.local',
      plan: 'starter',
      subscriptionStatus: 'none',
      apiKeys: {},
      isDemo: true,
    }
    Demo.loadSampleData()
    Store.save()
  },

  goRegister() {
    Connect.cleanup()
    Store.clear()
    State.bots = []
    State.conversations = []
    State.stats = null
    State.calendar = null
    State.billingStatus = null
    UI.page('register')
    toast('Crie sua conta gratuita para liberar edicoes, conexoes e configuracoes.', 'info')
  },

  applyUI() {
    const active = Demo.isActive()
    document.body.classList.toggle('demo-readonly', active)
    const banner = UI.el('demoReadOnlyBanner')
    if (banner) banner.style.display = active ? '' : 'none'
    ;['sName', 'sLastName', 'sOpenAI', 'sAssistant', 'sGemini', 'calendarId', 'cp-current', 'cp-new', 'cp-confirm'].forEach(id => {
      const field = UI.el(id)
      if (!field) return
      field.readOnly = active
      field.onclick = active ? () => Demo.requireRealAccount() : null
    })
  },

  loadSampleData() {
    const now = Date.now()
    const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()

    State.bots = [
      {
        id: 'demo-bot-sales',
        userId: 'demo-local',
        name: 'Atendente Comercial',
        model: 'gemini-2.5-flash',
        prompt: 'Atenda leads, qualifique necessidades e ofereca reunioes comerciais.',
        isActive: true,
        isConnected: true,
        phone: '5511999998888@c.us',
        sessionName: 'demo_sales',
        messageCount: 128,
        createdAt: iso(14400),
      },
      {
        id: 'demo-bot-support',
        userId: 'demo-local',
        name: 'Suporte Pos-venda',
        model: 'gpt-4',
        prompt: 'Ajude clientes com duvidas frequentes e encaminhe casos complexos.',
        isActive: false,
        isConnected: false,
        phone: null,
        sessionName: 'demo_support',
        messageCount: 42,
        createdAt: iso(10080),
      },
    ]

    State.conversations = [
      {
        id: 'demo-conv-ana',
        botId: 'demo-bot-sales',
        userId: 'demo-local',
        contactName: 'Ana Martins',
        contactPhone: '5511988887777@c.us',
        lastMessage: 'Perfeito, pode marcar para amanha as 15h.',
        lastMessageAt: iso(18),
        unreadCount: 2,
        isPaused: false,
        humanHandoff: false,
      },
      {
        id: 'demo-conv-carlos',
        botId: 'demo-bot-sales',
        userId: 'demo-local',
        contactName: 'Carlos Lima',
        contactPhone: '5521977776666@c.us',
        lastMessage: 'Quero entender os planos antes de contratar.',
        lastMessageAt: iso(74),
        unreadCount: 0,
        isPaused: true,
        humanHandoff: false,
      },
      {
        id: 'demo-conv-marina',
        botId: 'demo-bot-support',
        userId: 'demo-local',
        contactName: 'Marina Costa',
        contactPhone: '5531966665555@c.us',
        lastMessage: 'Obrigada, resolveu minha duvida.',
        lastMessageAt: iso(240),
        unreadCount: 0,
        isPaused: false,
        humanHandoff: false,
      },
    ]

    State.stats = {
      activeBots: 1,
      totalBots: 2,
      totalMessages: 170,
      totalConversations: 3,
      tokensUsed: 24830,
      plan: 'starter',
      subscriptionStatus: 'none',
      analyticsAvailable: false,
      planLabel: 'Starter',
      planPrice: 0,
      messageLimit: 50,
      remainingMessages: 0,
      usagePercent: 100,
      limitReached: false,
    }
    State.billingStatus = { plan: 'starter', subscriptionStatus: 'none', planExpiresAt: null, daysUntilExpiry: null, billings: [] }
    State.calendar = { connected: false, enabled: false, calendarId: 'primary' }
  },

  messagesFor(convId) {
    const data = {
      'demo-conv-ana': [
        { id: 'm1', role: 'user', content: 'Oi, gostaria de conhecer a plataforma para atendimento no WhatsApp.', createdAt: new Date(Date.now() - 32 * 60_000).toISOString() },
        { id: 'm2', role: 'assistant', content: 'Claro. Posso te explicar os recursos e, se fizer sentido, agendar uma reuniao rapida.', createdAt: new Date(Date.now() - 31 * 60_000).toISOString() },
        { id: 'm3', role: 'user', content: 'Tenho disponibilidade amanha as 15h.', createdAt: new Date(Date.now() - 19 * 60_000).toISOString() },
        { id: 'm4', role: 'assistant', content: 'Perfeito. Identifiquei a data e horario da reuniao. Com Google Agenda conectado, o evento seria criado automaticamente.', createdAt: new Date(Date.now() - 18 * 60_000).toISOString() },
      ],
      'demo-conv-carlos': [
        { id: 'm5', role: 'user', content: 'Quero entender os planos antes de contratar.', createdAt: new Date(Date.now() - 76 * 60_000).toISOString() },
        { id: 'm6', role: 'assistant', content: 'O Starter permite testar o fluxo. O Pro libera mensagens ilimitadas, Analytics completo e mais recursos de operacao.', createdAt: new Date(Date.now() - 74 * 60_000).toISOString() },
      ],
      'demo-conv-marina': [
        { id: 'm7', role: 'user', content: 'Como eu troco a chave da IA?', createdAt: new Date(Date.now() - 250 * 60_000).toISOString() },
        { id: 'm8', role: 'assistant', content: 'Acesse Configuracoes > API Keys e cole a nova chave OpenAI ou Gemini. A chave anterior fica preservada se o campo for deixado vazio.', createdAt: new Date(Date.now() - 248 * 60_000).toISOString() },
        { id: 'm9', role: 'user', content: 'Obrigada, resolveu minha duvida.', createdAt: new Date(Date.now() - 240 * 60_000).toISOString() },
      ],
    }
    return data[convId] ?? []
  },
}

const Modals = {
  open(id) {
    if (['newBot', 'checkoutPro', 'changePassword'].includes(id) && !Demo.requireRealAccount()) return
    document.getElementById(`m-${id}`)?.classList.add('open')
    if (id === 'connect') Connect.start()
    if (id === 'newBot') Bots.updateModelPrompt()
  },
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
  // Mostra banner de limite de mensagens (starter atingiu 50)
  showBanner(totalMessages, messageLimit) {
    if (UI.el('planLimitBanner')) return
    const banner = document.createElement('div')
    banner.id = 'planLimitBanner'
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(90deg,#f05060,#c03040);color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px;font-weight:500;box-shadow:0 2px 16px rgba(240,80,96,0.5);animation:toast-slide 0.3s ease;`
    banner.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">🚫</span><span>Você atingiu o limite de <strong>${messageLimit} mensagens</strong> do plano gratuito. Seu bot está <strong>pausado</strong> — faça upgrade para continuar.</span></div><button onclick="Billing.openCheckout()" style="background:#fff;color:#c03040;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">⚡ Fazer upgrade →</button>`
    document.body.prepend(banner)
    const main = document.querySelector('.main')
    if (main) main.style.paddingTop = '52px'
  },

  hideBanner() {
    const banner = UI.el('planLimitBanner'); if (banner) banner.remove()
    const main = document.querySelector('.main'); if (main) main.style.paddingTop = ''
  },

  // Mostra banner de plano vencido (past_due)
  showExpiredBanner(daysOverdue) {
    if (UI.el('planExpiredBanner')) return
    const banner = document.createElement('div')
    banner.id = 'planExpiredBanner'
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(90deg,#e04050,#a02030);color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px;font-weight:500;box-shadow:0 2px 16px rgba(220,60,70,0.5);animation:toast-slide 0.3s ease;`
    banner.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">🔴</span><span>Seu plano Pro <strong>venceu</strong>. Seus bots estão pausados — seus dados estão preservados.</span></div><button onclick="UI.view('billing');Billing.openCheckout()" style="background:#fff;color:#a02030;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">🔄 Renovar agora →</button>`
    document.body.prepend(banner)
    const main = document.querySelector('.main')
    if (main) main.style.paddingTop = '52px'
  },

  // Mostra banner de aviso de vencimento próximo (5 dias ou menos)
  showReminderBanner(daysLeft, expiresAt) {
    if (UI.el('planReminderBanner')) return
    const dateStr = expiresAt
      ? new Date(expiresAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })
      : ''
    const banner = document.createElement('div')
    banner.id = 'planReminderBanner'
    banner.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:999;background:linear-gradient(90deg,#c08010,#a06008);color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px;font-weight:500;box-shadow:0 2px 16px rgba(200,130,20,0.5);animation:toast-slide 0.3s ease;`
    banner.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">⚠️</span><span>Seu plano Pro vence em <strong>${daysLeft} dia${daysLeft !== 1 ? 's' : ''}</strong>${dateStr ? ` (${dateStr})` : ''}. Renove para não interromper o atendimento.</span></div><button onclick="UI.view('billing');Billing.openCheckout()" style="background:#fff;color:#a06008;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">Renovar agora →</button><button onclick="PlanLimit.dismissReminderBanner()" style="background:transparent;border:1px solid rgba(255,255,255,0.4);color:#fff;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;flex-shrink:0">✕</button>`
    document.body.prepend(banner)
    const main = document.querySelector('.main')
    if (main) main.style.paddingTop = '52px'
  },

  dismissReminderBanner() {
    const banner = UI.el('planReminderBanner'); if (banner) banner.remove()
    const main = document.querySelector('.main')
    // Só remove o padding se não houver outro banner
    if (!UI.el('planLimitBanner') && !UI.el('planExpiredBanner')) {
      if (main) main.style.paddingTop = ''
    }
    // Guarda no sessionStorage para não mostrar de novo na mesma sessão
    try { sessionStorage.setItem('reminderDismissed', '1') } catch (_) {}
  },

  hideAllBanners() {
    ;['planLimitBanner', 'planExpiredBanner', 'planReminderBanner'].forEach(id => {
      const el = UI.el(id); if (el) el.remove()
    })
    const main = document.querySelector('.main'); if (main) main.style.paddingTop = ''
  },

  // Aplica o estado correto de banner baseado nos stats + status de billing
  applyFromStats(stats) {
    // Limite de starter atingido
    if (stats.limitReached && stats.plan === 'starter') {
      PlanLimit.showBanner(stats.totalMessages, stats.messageLimit)
      return
    }
    PlanLimit.hideBanner?.() // compat
  },

  // Aplica o estado de billing (vencimento)
  applyFromBillingStatus(billingStatus) {
    const { subscriptionStatus, daysUntilExpiry, planExpiresAt } = billingStatus

    if (subscriptionStatus === 'past_due') {
      PlanLimit.showExpiredBanner(0)
      return
    }

    if (
      subscriptionStatus === 'active' &&
      daysUntilExpiry !== null &&
      daysUntilExpiry <= 5 &&
      daysUntilExpiry > 0
    ) {
      try {
        // Não mostra se o usuário já dispensou na sessão atual
        if (sessionStorage.getItem('reminderDismissed')) return
      } catch (_) {}
      PlanLimit.showReminderBanner(daysUntilExpiry, planExpiresAt)
    }
  },

  // Toast mostrado ao fazer login quando o plano está vencendo ou vencido
  showLoginToast(billingStatus) {
    const { subscriptionStatus, daysUntilExpiry } = billingStatus
    if (subscriptionStatus === 'past_due') {
      setTimeout(() => toast('🔴 Seu plano Pro está vencido. Seus bots estão pausados — renove em Assinatura.', 'error'), 800)
    } else if (subscriptionStatus === 'active' && daysUntilExpiry !== null && daysUntilExpiry <= 5 && daysUntilExpiry > 0) {
      setTimeout(() => toast(`⚠️ Seu plano Pro vence em ${daysUntilExpiry} dia${daysUntilExpiry !== 1 ? 's' : ''}. Renove em Assinatura para não perder o acesso.`, 'warning'), 800)
     }
   },
};

const Auth = {
  async login() {
    const email = UI.val('l-email'), password = UI.val('l-pass')
    if (!email || !password) { toast('Preencha todos os campos', 'error'); return }
    UI.setLoading('loginBtn', true)
    try {
      const data = await Api.post('/auth/login', { email, password })
      State.isDemo = false
      State.token = data.token; State.user = data.user
      if (data.mustChangePassword) State.user = { ...State.user, mustChangePassword: true }
      Store.save(); await Dashboard.enter()
      toast(`Bem-vindo de volta, ${data.user.name}! 👋`, 'success')
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('loginBtn', false) }
  },
  async register() {
  const name     = UI.val('r-name')
  const lastName = UI.val('r-last')
  const email    = UI.val('r-email')
  const password = UI.val('r-pass')
  const planIntent = document.getElementById('r-plan')?.value || 'starter'

  if (!name || !email || !password) { toast('Preencha todos os campos obrigatórios', 'error'); return }
  if (password.length < 8) { toast('Senha deve ter pelo menos 8 caracteres', 'error'); return }

  UI.setLoading('registerBtn', true)
  try {
    const data = await Api.post('/auth/register', { name, lastName, email, password, planIntent })
    State.isDemo = false
    State.token = data.token
    State.user  = data.user
    Store.save()
    await Dashboard.enter()
    toast(`Conta criada! Bem-vindo, ${data.user.name}! 🎉`, 'success')

    // Se escolheu pro → redireciona para billing e abre checkout
    if (data.pendingUpgrade) {
      setTimeout(() => {
        toast('Complete o pagamento para ativar o Pro ⚡', 'info')
        setTimeout(() => {
          UI.view('billing')
          Billing.openCheckout()
        }, 800)
      }, 600)
    }
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    UI.setLoading('registerBtn', false)
  }
},
  async demoLogin() {
    Demo.start()
    await Dashboard.enter()
    toast('Modo demonstracao ativado. A demonstracao e somente leitura.', 'info')
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
    if (!Demo.requireRealAccount()) return
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
    try { if (State.token) await Api.post('/auth/logout') } catch (_) {}
    Store.clear(); State.bots = []; State.conversations = []; State.stats = null; State.calendar = null; State.billingStatus = null
    UI.page('landing'); toast('Até logo! 👋', 'info')
  },
}

const Register = {
  selectPlan(plan) {
    // Atualiza o campo hidden
    document.getElementById('r-plan').value = plan

    const starter = document.getElementById('plan-card-starter')
    const pro     = document.getElementById('plan-card-pro')
    const checkS  = document.getElementById('plan-check-starter')
    const checkP  = document.getElementById('plan-check-pro')

    if (plan === 'starter') {
      starter.style.borderColor = 'var(--green)'
      starter.style.background  = 'rgba(0,212,106,0.06)'
      checkS.style.background   = 'var(--green)'
      checkS.style.borderColor  = 'var(--green)'
      checkS.innerHTML = '<div style="width:6px;height:6px;border-radius:50%;background:#000"></div>'

      pro.style.borderColor = 'var(--border)'
      pro.style.background  = 'var(--surface2)'
      checkP.style.background  = 'transparent'
      checkP.style.borderColor = 'var(--border2)'
      checkP.innerHTML = ''
    } else {
      pro.style.borderColor = 'var(--green)'
      pro.style.background  = 'linear-gradient(160deg,rgba(0,212,106,0.07),var(--surface))'
      checkP.style.background  = 'var(--green)'
      checkP.style.borderColor = 'var(--green)'
      checkP.innerHTML = '<div style="width:6px;height:6px;border-radius:50%;background:#000"></div>'

      starter.style.borderColor = 'var(--border)'
      starter.style.background  = 'var(--surface2)'
      checkS.style.background   = 'transparent'
      checkS.style.borderColor  = 'var(--border2)'
      checkS.innerHTML = ''
    }
  },
}

const Dashboard = {
  async enter() {
     UI.page('dashboard'); UI.view('overview'); Dashboard.updateSidebar()
     Demo.applyUI()
     await Dashboard.refresh()
     Demo.applyUI()

  if (State.user?.mustChangePassword) setTimeout(() => Modals.open('changePassword'), 500)
   },
  async refresh() {
    try { await Promise.all([Dashboard.loadStats(), Bots.load(), Conversations.load()]) }
    catch (err) { console.error('Dashboard refresh error:', err) }
  },
  renderStats(stats) {
      if (!stats) return
      UI.el('s-bots').textContent      = stats.activeBots
      UI.el('s-msgs').textContent      = stats.totalMessages.toLocaleString('pt-BR')
      UI.el('s-convs').textContent     = stats.totalConversations
      UI.el('s-tokens').textContent    = stats.tokensUsed.toLocaleString('pt-BR')
      UI.el('s-bots-meta').textContent = `${stats.totalBots} total`
      PlanLimit.applyFromStats(stats)
  },
  async loadStats() {
    if (Demo.isActive()) {
      Demo.loadSampleData()
      Dashboard.renderStats(State.stats)
      return
    }
    try {
      const stats = await Api.get('/users/me/stats')
      State.stats = stats
      Dashboard.renderStats(stats)

      // Busca status de billing e aplica banners/toasts
      try {
        const billingStatus = await Api.get('/billing/status')
        State.billingStatus = billingStatus
        PlanLimit.applyFromBillingStatus(billingStatus)

        // Toast de aviso apenas na primeira carga (sessionStorage como flag)
        try {
          if (!sessionStorage.getItem('loginToastShown')) {
            PlanLimit.showLoginToast(billingStatus)
            sessionStorage.setItem('loginToastShown', '1')
          }
        } catch (_) {}
      } catch (_) {}
    } catch (err) { toastError(err, 'Nao foi possivel carregar as estatisticas do painel.') }
  },

  updateSidebar() {
    const u = State.user; if (!u) return
    UI.el('sbAvatar').textContent = u.name[0].toUpperCase()
    UI.el('sbName').textContent   = `${u.name} ${u.lastName || ''}`
    UI.el('sbPlan').textContent   = Demo.isActive() ? 'DEMO' : (u.plan ?? 'starter').toUpperCase()
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
    if (Demo.isActive()) {
      Demo.loadSampleData()
      Bots.render(); Bots.renderOverview(); Bots.updateSteps()
      return
    }
    try { const result = await Api.get('/bots'); State.bots = Array.isArray(result) ? result : []; Bots.render(); Bots.renderOverview(); Bots.updateSteps() }
    catch (err) { State.bots = []; toastError(err, 'Nao foi possivel carregar seus bots.') }
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
  isGptModel(model) {
    return String(model ?? '').startsWith('gpt-')
  },
  ensureAssistantNote(id, anchor, text) {
    let note = UI.el(id)
    if (!note && anchor) {
      note = document.createElement('div')
      note.id = id
      note.className = 'settings-note'
      anchor.insertAdjacentElement('afterend', note)
    }
    if (note) note.textContent = text
    return note
  },
  updateModelPrompt() {
    const model = UI.val('bModel')
    const isGpt = Bots.isGptModel(model)
    const prompt = UI.el('bPrompt')
    const group = prompt?.closest('.form-group')
    const note = Bots.ensureAssistantNote(
      'bGptAssistantNote',
      group,
      'Para GPT, crie o Assistant na OpenAI e informe sua OpenAI Key + Assistant ID em Configuracoes > API Keys. O prompt fica dentro do Assistant.',
    )
    const legacyNote = document.querySelector('#m-newBot .modal-actions p')
    if (legacyNote) legacyNote.style.display = 'none'
    if (group) group.style.display = isGpt ? 'none' : ''
    if (note) note.style.display = isGpt ? '' : 'none'
    if (isGpt && prompt) prompt.value = ''
  },
  applyEditPromptVisibility(bot) {
    const isGpt = Bots.isGptModel(bot?.model)
    const prompt = UI.el('eBotPrompt')
    const group = prompt?.closest('.form-group')
    const note = Bots.ensureAssistantNote(
      'eGptAssistantNote',
      group,
      'Este bot usa GPT. Ajuste o comportamento diretamente no Assistant da OpenAI e confira a OpenAI Key + Assistant ID em Configuracoes > API Keys.',
    )
    if (group) group.style.display = isGpt ? 'none' : ''
    if (note) note.style.display = isGpt ? '' : 'none'
  },
  async create() {
    if (!Demo.requireRealAccount()) return
    const name = UI.val('bName'), model = UI.val('bModel')
    const prompt = Bots.isGptModel(model) ? undefined : UI.val('bPrompt')

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
    // 3. Verifica o nome
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
    if (!Demo.requireRealAccount()) return
    const bot = State.bots.find(b => b.id === botId); if (!bot) return
    State.activeBotId = botId
    const m = MODEL_META[bot.model] ?? { label: bot.model }
    UI.el('eBotTitle').textContent = bot.name
    UI.el('eBotMeta').textContent  = `${m.label} · criado em ${new Date(bot.createdAt).toLocaleDateString('pt-BR')}`
    UI.el('eBotPrompt').value = bot.prompt; UI.el('eBotActive').checked = bot.isActive
    Bots.applyEditPromptVisibility(bot)
    const connStatus = UI.el('eBotConnStatus'), connectBtn = UI.el('eBotConnectBtn'), disconnBtn = UI.el('eBotDisconnectBtn')
    const phoneFormatted = bot.phone ? ' — ' + _formatPhone(bot.phone) : ''
    if (connStatus) connStatus.textContent = bot.isConnected ? '🟢 Conectado ao WhatsApp' + phoneFormatted : '🔴 Desconectado'
    if (connectBtn) connectBtn.style.display = bot.isConnected ? 'none' : ''
    if (disconnBtn) disconnBtn.style.display  = bot.isConnected ? '' : 'none'
    Modals.open('editBot')
    Knowledge.resetForm()
    Knowledge.load(botId)
  },
  async save() {
    if (!Demo.requireRealAccount()) return
    const id = State.activeBotId; if (!id) return
    try {
      const bot = State.bots.find(b => b.id === id)
      const payload = { isActive: UI.el('eBotActive').checked }
      if (!Bots.isGptModel(bot?.model)) payload.prompt = UI.el('eBotPrompt').value
      const updated = await Api.patch(`/bots/${id}`, payload)
      const idx = State.bots.findIndex(b => b.id === id); if (idx >= 0) State.bots[idx] = updated
      Modals.close('editBot'); Bots.render(); Bots.renderOverview(); Bots.updateSteps()
      toast('Bot atualizado!', 'success')
    } catch (err) { toast(err.message, 'error') }
  },
  async delete() {
    if (!Demo.requireRealAccount()) return
    const id = State.activeBotId; if (!id) return
    const bot = State.bots.find(b => b.id === id)
    if (!confirm(`Excluir o bot "${bot?.name}"? Esta ação não pode ser desfeita.`)) return
    try {
      await Api.delete(`/bots/${id}`); State.bots = State.bots.filter(b => b.id !== id)
      Modals.close('editBot'); Bots.render(); Bots.renderOverview(); toast('Bot excluído', 'info')
    } catch (err) { toast(err.message, 'error') }
  },
  connectFromEdit() { if (!Demo.requireRealAccount()) return; const id = State.activeBotId; if (!id) return; Modals.close('editBot'); Connect.open(id) },
  async disconnectFromEdit() {
    if (!Demo.requireRealAccount()) return
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
  escape(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  },
}

const Knowledge = {
  items: [],

  resetForm() {
    ;['kbTitle', 'kbUrl', 'kbQuestion', 'kbAnswer', 'kbContent', 'kbFile'].forEach(id => {
      const el = UI.el(id)
      if (!el) return
      el.value = ''
    })
    const type = UI.el('kbType')
    if (type) type.value = 'text'
    Knowledge.items = []
    Knowledge.updateForm()
    Knowledge.render()
  },

  updateForm() {
    const type = UI.val('kbType') || 'text'
    const visible = {
      text: ['content', 'file'],
      faq:  ['question', 'answer'],
      link: ['url', 'content'],
      pdf:  ['file'],
    }[type] ?? ['content']

    document.querySelectorAll('[data-kb-field]').forEach(el => {
      el.style.display = visible.includes(el.dataset.kbField) ? '' : 'none'
    })

    const content = UI.el('kbContent')
    if (content) {
      content.placeholder = type === 'link'
        ? 'Opcional: cole um resumo se quiser evitar importar todo o link...'
        : 'Cole aqui informacoes, regras, catalogo, servicos ou instrucoes...'
    }
  },

  async load(botId = State.activeBotId) {
    if (!botId) return
    const list = UI.el('knowledgeList')
    if (list) list.innerHTML = '<div class="text-xs text-dim">Carregando base...</div>'
    try {
      const result = await Api.get(`/bots/${botId}/knowledge`)
      Knowledge.items = Array.isArray(result) ? result : []
      Knowledge.render()
    } catch (err) {
      Knowledge.items = []
      Knowledge.render()
      toastError(err, 'Nao foi possivel carregar a base de conhecimento.')
    }
  },

  async create() {
    if (!Demo.requireRealAccount()) return
    const botId = State.activeBotId
    if (!botId) return

    const type = UI.val('kbType') || 'text'
    const title = UI.val('kbTitle')
    if (title.length < 2) { toast('Informe um titulo para a base.', 'error'); return }

    const payload = { type, title }
    const file = UI.el('kbFile')?.files?.[0]

    try {
      if (type === 'faq') {
        payload.question = UI.val('kbQuestion')
        payload.answer = UI.val('kbAnswer')
        if (!payload.question || !payload.answer) throw new Error('Informe pergunta e resposta.')
      } else if (type === 'link') {
        payload.sourceUrl = UI.val('kbUrl')
        payload.content = UI.val('kbContent') || undefined
        if (!payload.sourceUrl) throw new Error('Informe a URL.')
      } else if (type === 'pdf') {
        if (!file) throw new Error('Selecione um PDF.')
        if (file.size > 3 * 1024 * 1024) throw new Error('PDF muito grande. Envie ate 3MB.')
        if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Selecione um arquivo PDF valido.')
        payload.fileName = file.name
        payload.mimeType = file.type || 'application/pdf'
        payload.fileBase64 = await Knowledge.readFile(file, 'dataUrl')
      } else {
        payload.content = UI.val('kbContent')
        if (file) {
          if (file.size > 512 * 1024) throw new Error('Arquivo de texto muito grande. Use ate 512KB.')
          payload.content = await Knowledge.readFile(file, 'text')
          payload.fileName = file.name
          payload.mimeType = file.type || 'text/plain'
        }
        if (!payload.content) throw new Error('Informe o conteudo da base.')
      }

      UI.setLoading('kbCreateBtn', true)
      const item = await Api.post(`/bots/${botId}/knowledge`, payload)
      Knowledge.items.unshift(item)
      Knowledge.clearInputs()
      Knowledge.render()
      toast('Base de conhecimento adicionada.', 'success')
    } catch (err) {
      toastError(err, 'Nao foi possivel adicionar a base.')
    } finally {
      UI.setLoading('kbCreateBtn', false)
    }
  },

  clearInputs() {
    ;['kbTitle', 'kbUrl', 'kbQuestion', 'kbAnswer', 'kbContent', 'kbFile'].forEach(id => {
      const el = UI.el(id)
      if (el) el.value = ''
    })
  },

  readFile(file, mode) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('Nao foi possivel ler o arquivo.'))
      if (mode === 'text') reader.readAsText(file)
      else reader.readAsDataURL(file)
    })
  },

  async toggle(itemId, isActive) {
    if (!Demo.requireRealAccount()) return
    const botId = State.activeBotId
    if (!botId) return
    try {
      const updated = await Api.patch(`/bots/${botId}/knowledge/${itemId}`, { isActive: !isActive })
      const idx = Knowledge.items.findIndex(item => item.id === itemId)
      if (idx >= 0) Knowledge.items[idx] = updated
      Knowledge.render()
      toast(updated.isActive ? 'Item ativado.' : 'Item pausado.', 'info')
    } catch (err) { toastError(err, 'Nao foi possivel atualizar o item.') }
  },

  async delete(itemId) {
    if (!Demo.requireRealAccount()) return
    const botId = State.activeBotId
    if (!botId) return
    const item = Knowledge.items.find(entry => entry.id === itemId)
    if (!confirm(`Remover "${item?.title ?? 'item'}" da base?`)) return
    try {
      await Api.delete(`/bots/${botId}/knowledge/${itemId}`)
      Knowledge.items = Knowledge.items.filter(entry => entry.id !== itemId)
      Knowledge.render()
      toast('Item removido da base.', 'info')
    } catch (err) { toastError(err, 'Nao foi possivel remover o item.') }
  },

  render() {
    const list = UI.el('knowledgeList')
    const badge = UI.el('kbCountBadge')
    if (badge) badge.textContent = `${Knowledge.items.length} ${Knowledge.items.length === 1 ? 'item' : 'itens'}`
    if (!list) return
    if (!Knowledge.items.length) {
      list.innerHTML = '<div class="kb-empty">Nenhum material adicionado ainda.</div>'
      return
    }

    const labels = { text: 'Texto', faq: 'FAQ', link: 'Link', pdf: 'PDF' }
    list.innerHTML = Knowledge.items.map(item => {
      const active = item.isActive !== false
      const previewSource = item.type === 'faq' ? (item.answer || item.content) : item.content
      const preview = String(previewSource ?? '').replace(/\s+/g, ' ').slice(0, 180)
      return `<div class="kb-item ${active ? '' : 'is-off'}">
        <div class="kb-item-main">
          <div class="kb-item-top">
            <strong>${Bots.escape(item.title)}</strong>
            <span class="kb-chip">${labels[item.type] ?? item.type}</span>
            ${active ? '<span class="kb-state on">Ativo</span>' : '<span class="kb-state off">Pausado</span>'}
          </div>
          <div class="kb-preview">${Bots.escape(preview || 'Sem previa')}</div>
          ${item.sourceUrl ? `<div class="kb-source">${Bots.escape(item.sourceUrl)}</div>` : ''}
        </div>
        <div class="kb-item-actions">
          <button class="btn btn-ghost btn-sm" onclick="Knowledge.toggle('${item.id}', ${active})">${active ? 'Pausar' : 'Ativar'}</button>
          <button class="btn btn-ghost btn-sm" onclick="Knowledge.delete('${item.id}')">Remover</button>
        </div>
      </div>`
    }).join('')
  },
}

const Conversations = {
  upsertLocal(updated) {
    if (!updated?.id) return null
    const idx = State.conversations.findIndex(c => c.id === updated.id)
    if (idx >= 0) State.conversations[idx] = { ...State.conversations[idx], ...updated }
    else State.conversations.unshift(updated)
    return State.conversations.find(c => c.id === updated.id) ?? null
  },
  async load() {
    if (Demo.isActive()) {
      Demo.loadSampleData()
      Conversations.render(); Conversations.renderOverview()
      return
    }
    try { const result = await Api.get('/conversations'); State.conversations = Array.isArray(result) ? result : []; Conversations.render(); Conversations.renderOverview() }
    catch (err) { State.conversations = []; toastError(err, 'Nao foi possivel carregar suas conversas.') }
  },
  render() {
    const el = UI.el('convsList'); if (!el) return
    if (!State.conversations.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><h3>Nenhuma conversa</h3><p>As conversas aparecerão quando seu bot estiver ativo</p></div>`
      HumanInbox.clearIfMissing()
      return
    }
    el.innerHTML = State.conversations.map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const displayName = (c.contactName && c.contactName !== c.contactPhone)
        ? c.contactName
        : _formatPhone(c.contactPhone)
      const selected = HumanInbox.activeConvId === c.id ? ' active' : ''

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

      return `<div class="conv-row${selected}" id="conv-row-${c.id}" data-search="${Bots.escape(displayName.toLowerCase())} ${Bots.escape(c.lastMessage?.toLowerCase() ?? '')}">
          <div class="conv-avatar" style="cursor:pointer;flex-shrink:0"
               onclick="HumanInbox.open('${c.id}')">&#128100;</div>

          <!-- ✅ FIX: overflow:hidden no corpo principal impede expansão além do flex -->
          <div style="flex:1;min-width:0;cursor:pointer;overflow:hidden"
               onclick="HumanInbox.open('${c.id}')">

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
    if (!Demo.requireRealAccount()) return
    if (!confirm('Excluir esta conversa? Todas as mensagens serão apagadas permanentemente.')) return
    try {
      await Api.delete(`/conversations/${convId}`)
      State.conversations = State.conversations.filter(c => c.id !== convId)
      if (HumanInbox.activeConvId === convId) HumanInbox.clear()
      Conversations.render(); Conversations.renderOverview(); toast('Conversa excluída', 'info')
    } catch (err) { toast('Erro ao excluir: ' + err.message, 'error') }
  },
  async pause(convId) {
    if (!Demo.requireRealAccount()) return
    try {
      const updated = await Api.post(`/conversations/${convId}/pause`)
      Conversations.upsertLocal(updated)
      Conversations.render(); ChatViewer.updatePauseStatus(convId, true, false); HumanInbox.refreshActiveState()
      toast('Bot pausado para esta conversa ⏸', 'info')
    } catch (err) { toast('Erro ao pausar: ' + err.message, 'error') }
  },
  async resume(convId) {
    if (!Demo.requireRealAccount()) return
    try {
      const updated = await Api.post(`/conversations/${convId}/resume`)
      Conversations.upsertLocal(updated)
      Conversations.render(); ChatViewer.updatePauseStatus(convId, false, false); HumanInbox.refreshActiveState()
      toast('Bot retomado ▶', 'success')
    } catch (err) { toast('Erro ao retomar: ' + err.message, 'error') }
  },
  renderOverview() {
    const el = UI.el('ov-convs'); if (!el) return
    if (!State.conversations.length) { el.innerHTML = `<div class="empty" style="padding:32px"><div class="empty-icon" style="font-size:28px">💬</div><h3>Nenhuma conversa</h3></div>`; return }
    el.innerHTML = State.conversations.slice(0, 4).map(c => {
      const time = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const name = (c.contactName && c.contactName !== c.contactPhone) ? c.contactName : _formatPhone(c.contactPhone)
      return `<div class="conv-row" style="cursor:pointer" onclick="UI.view('convs');HumanInbox.open('${c.id}')"><div class="conv-avatar">&#128100;</div><div class="conv-body" style="min-width:0"><div class="conv-name">${Bots.escape(name)}</div><div class="conv-preview" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${Bots.escape(c.lastMessage)}</div></div><div class="conv-right" style="flex-shrink:0"><div class="conv-time">${time}</div>${c.unreadCount > 0 ? `<div class="conv-unread">${c.unreadCount}</div>` : ''}</div></div>`
    }).join('')
  },
}

const HumanInbox = {
  activeConvId: null,
  activeMessages: [],

  get activeConv() {
    return State.conversations.find(c => c.id === HumanInbox.activeConvId) ?? null
  },

  activeBot(conv = HumanInbox.activeConv) {
    return conv ? State.bots.find(b => b.id === conv.botId) ?? null : null
  },

  displayName(conv) {
    if (!conv) return 'Selecione uma conversa'
    return (conv.contactName && conv.contactName !== conv.contactPhone)
      ? conv.contactName
      : _formatPhone(conv.contactPhone)
  },

  canReply(conv = HumanInbox.activeConv) {
    return Boolean(conv && (conv.isPaused || conv.humanHandoff))
  },

  clearIfMissing() {
    if (HumanInbox.activeConvId && !State.conversations.some(c => c.id === HumanInbox.activeConvId)) HumanInbox.clear()
  },

  clear() {
    HumanInbox.activeConvId = null
    HumanInbox.activeMessages = []
    const name = UI.el('inboxContactName')
    const phone = UI.el('inboxContactPhone')
    const badge = UI.el('inboxBotBadge')
    const status = UI.el('inboxPauseStatus')
    const messages = UI.el('inboxMessages')
    if (name) name.textContent = 'Selecione uma conversa'
    if (phone) phone.textContent = 'As mensagens apareceram aqui'
    if (badge) badge.textContent = 'Bot'
    if (status) status.innerHTML = ''
    if (messages) messages.innerHTML = '<div class="inbox-empty">Selecione uma conversa para atender.</div>'
    HumanInbox.renderComposer()
  },

  async open(convId) {
    const conv = State.conversations.find(c => c.id === convId)
    if (!conv) return
    HumanInbox.activeConvId = convId
    HumanInbox.activeMessages = []
    HumanInbox.renderHeader()
    HumanInbox.renderLoading()
    HumanInbox.renderComposer()
    Conversations.render()

    try {
      const messages = Demo.isActive()
        ? Demo.messagesFor(convId)
        : await Api.get(`/conversations/${convId}/messages`)
      if (HumanInbox.activeConvId !== convId) return
      HumanInbox.activeMessages = messages
      HumanInbox.renderMessages()
    } catch (err) {
      toastError(err, 'Nao foi possivel carregar as mensagens desta conversa.')
      const messages = UI.el('inboxMessages')
      if (messages) messages.innerHTML = '<div class="inbox-empty inbox-error">Erro ao carregar mensagens.</div>'
    }
  },

  renderHeader() {
    const conv = HumanInbox.activeConv
    const bot = HumanInbox.activeBot(conv)
    const name = UI.el('inboxContactName')
    const phone = UI.el('inboxContactPhone')
    const badge = UI.el('inboxBotBadge')
    const status = UI.el('inboxPauseStatus')
    if (name) name.textContent = HumanInbox.displayName(conv)
    if (phone) phone.textContent = conv ? _formatPhone(conv.contactPhone) : 'As mensagens apareceram aqui'
    if (badge) badge.textContent = bot ? `Bot: ${bot.name}` : 'Bot'
    if (status) status.innerHTML = HumanInbox.statusHtml(conv)
  },

  statusHtml(conv) {
    if (!conv) return ''
    if (conv.humanHandoff) {
      return `<span class="inbox-state warn">Humano</span><button class="btn btn-ghost btn-sm" onclick="Conversations.resume('${conv.id}')">Retomar</button>`
    }
    if (conv.isPaused) {
      return `<span class="inbox-state warn">Pausado</span><button class="btn btn-ghost btn-sm" onclick="Conversations.resume('${conv.id}')">Retomar</button>`
    }
    return `<span class="inbox-state ok">Bot ativo</span><button class="btn btn-ghost btn-sm" onclick="Conversations.pause('${conv.id}')">Pausar</button>`
  },

  renderLoading() {
    const messages = UI.el('inboxMessages')
    if (messages) {
      messages.innerHTML = '<div class="inbox-empty"><span class="spinner"></span><span>Carregando mensagens...</span></div>'
    }
  },

  renderMessages() {
    const container = UI.el('inboxMessages')
    if (!container) return
    const conv = HumanInbox.activeConv
    const bot = HumanInbox.activeBot(conv)
    const contactName = HumanInbox.displayName(conv)
    const botName = bot?.name ?? 'Bot'
    const messages = Array.isArray(HumanInbox.activeMessages) ? HumanInbox.activeMessages : []

    if (!messages.length) {
      container.innerHTML = '<div class="inbox-empty">Nenhuma mensagem ainda.</div>'
      return
    }

    container.innerHTML = messages.map((m, idx) => {
      const isUser = m.role === 'user'
      const isHuman = m.role === 'human'
      const isError = !isUser && String(m.content || '').startsWith('⚠️')
      const senderName = isUser ? contactName : isHuman ? 'Atendente' : botName
      const time = new Date(m.createdAt || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const prev = messages[idx - 1]
      const showLabel = !prev || prev.role !== m.role
      return `<div class="inbox-msg ${isUser ? 'user' : 'assistant'}${isError ? ' is-error' : ''}">
        ${showLabel ? `<div class="inbox-msg-label">${Bots.escape(senderName)}</div>` : ''}
        <div class="inbox-bubble">${Bots.escape(m.content || '')}</div>
        <span class="inbox-time">${time}</span>
      </div>`
    }).join('')

    setTimeout(() => { container.scrollTop = container.scrollHeight }, 30)
  },

  renderComposer() {
    const conv = HumanInbox.activeConv
    const bot = HumanInbox.activeBot(conv)
    const reply = UI.el('inboxReply')
    const send = UI.el('inboxSendBtn')
    const notice = UI.el('inboxComposerNotice')
    const hint = UI.el('inboxReplyHint')
    const canReply = HumanInbox.canReply(conv)
    const connected = Demo.isActive() || Boolean(bot?.isConnected)
    const enabled = Boolean(conv && canReply && connected && !Demo.isActive())

    if (reply) reply.disabled = !enabled
    if (send) send.disabled = !enabled
    if (hint) hint.textContent = conv ? 'O envio manual mantem o bot pausado nesta conversa.' : 'Selecione uma conversa para iniciar o atendimento.'
    if (!notice) return

    notice.classList.toggle('ready', enabled)
    if (!conv) {
      notice.textContent = 'Selecione uma conversa para visualizar o historico e responder.'
    } else if (Demo.isActive()) {
      notice.textContent = DEMO_READ_ONLY_MESSAGE
    } else if (!connected) {
      notice.textContent = 'Conecte este bot ao WhatsApp antes de enviar uma resposta manual.'
    } else if (!canReply) {
      notice.textContent = 'Pause o bot nesta conversa antes de responder manualmente.'
    } else {
      notice.textContent = 'Atendimento humano liberado. A resposta sera enviada pelo WhatsApp conectado.'
    }
  },

  handleKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      HumanInbox.send()
    }
  },

  async send() {
    if (!Demo.requireRealAccount()) return
    const conv = HumanInbox.activeConv
    if (!conv) { toast('Selecione uma conversa para responder.', 'warning'); return }
    if (!HumanInbox.canReply(conv)) { toast('Pause o bot nesta conversa antes de responder manualmente.', 'warning'); return }
    const bot = HumanInbox.activeBot(conv)
    if (!bot?.isConnected) { toast('Conecte o bot ao WhatsApp para enviar a resposta.', 'warning'); return }

    const reply = UI.el('inboxReply')
    const content = reply?.value?.trim() ?? ''
    if (!content) { toast('Digite uma mensagem antes de enviar.', 'warning'); return }

    const button = UI.el('inboxSendBtn')
    const original = button?.innerHTML
    if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span>' }

    try {
      const result = await Api.post(`/conversations/${conv.id}/reply`, { content })
      const updated = Conversations.upsertLocal(result?.conversation)
      if (result?.message) {
        HumanInbox.activeMessages.push(result.message)
      } else {
        HumanInbox.activeMessages.push({
          id: `local-${Date.now()}`,
          role: 'human',
          content,
          createdAt: new Date().toISOString(),
        })
      }
      if (updated) HumanInbox.activeConvId = updated.id
      if (reply) reply.value = ''
      HumanInbox.renderHeader()
      HumanInbox.renderMessages()
      HumanInbox.renderComposer()
      Conversations.render()
      Conversations.renderOverview()
      toast('Mensagem enviada pelo atendimento humano.', 'success')
    } catch (err) {
      toastError(err, 'Nao foi possivel enviar a resposta manual.')
    } finally {
      if (button && original) button.innerHTML = original
      HumanInbox.renderComposer()
    }
  },

  refreshActiveState() {
    if (!HumanInbox.activeConvId) return
    HumanInbox.clearIfMissing()
    HumanInbox.renderHeader()
    HumanInbox.renderComposer()
    Conversations.render()
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
      quota:      { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '💳', btnLabel: 'API Keys', btnAction: `UI.view('settings')` },
      network:    { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '🌐', btnLabel: null, btnAction: null },
      unknown:    { color: 'var(--yellow)', bg: 'rgba(240,179,64,0.08)',   border: 'rgba(240,179,64,0.3)',   icon: '⚠️', btnLabel: null, btnAction: null },
    }
    const s = STYLES[kind] ?? STYLES.unknown
    const alertEl = document.createElement('div')
    alertEl.dataset.botAlert = key
    alertEl.style.cssText = `display:flex;align-items:flex-start;gap:14px;padding:16px 18px;margin-bottom:10px;background:${s.bg};border:1px solid ${s.border};border-left:4px solid ${s.color};border-radius:10px;animation:toast-slide 0.3s ease;`
    const msgHtml   = message   ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;line-height:1.5">${Bots.escape(message)}</div>` : ''
    const actionHtml = action ? `<div style="font-size:12px;color:#f0c060;font-weight:500">👉 ${Bots.escape(action)}</div>` : ''
    const actionBtn = s.btnLabel ? `<button class="btn btn-sm" onclick="${s.btnAction}" style="background:${s.color};color:${kind==='connection'?'#fff':'#000'};font-size:11px;padding:5px 10px;border-radius:6px;white-space:nowrap">${s.btnLabel}</button>` : ''
    alertEl.innerHTML = `<div style="font-size:22px;flex-shrink:0;margin-top:1px">${s.icon}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:${s.color};margin-bottom:3px">${Bots.escape(botName)} — ${Bots.escape(title)}</div>${msgHtml}${actionHtml}</div><div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end">${actionBtn}<button class="btn btn-ghost btn-sm" onclick="BotAlerts.dismiss('${key}')" style="font-size:11px;padding:5px 10px">✕</button></div>`
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
  open(botId) { if (!Demo.requireRealAccount()) return; State.connectBotId = botId; Modals.open('connect') },

  start() {
    if (!Demo.requireRealAccount()) return
    const botId = State.connectBotId; if (!botId) return
    Api.post(`/bots/${botId}/connect`).catch((err) => {
      Connect.log(err.message || 'Nao foi possivel iniciar a conexao.', 'error')
      toastError(err, 'Nao foi possivel iniciar a conexao do WhatsApp.')
    })
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
      const { botId: errBotId, botName, kind, title, detail, action } = JSON.parse(e.data)
      const quotaMessage = 'Os creditos/tokens da chave de IA acabaram. Adicione creditos na OpenAI ou Gemini, confira sua chave em Configuracoes > API Keys e reative o bot.'
      const message = kind === 'quota' ? quotaMessage : detail
      BotAlerts.show(errBotId, botName, kind, title, message, action)
      toast(kind === 'quota' ? quotaMessage : `${title}. ${action || ''}`, kind === 'network' ? 'warning' : 'error')
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
      HumanInbox.refreshActiveState()
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
      HumanInbox.refreshActiveState()
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
      if (source.readyState === EventSource.CLOSED && !connectedOk) {
        Connect.log('Conexao de eventos encerrada. Feche e tente conectar novamente.', 'error')
        toast('A conexao em tempo real foi encerrada. Tente conectar novamente.', 'warning')
      }
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
    const clean = base64.replace(/^data:image\/[a-z]+;base64,/i, '').replace(/[^A-Za-z0-9+/=]/g, '')
    wrap.style.cssText = 'background:transparent;border:none;overflow:visible;'
    wrap.innerHTML = `<div style="background:#ffffff;border-radius:16px;padding:16px;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px rgba(0,0,0,0.08),0 8px 32px rgba(0,0,0,0.4);position:relative;overflow:hidden;"><img src="data:image/png;base64,${clean}" alt="QR Code WhatsApp" width="220" height="220" style="display:block;image-rendering:pixelated;image-rendering:crisp-edges;"><div style="position:absolute;left:10px;right:10px;height:2px;background:linear-gradient(90deg,transparent,rgba(0,212,106,0.8),transparent);box-shadow:0 0 8px rgba(0,212,106,0.6);animation:qr-scan 2.2s linear infinite;"></div></div>`
  },

  log(msg, type = '') {
    const box = UI.el('connectLog'); if (!box) return
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const line = document.createElement('div')
    if (type) line.className = `log-${type}`
    line.textContent = `[${time}] ${String(msg ?? '')}`
    box.appendChild(line)
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
    if (Demo.isActive()) {
      if (UI.el('sOpenAI')) UI.el('sOpenAI').placeholder = 'Disponivel apos criar sua conta'
      if (UI.el('sAssistant')) UI.el('sAssistant').placeholder = 'Disponivel apos criar sua conta'
      if (UI.el('sGemini')) UI.el('sGemini').placeholder = 'Disponivel apos criar sua conta'
      Settings.renderCalendar({ connected: false, enabled: false, calendarId: 'primary' })
      Demo.applyUI()
      return
    }
    Api.get('/auth/me').then(user => {
      State.user = user; Store.save()
      const keys = user.apiKeys ?? {}
      if (UI.el('sOpenAI')) {
        UI.el('sOpenAI').value = ''
        UI.el('sOpenAI').placeholder = keys.openaiKey ? 'OpenAI ja configurada. Preencha somente para trocar.' : 'Cole sua chave OpenAI'
      }
      if (UI.el('sAssistant')) {
        UI.el('sAssistant').value = ''
        UI.el('sAssistant').placeholder = keys.openaiAssistantId ? 'Assistant ja configurado. Preencha somente para trocar.' : 'Cole o Assistant ID'
      }
      if (UI.el('sGemini')) {
        UI.el('sGemini').value = ''
        UI.el('sGemini').placeholder = keys.geminiKey ? 'Gemini ja configurada. Preencha somente para trocar.' : 'Cole sua chave Gemini'
      }
    }).catch(() => {})
    Settings.loadCalendar()
  },
  async saveProfile() {
    if (!Demo.requireRealAccount()) return
    try {
      const updated = await Api.patch('/users/me', { name: UI.val('sName'), lastName: UI.val('sLastName') })
      State.user = { ...State.user, ...updated }; Store.save(); Dashboard.updateSidebar()
      toast('Perfil atualizado!', 'success')
    } catch (err) { toast(err.message, 'error') }
  },
  async saveApiKeys() {
    if (!Demo.requireRealAccount()) return
    try {
      const payload = {}
      const openaiKey = UI.val('sOpenAI')
      const openaiAssistantId = UI.val('sAssistant')
      const geminiKey = UI.val('sGemini')
      if (openaiKey) payload.openaiKey = openaiKey
      if (openaiAssistantId) payload.openaiAssistantId = openaiAssistantId
      if (geminiKey) payload.geminiKey = geminiKey
      if (!Object.keys(payload).length) {
        toast('Nenhuma chave nova informada. Suas chaves atuais foram mantidas.', 'info')
        return
      }
      const data = await Api.patch('/users/me/api-keys', payload)
      State.user = { ...State.user, apiKeys: data.apiKeys }
      Store.save()
      Settings.load()
      toast('Chaves de API salvas com seguranca.', 'success')
    } catch (err) { toastError(err) }
  },
  renderCalendar(status) {
    State.calendar = status
    const connected = Boolean(status?.connected)
    const enabled = Boolean(status?.enabled)
    const badge = UI.el('calendarStatusBadge')
    const toggle = UI.el('calendarEnabled')
    const calendarId = UI.el('calendarId')
    const connectBtn = UI.el('connectGoogleCalendarBtn')
    const disconnectBtn = UI.el('disconnectGoogleCalendarBtn')
    const saveBtn = UI.el('saveGoogleCalendarBtn')

    if (badge) {
      badge.textContent = connected ? (enabled ? 'Ativo' : 'Conectado') : 'Desconectado'
      badge.className = connected && enabled ? 'badge badge-green' : 'badge'
    }
    if (toggle) {
      toggle.checked = enabled
      toggle.disabled = !connected
    }
    if (calendarId) {
      calendarId.value = status?.calendarId || 'primary'
      calendarId.disabled = !connected
    }
    if (connectBtn) connectBtn.style.display = connected ? 'none' : ''
    if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none'
    if (saveBtn) saveBtn.disabled = !connected
  },
  async loadCalendar() {
    if (!UI.el('calendarStatusBadge')) return
    if (Demo.isActive()) {
      Settings.renderCalendar({ connected: false, enabled: false, calendarId: 'primary' })
      return
    }
    try {
      const status = await Api.get('/calendar/google/status')
      Settings.renderCalendar(status)
    } catch (err) {
      Settings.renderCalendar({ connected: false, enabled: false, calendarId: 'primary' })
      toastError(err, 'Nao foi possivel carregar o Google Agenda.')
    }
  },
  async connectGoogleCalendar() {
    if (!Demo.requireRealAccount()) return
    try {
      const data = await Api.get('/calendar/google/connect')
      const url = new URL(data.url)
      if (url.hostname !== 'accounts.google.com') throw new Error('URL de autorizacao Google invalida.')
      toast('Redirecionando para o Google...', 'info')
      window.location.href = url.toString()
    } catch (err) { toastError(err, 'Nao foi possivel iniciar a conexao com o Google.') }
  },
  async saveGoogleCalendar() {
    if (!Demo.requireRealAccount()) return
    if (!State.calendar?.connected) {
      toast('Conecte o Google Agenda antes de habilitar a automacao.', 'error')
      return
    }
    try {
      const payload = {
        enabled: Boolean(UI.el('calendarEnabled')?.checked),
        calendarId: UI.val('calendarId') || 'primary',
      }
      const status = await Api.patch('/calendar/google', payload)
      Settings.renderCalendar(status)
      toast(status.enabled ? 'Google Agenda ativado para agendamentos automaticos.' : 'Automacao do Google Agenda pausada.', 'success')
    } catch (err) { toastError(err, 'Nao foi possivel salvar o Google Agenda.') }
  },
  async disconnectGoogleCalendar() {
    if (!Demo.requireRealAccount()) return
    try {
      await Api.delete('/calendar/google')
      Settings.renderCalendar({ connected: false, enabled: false, calendarId: 'primary' })
      toast('Google Agenda desconectado.', 'info')
    } catch (err) { toastError(err, 'Nao foi possivel desconectar o Google Agenda.') }
  },
  async changePassword() {
    if (!Demo.requireRealAccount()) return
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
  showLocked() {
    const locked = UI.el('analyticsLocked')
    const content = UI.el('analyticsContent')
    if (locked) locked.style.display = ''
    if (content) content.style.display = 'none'
  },
  showContent() {
    const locked = UI.el('analyticsLocked')
    const content = UI.el('analyticsContent')
    if (locked) locked.style.display = 'none'
    if (content) content.style.display = ''
  },
  async load() {
    if (Demo.isActive()) {
      Analytics.showLocked()
      return
    }
    const stats = State.stats
    if (stats && !stats.analyticsAvailable) {
      Analytics.showLocked()
      return
    }

    try {
      const analytics = await Api.get('/users/me/analytics')
      Analytics.showContent()
      Analytics.render(analytics)
    } catch (err) {
      if (err?.status === 403) {
        Analytics.showLocked()
        return
      }
      toastError(err, 'Nao foi possivel carregar o Analytics.')
    }
  },
  render(data) {
    UI.el('an-total').textContent = data.totalMessages.toLocaleString('pt-BR')
    UI.el('an-convs').textContent = data.totalConversations.toLocaleString('pt-BR')
    UI.el('an-tokens').textContent = data.tokensUsed.toLocaleString('pt-BR')
    UI.el('an-avg').textContent = data.avgMessagesPerConversation.toLocaleString('pt-BR')
    UI.el('an-msgs-meta').textContent = `${data.userMessages.toLocaleString('pt-BR')} clientes / ${data.assistantMessages.toLocaleString('pt-BR')} IA`
    UI.el('an-convs-meta').textContent = `${data.activeBots.toLocaleString('pt-BR')} bots ativos`
    Analytics.renderDays(data.messagesByDay ?? [])
    Analytics.renderBots(data.botBreakdown ?? [])
    Analytics.renderConversations(data.topConversations ?? [])
  },
  renderDays(days) {
    const el = UI.el('an-days'); if (!el) return
    if (!days.length) {
      el.innerHTML = `<div class="empty" style="padding:24px"><h3>Sem dados recentes</h3></div>`
      return
    }
    const max = Math.max(...days.map(d => d.messages), 1)
    el.innerHTML = days.map(day => {
      const label = new Date(`${day.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      const width = Math.max(4, Math.round((day.messages / max) * 100))
      return `<div style="display:grid;grid-template-columns:54px 1fr 86px;gap:10px;align-items:center;margin-bottom:10px">
        <span class="text-xs text-dim">${label}</span>
        <div class="progress-track" style="height:8px"><div class="progress-fill" style="width:${width}%"></div></div>
        <span class="text-xs text-muted" style="text-align:right">${day.messages.toLocaleString('pt-BR')} msg</span>
      </div>`
    }).join('')
  },
  renderBots(bots) {
    const el = UI.el('an-bots'); if (!el) return
    if (!bots.length) {
      el.innerHTML = `<div class="empty" style="padding:24px"><h3>Nenhum bot ainda</h3></div>`
      return
    }
    const rows = bots.map(bot => `<tr>
      <td><strong>${Bots.escape(bot.name)}</strong><div class="text-xs text-dim">${Bots.escape(bot.model)}</div></td>
      <td>${bot.messages.toLocaleString('pt-BR')}</td>
      <td>${bot.tokens.toLocaleString('pt-BR')}</td>
    </tr>`).join('')
    el.innerHTML = `<table class="table"><thead><tr><th>Bot</th><th>Msgs</th><th>Tokens</th></tr></thead><tbody>${rows}</tbody></table>`
  },
  renderConversations(conversations) {
    const el = UI.el('an-conversations'); if (!el) return
    if (!conversations.length) {
      el.innerHTML = `<div class="empty" style="padding:24px"><h3>Nenhuma conversa ainda</h3></div>`
      return
    }
    const rows = conversations.map(conv => {
      const date = new Date(conv.lastMessageAt).toLocaleDateString('pt-BR')
      const name = conv.contactName && conv.contactName !== conv.contactPhone ? conv.contactName : _formatPhone(conv.contactPhone)
      return `<tr>
        <td><strong>${Bots.escape(name)}</strong><div class="text-xs text-dim">${Bots.escape(_formatPhone(conv.contactPhone))}</div></td>
        <td>${conv.messages.toLocaleString('pt-BR')}</td>
        <td>${conv.tokens.toLocaleString('pt-BR')}</td>
        <td class="text-muted">${date}</td>
      </tr>`
    }).join('')
    el.innerHTML = `<table class="table"><thead><tr><th>Contato</th><th>Mensagens</th><th>Tokens</th><th>Ultima</th></tr></thead><tbody>${rows}</tbody></table>`
  },
}

const Billing = {
  async render() {
    const u = State.user; if (!u) return
    const s = State.stats
    const plan = u.plan ?? 'starter'
    const planLabels = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' }
    const planPills  = { starter: 'GRÁTIS',  pro: 'PRO', enterprise: 'ENTERPRISE' }

    UI.el('bilPlan').textContent = planLabels[plan]
    const pill = UI.el('bilPill')
    if (pill) { pill.textContent = planPills[plan]; pill.className = `plan-pill ${plan}` }

    // Busca status de billing para preencher detalhes
    let billingStatus = State.billingStatus ?? null
    if (!billingStatus && !Demo.isActive()) {
      try { billingStatus = await Api.get('/billing/status') } catch (_) {}
    }

    const isPro           = plan === 'pro' || plan === 'enterprise'
    const subStatus       = billingStatus?.subscriptionStatus ?? 'none'
    const daysLeft        = billingStatus?.daysUntilExpiry ?? null
    const expiresAt       = billingStatus?.planExpiresAt ? new Date(billingStatus.planExpiresAt) : null
    const isExpired       = subStatus === 'past_due'

    // Visibilidade das seções
    const upgradeSection = UI.el('bilUpgradeSection')
    const subInfoSection = UI.el('bilSubInfo')
    const usageSection   = UI.el('bilUsageSection')
    const renewSection   = UI.el('bilRenewSection')

    if (upgradeSection) upgradeSection.style.display = isPro  ? 'none' : ''
    if (subInfoSection) subInfoSection.style.display  = isPro  ? '' : 'none'
    if (usageSection)   usageSection.style.display    = isPro  ? 'none' : ''
    if (renewSection)   renewSection.style.display    = isPro  ? '' : 'none'

    // Alerta de vencimento no topo do card
    const alertEl = UI.el('bilExpiryAlert')
    if (alertEl) {
      if (isExpired) {
        alertEl.style.display = ''
        alertEl.innerHTML = `<div style="background:rgba(240,80,96,0.08);border:1px solid rgba(240,80,96,0.3);border-left:4px solid var(--red);border-radius:8px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:flex-start;gap:12px"><div style="flex:1"><strong style="color:var(--red)">🔴 Plano vencido</strong><p style="font-size:13px;color:var(--text-muted);margin-top:5px">Seus bots estão pausados. Renove o Pro para retomar o atendimento — seus dados estão preservados.</p></div><button class="btn btn-primary btn-sm" onclick="Billing.openCheckout()" style="flex-shrink:0">Renovar →</button></div>`
      } else if (daysLeft !== null && daysLeft <= 5 && daysLeft > 0) {
        alertEl.style.display = ''
        alertEl.innerHTML = `<div style="background:rgba(240,179,64,0.08);border:1px solid rgba(240,179,64,0.3);border-left:4px solid var(--yellow);border-radius:8px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px"><div style="flex:1">⚠️ <strong style="color:var(--yellow)">Vence em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}</strong><span style="font-size:13px;color:var(--text-muted)"> — renove para não interromper o atendimento.</span></div><button class="btn btn-primary btn-sm" onclick="Billing.openCheckout()" style="flex-shrink:0">Renovar →</button></div>`
      } else {
        alertEl.style.display = 'none'
      }
    }

    // Info da assinatura Pro
    if (isPro && expiresAt) {
      const statusMap = {
        active:   `<span style="color:var(--green)">● Ativo</span>`,
        past_due: `<span style="color:var(--red)">● Vencido — bots pausados</span>`,
        cancelled:`<span style="color:var(--text-muted)">● Cancelado</span>`,
        none:     `<span style="color:var(--text-muted)">—</span>`,
      }
      const sEl = UI.el('bilSubStatus')
      if (sEl) sEl.innerHTML = statusMap[subStatus] ?? subStatus
      const eEl = UI.el('bilSubExpiry')
      if (eEl) eEl.textContent = expiresAt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    }

    // Uso (starter)
    if (!isPro && s) {
      const msgs       = s.totalMessages ?? 0
      const limit      = s.messageLimit ?? null
      const percent    = s.usagePercent ?? 0
      const remaining  = s.remainingMessages
      const limited    = s.limitReached ?? false

      const usageEl = UI.el('bilUsage')
      if (usageEl) usageEl.textContent = `${msgs.toLocaleString('pt-BR')} / ${limit === null ? '∞' : limit.toLocaleString('pt-BR')}`
      const barEl = UI.el('bilBar')
      if (barEl) {
        barEl.style.width      = `${percent}%`
        barEl.style.background = limited ? 'var(--red)' : percent >= 80 ? 'var(--yellow)' : 'var(--green)'
      }
      const usageAlertEl = UI.el('bilUsageAlert')
      if (usageAlertEl) {
        if (limited) {
          usageAlertEl.style.display = ''
          usageAlertEl.innerHTML = `<div style="background:rgba(240,80,96,0.08);border:1px solid rgba(240,80,96,0.3);border-left:4px solid var(--red);border-radius:8px;padding:12px 16px;margin-top:12px;font-size:13px;color:var(--text-muted)">🚫 <strong style="color:var(--red)">Limite atingido!</strong> Faça upgrade para continuar respondendo.</div>`
        } else if (percent >= 80 && limit !== null) {
          usageAlertEl.style.display = ''
          usageAlertEl.innerHTML = `<div style="background:rgba(240,179,64,0.08);border:1px solid rgba(240,179,64,0.3);border-left:4px solid var(--yellow);border-radius:8px;padding:12px 16px;margin-top:12px;font-size:13px;color:var(--text-muted)">⚠️ Você usou ${percent}% do limite. Restam <strong>${remaining?.toLocaleString('pt-BR') ?? 0} mensagens</strong>.</div>`
        } else {
          usageAlertEl.style.display = 'none'
        }
      }
    }

    Billing.loadHistory(billingStatus?.billings ?? [])
  },

  loadHistory(billings) {
    const container = UI.el('bilInvoices'); if (!container) return
    if (!billings.length) {
      container.innerHTML = `<tr><td colspan="5"><div class="empty"><div class="empty-icon">🧾</div><h3>Nenhuma cobrança ainda</h3><p>Aparecerão aqui após o primeiro pagamento</p></div></td></tr>`
      return
    }
    const ST = {
      PENDING:   { l: 'Pendente',  c: 'badge-yellow' },
      PAID:      { l: 'Pago',      c: 'badge-green'  },
      EXPIRED:   { l: 'Expirado',  c: 'badge-red'    },
      CANCELLED: { l: 'Cancelado', c: 'badge-red'    },
    }
    container.innerHTML = billings.map(b => {
      const st  = ST[b.status] ?? { l: b.status, c: 'badge-yellow' }
      const dt  = new Date(b.createdAt).toLocaleDateString('pt-BR')
      const amt = (b.amount / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      let safeUrl = null
      try {
        const parsedUrl = new URL(b.url)
        safeUrl = parsedUrl.protocol === 'https:' ? parsedUrl.href : null
      } catch (_) {}
      return `<tr>
        <td class="mono" style="font-size:11px;color:var(--text-dim)">${Bots.escape(b.id)}</td>
        <td>${dt}</td><td>${amt}</td>
        <td><span class="badge ${st.c}">${Bots.escape(st.l)}</span></td>
        <td>${safeUrl && b.status === 'PENDING' ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">Pagar →</a>` : '—'}</td>
      </tr>`
    }).join('')
  },

  openCheckout() {
    if (!Demo.requireRealAccount()) return
    const ti = UI.el('checkoutTaxId'), ph = UI.el('checkoutPhone')
    if (ti) ti.value = ''; if (ph) ph.value = ''
    Modals.open('checkoutPro')
  },

  async startCheckout() {
    if (!Demo.requireRealAccount()) return
    const taxId     = UI.val('checkoutTaxId')
    const cellphone = UI.val('checkoutPhone')
    if (taxId.replace(/\D/g, '').length < 11) { toast('Informe um CPF ou CNPJ válido', 'error'); return }
    UI.setLoading('checkoutBtn', true)
    try {
      const data = await Api.post('/billing/checkout', { taxId: taxId.trim(), cellphone: cellphone || undefined })
      if (!/^https:\/\//i.test(data.url || '')) throw new Error('URL de pagamento invalida retornada pelo servidor.')
      window.open(data.url, '_blank', 'noopener,noreferrer')
      Modals.close('checkoutPro')
      toast('Página de pagamento aberta! O plano é ativado imediatamente após confirmação. 🎉', 'info')
    } catch (err) { toast(err.message, 'error') }
    finally { UI.setLoading('checkoutBtn', false) }
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
      const messages = Demo.isActive()
        ? Demo.messagesFor(convId)
        : await Api.get(`/conversations/${convId}/messages`)
      ChatViewer.render(messages, bot, displayName)
    } catch (err) {
      toastError(err, 'Nao foi possivel carregar as mensagens desta conversa.')
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
      const isHuman     = m.role === 'human'
      const isError     = m.role === 'assistant' && m.content.startsWith('⚠️')
      const time        = new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const text        = Bots.escape(m.content)
      const senderName  = isUser ? contactName : isHuman ? 'Atendente' : botName
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

  async pauseCurrentChat()  { if (!Demo.requireRealAccount()) return; const id = ChatViewer._activeConvId; if (id) await Conversations.pause(id) },
  async resumeCurrentChat() { if (!Demo.requireRealAccount()) return; const id = ChatViewer._activeConvId; if (id) await Conversations.resume(id) },

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

document.addEventListener('change', e => {
  const target = e.target
  if (!Demo.isActive() || !(target instanceof HTMLInputElement)) return
  if (target.type !== 'checkbox' || !target.closest('#view-settings')) return
  target.checked = !target.checked
  Demo.requireRealAccount()
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'))
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (document.getElementById('login').classList.contains('active'))    Auth.login()
    if (document.getElementById('register').classList.contains('active')) Auth.register()
  }
})

;(async () => {
  const params = new URLSearchParams(window.location.search)
  const calendarOAuthStatus = params.get('calendar')
  if (calendarOAuthStatus) {
    params.delete('calendar')
    params.delete('reason')
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`
    window.history.replaceState({}, document.title, clean)
  }

  Store.load()
  if (Demo.isActive()) {
    State.isDemo = true
    if (State.user) State.user = { ...State.user, isDemo: true }
    else State.user = { id: 'demo-local', name: 'Demo', lastName: 'User', email: 'demo@zapiens.local', plan: 'starter', subscriptionStatus: 'none', apiKeys: {}, isDemo: true }
    Demo.loadSampleData()
    await Dashboard.enter()
    return
  }
  if (State.token && State.user) {
    try {
      const me = await Api.get('/auth/me'); State.user = me; Store.save(); await Dashboard.enter()
      if (calendarOAuthStatus) {
        UI.view('settings')
        const tab = document.querySelector('[data-calendar-tab]')
        if (tab) UI.tab('t-calendar', tab)
        Settings.loadCalendar()
        toast(calendarOAuthStatus === 'connected' ? 'Google Agenda conectado.' : 'Nao foi possivel conectar o Google Agenda.', calendarOAuthStatus === 'connected' ? 'success' : 'error')
      }
    }
    catch (_) { Store.clear(); UI.page('landing') }
  } else { UI.page('landing') }
})()
