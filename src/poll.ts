import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadRuntimeConfig, type Config } from './core/config.js'
import { recordPollRun, runPoll, summarize, type PollDeps } from './core/poll.js'
import type { Notifier } from './notify/types.js'
import { claimRun } from './db/poll-runs.js'
import { buildPollDeps, initRuntime } from './core/runtime.js'
import { openDb, type Database } from './db/index.js'
import { checkSleepGap, recordPoll } from './core/sleepgap.js'

/**
 * One poll run on a database somebody else opened, and the line to log about it. The body of the
 * hourly poller, split out so the Mac app can run it inside its own long-lived process: that process
 * keeps one connection for its whole life and must not have it closed under it after every run.
 * Opening and closing the database is the caller's business.
 *
 * `ran` is false when another run owns the carriers and the mailbox (see below); `summary` is then
 * the sentence saying so. The caller supplies the timestamp when it logs the line.
 *
 * `opts.now` replaces the clock for the whole run. `opts.notifier` and `opts.updateCheck` replace what
 * `buildPollDeps` would have supplied, which is how the app swaps in its own notifications and its own
 * way of finding out about an update.
 */
export async function runPollOnce(
  db: Database,
  config: Config,
  opts: { now?: Date; notifier?: Notifier; updateCheck?: PollDeps['updateCheck'] } = {},
): Promise<{ ran: boolean; summary: string }> {
  const startedAt = opts.now ?? new Date()
  const startedMs = startedAt.getTime()
  // Recorded in `poll_runs` before the work starts and completed whatever happens, so a run that
  // crashes or is killed is still in the activity log rather than missing from it. Claimed rather
  // than simply started: a "Refresh now" (or `cli poll`) still going in another process owns the
  // carriers and the mailbox, and a second run beside it would poll and announce everything twice.
  // Skipping is safe - the next hour comes round - and is not a failure, so it exits 0.
  const claim = claimRun(db, 'poller', startedAt)
  if (!claim.claimed) {
    const { live } = claim
    return {
      ran: false,
      summary: `run ${live.id} (${live.trigger}, started ${live.startedAt.toISOString()}) is already in progress; not polling`,
    }
  }
  const runId = claim.id
  // After a long sleep the backoff tiers' idea of "recently polled" is stale: refresh everything
  // (tier backoff only; the gated-carrier throttle and needs_postcode skip still apply).
  const gap = checkSleepGap(db)
  // Only what the caller actually gave replaces the defaults: spreading an absent key would overwrite
  // `buildPollDeps`'s own notifier or update check with `undefined` and switch the step off.
  const overrides: Partial<PollDeps> = {
    forceAll: gap.longGap,
    // Every status change this run makes is attributed to the hourly poller and to this run row.
    cause: { actor: 'poller', runId, at: startedAt },
  }
  if (opts.now) overrides.now = opts.now
  if (opts.notifier) overrides.notifier = opts.notifier
  if (opts.updateCheck) overrides.updateCheck = opts.updateCheck
  const report = await recordPollRun(db, runId, runPoll(buildPollDeps(db, config, overrides)))
  // Only after the run completed (a crash mid-refresh leaves the gap to be retried), and never fatal:
  // failing to note the time must not turn a good poll into exit 1.
  try { recordPoll(db, startedMs) } catch (err) {
    console.error(`poll: could not record the poll time: ${err instanceof Error ? err.message : String(err)}`)
  }
  const slept = gap.longGap ? ` [slept ${(gap.sleptMs / 3_600_000).toFixed(1)}h: full refresh]` : ''
  return { ran: true, summary: `${summarize(report)}${slept}` }
}

/**
 * Poller entry point, run hourly by launchd. A carrier failing is data, not an error: it is
 * recorded in carrier_health and the run still exits 0. Only a startup failure (unreadable
 * config, unopenable database) exits non-zero.
 */
export async function runPoller(configPath: string | undefined): Promise<void> {
  const config = loadRuntimeConfig(configPath)
  initRuntime(config)   // the poller exits every run; DPD's token must outlive it
  const db = openDb(config.dbPath)
  try {
    const { summary } = await runPollOnce(db, config)
    console.log(`${new Date().toISOString()} ${summary}`)
  } finally {
    db.close()
  }
}

// Run only as the entry point, so a test can import `runPoller` without starting a poll.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPoller(process.argv[2]).catch(err => {
    console.error(`poll: fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
