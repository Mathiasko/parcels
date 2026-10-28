import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { DateTime } from 'luxon'
import type { Config } from './config.js'
import { isDormant } from './backoff.js'
import { pollerStatus } from './pollwatch.js'
import { PENDING } from '../db/messages.js'
import type { Database } from '../db/index.js'
import { carrierHealth } from '../db/health.js'
import { activityForBundle, describeActivity } from '../db/activity-log.js'
import { getIngestStatus } from '../db/ingest-status.js'
import { userVersion } from '../db/migrate.js'
import { listActive } from '../db/parcels.js'
import { listRuns } from '../db/poll-runs.js'
import { getUpdateCheck } from '../db/update-state.js'
import { readUpdateRun, updateStatusPath } from './update.js'

/**
 * The support bundle: everything the author of this app needs to diagnose a fault on somebody else's
 * machine, as one plain-text file that the person generating it can read before they send it.
 *
 * Three rules, and the tests in `test/support-bundle.test.ts` are the statement of all three.
 *
 * 1. **An allow-list, never a dump.** Every field below was chosen; nothing is included because it
 *    happened to be in a row that was being read. The App Password is not merely omitted, it is never
 *    read: no code path here touches `config.imap.pass`, so there is no field to get wrong.
 * 2. **A final redaction pass over the assembled text**, as belt and braces rather than as the
 *    defence. The structured fields cannot carry a tracking number or an address - the allow-list is
 *    what stops that - but a log tail can, because a stack trace carries whatever the carrier said.
 * 3. **Bounded.** A bundle nobody can paste is no use, so each log gets a tail budget and the whole
 *    file gets a cap, and it says when either one bit.
 *
 * Plain text rather than JSON or a zip for one reason: the person sending it is not technical, and he
 * has to be able to read what he is about to hand over. It is also greppable at the other end.
 */

/** How much of the end of each log file is carried. The tail, because the newest lines are the fault. */
export const LOG_TAIL_BYTES = 4_000

/**
 * The cap on the whole file. Belt and braces behind the per-log budget: with the run log bounded to
 * `POLL_RUNS_KEPT` rows and two log tails of `LOG_TAIL_BYTES`, nothing here can reach this - which is
 * the point of having it. Sized to stay pasteable into a mail client or a chat window.
 */
export const SUPPORT_BUNDLE_MAX_BYTES = 40_000

/** How many of the most recent poll runs the bundle carries. Two days of hourly polling is 30. */
const RUNS_INCLUDED = 15

/**
 * How many activity entries the bundle carries. Fewer than /health shows: the whole point of this file
 * is that somebody can read it before sending it, and these are the newest lines, which are the fault.
 */
const ACTIVITY_INCLUDED = 25

/** The launchd agents this app installs (`scripts/install-agents.sh` keeps the same list). */
export const SUPPORT_AGENTS = ['local.parcels.poller', 'local.parcels.web'] as const

/** The zone the generated-at line and the download filename are written in; the app's own. */
const ZONE = 'Europe/Bratislava'

export const REDACTED_EMAIL = '[email redacted]'
export const REDACTED_NUMBER = '[tracking number redacted]'

/** What launchd says about one agent. `loaded` means launchctl lists it at all. */
export interface AgentStatus {
  label: string
  loaded: boolean
  /** The running process, when it is running. The poller is a scheduled job, so usually absent. */
  pid?: number
  /** The exit status of its last run: 0 is the healthy answer, anything else is the fault. */
  lastExit?: number
}

/** Either what launchctl said about each agent, or why it could not be asked. Never both empty. */
export interface LaunchdReport {
  agents: AgentStatus[]
  error?: string
}

/** The machine, as three strings. Separated out so a test does not depend on the host it runs on. */
export interface SupportEnv {
  node: string
  os: string
  arch: string
}

