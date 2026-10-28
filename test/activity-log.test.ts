import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openDb, type Database } from '../src/db/index.js'
import {
  ACTIVITY_LOG_KEPT, activityForBundle, bundleStatusRaw, describeActivity, listActivity, logAction,
  STATUS_RAW_MAX, type Cause,
} from '../src/db/activity-log.js'
import { deleteParcel, getParcel, insertParcel, updateParcelState } from '../src/db/parcels.js'
import { dismissMessage, dismissMessages } from '../src/db/messages.js'
import { MIGRATIONS } from '../src/db/migrate.js'
import { runPoll } from '../src/core/poll.js'
import { startRun } from '../src/db/poll-runs.js'
import { buildServer, refreshIdle, type WebDeps } from '../src/web/server.js'
import { buildSupportBundle } from '../src/core/support.js'
import { changedSettingFields } from '../src/web/settings.js'
import type { ConfigDocument } from '../src/core/config.js'
import { bodyHttp, config, ev, memDb, NOW, okResult, stubAdapter } from './poll-helpers.js'

const POLLER: Cause = { actor: 'poller', runId: 14, at: NOW }

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'parcels-activity-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const gls = (db: Database, number = '1930144672'): number =>
  insertParcel(db, { carrier: 'gls', trackingNumber: number, label: 'Birthday present for Eva', source: 'manual' })

const rows = (db: Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

const server = (db: Database, extra: Partial<WebDeps> = {}) =>
  buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} }, ...extra })

// --- the status-transition log -------------------------------------------------------------------

describe('a status change is recorded where it happens', () => {
  test('a change through updateParcelState writes one row with from, to and the raw status', () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)

    const log = listActivity(db, 10)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      kind: 'status', parcelId: id, carrier: 'gls',
      from: 'unknown', to: 'ready_for_pickup', raw: 'DELIVEREDPS', actor: 'poller', runId: 14,
    })
    expect(log[0]!.at).toEqual(NOW)
  })

  test('a status that did not change writes nothing, however often it is written', () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    expect(rows(db)).toBe(1)
  })

  /** The line that would have made the real incident self-diagnosing. */
  test('the GLS incident reads as one line: the transition, the raw string, the run and who ran it', () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    updateParcelState(db, id, { status: 'delivered', statusRaw: 'DELIVEREDPS' }, POLLER)

    const line = describeActivity(listActivity(db, 10)[0]!)
    expect(line).toContain('ready_for_pickup -> delivered')
    expect(line).toContain('DELIVEREDPS')
    expect(line).toContain(`#${id}`)
  })

  test('a parcel that is deleted keeps its history: the log holds no reference to the parcels table', () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    deleteParcel(db, id, { actor: 'web', at: NOW })

    expect(getParcel(db, id)).toBeUndefined()
    const log = listActivity(db, 10)
    expect(log).toHaveLength(2)
    expect(log.map(e => e.kind)).toEqual(['parcel_deleted', 'status'])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

// --- attribution ---------------------------------------------------------------------------------

describe('a status change says what caused it', () => {
  const posta = (db: Database) =>
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR123456789SK', source: 'manual' })
  const adapters = () => [stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('scan', 'in_transit')])))]

  test('a change during the hourly poll is the poller, with the run it happened in', async () => {
    const db = memDb()
    posta(db)
    const runId = startRun(db, 'poller', NOW)
    await runPoll({
      db, config, now: NOW, http: bodyHttp(), adapters: adapters(),
      cause: { actor: 'poller', runId, at: NOW },
    })
    expect(listActivity(db, 10)[0]).toMatchObject({
      kind: 'status', actor: 'poller', runId, from: 'unknown', to: 'in_transit',
    })
  })

  test('a change during a web refresh is the web, with the run the button started', async () => {
    const db = memDb()
    posta(db)
    const app = server(db, { adapters: adapters(), http: bodyHttp() })
    await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    await refreshIdle(app)

    const status = listActivity(db, 10).find(e => e.kind === 'status')
    expect(status).toMatchObject({ actor: 'web', to: 'in_transit' })
    expect(status!.runId).toBeGreaterThan(0)
  })

  test('a change made by a migration is the migration', () => {
    const path = join(tmp(), 'parcels.db')
    const before = openDb(path, [])                     // born at the baseline, before the GLS fix
    const id = insertParcel(before, { carrier: 'gls', trackingNumber: '1234567890', source: 'manual' })
    before.prepare("UPDATE parcels SET status = 'delivered', status_raw = 'DELIVEREDPS' WHERE id = ?").run(id)
    before.close()

    const after = openDb(path, MIGRATIONS)
    try {
      expect(listActivity(after, 10)[0]).toMatchObject({
        kind: 'status', actor: 'migration', parcelId: id,
        from: 'delivered', to: 'ready_for_pickup', raw: 'DELIVEREDPS',
      })
      expect(listActivity(after, 10)[0]!.runId).toBeUndefined()   // a migration is not a poll run
    } finally {
      after.close()
    }
  })

  /** Migration 3 folded two parcels into one on the author's machine and said nothing about it. */
  test('a migration that merges two parcels into one is a line, not an inference', () => {
    const path = join(tmp(), 'parcels.db')
    const before = openDb(path, [])
    const raw = before.prepare(`
      INSERT INTO parcels (carrier, tracking_number, status, first_seen_at, source)
      VALUES ('gls', ?, 'in_transit', '2026-10-20T09:00:00.000Z', 'email')
    `)
    const padded = Number(raw.run('01928813352').lastInsertRowid)
    const bare = Number(raw.run('1928813352').lastInsertRowid)
    expect(bare).toBeGreaterThan(padded)
    before.close()

    const after = openDb(path, MIGRATIONS)
    try {
      const merged = listActivity(after, 10).filter(e => e.kind === 'parcels_merged')
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ actor: 'migration', parcelId: padded, carrier: 'gls', count: 1 })
      expect(describeActivity(merged[0]!)).toContain(`#${padded}`)
    } finally {
      after.close()
    }
  })
})

