import type { Database } from './index.js'
import type { UpdateCheck } from '../core/update.js'

/**
 * How long an answer is good for: one `git fetch` a day and no more.
 *
 * It lives here rather than in core/update.ts because it is a statement about how stale the stored row
 * may be, which is this module's business - and because core/update.ts imports this module, so a
 * constant the other way round would make the cycle a runtime one instead of the type-only one it is.
 * core/update.ts re-exports it, so a caller has one place to import from.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3_600_000

/**
 * Where this install stands against the repository it came from, as it was last looked at: the one
 * `update_check` row (see db/schema.sql). It lives in the database rather than in memory for the same
 * reason `last_poll` does - the poller is a fresh process every hour, and an update deliberately
 * replaces the web one - and so that the page can show an answer that was found by the poller.
 *
 * Nothing stored here is sensitive: commit shas, a count, a branch name, and the one-line subjects of
 * the commits that would be installed.
 */
export interface StoredUpdateCheck extends UpdateCheck {
  checkedAt: Date
  /** The upstream commit the "an update is available" banner has already been sent for. */
  notifiedSha?: string
}

type Row = Record<string, string | number | null>
const str = (v: string | number | null): string | undefined => (v === null ? undefined : (v as string))

/**
 * Stores what a check found, leaving what has already been *said* about it alone: `notified_sha` and
 * `logged_started_at` are written by their own functions, and a check that overwrote them would
 * re-announce the same version every day (and re-log the same update every time it ran).
 */
export function recordUpdateCheck(db: Database, check: UpdateCheck, at: Date): void {
  db.prepare(`
    INSERT INTO update_check (id, checked_at, state, behind, version, branch, upstream,
                              local_sha, remote_sha, changes, reason)
    VALUES (1, @checkedAt, @state, @behind, @version, @branch, @upstream,
            @localSha, @remoteSha, @changes, @reason)
    ON CONFLICT (id) DO UPDATE SET
      checked_at = excluded.checked_at, state = excluded.state, behind = excluded.behind,
      version = excluded.version, branch = excluded.branch, upstream = excluded.upstream,
      local_sha = excluded.local_sha, remote_sha = excluded.remote_sha,
      changes = excluded.changes, reason = excluded.reason
  `).run({
    checkedAt: at.toISOString(),
    state: check.state,
    behind: check.behind,
    version: check.version ?? null,
    branch: check.branch ?? null,
    upstream: check.upstream ?? null,
    localSha: check.localSha ?? null,
    remoteSha: check.remoteSha ?? null,
    changes: check.changes.length === 0 ? null : check.changes.join('\n'),
    reason: check.reason ?? null,
  })
}

/** The last check, or nothing if none has ever been made. Never throws: /health reads it. */
export function getUpdateCheck(db: Database): StoredUpdateCheck | undefined {
  let r: Row | undefined
  try {
    r = db.prepare('SELECT * FROM update_check WHERE id = 1').get() as Row | undefined
  } catch {
    return undefined
  }
  if (!r) return undefined
  const changes = str(r.changes)
  return {
    checkedAt: new Date(r.checked_at as string),
    state: r.state as UpdateCheck['state'],
    behind: (r.behind as number) ?? 0,
    changes: changes === undefined || changes === '' ? [] : changes.split('\n'),
    version: str(r.version),
    branch: str(r.branch),
    upstream: str(r.upstream),
    localSha: str(r.local_sha),
    remoteSha: str(r.remote_sha),
    reason: str(r.reason),
    notifiedSha: str(r.notified_sha),
  }
}

/**
 * Whether enough time has passed to look again. Keyed on the last ATTEMPT, not the last success: a
 * checkout that refuses the check (dirty, detached, not a repository) answers the same way every
 * time, and keying on success would turn a daily `git fetch` into an hourly one for exactly the
 * machines that can do nothing with the answer.
 */
export function dueForUpdateCheck(
  db: Database, now: Date, intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  const last = getUpdateCheck(db)
  if (!last) return true
  return now.getTime() - last.checkedAt.getTime() >= intervalMs
}

/** Remembers that this upstream commit has been announced, so the banner fires once per version. */
export function markUpdateNotified(db: Database, sha: string): void {
  db.prepare('UPDATE update_check SET notified_sha = ? WHERE id = 1').run(sha)
}

/** The `startedAt` of the last update whose outcome has already reached the activity log. */
export function loggedUpdateStart(db: Database): string | undefined {
  const r = db.prepare('SELECT logged_started_at FROM update_check WHERE id = 1')
    .get() as { logged_started_at: string | null } | undefined
  return r?.logged_started_at ?? undefined
}

/**
 * Records that this update's outcome has been logged. `INSERT ... ON CONFLICT` rather than a bare
 * UPDATE: an update can only follow a check, but a database whose check row was never written (it was
 * installed, updated and never polled) must still be able to remember that it logged one.
 */
export function markUpdateLogged(db: Database, startedAt: string, at: Date): void {
  db.prepare(`
    INSERT INTO update_check (id, checked_at, state, logged_started_at) VALUES (1, ?, 'unknown', ?)
    ON CONFLICT (id) DO UPDATE SET logged_started_at = excluded.logged_started_at
  `).run(at.toISOString(), startedAt)
}
