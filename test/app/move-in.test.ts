import BetterSqlite3 from 'better-sqlite3'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import { moveIn, type MoveInDeps } from '../../app/move-in.js'
import { authStorePathFor } from '../../src/carriers/dpd.js'
import { openDb, type Database } from '../../src/db/index.js'
import { storeMessage } from '../../src/db/messages.js'
import { insertParcel } from '../../src/db/parcels.js'

const UID = 501
const mode = (path: string) => statSync(path).mode & 0o777

/** Every path under `dir` with its bytes (directories as ''), to prove nothing in the clone was changed. */
function snapshot(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(dir, p)
      if (skip.includes(rel)) continue
      if (e.isDirectory()) { out[rel] = ''; walk(p) } else out[rel] = readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}

interface Fixture {
  clone: string
  support: string
  launchAgents: string
  plists: string[]
  /** The clone's database, still open: the uncheckpointed row is only in its WAL. */
  db: Database
  dbFile: string
  calls: string[][]
  deps: (launchctl?: MoveInDeps['launchctl']) => MoveInDeps
}

/**
 * A git-clone install as it is on a friend's Mac: a config with an absolute dbPath, a WAL-mode
 * database with three parcels (the last written after the last checkpoint), two stored emails in
 * data/mail, no tiles, and both launchd plists.
 */
function fixture(o: { dbPath?: 'absolute' | 'default' | 'other'; dpd?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'parcels-move-in-'))
  const clone = join(root, 'Desktop', 'parcels')
  const support = join(root, 'Library', 'Application Support', 'Parcels')
  const launchAgents = join(root, 'Library', 'LaunchAgents')
  mkdirSync(launchAgents, { recursive: true })
  mkdirSync(clone, { recursive: true })

  const relDb = o.dbPath === 'other' ? 'db/mine.db' : 'data/parcels.db'
  const dbFile = join(clone, relDb)
  const dbPath = o.dbPath === 'absolute' || o.dbPath === undefined ? dbFile : o.dbPath === 'other' ? relDb : undefined
  writeFileSync(join(clone, 'config.json'), `${JSON.stringify({
    defaultPostalCode: '81101',
    ...(dbPath !== undefined && { dbPath }),
    port: 8799,
    notifier: 'auto',
    mapPreview: true,
    imap: { host: 'imap.example.test', port: 993, user: 'someone@example.test', pass: 'not-a-real-password', mailbox: 'parcels' },
    somethingNewer: { kept: true },
  }, null, 2)}\n`, { mode: 0o600 })

  const db = openDb(dbFile)
  db.pragma('wal_autocheckpoint = 0')
  const mailDir = join(clone, relDb, '..', 'mail')
  const m1 = storeMessage(db, { messageId: '<1@x>', from: 'shop@example.test', subject: 'Shipped', receivedAt: new Date('2026-10-01T10:00:00Z'), raw: Buffer.from('mail one') }, mailDir)
  storeMessage(db, { messageId: '<2@x>', from: 'shop@example.test', subject: 'Shipped too', receivedAt: new Date('2026-10-02T10:00:00Z'), raw: Buffer.from('mail two') }, mailDir)
  insertParcel(db, { carrier: 'gls', trackingNumber: '11111111111', label: 'first', source: 'email', sourceMessageId: '<1@x>' })
  insertParcel(db, { carrier: 'dpd', trackingNumber: '22222222222222', label: 'second', source: 'manual' })
  db.pragma('wal_checkpoint(TRUNCATE)')
  insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z3333333333', label: 'after the checkpoint', source: 'manual' })
  expect(m1).toBe(1)
  if (o.dpd) writeFileSync(authStorePathFor(dbFile)!, '{"credential":{"value":"x","at":1}}', { mode: 0o600 })

  const plists = ['local.parcels.poller', 'local.parcels.web'].map(label => {
    const p = join(launchAgents, `${label}.plist`)
    writeFileSync(p, `<plist><dict><key>Label</key><string>${label}</string></dict></plist>\n`)
    return p
  })
  const calls: string[][] = []
  const ok: MoveInDeps['launchctl'] = () => ({ code: 0, stderr: '' })
  return {
    clone, support, launchAgents, plists, db, dbFile, calls,
    deps: (launchctl = ok) => ({
      clone, plists, support, uid: UID,
      launchctl: args => { calls.push(args); return launchctl(args) },
    }),
  }
}

const parcelsIn = (file: string) => {
  const db = new BetterSqlite3(file, { readonly: true })
  try {
    return (db.prepare('SELECT label FROM parcels ORDER BY id').all() as { label: string }[]).map(r => r.label)
  } finally { db.close() }
}