// --- the action log ------------------------------------------------------------------------------

describe('the log says what the user did', () => {
  const junk = (db: Database, from: string): number => {
    const dir = tmp()
    const path = join(dir, 'm.eml')
    writeFileSync(path, 'From: x\r\n\r\nbody\r\n')
    return Number(db.prepare(`
      INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note)
      VALUES (?, ?, ?, 'Newsletter', ?, 0, 'no tracking number found in this message')
    `).run(`<m${Math.random()}@x>`, NOW.toISOString(), from, path).lastInsertRowid)
  }

  test('deleting a parcel writes an action row carrying the status it was in', async () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, POLLER)
    const app = server(db)
    await app.inject({ method: 'POST', url: `/parcel/${id}/delete`, ...form({}) })

    const log = listActivity(db, 10)
    expect(log[0]).toMatchObject({
      kind: 'parcel_deleted', actor: 'web', parcelId: id, carrier: 'gls', from: 'ready_for_pickup',
    })
    expect(describeActivity(log[0]!)).toMatch(/deleted/i)
  })

  test('a bulk dismissal records how many and that it was one sender', () => {
    const db = memDb()
    junk(db, 'news@info.billa.sk')
    const last = junk(db, 'news@info.billa.sk')
    junk(db, 'sluzobnicek@alza.sk')
    expect(dismissMessages(db, { upTo: last, from: 'news@info.billa.sk' }, { actor: 'web', at: NOW })).toBe(2)

    expect(listActivity(db, 10)[0]).toMatchObject({
      kind: 'messages_dismissed', actor: 'web', count: 2, detail: 'sender',
    })
    expect(describeActivity(listActivity(db, 10)[0]!)).toContain('2')
  })

  test('a bulk dismissal never records WHICH sender, only that it was one', () => {
    const db = memDb()
    const last = junk(db, 'news@info.billa.sk')
    dismissMessages(db, { upTo: last, from: 'news@info.billa.sk' }, { actor: 'web', at: NOW })
    const text = JSON.stringify(listActivity(db, 100))
    expect(text).not.toContain('billa')
    expect(text).not.toContain('@')
  })

  test('clearing the whole queue is distinguishable from clearing one sender', () => {
    const db = memDb()
    junk(db, 'news@info.billa.sk')
    const last = junk(db, 'sluzobnicek@alza.sk')
    dismissMessages(db, { upTo: last }, { actor: 'web', at: NOW })
    expect(listActivity(db, 10)[0]).toMatchObject({ kind: 'messages_dismissed', count: 2, detail: 'all' })
  })

  test('dismissing a single message is recorded too', () => {
    const db = memDb()
    const id = junk(db, 'news@info.billa.sk')
    dismissMessage(db, id, { actor: 'web', at: NOW })
    expect(listActivity(db, 10)[0]).toMatchObject({ kind: 'messages_dismissed', count: 1, detail: 'one' })
  })

  test('a dismissal that dismissed nothing writes nothing', () => {
    const db = memDb()
    expect(dismissMessages(db, { upTo: 99 }, { actor: 'web', at: NOW })).toBe(0)
    expect(rows(db)).toBe(0)
  })

  /**
   * `dismissed` repeats the PENDING predicate in its UPDATE, so a row that stopped being pending
   * between the SELECT and the UPDATE is skipped and is not counted. The log has to agree with what
   * was really dismissed rather than with what was selected, or a count on this page would be a
   * number that happened to nothing. The trigger stands in for that race, which nothing else can
   * provoke from one thread: `RAISE(IGNORE)` in a BEFORE trigger abandons the row's update silently.
   */
  test('a dismissal records what it really dismissed, not what it selected', () => {
    const db = memDb()
    const skipped = junk(db, 'news@info.billa.sk')
    const last = junk(db, 'sluzobnicek@alza.sk')
    db.exec(`CREATE TRIGGER skip BEFORE UPDATE OF parsed_ok ON messages
             WHEN old.id = ${skipped} BEGIN SELECT RAISE(IGNORE); END`)

    expect(dismissMessages(db, { upTo: last }, { actor: 'web', at: NOW })).toBe(1)
    expect(listActivity(db, 10)[0]).toMatchObject({ kind: 'messages_dismissed', count: 1 })
  })

  test('a dismissal that selected rows but changed none of them writes nothing', () => {
    const db = memDb()
    junk(db, 'news@info.billa.sk')
    const last = junk(db, 'sluzobnicek@alza.sk')
    db.exec('CREATE TRIGGER skip BEFORE UPDATE OF parsed_ok ON messages BEGIN SELECT RAISE(IGNORE); END')

    expect(dismissMessages(db, { upTo: last }, { actor: 'web', at: NOW })).toBe(0)
    expect(rows(db)).toBe(0)
  })

  test('assigning a message to a parcel is recorded against that parcel', async () => {
    const db = memDb()
    const messageId = junk(db, 'noreply@gls-group.eu')
    const app = server(db)
    const res = await app.inject({
      method: 'POST', url: `/attention/${messageId}/assign`, ...form({ number: '1930144672', carrier: 'gls' }),
    })
    expect(res.statusCode).toBe(303)

    const log = listActivity(db, 10)
    expect(log[0]).toMatchObject({ kind: 'message_assigned', actor: 'web', carrier: 'gls' })
    expect(log[0]!.parcelId).toBeGreaterThan(0)
    expect(JSON.stringify(log)).not.toContain('1930144672')
  })

  test('pressing refresh is recorded, with the run it started and how much it covered', async () => {
    const db = memDb()
    insertParcel(db, { carrier: 'posta', trackingNumber: 'RR123456789SK', source: 'manual' })
    const app = server(db, { adapters: [], http: bodyHttp() })
    await app.inject({ method: 'POST', url: '/refresh', ...form({}) })
    await refreshIdle(app)

    const refresh = listActivity(db, 10).find(e => e.kind === 'refresh')!
    expect(refresh).toMatchObject({ actor: 'web', count: 1, detail: 'all' })
    expect(refresh.runId).toBeGreaterThan(0)
  })

  test('refreshing one parcel says so, rather than reading as a whole-dashboard refresh', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR123456789SK', source: 'manual' })
    const app = server(db, { adapters: [], http: bodyHttp() })
    await app.inject({ method: 'POST', url: '/refresh', ...form({ parcel: String(id) }) })
    await refreshIdle(app)

    expect(listActivity(db, 10).find(e => e.kind === 'refresh')).toMatchObject({ count: 1, detail: 'one' })
  })
})

