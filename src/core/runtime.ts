import { dirname, join } from 'node:path'
import { allAdapters } from '../carriers/registry.js'
import { authStorePathFor, setDpdAuthStore } from '../carriers/dpd.js'
import type { Database } from '../db/index.js'
import { createNotifier } from '../notify/send.js'
import type { Config } from './config.js'
import { createHttpClient } from './http.js'
import type { PollDeps } from './poll.js'

/**
 * Process-wide setup every long-lived entry point (poller, CLI, web server) must do before it polls
 * anything. Each of them can run a real poll, and each is a separate process: without this, DPD's
 * credential chain (Firebase -> OAuth, with its freshly minted installation id) would be redone from
 * scratch on every poll instead of being read from `dpd-auth.json` beside the database.
 */
export function initRuntime(config: Config): void {
  setDpdAuthStore(authStorePathFor(config.dbPath))
}

/**
 * The dependencies of a full poll run: real HTTP, every registered adapter, the configured notifier, and
 * mail ingest when `imap` is configured. The scheduled poller (`poll.ts`) and `cli poll` both build their
 * run from this, so "poll" means the same operation in both and they cannot drift. Callers add only what
 * is genuinely theirs (the poller's sleep-gap `forceAll`); tests override the rest.
 */
export function buildPollDeps(db: Database, config: Config, overrides: Partial<PollDeps> = {}): PollDeps {
  return {
    db,
    config,
    http: createHttpClient(),
    adapters: allAdapters(),
    now: new Date(),
    notifier: createNotifier(config.notifier),
    // Raw mail lands in data/mail beside the database. Read-only against the mailbox; see ingest/imap.ts.
    ingest: config.imap && { imap: config.imap, mailDir: join(dirname(config.dbPath), 'mail') },
    ...overrides,
  }
}