const BOOTOUTS = [['bootout', `gui/${UID}/local.parcels.poller`], ['bootout', `gui/${UID}/local.parcels.web`]]

describe('moveIn', () => {
  test('moves a WAL database, the mail, and the config into the app, and parks the plists', async () => {
    const f = fixture({ dpd: true })
    const before = snapshot(f.clone, ['data/parcels.db', 'data/parcels.db-wal', 'data/parcels.db-shm'])
    // The live install's Chromium state and login-item marker are already in the support folder.
    mkdirSync(join(f.support, 'Chromium'), { recursive: true })
    writeFileSync(join(f.support, 'Chromium', 'x'), 'chromium')

    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toEqual({ ok: true })

    const data = join(f.support, 'data')
    const copy = join(data, 'parcels.db')
    // Every row, including the one only the WAL held.
    expect(parcelsIn(copy)).toEqual(['first', 'second', 'after the checkpoint'])
    const check = new BetterSqlite3(copy, { readonly: true })
    expect(check.pragma('integrity_check', { simple: true })).toBe('ok')
    // The stored emails now point at the app's own copies, so dismissing one never deletes the clone's.
    expect(check.prepare('SELECT raw_path FROM messages ORDER BY id').all()).toEqual([
      { raw_path: join(data, 'mail', '1.eml') }, { raw_path: join(data, 'mail', '2.eml') },
    ])
    check.close()

    const config = JSON.parse(readFileSync(join(f.support, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(config.dbPath).toBe('data/parcels.db')
    // Everything else is the clone's document, unknown keys included.
    expect(config.imap).toMatchObject({ pass: 'not-a-real-password' })
    expect(config.somethingNewer).toEqual({ kept: true })
    expect(config.port).toBe(8799)
    expect(mode(join(f.support, 'config.json'))).toBe(0o600)
    expect(mode(f.support)).toBe(0o700)
    expect(mode(data)).toBe(0o700)
    expect(mode(copy)).toBe(0o600)
    expect(mode(join(data, 'mail'))).toBe(0o700)
    expect(mode(join(data, 'mail', '1.eml'))).toBe(0o600)
    expect(readFileSync(join(data, 'mail', '2.eml'), 'utf8')).toBe('mail two')
    expect(readFileSync(join(data, 'dpd-auth.json'), 'utf8')).toContain('credential')
    expect(mode(join(data, 'dpd-auth.json'))).toBe(0o600)
    expect(existsSync(join(data, 'tiles'))).toBe(false)
    // Nothing of the move's own bookkeeping is left behind.
    expect(readdirSync(f.support).sort()).toEqual(['Chromium', 'config.json', 'data'])
    expect(readFileSync(join(f.support, 'Chromium', 'x'), 'utf8')).toBe('chromium')

    // launchd: both jobs stopped, poller first, and nothing started again.
    expect(f.calls).toEqual(BOOTOUTS)
    for (const p of f.plists) expect(existsSync(p)).toBe(false)
    expect(readdirSync(join(f.clone, 'launchd-backup')).sort()).toEqual(['local.parcels.poller.plist', 'local.parcels.web.plist'])

    // The clone is as it was, apart from the new launchd-backup folder.
    expect(snapshot(f.clone, ['data/parcels.db', 'data/parcels.db-wal', 'data/parcels.db-shm', 'launchd-backup'])).toEqual(before)
  })

  test('copies the tiles when there are some, with owner-only modes even if the clone had looser ones', async () => {
    const f = fixture()
    const tiles = join(f.clone, 'data', 'tiles', '15', '18000')
    mkdirSync(tiles, { recursive: true, mode: 0o755 })
    writeFileSync(join(tiles, '11000.png'), 'png', { mode: 0o644 })
    chmodSync(join(f.clone, 'data', 'tiles'), 0o755)
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toEqual({ ok: true })
    const copied = join(f.support, 'data', 'tiles')
    expect(readFileSync(join(copied, '15', '18000', '11000.png'), 'utf8')).toBe('png')
    expect(mode(copied)).toBe(0o700)
    expect(mode(join(copied, '15', '18000'))).toBe(0o700)
    expect(mode(join(copied, '15', '18000', '11000.png'))).toBe(0o600)
    // preserveTimestamps: a tile's age is what decides when it is fetched again. The copy keeps the
    // time to about the millisecond: utimes takes it as a float of seconds.
    const drift = statSync(join(copied, '15', '18000', '11000.png')).mtimeMs - statSync(join(tiles, '11000.png')).mtimeMs
    expect(Math.abs(drift)).toBeLessThan(1)
    // The clone's own modes are left alone.
    expect(mode(join(tiles, '11000.png'))).toBe(0o644)
  })

  test('a job that is not loaded counts as stopped', async () => {
    const f = fixture()
    const result = await moveIn(f.deps(() => ({ code: 3, stderr: 'Boot-out failed: 3: No such process\n' })))
    f.db.close()
    expect(result).toEqual({ ok: true })
    expect(f.calls).toEqual(BOOTOUTS)
  })

  test('"No such process" with another exit code also counts as stopped', async () => {
    const f = fixture()
    const result = await moveIn(f.deps(() => ({ code: 113, stderr: 'Boot-out failed: No such process' })))
    f.db.close()
    expect(result).toEqual({ ok: true })
  })

  test('a database the old install already closed (no WAL left) is copied too', async () => {
    const f = fixture()
    f.db.close()
    expect(existsSync(`${f.dbFile}-wal`)).toBe(false)
    expect(await moveIn(f.deps())).toEqual({ ok: true })
    expect(parcelsIn(join(f.support, 'data', 'parcels.db'))).toEqual(['first', 'second', 'after the checkpoint'])
  })

  test('a relative dbPath of the clone is read from the clone and becomes the app default', async () => {
    const f = fixture({ dbPath: 'other' })
    expect(await moveIn(f.deps())).toEqual({ ok: true })
    f.db.close()
    expect(JSON.parse(readFileSync(join(f.support, 'config.json'), 'utf8')).dbPath).toBe('data/parcels.db')
    expect(parcelsIn(join(f.support, 'data', 'parcels.db'))).toHaveLength(3)
    expect(readFileSync(join(f.support, 'data', 'mail', '1.eml'), 'utf8')).toBe('mail one')
  })

  test('a config with no dbPath keeps having none: the default is already the app\'s', async () => {
    const f = fixture({ dbPath: 'default' })
    expect(await moveIn(f.deps())).toEqual({ ok: true })
    f.db.close()
    expect(JSON.parse(readFileSync(join(f.support, 'config.json'), 'utf8'))).not.toHaveProperty('dbPath')
  })

  test('a corrupt database fails, removes only what the move made, and starts the old jobs again', async () => {
    const f = fixture()
    f.db.close()
    writeFileSync(f.dbFile, Buffer.alloc(8192, 0x5a))
    mkdirSync(join(f.support, 'Chromium'), { recursive: true })
    writeFileSync(join(f.support, 'Chromium', 'x'), 'chromium')
    writeFileSync(join(f.support, '.login-item-set'), 'marker')
    const before = snapshot(f.clone)

    const result = await moveIn(f.deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(['copy', 'check']).toContain(result.step)
    // Said as sentences: what could not be read, and how the old install was left.
    expect(result.reason).toBe(`The old database at ${f.dbFile} could not be read: file is not a database. The old install was started again.`)

    // Only config.json and data/ were the move's; Chromium's live state and the marker stay.
    expect(existsSync(join(f.support, 'config.json'))).toBe(false)
    expect(existsSync(join(f.support, 'data'))).toBe(false)
    expect(readdirSync(f.support).sort()).toEqual(['.login-item-set', 'Chromium'])
    expect(readFileSync(join(f.support, 'Chromium', 'x'), 'utf8')).toBe('chromium')

    expect(f.calls).toEqual([
      ...BOOTOUTS,
      ['bootstrap', `gui/${UID}`, f.plists[1]!],
      ['bootstrap', `gui/${UID}`, f.plists[0]!],
    ])
    for (const p of f.plists) expect(existsSync(p)).toBe(true)
    expect(snapshot(f.clone)).toEqual(before)
  })

  test('a job that will not stop fails at "stop", copies nothing, and starts both again', async () => {
    const f = fixture()
    const result = await moveIn(f.deps(args =>
      args[1]?.endsWith('web') ? { code: 5, stderr: 'Boot-out failed: 5: Input/output error' } : { code: 0, stderr: '' }))
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'stop' })
    if (!result.ok) expect(result.reason).toContain('Input/output error')
    expect(existsSync(join(f.support, 'data'))).toBe(false)
    expect(existsSync(join(f.support, 'config.json'))).toBe(false)
    expect(f.calls.filter(c => c[0] === 'bootstrap')).toEqual([
      ['bootstrap', `gui/${UID}`, f.plists[1]!], ['bootstrap', `gui/${UID}`, f.plists[0]!],
    ])
  })

  test('a plist that cannot be parked fails at "park": the plists go back and the jobs start again', async () => {
    const f = fixture()
    // A file where the backup folder would go: the folder cannot be made.
    writeFileSync(join(f.clone, 'launchd-backup'), 'in the way')
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'park' })
    for (const p of f.plists) expect(existsSync(p)).toBe(true)
    expect(existsSync(join(f.support, 'config.json'))).toBe(false)
    expect(existsSync(join(f.support, 'data'))).toBe(false)
    expect(f.calls.filter(c => c[0] === 'bootstrap')).toHaveLength(2)
    expect(readFileSync(join(f.clone, 'launchd-backup'), 'utf8')).toBe('in the way')
  })

  test('a second plist that cannot be parked brings the first one back too', async () => {
    const f = fixture()
    mkdirSync(join(f.clone, 'launchd-backup'))
    // The web plist vanishes after its job is stopped, so the poller's plist is parked and the web
    // one cannot be.
    const result = await moveIn({
      ...f.deps(),
      launchctl: args => {
        f.calls.push(args)
        if (args[0] === 'bootout' && args[1]?.endsWith('web')) rmSync(f.plists[1]!)
        return { code: 0, stderr: '' }
      },
    })
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'park' })
    expect(existsSync(f.plists[0]!)).toBe(true)
    expect(readdirSync(join(f.clone, 'launchd-backup'))).toEqual([])
  })

  test('an earlier backup in launchd-backup is never overwritten', async () => {
    const f = fixture()
    mkdirSync(join(f.clone, 'launchd-backup'))
    writeFileSync(join(f.clone, 'launchd-backup', 'local.parcels.web.plist'), 'older')
    expect(await moveIn(f.deps())).toEqual({ ok: true })
    f.db.close()
    expect(readFileSync(join(f.clone, 'launchd-backup', 'local.parcels.web.plist'), 'utf8')).toBe('older')
    expect(readdirSync(join(f.clone, 'launchd-backup')).sort())
      .toEqual(['local.parcels.poller.plist', 'local.parcels.web.2.plist', 'local.parcels.web.plist'])
  })

  test('a data folder the app did not make is left alone, and nothing is stopped', async () => {
    const f = fixture()
    mkdirSync(join(f.support, 'data'), { recursive: true })
    writeFileSync(join(f.support, 'data', 'someone-elses'), 'keep')
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'copy' })
    expect(readFileSync(join(f.support, 'data', 'someone-elses'), 'utf8')).toBe('keep')
    expect(f.calls).toEqual([])
    for (const p of f.plists) expect(existsSync(p)).toBe(true)
  })

  test('settings the app already has are never touched, and nothing is stopped', async () => {
    const f = fixture()
    mkdirSync(f.support, { recursive: true })
    writeFileSync(join(f.support, 'config.json'), '{"defaultPostalCode":"01001"}')
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'copy' })
    expect(readFileSync(join(f.support, 'config.json'), 'utf8')).toBe('{"defaultPostalCode":"01001"}')
    expect(f.calls).toEqual([])
  })

  test('what an interrupted move left behind is cleared, and the move goes ahead', async () => {
    const f = fixture()
    // A move that was cut off (power loss, a force quit) during the copy: its marker and a partial data/.
    mkdirSync(join(f.support, 'data', 'mail'), { recursive: true })
    writeFileSync(join(f.support, 'data', 'parcels.db'), 'half')
    writeFileSync(join(f.support, '.moving-in'), '')
    expect(await moveIn(f.deps())).toEqual({ ok: true })
    f.db.close()
    expect(parcelsIn(join(f.support, 'data', 'parcels.db'))).toHaveLength(3)
    expect(existsSync(join(f.support, '.moving-in'))).toBe(false)
  })

  test('a clone config that cannot be read fails before anything is stopped', async () => {
    const f = fixture()
    writeFileSync(join(f.clone, 'config.json'), '{ not json')
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'copy' })
    expect(f.calls).toEqual([])
    expect(existsSync(join(f.support, 'data'))).toBe(false)
  })

  test('a clone config the app would not load fails before anything is stopped', async () => {
    const f = fixture()
    writeFileSync(join(f.clone, 'config.json'), JSON.stringify({ defaultPostalCode: '81101', notifier: 'pigeon' }))
    const result = await moveIn(f.deps())
    f.db.close()
    expect(result).toMatchObject({ ok: false, step: 'copy' })
    expect(f.calls).toEqual([])
  })

  test('a missing database fails before anything is stopped', async () => {
    const f = fixture({ dbPath: 'other' })
    f.db.close()
    rmSync(join(f.clone, 'db'), { recursive: true })
    const result = await moveIn(f.deps())
    expect(result).toMatchObject({ ok: false, step: 'copy' })
    expect(f.calls).toEqual([])
  })

  test('a failed restart of the old jobs is said in the reason', async () => {
    const f = fixture()
    f.db.close()
    writeFileSync(f.dbFile, Buffer.alloc(8192, 0x5a))
    const result = await moveIn(f.deps(args =>
      args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : { code: 0, stderr: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('Bootstrap failed: 5: Input/output error')
      expect(result.reason).toContain('install-agents.sh')
    }
  })
})
