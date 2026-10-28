import type { Database } from './index.js'
import type { RunTrigger } from './poll-runs.js'
import type { CanonicalStatus, CarrierId } from '../core/types.js'

/**
 * The activity log: every change to a parcel's derived status, and everything the user did.
 *
 * It exists because of a GLS parcel that silently left the dashboard. It had been marked `delivered`
 * while it was actually sitting in a locker, because `DELIVEREDPS` ("handed to a ParcelShop") was
 * mapped to `delivered`. That was diagnosed only by reading the live database within hours of it
 * happening, and the evidence is already gone: the status was overwritten the moment the real delivery
 * was reported, and `raw_responses` keeps five bodies per parcel, so the one that proved it has rotated
 * out. On somebody else's machine, reported a day later, there would have been nothing at all to find.
 *
 * Four rules, and the tests in `test/activity-log.test.ts` are the statement of all four.
 *
 * 1. **ONE append-only table.** A status transition and a user action are the same question asked twice
 *    ("why does the dashboard look like this?"), and splitting them would mean reading two logs and
 *    interleaving them by hand. Rows are only ever inserted and only ever trimmed by age.
 * 2. **An allow-list of columns, never a free-text note.** Statuses, carriers, counts and ids only.
 *    Every value written here is either a number, an id, or a token from this app's own closed
 *    vocabulary. There are two exceptions, both deliberate: the carrier's raw status string, which is
 *    the whole point of the log and is gated at the support-bundle boundary rather than at the column
 *    (see `bundleStatusRaw`); and the commit shas on an `update` row, which are hex and nothing else
 *    (`shaOrDash`) and are already printed in full at the bottom of /health. No tracking number,
 *    label, merchant, address, locker code, mail subject or sender is written, ever.
 * 3. **It can never fail the work it describes.** Every writer here is wrapped: a diagnostics row that
 *    cannot be stored must not turn a good poll into a failed one, nor a dismissal into a 500. The
 *    wrapping is INSIDE this module rather than at each call site (which is how `recordIngest` is
 *    guarded), because there are a dozen call sites and a guard every caller has to remember is a
 *    guard one caller will forget.
 * 4. **Bounded**, like `poll_runs` and `raw_responses`, and trimmed on every insert.
 */

/**
 * Who acted. `poller | cli | web` is deliberately `poll_runs.trigger`'s own vocabulary rather than a
 * second spelling of it (see db/poll-runs.ts), so a run id and the actor beside it cannot disagree.
 *
 * `migration` is a schema upgrade rewriting rows at open time: it belongs to no run, and a change it
 * made must not read as something a carrier said. `unknown` is a write from a code path that did not
 * name itself; no path in the app leaves it that way, and it exists so that forgetting to attribute a
 * new call site degrades to an honest "nobody said" instead of a confident lie.
 */
export type Actor = RunTrigger | 'migration' | 'unknown'

/** What caused an entry: who acted, which run they acted in, and the clock they acted on. */
export interface Cause {
  actor: Actor
  /** The `poll_runs` row this happened inside. Absent outside a run (a user action, a migration). */
  runId?: number
  /**
   * When it happened. Every entry point that already has a clock passes its own (`deps.now`, the
   * server's `now()`), so the log agrees with the run and the page it belongs to rather than with the
   * wall clock at the moment of the insert. Defaults to now.
   */
  at?: Date
}

/** The attribution of a write that named no cause. See `Actor`. */
export const UNATTRIBUTED: Cause = { actor: 'unknown' }

