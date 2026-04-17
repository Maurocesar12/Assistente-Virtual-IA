/**
 * index.ts — atualizado para iniciar o scheduler de assinaturas
 * Substitua src/index.ts pelo conteúdo abaixo
 */

import { createApp }                   from './app.js'
import { env }                         from './config/env.js'
import { startSubscriptionScheduler }  from './routes/billing.js'

if (typeof (global as any).gc !== 'function') {
  console.warn(
    '[Memory] GC manual não disponível.\n' +
    '         Adicione NODE_OPTIONS=--expose-gc nas variáveis de ambiente.'
  )
}

const app = createApp()

app.listen(env.PORT, () => {
  console.log('')
  console.log('  ╔══════════════════════════════════════╗')
  console.log('  ║         Zapiens Server v2.0            ║')
  console.log('  ╚══════════════════════════════════════╝')
  console.log(`  🚀  Listening on http://localhost:${env.PORT}`)
  console.log(`  🌍  Environment: ${env.NODE_ENV}`)
  console.log(`  🧠  GC manual: ${typeof (global as any).gc === 'function' ? '✅ ativo' : '❌ inativo'}`)
  console.log('')

  // Inicia o scheduler de verificação de assinaturas
  startSubscriptionScheduler()
})