// --- settings ------------------------------------------------------------------------------------

describe('saving settings records which fields changed and never a value', () => {
  const doc = (over: Record<string, unknown> = {}): ConfigDocument => ({
    defaultPostalCode: '81101', notifier: 'auto', mapPreview: true, port: 8787, dbPath: 'data/parcels.db',
    imap: { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: 'qwertyuiopasdfgh', mailbox: 'parcels' },
    ...over,
  })

  test('an unchanged document changes no field', () => {
    expect(changedSettingFields(doc(), doc())).toEqual([])
  })

  test('each top-level field is named by its own name', () => {
    expect(changedSettingFields(doc(), doc({ notifier: 'osascript' }))).toEqual(['notifier'])
    expect(changedSettingFields(doc(), doc({ defaultPostalCode: '90031' }))).toEqual(['defaultPostalCode'])
    expect(changedSettingFields(doc(), doc({ mapPreview: false }))).toEqual(['mapPreview'])
  })

  test('a changed App Password is reported as a changed field, never as a value', () => {
    const next = doc({ imap: { ...(doc().imap as object), pass: 'zzzzzzzzzzzzzzzz' } })
    expect(changedSettingFields(doc(), next)).toEqual(['imap.pass'])
  })

  test('mail being turned on or off is one field, not five', () => {
    expect(changedSettingFields(doc({ imap: undefined }), doc())).toEqual(['imap'])
    expect(changedSettingFields(doc(), doc({ imap: undefined }))).toEqual(['imap'])
  })

  test('a save through the page records the field names and none of the values', async () => {
    const dir = tmp()
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, `${JSON.stringify(doc(), null, 2)}\n`, { mode: 0o600 })
    const db = memDb()
    const app = buildServer({ db, config, configPath, now: () => NOW, notifier: { send: async () => {} } })
    const res = await app.inject({
      method: 'POST', url: '/settings', ...form({
        defaultPostalCode: '90031', notifier: 'osascript', mapPreview: 'true',
        imapHost: 'imap.gmail.com', imapPort: '993', imapUser: 'you@gmail.com', imapMailbox: 'parcels',
        imapPass: 'zzzzzzzzzzzzzzzz',
      }),
    })
    expect(res.statusCode).toBe(303)

    const log = listActivity(db, 10)
    expect(log[0]).toMatchObject({ kind: 'settings_saved', actor: 'web' })
    expect(log[0]!.detail).toContain('defaultPostalCode')
    expect(log[0]!.detail).toContain('notifier')
    expect(log[0]!.detail).toContain('imap.pass')
    const text = JSON.stringify(log)
    expect(text).not.toContain('90031')
    expect(text).not.toContain('osascript')
    expect(text).not.toContain('zzzzzzzzzzzzzzzz')
    expect(text).not.toContain('you@gmail.com')
  })

  test('a rejected save records nothing: nothing was saved', async () => {
    const dir = tmp()
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, `${JSON.stringify(doc(), null, 2)}\n`, { mode: 0o600 })
    const db = memDb()
    const app = buildServer({ db, config, configPath, now: () => NOW, notifier: { send: async () => {} } })
    const res = await app.inject({ method: 'POST', url: '/settings', ...form({ defaultPostalCode: 'nope' }) })
    expect(res.statusCode).toBe(400)
    expect(rows(db)).toBe(0)
  })
})