/**
 * How many entries the log keeps.
 *
 * Far more than the 50 runs and the 5 raw responses, and deliberately so: a run row is written every
 * hour whether or not anything happened, while these are written only when something DID happen. On
 * the author's machine that is of the order of a hundred rows a week - ten or so parcels, each moving
 * through six to eight statuses, plus a handful of actions - so this cap is roughly five months of
 * normal use, at about 120 bytes a row and well under half a megabyte in total.
 *
 * Five months is the horizon that matters. The incident that prompted this log was diagnosed hours
 * later on the author's own machine; the same fault on somebody else's, noticed because a parcel never
 * arrived and reported a week or a month afterwards, is the case the log has to survive. Two days of
 * history (`POLL_RUNS_KEPT`) would not, and five rows (`RAW_RESPONSES_KEPT`) certainly would not.
 */
export const ACTIVITY_LOG_KEPT = 2000

/**
 * How much of a carrier's raw status string is stored. A status code is a word (`DELIVEREDPS`); a
 * carrier that answers with a paragraph must not be able to make this table the biggest one in the
 * database, nor push the newest lines of the support bundle past its cap.
 */
export const STATUS_RAW_MAX = 80

/**
 * What kind of entry a row is. `status` is the transition log; the rest is the action log.
 * One closed set, because `kind` is what a reader groups by and a typo in it would hide a row.
 */
export type ActivityKind =
  | 'status'
  | 'parcel_deleted'
  | 'parcels_merged'
  | 'message_assigned'
  | 'messages_dismissed'
  | 'settings_saved'
  | 'refresh'
  | 'update'

/**
 * The settings the page can change, as names. The list is closed and is the ONLY thing ever recorded
 * about a save: which fields moved, never what they moved to. `imap.pass` is the reason that rule is
 * absolute - "the App Password changed" is a useful diagnostic and the password itself is a secret -
 * and `imap` means the whole mail block was added or removed, which is one decision and not five.
 */
export const SETTING_FIELDS = [
  'defaultPostalCode', 'notifier', 'mapPreview',
  'imap', 'imap.host', 'imap.port', 'imap.user', 'imap.mailbox', 'imap.pass',
] as const
export type SettingField = typeof SETTING_FIELDS[number]

/**
 * How an attempt to install a new version of the app ended.
 *
 * `rolled_back` is the good failure: the build or the install broke, and the checkout was put back to
 * the commit it was on and rebuilt, so the machine is running what it was running before.
 * `rollback_failed` is the one that needs a person. `abandoned` is an update that stopped answering -
 * its process was killed, so nothing ever wrote an outcome - and it is recorded rather than left
 * silent, because "I pressed Update and then nothing" is precisely the report this log exists to answer.
 */
export type UpdateLogOutcome = 'ok' | 'failed' | 'rolled_back' | 'rollback_failed' | 'abandoned'

/** A derived status change: the thing the GLS incident needed and did not have. */
export interface StatusChange {
  parcelId: number
  carrier: CarrierId
  from: CanonicalStatus
  to: CanonicalStatus
  /** The carrier's own string behind the new status (`DELIVEREDPS`), where there is one. */
  raw?: string
}

/**
 * Everything the user can do that changes what the dashboard shows. Each variant carries only ids,
 * counts, statuses and closed-vocabulary tokens, which is what makes the whole table sendable.
 *
 * `messages_dismissed` deliberately records the SCOPE of a bulk dismissal and not the sender it was
 * aimed at. A sender is a mail address: it says who the person corresponds with, shops with and banks
 * with, and it is exactly what the support bundle already redacts out of log tails. "You dismissed 37
 * messages from one sender on Tuesday" answers the question the log exists to answer, and naming that
 * sender would add a third party's address to a table that /health prints verbatim and the bundle
 * sends. So: the one borderline field is excluded, and the count and the scope take its place.
 */
