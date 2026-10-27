import type { Database } from './index.js'

/** Who started the run. The log is of the app's activity, so it has to say which part of it acted. */
export type RunTrigger = 'poller' | 'cli' | 'web'

/** The numbers a finished run reports, read off the run's report (see `runCounts` in core/poll.ts). */
export interface RunCounts {
  polled: number
  newEvents: number
  /** New messages the mailbox yielded, and the parcels they became. Absent when the run had no mailbox. */
  mailRead?: number
  created?: number
  failures: number
}

export interface PollRun extends RunCounts {
  id: number
  trigger: RunTrigger
  startedAt: Date
  /** Absent while the run is still going. */
  finishedAt?: Date
  /** Why the run itself ended badly; absent for a run that completed (even one with carrier failures). */
  error?: string
  summary?: string
}

/**
 * How many runs the log keeps. The poller runs hourly, so this is about two days of history: enough to
 * answer "is it working?" and "what did it do overnight", and small enough that the table cannot grow
 * without limit on a machine nobody prunes. Trimmed on every insert, as `RAW_RESPONSES_KEPT` is.
 */
export const POLL_RUNS_KEPT = 50

/**
 * A run still unfinished after this long is not running: the process was killed (or crashed in a way
 * that skipped the recording), and nothing will ever complete its row. Without this a dashboard that
 * re-renders itself while a run is in progress would wait for ever for a run that no longer exists.
 *
 * Generous on purpose - a first mail ingest downloads a whole mailbox - and it is also the cap on how
 * long a page will keep re-requesting itself, because that only happens while a run is in progress.
 */
export const RUN_STALE_MS = 10 * 60_000

const ERROR_MAX = 300
const SUMMARY_MAX = 1000

type Row = Record<string, string | number | null>
const date = (v: string | number | null) => (v === null ? undefined : new Date(v as string))
const num = (v: string | number | null) => (v === null ? undefined : (v as number))
const str = (v: string | number | null) => (v === null ? undefined : (v as string))

const toRun = (r: Row): PollRun => ({
  id: r.id as number,
  trigger: r.trigger as RunTrigger,
  startedAt: new Date(r.started_at as string),
  finishedAt: date(r.finished_at),
  polled: r.polled as number,
  newEvents: r.new_events as number,
  mailRead: num(r.mail_read),
  created: num(r.created),
  failures: r.failures as number,
  error: str(r.error),
  summary: str(r.summary),
})

/**
 * Opens a run and returns its id. The row exists before the work starts, so a caller can show the run
 * while it is still going (the web refresh redirects to it), and so a run that never finishes is still
 * visible rather than absent. Trimming happens here, where rows are added, and nowhere else.
 */
export function startRun(db: Database, trigger: RunTrigger, at: Date): number {
  const id = Number(db.prepare('INSERT INTO poll_runs (trigger, started_at) VALUES (?, ?)')
    .run(trigger, at.toISOString()).lastInsertRowid)
  db.prepare(`
    DELETE FROM poll_runs WHERE id NOT IN (SELECT id FROM poll_runs ORDER BY id DESC LIMIT ?)
  `).run(POLL_RUNS_KEPT)
  return id
}

/**
 * Completes a run with what it did. `error` is cleared, which is what makes a run reaped as stale
 * correct itself: a run that outlived `RUN_STALE_MS` and then finished anyway is a successful run, and
 * the guess that it had died must not outlive the answer.
 */
export function finishRun(db: Database, id: number, r: { counts: RunCounts; summary: string }, at: Date): void {
  const c = r.counts
  db.prepare(`
    UPDATE poll_runs SET
      finished_at = ?, polled = ?, new_events = ?, mail_read = ?, created = ?, failures = ?,
      error = NULL, summary = ?
    WHERE id = ?
  `).run(
    at.toISOString(), c.polled, c.newEvents, c.mailRead ?? null, c.created ?? null, c.failures,
    r.summary.slice(0, SUMMARY_MAX), id,
  )
}

/** Ends a run that did not complete. The text is the most important row on the Health panel. */
export function failRun(db: Database, id: number, error: string, at: Date): void {
  db.prepare('UPDATE poll_runs SET finished_at = ?, error = ? WHERE id = ?')
    .run(at.toISOString(), error.slice(0, ERROR_MAX), id)
}

/**
 * Closes every run too old to still be going, and returns how many it closed. This is the whole of the
 * crash recovery: a killed process leaves an unfinished row behind, and the next reader turns it into a
 * failed run instead of a dashboard that waits for ever. Call it before asking what is running.
 *
 * Never throws: a log that cannot be tidied must not take a page down.
 */
export function reapStaleRuns(db: Database, now: Date, staleMs: number = RUN_STALE_MS): number {
  const cutoff = new Date(now.getTime() - staleMs).toISOString()
  try {
    return db.prepare(`
      UPDATE poll_runs SET finished_at = ?, error = ?
      WHERE finished_at IS NULL AND started_at <= ?
    `).run(now.toISOString(), `the process did not finish this run (nothing after ${Math.round(staleMs / 60_000)} minutes)`, cutoff).changes
  } catch {
    return 0
  }
}

/** The run in progress, if any. Ask `reapStaleRuns` first, or an abandoned run answers here for ever. */
export function runningRun(db: Database): PollRun | undefined {
  const r = db.prepare('SELECT * FROM poll_runs WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1').get() as Row | undefined
  return r && toRun(r)
}

export function getRun(db: Database, id: number): PollRun | undefined {
  const r = db.prepare('SELECT * FROM poll_runs WHERE id = ?').get(id) as Row | undefined
  return r && toRun(r)
}

/**
 * The log, newest first. Ordered by when the run STARTED, which is the column the panel shows, rather
 * than by insert order - the two agree in practice, and sorting by what is displayed cannot surprise.
 * (Trimming keys on `id`, which is the only thing that is guaranteed monotonic.)
 */
export function listRuns(db: Database, limit: number): PollRun[] {
  const rows = db.prepare('SELECT * FROM poll_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as Row[]
  return rows.map(toRun)
}
