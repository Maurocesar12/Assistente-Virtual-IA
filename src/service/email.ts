import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

function createTransporter() {
  return nodemailer.createTransport({
    host:   env.SMTP_HOST,
    port:   env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  })
}

function buildResetEmail(userName: string, tempPassword: string, expiresMinutes: number) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Redefinição de Senha — ZapGPT</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#080b0f;font-family:Arial,sans-serif;color:#e8edf5}
    .wrap{max-width:520px;margin:40px auto;background:#111620;border:1px solid #1e2a3a;border-radius:18px;overflow:hidden}
    .header{background:linear-gradient(135deg,rgba(0,212,106,.12),rgba(0,212,106,.04));padding:36px 40px 28px;border-bottom:1px solid #1e2a3a}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:20px}
    .logo-dot{width:10px;height:10px;background:#00d46a;border-radius:50%}
    .logo-text{font-size:20px;font-weight:800;color:#e8edf5}
    .header h1{font-size:22px;font-weight:700;color:#e8edf5}
    .header p{font-size:14px;color:#7b8fa6;margin-top:6px}
    .body{padding:36px 40px}
    .greeting{font-size:15px;color:#e8edf5;margin-bottom:18px}
    .info-box{background:#0d1117;border:1px solid #1e2a3a;border-radius:10px;padding:20px 24px;margin-bottom:24px}
    .info-box p{font-size:13px;color:#7b8fa6;margin-bottom:10px}
    .temp-password{font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#00d46a;letter-spacing:3px;background:rgba(0,212,106,.06);border:1px solid rgba(0,212,106,.2);border-radius:8px;padding:12px 18px;text-align:center;display:block}
    .warning{background:rgba(240,179,64,.06);border:1px solid rgba(240,179,64,.2);border-radius:8px;padding:14px 18px;margin-bottom:24px}
    .warning p{font-size:13px;color:#f0c060;line-height:1.6}
    .steps{margin-bottom:24px}
    .steps p{font-size:14px;font-weight:600;color:#e8edf5;margin-bottom:12px}
    .step{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
    .step-num{width:20px;height:20px;background:rgba(0,212,106,.1);border:1px solid rgba(0,212,106,.2);border-radius:50%;font-size:11px;font-weight:700;color:#00d46a;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
    .step span{font-size:13px;color:#7b8fa6;line-height:1.5}
    .divider{height:1px;background:#1e2a3a;margin:24px 0}
    .security{font-size:12px;color:#3d506a;line-height:1.6}
    .security strong{color:#7b8fa6}
    .footer{padding:20px 40px;border-top:1px solid #1e2a3a;text-align:center;font-size:12px;color:#3d506a}
    .footer a{color:#00d46a;text-decoration:none}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo"><div class="logo-dot"></div><span class="logo-text">ZapGPT</span></div>
      <h1>Redefinição de senha</h1>
      <p>Recebemos uma solicitação para sua conta</p>
    </div>
    <div class="body">
      <p class="greeting">Olá, <strong>${userName}</strong> 👋</p>
      <p style="font-size:14px;color:#7b8fa6;margin-bottom:20px;">
        Recebemos uma solicitação de redefinição de senha para sua conta no ZapGPT.
        Use a senha temporária abaixo para acessar.
      </p>
      <div class="info-box">
        <p>Sua senha temporária (válida por ${expiresMinutes} minutos):</p>
        <code class="temp-password">${tempPassword}</code>
      </div>
      <div class="warning">
        <p>⚠️ <strong>Importante:</strong> Esta senha expira em <strong>${expiresMinutes} minutos</strong>. Após fazer login, vá em Configurações e defina uma nova senha.</p>
      </div>
      <div class="steps">
        <p>Como usar:</p>
        <div class="step"><div class="step-num">1</div><span>Acesse o ZapGPT e clique em "Entrar"</span></div>
        <div class="step"><div class="step-num">2</div><span>Use seu email e a senha temporária acima</span></div>
        <div class="step"><div class="step-num">3</div><span>Vá em <strong>Configurações → Perfil</strong> e defina uma nova senha permanente</span></div>
      </div>
      <div class="divider"></div>
      <p class="security">
        <strong>Não solicitou isso?</strong><br>
        Ignore este email. Sua senha atual continua a mesma.
        Esta senha temporária será invalidada em ${expiresMinutes} minutos automaticamente.
      </p>
    </div>
    <div class="footer">
      © 2026 ZapGPT &nbsp;·&nbsp; Email automático, não responda<br>
      <a href="#">Privacidade</a> &nbsp;·&nbsp; <a href="#">Termos</a>
    </div>
  </div>
</body>
</html>`

  const text = `ZapGPT — Redefinição de Senha\n\nOlá, ${userName}!\n\nSua senha temporária: ${tempPassword}\n(válida por ${expiresMinutes} minutos)\n\nApós o login, vá em Configurações → Perfil e defina uma nova senha.\n\nSe não solicitou, ignore este email.`

  return { html, text }
}

export async function sendPasswordResetEmail(params: {
  to: string
  userName: string
  tempPassword: string
  expiresMinutes?: number
}): Promise<void> {
  const expiresMinutes = params.expiresMinutes ?? 15
  const transporter = createTransporter()
  const { html, text } = buildResetEmail(params.userName, params.tempPassword, expiresMinutes)

  await transporter.sendMail({
    from: `"ZapGPT" <${env.SMTP_FROM ?? env.SMTP_USER}>`,
    to: params.to,
    subject: '🔑 Sua senha temporária — ZapGPT',
    text,
    html,
  })
}