export interface SupportDeps {
  db: Database
  config: Config
  /** `0.1.0 (0db9a83)`, as /health shows it; see core/version.ts. */
  version: string
  now: Date
  /** Defaults to this process and this machine. */
  env?: SupportEnv
  /** Defaults to asking `launchctl list`. */
  launchd?: LaunchdReport
  /** Where the logs and the mail dir live; defaults to the directory holding the database. */
  dataDir?: string
  /** The two caps, overridable so the truncation paths can be tested without a 40 kB fixture. */
  limits?: { maxBytes?: number; logTailBytes?: number }
}

/**
 * The tracking-number shapes, lifted from the `matches()` of each adapter in `src/carriers/`:
 *
 *   posta   `^[A-Z]{2}\d{9}SK$`            packeta `^Z\d{10}$`
 *   sps     `^703\d{11}[0-4]\d$`           sps     `^SK[A-HJ-NP-Z0-9]{5}\d{2}[A-HJ-NP-Z0-9]{9}$`
 *   dhl     `^JJD\d{10,22}$`, `^JVGL\d{10,22}$`, `^3S[A-Z0-9]{8,18}$`, `^000\d{13,25}$`
 *   dpd     `^\d{14}[0-9A-Z]?$`            gls     `^\d{10,12}$`
 *
 * The bare-digit forms (gls, dpd, and the digits of the dhl and sps prefixed forms) are collapsed into
 * one rule: any run of ten or more digits. Deliberately broader than the union of the shapes - it is
 * one rule instead of five overlapping ones, and it is a strict superset, so a shape added to a
 * carrier tomorrow is already covered. The cost is that a 13-digit epoch in a stack trace is redacted
 * too; a timestamp is readable in a dozen other forms and a tracking number is not recoverable once
 * sent, so the trade goes this way.
 *
 * Anchored on both sides with "not a letter or a digit" rather than `\b`, so `Z1172430119` inside
 * `ref=Z1172430119,` is caught while `v24.21.0` and `2026-10-27T18:06:03.466Z` are left alone.
 *
 * Ordered longest-first where two could match at the same position: `\d{14}[0-9A-Z]` before `\d{10,}`,
 * or a DPD number with a trailing letter would fail the right-hand boundary and escape.
 */
const TRACKING_SHAPES = [
  'JVGL\\d{10,22}',
  'JJD\\d{10,22}',
  '3S[A-Z0-9]{8,18}',
  'Z\\d{10}',
  '[A-Z]{2}\\d{9}SK',
  'SK[A-HJ-NP-Z0-9]{5}\\d{2}[A-HJ-NP-Z0-9]{9}',
  '\\d{14}[0-9A-Z]',
  '\\d{10,}',
]

const TRACKING = new RegExp(`(?<![A-Za-z0-9])(?:${TRACKING_SHAPES.join('|')})(?![A-Za-z0-9])`, 'gi')

/**
 * Anything shaped like a mail address, local part and domain together. The domain goes with it: an
 * address reduced to its domain still says who the person banks and shops with.
 */
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/**
 * The last thing done to the assembled text. Addresses first: a mail address whose local part is
 * itself number-shaped (`1930144672@example.org`) must lose its domain too, and redacting the number
 * first would leave the domain standing beside a placeholder.
 */
export function redactSensitive(text: string): string {
  return text.replace(EMAIL, REDACTED_EMAIL).replace(TRACKING, REDACTED_NUMBER)
}

/** `parcels-support-2026-10-28.txt`: the app, and the day it was generated, locally. */
export const supportBundleFilename = (now: Date): string =>
  `parcels-support-${DateTime.fromJSDate(now, { zone: ZONE }).toFormat('yyyy-LL-dd')}.txt`

const runLaunchctlList = (): string => {
  const r = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5_000 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`launchctl list exited with ${r.status}`)
  return r.stdout
}

/**
 * Whether each of this app's agents is loaded, and how its last run ended. `launchctl list` prints
 * `PID<TAB>Status<TAB>Label`, with `-` for an agent that is loaded but not currently running - which
 * is the normal state of a scheduled poller, and must not read as "not installed".
 *
 * Asked once for all labels, and never throws: no launchctl (or a refusal) is an answer to report, not
 * a reason the bundle cannot be made. An agent missing from the list is reported as not loaded rather
 * than omitted, because "it was never installed" is the most common fault this bundle exists to find.
 */