export type Action =
  | { kind: 'parcel_deleted'; parcelId: number; carrier: CarrierId; status: CanonicalStatus }
  | { kind: 'parcels_merged'; parcelId: number; carrier: CarrierId; count: number }
  | { kind: 'message_assigned'; parcelId: number; carrier: CarrierId }
  | { kind: 'messages_dismissed'; count: number; scope: 'all' | 'sender' | 'one' }
  | { kind: 'settings_saved'; fields: readonly SettingField[] }
  | { kind: 'refresh'; count: number; scope: 'all' | 'one' }
  /**
   * The outcome of an update, with the commits it moved between. A commit sha is the one value in this
   * table that is neither a count nor a word from a closed vocabulary, and it is included because
   * "which version is this machine actually on?" is the question an update that went wrong raises. It
   * is hex and nothing else (`shaOrDash` below), it names no person, place or parcel, and it is
   * already printed in full at the bottom of /health.
   */
  | { kind: 'update'; outcome: UpdateLogOutcome; from?: string; to?: string }

/** One row, as a reader wants it. Absent fields are the columns that do not apply to the kind. */
export interface ActivityEntry {
  id: number
  at: Date
  actor: Actor
  runId?: number
  kind: ActivityKind
  parcelId?: number
  carrier?: CarrierId
  from?: CanonicalStatus
  to?: CanonicalStatus
  raw?: string
  count?: number
  /** A token from this app's own vocabulary: a dismissal's scope, or the field names of a save. */
  detail?: string
}

type Row = Record<string, string | number | null>
const str = (v: string | number | null) => (v === null ? undefined : (v as string))
const num = (v: string | number | null) => (v === null ? undefined : (v as number))

const toEntry = (r: Row): ActivityEntry => ({
  id: r.id as number,
  at: new Date(r.at as string),
  actor: r.actor as Actor,
  runId: num(r.run_id),
  kind: r.kind as ActivityKind,
  parcelId: num(r.parcel_id),
  carrier: str(r.carrier) as CarrierId | undefined,
  from: str(r.from_status) as CanonicalStatus | undefined,
  to: str(r.to_status) as CanonicalStatus | undefined,
  raw: str(r.status_raw),
  count: num(r.count),
  detail: str(r.detail),
})

/**
 * The only guard, and it is on the inside. Nothing in this module may throw into its caller: these
 * rows are diagnostics, and a poll or a button press has to succeed whether or not one can be stored.
 *
 * Catching here rather than at the call site is also what makes it safe inside a transaction: a
 * statement that fails does not by itself abort an open SQLite transaction, so swallowing the error
 * leaves the real work of `applyCarrier` or `deleteParcel` to commit exactly as it would have.
 */
