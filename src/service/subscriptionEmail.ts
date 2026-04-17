/**
 * subscriptionEmail.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Emails transacionais de assinatura:
 *   activated  → Pro ativado com sucesso (primeiro pagamento)
 *   renewed    → Renovação mensal confirmada
 *   reminder   → Aviso 5 dias antes do vencimento
 *   expired    → Plano vencido, conta congelada
 *   cancelled  → Assinatura cancelada (pro mantido até vencimento)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

type EmailType = 'activated' | 'renewed' | 'reminder' | 'expired' | 'cancelled'

function createTransporter() {
  return nodemailer.createTransport({
    host:   env.SMTP_HOST,
    port:   env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth:   { user: env.SMTP_USER, pass: env.SMTP_PASS },
  })
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

const BASE_STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080b0f;font-family:Arial,sans-serif;color:#e8edf5}
.wrap{max-width:520px;margin:40px auto;background:#111620;border:1px solid #1e2a3a;border-radius:18px;overflow:hidden}
.header{background:linear-gradient(135deg,rgba(0,212,106,.1),rgba(0,212,106,.03));padding:32px 40px 24px;border-bottom:1px solid #1e2a3a}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.logo-dot{width:10px;height:10px;background:#00d46a;border-radius:50%}
.logo-text{font-size:20px;font-weight:800;color:#e8edf5}
.header h1{font-size:20px;font-weight:700;color:#e8edf5}
.header p{font-size:14px;color:#7b8fa6;margin-top:5px}
.body{padding:32px 40px}
.info-box{background:#0d1117;border:1px solid #1e2a3a;border-radius:10px;padding:18px 22px;margin-bottom:20px}
.info-box p{font-size:13px;color:#7b8fa6;margin-bottom:6px}
.info-box strong{color:#e8edf5}
.cta{display:inline-block;background:#00d46a;color:#000;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin:20px 0}
.footer{padding:20px 40px;border-top:1px solid #1e2a3a;text-align:center;font-size:12px;color:#3d506a}
.footer a{color:#00d46a;text-decoration:none}
`

function buildHtml(icon: string, title: string, subtitle: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Zapiens</title><style>${BASE_STYLE}</style></head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo"><div class="logo-dot"></div><span class="logo-text">Zapiens</span></div>
      <h1>${icon} ${title}</h1>
      <p>${subtitle}</p>
    </div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">© 2026 Zapiens &nbsp;·&nbsp; <a href="#">Privacidade</a> &nbsp;·&nbsp; <a href="#">Termos</a><br>Este email foi enviado automaticamente — não responda.</div>
  </div>
</body></html>`
}

function getEmailContent(
  type: EmailType,
  userName: string,
  expiresAt: Date | null | undefined,
  daysLeft?: number,
): { subject: string; html: string; text: string } {
  const date = formatDate(expiresAt)
  const frontendUrl = env.FRONTEND_URL.replace(/\/$/, '')

  switch (type) {
    case 'activated':
      return {
        subject: '🎉 Plano Pro ativado — Zapiens',
        html: buildHtml('🎉', 'Plano Pro ativado!', 'Sua assinatura mensal está ativa',
          `<p style="font-size:15px;color:#e8edf5;margin-bottom:18px">Olá, <strong>${userName}</strong>! 👋</p>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Seu plano Pro foi ativado com sucesso. A partir de agora você tem acesso a mensagens ilimitadas, até 5 números de WhatsApp e suporte prioritário.</p>
           <div class="info-box">
             <p>Próxima renovação automática</p>
             <strong style="font-size:18px">${date}</strong>
           </div>
           <p style="font-size:13px;color:#7b8fa6;line-height:1.7">Sua assinatura renova automaticamente todo mês. Se quiser cancelar, acesse o painel em Assinatura.</p>
           <a class="cta" href="${frontendUrl}">Acessar o painel →</a>`),
        text: `Olá, ${userName}! Plano Pro ativado. Próxima renovação: ${date}. Acesse ${frontendUrl}`,
      }

    case 'renewed':
      return {
        subject: '✅ Assinatura renovada — Zapiens',
        html: buildHtml('✅', 'Assinatura renovada', 'Seu plano Pro foi renovado com sucesso',
          `<p style="font-size:15px;color:#e8edf5;margin-bottom:18px">Olá, <strong>${userName}</strong>! 👋</p>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Seu plano Pro foi renovado e o pagamento confirmado. Continue aproveitando todos os recursos sem interrupção.</p>
           <div class="info-box">
             <p>Próxima renovação</p>
             <strong style="font-size:18px">${date}</strong>
           </div>
           <a class="cta" href="${frontendUrl}">Acessar o painel →</a>`),
        text: `Olá, ${userName}! Assinatura renovada. Próxima renovação: ${date}.`,
      }

    case 'reminder':
      return {
        subject: `⚠️ Seu plano Pro vence em ${daysLeft} dias — Zapiens`,
        html: buildHtml('⚠️', `Plano vence em ${daysLeft} dias`, 'Garanta a renovação para não perder o acesso',
          `<p style="font-size:15px;color:#e8edf5;margin-bottom:18px">Olá, <strong>${userName}</strong>!</p>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Seu plano Pro vence em <strong style="color:#f0c060">${daysLeft} dias</strong>, no dia <strong style="color:#e8edf5">${date}</strong>. Se sua assinatura estiver ativa com cartão de crédito, a renovação acontece automaticamente — nenhuma ação é necessária.</p>
           <div class="info-box" style="border-color:rgba(240,179,64,0.3);background:rgba(240,179,64,0.04)">
             <p style="color:#f0c060">Data de vencimento</p>
             <strong style="font-size:18px;color:#f0c060">${date}</strong>
           </div>
           <p style="font-size:13px;color:#7b8fa6;line-height:1.7">Se sua assinatura foi feita via PIX, é necessário realizar um novo pagamento antes da data de vencimento para manter o acesso.</p>
           <a class="cta" href="${frontendUrl}/#billing" style="background:#f0b340;color:#000">Ver assinatura →</a>`),
        text: `Olá, ${userName}! Seu plano Pro vence em ${daysLeft} dias (${date}). Acesse ${frontendUrl}/#billing.`,
      }

    case 'expired':
      return {
        subject: '🔴 Plano Pro expirado — conta congelada',
        html: buildHtml('🔴', 'Plano expirado', 'Sua conta foi alterada para o plano Starter',
          `<p style="font-size:15px;color:#e8edf5;margin-bottom:18px">Olá, <strong>${userName}</strong>!</p>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Seu plano Pro venceu em <strong style="color:#f07080">${date}</strong> e a assinatura não foi renovada. Sua conta foi alterada para o plano Starter — seus dados estão preservados.</p>
           <div class="info-box" style="border-color:rgba(240,80,96,0.3);background:rgba(240,80,96,0.04)">
             <p style="color:#f07080">O que mudou</p>
             <ul style="list-style:none;display:flex;flex-direction:column;gap:6px;margin-top:8px">
               <li style="font-size:13px;color:#7b8fa6">✕ Bots pausados (limite de 50 mensagens/mês)</li>
               <li style="font-size:13px;color:#7b8fa6">✕ Apenas 1 número de WhatsApp</li>
               <li style="font-size:13px;color:#00d46a">✓ Seus dados e conversas foram preservados</li>
             </ul>
           </div>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Para reativar o Pro e retomar o atendimento completo, clique abaixo.</p>
           <a class="cta" href="${frontendUrl}/#billing" style="background:#f05060;color:#fff">Reativar plano Pro →</a>`),
        text: `Olá, ${userName}! Seu plano Pro expirou. Reative em ${frontendUrl}/#billing.`,
      }

    case 'cancelled':
      return {
        subject: 'Assinatura cancelada — Zapiens',
        html: buildHtml('📋', 'Assinatura cancelada', 'Confirmação de cancelamento',
          `<p style="font-size:15px;color:#e8edf5;margin-bottom:18px">Olá, <strong>${userName}</strong>!</p>
           <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px">Sua assinatura foi cancelada. Você continuará com acesso Pro até <strong style="color:#e8edf5">${date}</strong>, quando a conta será alterada para o plano Starter.</p>
           <div class="info-box">
             <p>Acesso Pro até</p>
             <strong style="font-size:18px">${date}</strong>
           </div>
           <p style="font-size:13px;color:#7b8fa6;line-height:1.7">Se mudou de ideia, você pode reativar a assinatura antes dessa data no painel.</p>
           <a class="cta" href="${frontendUrl}/#billing">Ver assinatura →</a>`),
        text: `Olá, ${userName}! Assinatura cancelada. Acesso Pro mantido até ${date}.`,
      }
  }
}

export async function sendSubscriptionEmail(
  type: EmailType,
  to: string,
  userName: string,
  expiresAt?: Date | null,
  daysLeft?: number,
): Promise<void> {
  try {
    const { subject, html, text } = getEmailContent(type, userName, expiresAt, daysLeft)
    const transporter = createTransporter()
    await transporter.sendMail({
      from:    `"Zapiens" <${env.SMTP_FROM ?? env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    })
    console.log(`[Email] ${type} enviado para ${to}`)
  } catch (err) {
    // Email nunca deve derrubar o fluxo principal
    console.error(`[Email] Falha ao enviar ${type} para ${to}:`, err)
  }
}