export function launchdAgents(
  labels: readonly string[] = SUPPORT_AGENTS, list: () => string = runLaunchctlList,
): LaunchdReport {
  let out: string
  try {
    out = list()
  } catch (err) {
    return { agents: [], error: err instanceof Error ? err.message : String(err) }
  }
  const rows = new Map<string, { pid?: number; lastExit?: number }>()
  for (const line of out.split('\n')) {
    const [pid, status, label] = line.split('\t')
    if (label === undefined || label === '' || label === 'Label') continue
    rows.set(label, {
      pid: pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : undefined,
      lastExit: status !== undefined && /^-?\d+$/.test(status) ? Number(status) : undefined,
    })
  }
  return {
    agents: labels.map(label => {
      const row = rows.get(label)
      return row === undefined ? { label, loaded: false } : { label, loaded: true, ...row }
    }),
  }
}

/** The end of a log file, and the honest facts about what was left out. */
export interface LogTail {
  /** What the whole file holds, so the reader knows how much they are not seeing. */
  bytes: number
  text: string
  truncated: boolean
}

/**
 * The last `maxBytes` of a file, never the whole of it. A tail that starts mid-line is cut back to the
 * next line break, because half a line is a misleading line - unless dropping it would leave nothing,
 * which happens when the log is one enormous line and some of it beats none of it.
 *
 * Returns undefined for a file that is not there, which is itself a diagnostic: the poller has never
 * run under launchd, or its plist points somewhere else.
 */
export function readLogTail(path: string, maxBytes: number): LogTail | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const bytes = fstatSync(fd).size
    const start = Math.max(0, bytes - maxBytes)
    const length = bytes - start
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    const whole = buf.subarray(0, read).toString('utf8')
    const truncated = start > 0
    const afterBreak = whole.slice(whole.indexOf('\n') + 1)
    return { bytes, text: truncated && afterBreak.trim() !== '' ? afterBreak : whole, truncated }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already gone; nothing to do about it here */ }
    }
  }
}

/** How many files a directory holds and how much they weigh. One level: `data/mail` is flat. */
function dirStats(dir: string): { files: number; bytes: number } | undefined {
  try {
    let files = 0
    let bytes = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      files += 1
      try { bytes += statSync(join(dir, entry.name)).size } catch { /* raced away between the two calls */ }
    }
    return { files, bytes }
  } catch {
    return undefined
  }
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

/**
 * Human-readable, and never a raw byte count. Not only for the reader: a byte count can reach ten
 * digits, which the redaction pass would then replace with a placeholder, and a size that reads as a
 * redacted tracking number would be a confusing lie.
 */
function formatBytes(n: number): string {
  let value = n
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}

const fileSize = (path: string): string | undefined => {
  try { return formatBytes(statSync(path).size) } catch { return undefined }
}

function detectEnv(): SupportEnv {
  const kernel = `${platform()} ${release()}`
  let os = kernel
  try {
    const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5_000 })
    const product = r.status === 0 ? r.stdout.trim() : ''
    if (/^[\d.]{1,20}$/.test(product)) os = `macOS ${product} (${kernel})`
  } catch { /* not a Mac, or no sw_vers: the kernel version is still an honest answer */ }
  return { node: process.version, os, arch: arch() }
}

const iso = (d: Date | undefined): string => d?.toISOString() ?? '-'

/** `Port:               8787`. One column width for the whole file, so every value lines up. */
const field = (key: string, value: string | number): string => `${`${key}:`.padEnd(20)}${value}`

const row = (cells: Array<string | number>, widths: number[]): string =>
  cells.map((c, i) => (i === cells.length - 1 ? String(c) : String(c).padEnd(widths[i] ?? 0))).join('')

const agentLine = (a: AgentStatus): string => {
  if (!a.loaded) return `${a.label.padEnd(24)}not loaded (launchctl does not list it)`
  const running = a.pid === undefined ? 'not running' : `running (pid ${a.pid})`
  const exit = a.lastExit === undefined ? 'last exit unknown' : `last exit ${a.lastExit}`
  return `${a.label.padEnd(24)}loaded, ${running}, ${exit}`
}