function quietly(what: string, write: () => void): void {
  try {
    write()
  } catch (err) {
    console.error(`activity log: could not record ${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface Insert {
  kind: ActivityKind
  parcelId?: number
  carrier?: CarrierId
  from?: string
  to?: string
  raw?: string
  count?: number
  detail?: string
}

/**
 * Appends one row and trims the table.
 *
 * The trim keys on `id`, the only column guaranteed monotonic, and is written as a range delete below
 * the oldest id worth keeping rather than as `poll_runs`' `id NOT IN (SELECT ... LIMIT n)`. Same
 * result, but this table is forty times larger, and the `NOT IN` form would build a 2000-element set
 * on every insert where this reads 2000 index entries once and deletes a contiguous range.
 */
function append(db: Database, e: Insert, cause: Cause): void {
  const at = cause.at ?? new Date()
  db.prepare(`
    INSERT INTO activity_log (at, actor, run_id, kind, parcel_id, carrier,
                              from_status, to_status, status_raw, count, detail)
    VALUES (@at, @actor, @runId, @kind, @parcelId, @carrier, @from, @to, @raw, @count, @detail)
  `).run({
    at: at.toISOString(),
    actor: cause.actor,
    runId: cause.runId ?? null,
    kind: e.kind,
    parcelId: e.parcelId ?? null,
    carrier: e.carrier ?? null,
    from: e.from ?? null,
    to: e.to ?? null,
    raw: e.raw === undefined ? null : e.raw.slice(0, STATUS_RAW_MAX),
    count: e.count ?? null,
    detail: e.detail ?? null,
  })
  db.prepare(`
    DELETE FROM activity_log WHERE id < (
      SELECT MIN(id) FROM (SELECT id FROM activity_log ORDER BY id DESC LIMIT ?))
  `).run(ACTIVITY_LOG_KEPT)
}

/**
 * Records that a parcel's derived status moved. Call it only when it really did move: an unchanged
 * status is not an event, and logging one would bury the real transitions under an hourly repeat of
 * every parcel's current state. `updateParcelState` is where that comparison lives.
 */
export function logStatusChange(db: Database, c: StatusChange, cause: Cause = UNATTRIBUTED): void {
  quietly(`${c.from} -> ${c.to} on parcel ${c.parcelId}`, () => append(db, {
    kind: 'status', parcelId: c.parcelId, carrier: c.carrier, from: c.from, to: c.to, raw: c.raw,
  }, cause))
}

/** Records something the user (or a migration) did. See `Action` for what each variant may carry. */
export function logAction(db: Database, a: Action, cause: Cause = UNATTRIBUTED): void {
  quietly(a.kind, () => append(db, insertFor(a), cause))
}

function insertFor(a: Action): Insert {
  switch (a.kind) {
    case 'parcel_deleted':
      // The status it was in goes in `from_status`: there is no status it moved TO, the parcel is gone.
      return { kind: a.kind, parcelId: a.parcelId, carrier: a.carrier, from: a.status }
    case 'parcels_merged':
      return { kind: a.kind, parcelId: a.parcelId, carrier: a.carrier, count: a.count }
    case 'message_assigned':
      return { kind: a.kind, parcelId: a.parcelId, carrier: a.carrier }
    case 'messages_dismissed':
      return { kind: a.kind, count: a.count, detail: a.scope }
    case 'settings_saved':
      return { kind: a.kind, count: a.fields.length, detail: a.fields.join(' ') }
    case 'refresh':
      return { kind: a.kind, count: a.count, detail: a.scope }
    case 'update':
      // Three tokens in one column: the outcome, then where it came from and where it ended up. A
      // column each would mean three migrations for one fact that is never read apart.
      return { kind: a.kind, detail: [a.outcome, shaOrDash(a.from), shaOrDash(a.to)].join(' ') }
  }
}

/**
 * A commit sha, shortened, or `-` for "not recorded". Anything that is not hex becomes `-`: the shas
 * reaching this come from a file a detached shell script wrote, and a column this table prints
 * verbatim must not be able to carry whatever happened to be in it.
 */
const shaOrDash = (v: string | undefined): string =>
  (v !== undefined && /^[0-9a-f]{4,40}$/.test(v) ? v.slice(0, 10) : '-')

/**
 * The log, newest first. Ordered by the recorded instant and then by id, as `listRuns` is: sorting by
 * the column the page prints cannot surprise a reader, and the id tiebreak keeps the several entries
 * one run writes at its single clock reading in the order they were written.
 *
 * Never throws: this is read by /health and by the support bundle, which are the two pages somebody
 * opens BECAUSE something is broken, and a log that cannot be read must not take either of them down.
 */
export function listActivity(db: Database, limit: number): ActivityEntry[] {
  try {
    const rows = db.prepare('SELECT * FROM activity_log ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Row[]
    return rows.map(toEntry)
  } catch {
    return []
  }
}

/**
 * A carrier status string the support bundle is allowed to carry, or a marker in its place.
 *
 * `raw` is the one field here that is not from a closed vocabulary: most carriers answer with a code
 * (`DELIVEREDPS`, `PARCEL_HANDED`, a numeric `stateCode`), but Packeta's `packetStatus` is a sentence
 * written for a human, and a sentence can name the place the parcel is waiting - which is as good as
 * the user's neighbourhood. `DELIVEREDPS` is also precisely what makes this log worth sending, so the
 * answer is an allow-list rather than dropping the field: one token of letters, digits and the
 * punctuation codes use, and anything else - a space, an accent, a comma - is not a code and does not go.
 *
 * A positive allow-list, deliberately, and not a reliance on the bundle's own redaction pass: that
 * pass looks for mail addresses and tracking numbers, and a street name is neither.
 */
export const NOT_A_CODE = '[not a status code]'

export function bundleStatusRaw(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return /^[A-Za-z0-9_.:+/-]{1,40}$/.test(raw) ? raw : NOT_A_CODE
}

/**
 * The slice the support bundle prints. One function so the bundle cannot forget the gate: whatever it
 * asks for here has already been through `bundleStatusRaw`, and every other column is an id, a count,
 * a canonical status or a token from this app's own vocabulary.
 */
export function activityForBundle(db: Database, limit: number): ActivityEntry[] {
  return listActivity(db, limit).map(e => (e.raw === undefined ? e : { ...e, raw: bundleStatusRaw(e.raw) }))
}

/** The `update` line: `ok ffa1f20 9f8e7d6` as English. The three tokens come from `insertFor`. */
function describeUpdate(detail: string | undefined): string {
  const [outcome, from = '-', to = '-'] = (detail ?? '').split(' ')
  const at = (sha: string) => (sha === '-' ? 'an unrecorded commit' : sha)
  switch (outcome) {
    case 'ok':
      return `updated from ${at(from)} to ${at(to)}`
    case 'rolled_back':
      return `update failed and was rolled back to ${at(from)}, which is what it is running`
    case 'rollback_failed':
      return `update failed AND could not be rolled back; the checkout is at ${at(to)} and needs attention`
    case 'failed':
      return `update failed before anything was installed; still at ${at(from)}`
    case 'abandoned':
      return `update stopped answering and never reported an outcome; it was at ${at(from)} when it started`
    default:
      return `update: ${detail ?? 'nothing recorded'}`
  }
}

const FIELD_WORDS: Record<ActivityKind, string> = {
  status: 'status',
  parcel_deleted: 'parcel deleted',
  parcels_merged: 'parcels merged',
  message_assigned: 'email assigned',
  messages_dismissed: 'mail dismissed',
  settings_saved: 'settings saved',
  refresh: 'refresh pressed',
  update: 'update',
}

/** The word for a kind, for a page that groups rows by what happened. */
export const activityKindWord = (kind: ActivityKind): string => FIELD_WORDS[kind] ?? kind

/**
 * One line of English for an entry: what /health prints in its "what happened" cell and what the
 * support bundle prints in its table. The same function for both, as `summarize` serves the poll log
 * and the `poll_runs` row, so the line the user reads and the line the author receives cannot differ.
 */
export function describeActivity(e: ActivityEntry): string {
  const parcel = e.parcelId === undefined ? '' : `#${e.parcelId}${e.carrier ? ` ${e.carrier}` : ''}`
  switch (e.kind) {
    case 'status':
      return `${parcel}: ${e.from ?? '?'} -> ${e.to ?? '?'}${e.raw ? ` (raw ${e.raw})` : ''}`
    case 'parcel_deleted':
      return `${parcel} deleted${e.from ? `, it was ${e.from}` : ''}`
    case 'parcels_merged':
      return `${parcel} absorbed ${e.count ?? 0} duplicate parcel(s) of the same shipment`
    case 'message_assigned':
      return `an email was assigned to ${parcel}`
    case 'messages_dismissed':
      return `${e.count ?? 0} message(s) dismissed${
        e.detail === 'sender' ? ', from one sender' : e.detail === 'one' ? '' : ', the whole queue'}`
    case 'settings_saved':
      return `settings saved: ${e.detail === undefined || e.detail === '' ? 'nothing changed' : `${e.detail.split(' ').join(', ')} changed`}`
    case 'refresh':
      return `refresh pressed for ${e.detail === 'one' ? 'one parcel' : `all ${e.count ?? 0} due parcel(s)`}`
    case 'update':
      return describeUpdate(e.detail)
    default:
      return e.kind
  }
}
