/**
 * service/billingEmail.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Emails transacionais de cobrança manual:
 *   activated → Pro ativado (primeiro pagamento)
 *   renewed   → Pagamento de renovação confirmado
 *   reminder  → Aviso 5 dias antes do vencimento
 *   expired   → Plano venceu, bots pausados
 * ─────────────────────────────────────────────────────────────────────────────
 */

import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

export type BillingEmailType = 'activated' | 'renewed' | 'reminder' | 'expired'

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080b0f;font-family:Arial,sans-serif;color:#e8edf5}
.wrap{max-width:520px;margin:40px auto;background:#111620;border:1px solid #1e2a3a;border-radius:18px;overflow:hidden}
.header{padding:30px 40px 22px;border-bottom:1px solid #1e2a3a}
.header.green{background:linear-gradient(135deg,rgba(0,212,106,.1),rgba(0,212,106,.02))}
.header.yellow{background:linear-gradient(135deg,rgba(240,179,64,.08),rgba(240,179,64,.01))}
.header.red{background:linear-gradient(135deg,rgba(240,80,96,.08),rgba(240,80,96,.01))}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.dot{width:9px;height:9px;background:#00d46a;border-radius:50%}
.logo-text{font-size:18px;font-weight:800;color:#e8edf5}
.header h1{font-size:19px;font-weight:700;color:#e8edf5}
.header p{font-size:13px;color:#7b8fa6;margin-top:5px}
.body{padding:30px 40px}
.row{font-size:14px;color:#7b8fa6;margin-bottom:16px;line-height:1.7}
.box{background:#0d1117;border:1px solid #1e2a3a;border-radius:10px;padding:16px 20px;margin-bottom:18px}
.box.yellow{border-color:rgba(240,179,64,.3);background:rgba(240,179,64,.04)}
.box.red{border-color:rgba(240,80,96,.3);background:rgba(240,80,96,.04)}
.box label{font-size:11px;color:#7b8fa6;text-transform:uppercase;letter-spacing:.8px;display:block;margin-bottom:5px}
.box strong{font-size:16px;font-weight:700;color:#e8edf5}
.box.yellow strong{color:#f0c060}
.box.red strong{color:#f07080}
.cta{display:inline-block;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:4px}
.cta.green{background:#00d46a;color:#000}
.cta.yellow{background:#f0b340;color:#000}
.cta.red{background:#f05060;color:#fff}
.features{list-style:none;display:flex;flex-direction:column;gap:8px;margin:14px 0}
.features li{font-size:13px;color:#7b8fa6;display:flex;align-items:center;gap:8px}
.features li span{color:#00d46a;font-weight:700}
.divider{height:1px;background:#1e2a3a;margin:20px 0}
.note{font-size:12px;color:#3d506a;line-height:1.65}
.footer{padding:18px 40px;border-top:1px solid #1e2a3a;text-align:center;font-size:11px;color:#3d506a}
.footer a{color:#00d46a;text-decoration:none}
`

function wrap(header: string, headerClass: string, body: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><style>${BASE_CSS}</style></head>
<body><div class="wrap">
  <div class="header ${headerClass}">
    <div class="logo"><div class="dot"></div><span class="logo-text">Zapiens</span></div>
    ${header}
  </div>
  <div class="body">${body}</div>
  <div class="footer">© 2026 Zapiens &nbsp;·&nbsp; <a href="#">Privacidade</a> &nbsp;·&nbsp; <a href="#">Termos</a><br>Email automático — não responda.</div>
</div></body></html>`
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function buildContent(
  type: BillingEmailType,
  name: string,
  expiresAt: Date,
  daysLeft?: number,
  frontendUrl?: string,
): { subject: string; html: string; text: string } {
  const date = fmtDate(expiresAt)
  const url  = (frontendUrl ?? '').replace(/\/$/, '')

  if (type === 'activated') {
    return {
      subject: '🎉 Plano Pro ativado — Zapiens',
      text: `Olá ${name}! Seu plano Pro foi ativado. Vence em ${date}. Acesse ${url}`,
      html: wrap(
        `<h1>🎉 Plano Pro ativado!</h1><p>Pagamento confirmado. Bem-vindo ao Pro.</p>`,
        'green',
        `<p class="row">Olá, <strong style="color:#e8edf5">${name}</strong>! Seu pagamento foi confirmado e o plano Pro já está ativo.</p>
         <div class="box">
           <label>Acesso garantido até</label>
           <strong>${date}</strong>
         </div>
         <ul class="features">
           <li><span>✓</span>Mensagens ilimitadas — bot nunca pausado por limite</li>
           <li><span>✓</span>Até 5 números de WhatsApp</li>
           <li><span>✓</span>Suporte prioritário</li>
         </ul>
         <p class="row">Em 30 dias você receberá um aviso para renovar o plano antes do vencimento.</p>
         <a class="cta green" href="${url}">Acessar o painel →</a>`,
      ),
    }
  }

  if (type === 'renewed') {
    return {
      subject: '✅ Pagamento confirmado — Zapiens',
      text: `Olá ${name}! Renovação confirmada. Próximo vencimento: ${date}. Acesse ${url}`,
      html: wrap(
        `<h1>✅ Pagamento confirmado!</h1><p>Seu plano Pro foi renovado por mais 30 dias.</p>`,
        'green',
        `<p class="row">Olá, <strong style="color:#e8edf5">${name}</strong>! Recebemos seu pagamento e o plano Pro foi renovado com sucesso.</p>
         <div class="box">
           <label>Próximo vencimento</label>
           <strong>${date}</strong>
         </div>
         <p class="row">Você receberá outro aviso quando estiver próximo do próximo vencimento.</p>
         <a class="cta green" href="${url}">Acessar o painel →</a>`,
      ),
    }
  }

  if (type === 'reminder') {
    const dias = daysLeft ?? 5
    return {
      subject: `⚠️ Seu plano Pro vence em ${dias} dias — Zapiens`,
      text: `Olá ${name}! Seu plano Pro vence em ${dias} dias (${date}). Renove em ${url}/#billing`,
      html: wrap(
        `<h1>⚠️ Plano vence em ${dias} dias</h1><p>Renove antes de ${date} para não perder o acesso.</p>`,
        'yellow',
        `<p class="row">Olá, <strong style="color:#e8edf5">${name}</strong>! Seu plano Pro vence em <strong style="color:#f0c060">${dias} dia${dias !== 1 ? 's' : ''}</strong>.</p>
         <div class="box yellow">
           <label>Data de vencimento</label>
           <strong>${date}</strong>
         </div>
         <p class="row">Se você não renovar antes dessa data, seus bots serão pausados automaticamente. Suas conversas e configurações ficam preservadas.</p>
         <div class="divider"></div>
         <p class="row" style="font-size:13px"><strong style="color:#e8edf5">Como renovar:</strong><br>
           1. Acesse o painel → Assinatura<br>
           2. Clique em "Renovar Pro"<br>
           3. Pague via PIX ou Cartão<br>
           4. Acesso liberado imediatamente após confirmação
         </p>
         <a class="cta yellow" href="${url}/#billing">Renovar agora →</a>`,
      ),
    }
  }

  // expired
  return {
    subject: '🔴 Plano vencido — bots pausados',
    text: `Olá ${name}! Seu plano Pro venceu em ${date}. Seus bots estão pausados. Renove em ${url}/#billing`,
    html: wrap(
      `<h1>🔴 Plano vencido</h1><p>Seus bots foram pausados. Renove para retomar o atendimento.</p>`,
      'red',
      `<p class="row">Olá, <strong style="color:#e8edf5">${name}</strong>! Seu plano Pro venceu em <strong style="color:#f07080">${date}</strong> e não houve renovação.</p>
       <div class="box red">
         <label>O que mudou</label>
         <ul style="list-style:none;margin-top:8px;display:flex;flex-direction:column;gap:7px">
           <li style="font-size:13px;color:#f07080">✕ Bots pausados (não respondem mensagens)</li>
           <li style="font-size:13px;color:#7b8fa6">✓ Seus dados e conversas foram preservados</li>
           <li style="font-size:13px;color:#7b8fa6">✓ Limite starter: 50 mensagens/mês</li>
         </ul>
       </div>
       <p class="row">Para reativar seus bots e retomar o atendimento completo, clique abaixo. O acesso é liberado imediatamente após o pagamento.</p>
       <a class="cta red" href="${url}/#billing">Reativar plano Pro →</a>`,
    ),
  }
}

export async function sendBillingEmail(
  type: BillingEmailType,
  to: string,
  userName: string,
  expiresAt: Date,
  daysLeft?: number,
): Promise<void> {
  try {
    const transporter = nodemailer.createTransport({
      host:   env.SMTP_HOST,
      port:   env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:   { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
    const { subject, html, text } = buildContent(type, userName, expiresAt, daysLeft, env.FRONTEND_URL)
    await transporter.sendMail({
      from:    `"Zapiens" <${env.SMTP_FROM ?? env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    })
    console.log(`[Email] ${type} enviado para ${to}`)
  } catch (err) {
    // Email nunca derruba o fluxo principal
    console.error(`[Email] Falha ao enviar ${type} para ${to}:`, err)
  }
}