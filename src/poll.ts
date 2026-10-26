import { createHttpClient } from './core/http.js'
import { loadRuntimeConfig } from './core/config.js'
import { runPoll, summarize } from './core/poll.js'
import { allAdapters } from './carriers/registry.js'
import { authStorePathFor, setDpdAuthStore } from './carriers/dpd.js'
import { openDb } from './db/index.js'
import { createNotifier } from './notify/send.js'

/**
 * Poller entry point, run hourly by launchd. A carrier failing is data, not an error: it is
 * recorded in carrier_health and the run still exits 0. Only a startup failure (unreadable
 * config, unopenable database) exits non-zero.
 */
async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.argv[2])
  setDpdAuthStore(authStorePathFor(config.dbPath))   // the poller exits every run; DPD's token must outlive it
  const db = openDb(config.dbPath)
  try {
    const report = await runPoll({
      db, http: createHttpClient(), adapters: allAdapters(), config, now: new Date(),
      notifier: createNotifier(config.notifier),
    })
    console.log(`${new Date().toISOString()} ${summarize(report)}`)
  } finally {
    db.close()
  }
}

main().catch(err => {
  console.error(`poll: fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
