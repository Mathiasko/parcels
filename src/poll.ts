import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadRuntimeConfig } from './core/config.js'
import { recordPollRun, runPoll, summarize } from './core/poll.js'
import { claimRun } from './db/poll-runs.js'
import { buildPollDeps, initRuntime } from './core/runtime.js'
import { openDb } from './db/index.js'
import { checkSleepGap, recordPoll } from './core/sleepgap.js'

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
    const startedMs = Date.now()
    // Recorded in `poll_runs` before the work starts and completed whatever happens, so a run that
    // crashes or is killed is still in the activity log rather than missing from it. Claimed rather
    // than simply started: a "Refresh now" (or `cli poll`) still going in another process owns the
    // carriers and the mailbox, and a second run beside it would poll and announce everything twice.
    // Skipping is safe - the next hour comes round - and is not a failure, so it exits 0.
    const claim = claimRun(db, 'poller', new Date(startedMs))
    if (!claim.claimed) {
      const { live } = claim
      console.log(`${new Date().toISOString()} run ${live.id} (${live.trigger}, started ${live.startedAt.toISOString()}) is already in progress; not polling`)
      return
    }
    const runId = claim.id
    // After a long sleep the backoff tiers' idea of "recently polled" is stale: refresh everything
    // (tier backoff only; the gated-carrier throttle and needs_postcode skip still apply).
    const gap = checkSleepGap(db)
    const report = await recordPollRun(db, runId, runPoll(buildPollDeps(db, config, {
      forceAll: gap.longGap,
      // Every status change this run makes is attributed to the hourly poller and to this run row.
      cause: { actor: 'poller', runId, at: new Date(startedMs) },
    })))
    // Only after the run completed (a crash mid-refresh leaves the gap to be retried), and never fatal:
    // failing to note the time must not turn a good poll into exit 1.
    try { recordPoll(db, startedMs) } catch (err) {
      console.error(`poll: could not record the poll time: ${err instanceof Error ? err.message : String(err)}`)
    }
    const slept = gap.longGap ? ` [slept ${(gap.sleptMs / 3_600_000).toFixed(1)}h: full refresh]` : ''
    console.log(`${new Date().toISOString()} ${summarize(report)}${slept}`)
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
