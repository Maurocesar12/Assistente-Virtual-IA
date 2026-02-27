import { createApp } from './app.js'
import { env } from './config/env.js'

const app = createApp()

app.listen(env.PORT, () => {
  console.log('')
  console.log('  ╔══════════════════════════════════════╗')
  console.log('  ║         ZapGPT Server v2.0            ║')
  console.log('  ╚══════════════════════════════════════╝')
  console.log(`  🚀  Listening on http://localhost:${env.PORT}`)
  console.log(`  🌍  Environment: ${env.NODE_ENV}`)
  console.log(`  📁  Serving frontend from /public`)
  console.log('')
})
