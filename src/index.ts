/**
 * index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createApp } from './app.js'
import { env }       from './config/env.js'

// ── Aviso se --expose-gc não estiver ativo ────────────────────────────────────
if (typeof (global as any).gc !== 'function') {
  console.warn(
    '[Memory] GC manual não disponível.\n' +
    '         Para reduzir picos de RAM após conexão do WhatsApp,\n' +
    '         adicione NODE_OPTIONS=--expose-gc nas variáveis de ambiente.'
  )
}

const app = createApp()

app.listen(env.PORT, () => {
  console.log('')
  console.log('  ╔══════════════════════════════════════╗')
  console.log('  ║         ZapGPT Server v2.0            ║')
  console.log('  ╚══════════════════════════════════════╝')
  console.log(`  🚀  Listening on http://localhost:${env.PORT}`)
  console.log(`  🌍  Environment: ${env.NODE_ENV}`)
  console.log(`  🧠  GC manual: ${typeof (global as any).gc === 'function' ? '✅ ativo' : '❌ inativo (adicione NODE_OPTIONS=--expose-gc)'}`)
  console.log('')
})