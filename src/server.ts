import { loadRuntimeConfig, runtimeConfigPath } from './core/config.js'
import { initRuntime } from './core/runtime.js'
import { openDb } from './db/index.js'
import { buildServer, BIND_HOST, startServer } from './web/server.js'

/**
 * Web UI entry point, kept alive by launchd. `POST /refresh` runs a real poll in THIS process, so DPD's
 * auth store must be pointed at its file exactly as the poller and CLI do (`initRuntime`); otherwise every
 * click would re-run the whole Firebase -> OAuth chain and mint a fresh installation id.
 */
async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.argv[2])
  initRuntime(config)
  const db = openDb(config.dbPath)
  // The path as well as the values: /settings reads this file back and writes it (see WebDeps).
  const app = buildServer({ db, config, configPath: runtimeConfigPath(process.argv[2]) })
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
