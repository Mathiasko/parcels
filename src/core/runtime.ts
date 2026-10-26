import { authStorePathFor, setDpdAuthStore } from '../carriers/dpd.js'
import type { Config } from './config.js'

/**
 * Process-wide setup every long-lived entry point (poller, CLI, web server) must do before it polls
 * anything. Each of them can run a real poll, and each is a separate process: without this, DPD's
 * credential chain (Firebase -> OAuth, with its freshly minted installation id) would be redone from
 * scratch on every poll instead of being read from `dpd-auth.json` beside the database.
 */
export function initRuntime(config: Config): void {
  setDpdAuthStore(authStorePathFor(config.dbPath))
}