// --- retention -----------------------------------------------------------------------------------

describe('the log is bounded', () => {
  test('it is trimmed to its cap on every insert, and the newest rows are the ones kept', () => {
    const db = memDb()
    for (let i = 0; i < ACTIVITY_LOG_KEPT + 5; i++) {
      logAction(db, { kind: 'refresh', count: i, scope: 'all' }, { actor: 'web', at: NOW })
    }
    expect(rows(db)).toBe(ACTIVITY_LOG_KEPT)
    expect(listActivity(db, 1)[0]!.count).toBe(ACTIVITY_LOG_KEPT + 4)
  })

  test('far more rows are kept than the five raw responses, because these are tiny', () => {
    expect(ACTIVITY_LOG_KEPT).toBeGreaterThan(1000)
  })

  test('a carrier that answers with a paragraph cannot store one: the raw string is bounded', () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'in_transit', statusRaw: 'x'.repeat(5_000) }, POLLER)
    expect(listActivity(db, 1)[0]!.raw!.length).toBe(STATUS_RAW_MAX)
  })
})

// --- diagnostics must never break anything -------------------------------------------------------

describe('a log write can never fail the work it describes', () => {
  test('a poll still completes and still stores its status when the log cannot be written', async () => {
    const db = memDb()
    const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR123456789SK', source: 'manual' })
    db.exec('DROP TABLE activity_log')

    const report = await runPoll({
      db, config, now: NOW, http: bodyHttp(),
      adapters: [stubAdapter('posta', inputs => inputs.map(i => okResult(i.number, [ev('scan', 'in_transit')])))],
      cause: { actor: 'poller', runId: 1, at: NOW },
    })
    expect(report.failures).toEqual([])
    expect(getParcel(db, id)!.status).toBe('in_transit')
  })

  test('a user action still happens when the log cannot be written', async () => {
    const db = memDb()
    const id = gls(db)
    db.exec('DROP TABLE activity_log')
    const app = server(db)
    const res = await app.inject({ method: 'POST', url: `/parcel/${id}/delete`, ...form({}) })
    expect(res.statusCode).toBe(303)
    expect(getParcel(db, id)).toBeUndefined()
  })

  test('listing the log on a database that has none is empty, not a throw', () => {
    const db = memDb()
    db.exec('DROP TABLE activity_log')
    expect(listActivity(db, 10)).toEqual([])
    expect(activityForBundle(db, 10)).toEqual([])
  })
})

