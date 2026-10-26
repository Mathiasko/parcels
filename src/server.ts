import { loadRuntimeConfig } from './core/config.js'
import { authStorePathFor, setDpdAuthStore } from './carriers/dpd.js'
import { openDb } from './db/index.js'
import { buildServer, BIND_HOST, startServer } from './web/server.js'

/**
 * Web UI entry point, kept alive by launchd. `POST /refresh` runs a real poll in THIS process, so DPD's
 * auth store must be pointed at its file exactly as the poller and CLI do; otherwise every click would
 * re-run the whole Firebase -> OAuth chain and mint a fresh installation id.
 */
async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.argv[2])
  setDpdAuthStore(authStorePathFor(config.dbPath))
  const db = openDb(config.dbPath)
  const app = buildServer({ db, config })
  const shutdown = () => { void app.close().finally(() => { db.close(); process.exit(0) }) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await startServer(app, config.port)
  console.log(`${new Date().toISOString()} listening on http://${BIND_HOST}:${config.port}`)
}

main().catch(err => {
  console.error(`server: fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
