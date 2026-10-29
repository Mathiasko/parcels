import { dirname, join } from 'node:path'
import { allAdapters } from '../carriers/registry.js'
import { authStorePathFor, setDpdAuthStore } from '../carriers/dpd.js'
import type { Database } from '../db/index.js'
import { notifierFor } from '../notify/send.js'
import type { Config } from './config.js'
import { createBinaryFetch, createHttpClient } from './http.js'
import { tileDirFor } from './tiles.js'
import type { PollDeps } from './poll.js'
import { checkAppRelease, githubFetchJson } from './app-update.js'
import { host } from './host.js'
import { appVersion } from './version.js'

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
    notifier: notifierFor(config),
    // Raw mail lands in data/mail beside the database. Read-only against the mailbox; see ingest/imap.ts.
    ingest: config.imap && { imap: config.imap, mailDir: join(dirname(config.dbPath), 'mail') },
    // Map tiles land in data/tiles, beside the mail. Omitted entirely when the preview is off, so the
    // opt-out is visible in the dependencies and not only in a check inside the run.
    mapPreview: config.mapPreview
      ? { tileDir: tileDirFor(config.dbPath), fetchBytes: createBinaryFetch() }
      : undefined,
    // Present, with every default: one `git fetch` a day through `scripts/update.sh --check`, and the
    // adoption of an update that finished while nothing was watching. Present here rather than inside
    // `runPoll` so that a test which builds its own PollDeps spawns no git at all, and so that the
    // "Refresh now" button - which does not use this function - stays a pure parcel refresh.
    // The Mac app has no checkout to fetch: it asks GitHub Releases once a day instead, under the same
    // rate limit, and the injected check also tells the poll to leave the git status file alone.
    updateCheck: host() === 'app'
      ? { check: () => checkAppRelease(appVersion(), githubFetchJson(appVersion())) }
      : {},
    ...overrides,
  }
}