// --- the support bundle --------------------------------------------------------------------------

describe('the slice the support bundle carries', () => {
  const LOCKER = 'Zasielka je pripravena v Z-BOX Bratislava Dlha 7'

  /** A parcel whose label, number and carrier sentence are all things the bundle may not send. */
  const loaded = (): { db: Database; id: number } => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'in_transit', statusRaw: 'INTRANSIT' }, POLLER)
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: LOCKER }, POLLER)
    return { db, id }
  }

  test('a status code passes the allow-list; a carrier sentence does not', () => {
    expect(bundleStatusRaw('DELIVEREDPS')).toBe('DELIVEREDPS')
    expect(bundleStatusRaw('PARCEL_HANDED')).toBe('PARCEL_HANDED')
    expect(bundleStatusRaw('1')).toBe('1')
    expect(bundleStatusRaw(undefined)).toBeUndefined()
    expect(bundleStatusRaw(LOCKER)).not.toContain('Dlha')
    expect(bundleStatusRaw('Ready at Z-BOX')).not.toContain('Z-BOX')
  })

  test('the slice holds no tracking number, label or address', () => {
    const { db } = loaded()
    const text = JSON.stringify(activityForBundle(db, 50))
    expect(text).not.toContain('1930144672')
    expect(text).not.toContain('Birthday present')
    expect(text).not.toContain('Dlha 7')
    // ...but the diagnosis is still there: the transition, and the code-shaped raw string.
    expect(text).toContain('ready_for_pickup')
    expect(text).toContain('INTRANSIT')
  })

  test('the bundle prints the slice, and the allow-list rather than the final pass is what cleans it', () => {
    const { db } = loaded()
    const text = buildSupportBundle({
      db, config, version: '0.1.0 (0db9a83)', now: NOW,
      env: { node: 'v24.21.0', os: 'macOS', arch: 'arm64' }, launchd: { agents: [] }, dataDir: tmp(),
    })
    expect(text).toMatch(/activity/i)
    expect(text).toContain('ready_for_pickup')
    expect(text).toContain('INTRANSIT')                 // the code-shaped raw string survives
    expect(text).not.toContain('Dlha 7')
    expect(text).not.toContain('Birthday present')
    expect(text).not.toContain('1930144672')
    expect(text).not.toContain('[tracking number redacted]')
  })

  test('an empty log is stated as empty rather than left out', () => {
    const text = buildSupportBundle({
      db: memDb(), config, version: '0.1.0 (0db9a83)', now: NOW,
      env: { node: 'v24.21.0', os: 'macOS', arch: 'arm64' }, launchd: { agents: [] }, dataDir: tmp(),
    })
    expect(text).toMatch(/activity/i)
    expect(text).toMatch(/nothing has been recorded/i)
  })
})

// --- /health -------------------------------------------------------------------------------------

describe('/health shows the recent entries', () => {
  test('newest first', async () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'in_transit', statusRaw: 'INTRANSIT' }, { actor: 'poller', at: NOW })
    updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS' }, { actor: 'poller', at: NOW })
    logAction(db, { kind: 'messages_dismissed', count: 7, scope: 'all' }, { actor: 'web', at: NOW })

    const body = (await server(db).inject({ method: 'GET', url: '/health' })).body
    const ids = [...body.matchAll(/data-activity="(\d+)"/g)].map(m => Number(m[1]))
    expect(ids).toHaveLength(3)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
    expect(body).toContain('ready_for_pickup')
    expect(body).toContain('DELIVEREDPS')
  })

  test('an empty log says so rather than showing an empty table', async () => {
    const body = (await server(memDb()).inject({ method: 'GET', url: '/health' })).body
    expect(body).not.toContain('data-activity=')
    expect(body).toMatch(/nothing has been recorded/i)
  })

  test('a parcel name never reaches the page through this panel', async () => {
    const db = memDb()
    const id = gls(db)
    updateParcelState(db, id, { status: 'in_transit', statusRaw: 'INTRANSIT' }, { actor: 'poller', at: NOW })
    const body = (await server(db).inject({ method: 'GET', url: '/health' })).body
    expect(body).not.toContain('Birthday present')
  })
})
