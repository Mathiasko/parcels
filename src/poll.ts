import { loadRuntimeConfig } from './core/config.js'
import { recordPollRun, runPoll, summarize } from './core/poll.js'
import { startRun } from './db/poll-runs.js'
import { buildPollDeps, initRuntime } from './core/runtime.js'
import { openDb } from './db/index.js'
import { checkSleepGap, recordPoll } from './core/sleepgap.js'

/**
 * Poller entry point, run hourly by launchd. A carrier failing is data, not an error: it is
 * recorded in carrier_health and the run still exits 0. Only a startup failure (unreadable
 * config, unopenable database) exits non-zero.
 */
async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.argv[2])
  initRuntime(config)   // the poller exits every run; DPD's token must outlive it
  const db = openDb(config.dbPath)
  try {
    // After a long sleep the backoff tiers' idea of "recently polled" is stale: refresh everything
    // (tier backoff only; the gated-carrier throttle and needs_postcode skip still apply).
    const startedMs = Date.now()
    const gap = checkSleepGap(db)
    // Recorded in `poll_runs` before the work starts and completed whatever happens, so a run that
    // crashes or is killed is still in the activity log rather than missing from it.
    const runId = startRun(db, 'poller', new Date(startedMs))
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

main().catch(err => {
  console.error(`poll: fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