/**
 * Cuts the finished text to the cap and says that it did. Applied AFTER redaction, so cutting can
 * only ever remove text and never re-expose any: the opposite order could slice a placeholder in half
 * but could also, in principle, leave a shape the pass had not yet reached.
 */
function capToSize(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const note = `\n[the rest of this bundle was cut to fit ${maxBytes} bytes; everything above is complete]\n`
  const room = maxBytes - Buffer.byteLength(note)
  if (room <= 0) return note
  // Cut the bytes, then drop the replacement character a half-finished UTF-8 sequence decodes to.
  let head = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '')
  const lastBreak = head.lastIndexOf('\n')
  if (lastBreak > room / 2) head = head.slice(0, lastBreak)
  return head + note
}

/**
 * The bundle, as one string. The same function serves the block on /health and the download, so what
 * the sender reads is byte-for-byte what the recipient gets.
 *
 * Sections are ordered by how much they are worth, because the cap cuts from the end: what is running
 * and how it is configured first, the logs - the only part that can be large - last.
 *
 * Every section is guarded. This is the file somebody makes BECAUSE the app is broken, so one
 * unreadable table must leave a note in its place rather than take the whole bundle down.
 */
export function buildSupportBundle(deps: SupportDeps): string {
  const { db, config, version, now } = deps
  const env = deps.env ?? detectEnv()
  const launchd = deps.launchd ?? launchdAgents()
  const dataDir = deps.dataDir ?? dirname(config.dbPath)
  const maxBytes = deps.limits?.maxBytes ?? SUPPORT_BUNDLE_MAX_BYTES
  const tailBytes = deps.limits?.logTailBytes ?? LOG_TAIL_BYTES

  const out: string[] = []
  const section = (title: string, body: () => string[]): void => {
    out.push('', `-- ${title} --`)
    try {
      out.push(...body())
    } catch (err) {
      out.push(`(this section could not be read: ${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

  out.push(
    '===== parcels support bundle =====',
    field('Generated', `${DateTime.fromJSDate(now, { zone: ZONE }).toFormat('yyyy-LL-dd HH:mm ZZZZ')} (${iso(now)})`),
    'This file is diagnostics for the author of this app, and it is meant to be read before it is',
    'sent. It carries only the fields that were chosen for it: no tracking numbers, parcel names,',
    'shop names, addresses, locker codes, mail subjects or senders, mail addresses or passwords.',
    'The assembled text was then put through a pass that replaces anything still shaped like a mail',
    'address or a tracking number, because a log line can carry what a column never would.',
  )

  section('app', () => [
    field('Version', version),
    field('Node', env.node),
    field('OS', env.os),
    field('Architecture', env.arch),
    field('Schema', `user_version ${userVersion(db)}`),
  ])

  section('launchd agents', () => [
    ...(launchd.error === undefined ? [] : [`launchctl could not be asked: ${launchd.error}`]),
    ...launchd.agents.map(agentLine),
  ])

  section('config (shape only, never values)', () => {
    const imap = config.imap
    return [
      field('Port', config.port),
      field('Notifier', config.notifier),
      field('Map preview', config.mapPreview ? 'on' : 'off'),
      field('Default postcode', config.defaultPostalCode === '' ? 'not set' : 'set (value not included)'),
      field('Mail', imap === undefined ? 'not configured' : 'configured'),
      ...(imap === undefined ? [] : [field('Mail server', `${imap.host}:${imap.port}, mailbox "${imap.mailbox}"`)]),
      field('Mail account', imap === undefined ? '-' : 'set (value not included)'),
      field('App Password', imap === undefined ? '-' : 'set (never read by this bundle)'),
    ]
  })

  section('counts', () => {
    const group = (column: 'status' | 'carrier'): string => {
      const rows = db.prepare(
        `SELECT ${column} AS k, COUNT(*) AS n FROM parcels GROUP BY ${column} ORDER BY ${column}`,
      ).all() as { k: string; n: number }[]
      return rows.length === 0 ? 'none' : rows.map(r => `${r.k} ${r.n}`).join(', ')
    }
    // `PENDING` rather than a copy of its SQL: this number has to be the one /attention shows, or it
    // sends the reader looking for a fault that is not there (see db/messages.ts for the four states).
    const waiting = scalar(`SELECT COUNT(*) AS n FROM messages WHERE ${PENDING}`)
    const ignored = scalar('SELECT COUNT(*) AS n FROM messages WHERE ignored = 1')
    const dormant = listActive(db).filter(p => isDormant(p, now)).length
    const mail = dirStats(join(dataDir, 'mail'))
    const tiles = dirStats(join(dataDir, 'tiles'))
    const db1 = config.dbPath === ':memory:' ? undefined : fileSize(config.dbPath)
    const wal = config.dbPath === ':memory:' ? undefined : fileSize(`${config.dbPath}-wal`)
    return [
      field('Parcels', scalar('SELECT COUNT(*) AS n FROM parcels')),
      field('By status', group('status')),
      field('By carrier', group('carrier')),
      field('Events', scalar('SELECT COUNT(*) AS n FROM events')),
      field('Messages', scalar('SELECT COUNT(*) AS n FROM messages')),
      field('Attention queue', `${waiting} message(s) waiting, ${ignored} ignored, ${dormant} dormant parcel(s)`),
      field('Raw responses', scalar('SELECT COUNT(*) AS n FROM raw_responses')),
      field('Pickup codes', scalar('SELECT COUNT(*) AS n FROM pickup_codes WHERE code IS NOT NULL')),
      field('Geocode cache', scalar('SELECT COUNT(*) AS n FROM geocode_cache')),
      field('Mail dir', mail === undefined ? 'not present' : `${mail.files} file(s), ${formatBytes(mail.bytes)}`),
      field('Tile cache', tiles === undefined ? 'not present' : `${tiles.files} file(s), ${formatBytes(tiles.bytes)}`),
      field('Database', db1 === undefined ? 'in memory' : `${db1} (write-ahead log ${wal ?? 'none'})`),
    ]
  })

  section('carrier health', () => {
    const rows = carrierHealth(db)
    if (rows.length === 0) return ['no carrier has been polled yet']
    const widths = [10, 7, 26, 26, 12]
    return [
      row(['carrier', 'fails', 'last ok', 'last error', 'kind', 'detail'], widths),
      ...rows.map(h => row([
        h.carrier, h.consecutiveFailures, iso(h.lastOkAt), iso(h.lastErrorAt),
        h.lastErrorKind ?? '-', h.lastErrorDetail ?? '-',
      ], widths)),
    ]
  })

  section('mail ingest', () => {
    const status = getIngestStatus(db)
    const marks = db.prepare('SELECT COUNT(*) AS n, MAX(last_uid) AS uid, MAX(updated_at) AS at FROM imap_state')
      .get() as { n: number; uid: number | null; at: string | null }
    return [
      field('Last ok', status === undefined ? 'never' : iso(status.lastOkAt)),
      field('Last error', status === undefined ? '-' : iso(status.lastErrorAt)),
      field('Error', status?.lastError ?? '-'),
      field('Failures in a row', status?.consecutiveFailures ?? 0),
      field('IMAP watermark', marks.n === 0
        ? 'none (no mailbox has been read to the end yet)'
        : `present (${marks.n} mailbox(es), highest uid ${marks.uid ?? '-'}, updated ${marks.at ?? '-'})`),
    ]
  })

  section('poller', () => {
    const poller = pollerStatus(db, now)
    return [
      field('Last completed run', iso(poller.lastPollAt)),
      field('Overdue', poller.overdue ? 'YES - no poll has completed for over 2 hours of the 07:00-21:00 day' : 'no'),
    ]
  })

  /**
   * How this install stands against the repository it came from, and how its last update went.
   *
   * It is here because "he is still running October's code" and "he pressed Update and the dashboard
   * came back on the old version" are both reports this bundle has to be able to answer, and neither
   * is visible anywhere else: the detached updater's own account of itself is a file in `data/`, and
   * the process that started it did not live to see how it ended. Nothing in this section is
   * sensitive - commit shas, a count, a branch name and the subjects of published commits.
   */
  section('update', () => {
    const check = getUpdateCheck(db)
    const run = readUpdateRun(updateStatusPath(dataDir))
    return [
      field('Last checked', check === undefined ? 'never' : iso(check.checkedAt)),
      field('Against', check?.upstream ?? '-'),
      field('State', check === undefined ? 'never checked'
        : check.state === 'behind' ? `behind by ${check.behind} commit(s)` : check.state),
      field('Commit', `${check?.localSha ?? '-'} (upstream ${check?.remoteSha ?? '-'})`),
      ...(check?.reason === undefined ? [] : [field('Cannot update', check.reason)]),
      field('Last update run', run === undefined ? 'none recorded' : `${run.state}, started ${iso(run.startedAt)}`),
      ...(run === undefined ? [] : [
        field('Finished', iso(run.finishedAt)),
        field('Moved', `${run.from ?? '-'} -> ${run.to ?? '-'}`),
        field('Rollback', run.rollback ?? '-'),
        field('update.sh exit', run.exit ?? '-'),
      ]),
    ]
  })

  section(`recent poll runs (newest first, up to ${RUNS_INCLUDED})`, () => {
    const runs = listRuns(db, RUNS_INCLUDED)
    if (runs.length === 0) return ['no run has ever been recorded']
    const widths = [26, 9, 26, 8, 8, 6, 9, 7]
    return [
      row(['started', 'trigger', 'finished', 'polled', 'events', 'mail', 'created', 'fails', 'outcome'], widths),
      ...runs.map(r => row([
        iso(r.startedAt), r.trigger, iso(r.finishedAt), r.polled, r.newEvents,
        r.mailRead ?? '-', r.created ?? '-', r.failures,
        r.error ?? r.summary ?? (r.finishedAt ? 'nothing to report' : 'still going'),
      ], widths)),
    ]
  })

  /**
   * The activity log: the status transitions and the user actions behind what the rest of this file
   * reports (see db/activity-log.ts). The one section whose rows are read through a gate rather than
   * verbatim - `activityForBundle` puts the carrier's raw status string through an allow-list, because
   * `DELIVEREDPS` is the diagnosis and a carrier's sentence can name the place a parcel is waiting.
   * Everything else in these rows is an id, a count, a canonical status or a word from this app's own
   * vocabulary, so the allow-list is doing the work here and not the final redaction pass.
   */
  section(`recent activity (newest first, up to ${ACTIVITY_INCLUDED})`, () => {
    const entries = activityForBundle(db, ACTIVITY_INCLUDED)
    if (entries.length === 0) return ['nothing has been recorded yet']
    const widths = [26, 10, 7]
    return [
      row(['when', 'who', 'run', 'what happened'], widths),
      ...entries.map(e => row([iso(e.at), e.actor, e.runId ?? '-', describeActivity(e)], widths)),
    ]
  })

  // The logs last: the only part of this file that can be large, and the only part the cap can reach.
  // `update.log` is the only account there is of what an update did: its process is detached and
  // replaces the web server, so nothing in the app can report on it from the inside.
  for (const name of ['poll.log', 'poll.err.log', 'update.log']) {
    const tail = readLogTail(join(dataDir, name), tailBytes)
    if (tail === undefined) {
      out.push('', `-- data/${name} (not present) --`)
      continue
    }
    if (tail.bytes === 0) {
      out.push('', `-- data/${name} (empty) --`)
      continue
    }
    const how = tail.truncated
      ? `last ${formatBytes(Buffer.byteLength(tail.text))} of ${formatBytes(tail.bytes)}; earlier lines truncated`
      : `all of it, ${formatBytes(tail.bytes)}`
    out.push('', `-- data/${name} (${how}) --`, tail.text.replace(/\n+$/, ''))
  }

  out.push('', '===== end of parcels support bundle =====', '')
  return capToSize(redactSensitive(out.join('\n')), maxBytes)
}
