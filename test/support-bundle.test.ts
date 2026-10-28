import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildSupportBundle, launchdAgents, LOG_TAIL_BYTES, REDACTED_EMAIL, REDACTED_NUMBER, redactSensitive,
  SUPPORT_AGENTS, SUPPORT_BUNDLE_MAX_BYTES, supportBundleFilename, type LaunchdReport, type SupportDeps,
} from '../src/core/support.js'
import { buildServer, type WebDeps } from '../src/web/server.js'
import { recordHealth } from '../src/db/health.js'
import { recordIngest } from '../src/db/ingest-status.js'
import { recordPickupCode } from '../src/db/pickup-codes.js'
import { saveImapState } from '../src/db/imap-state.js'
import { appendEvents } from '../src/db/events.js'
import { finishRun, startRun } from '../src/db/poll-runs.js'
import { insertParcel, updateParcelState } from '../src/db/parcels.js'
import { escapeHtml } from '../src/web/views/html.js'
import type { Config } from '../src/core/config.js'
import type { Database } from '../src/db/index.js'
import { memDb, NOW } from './poll-helpers.js'

/**
 * Everything the bundle must never carry, in one place, so a test can assert on the whole list rather
 * than on whichever field it remembered. These are the values the fixtures below are built from.
 */
const SECRETS = {
  appPassword: 'qwertyuiopasdfgh',
  email: 'friend.surname@gmail.com',
  emailLocalPart: 'friend.surname',
  defaultPostcode: '90031',
  label: 'Birthday present for Eva',
  merchant: 'Alza.sk',
  pickupName: 'Z-BOX Bratislava Dlha 7',
  pickupStreet: 'Dlha 7',
  pickupCity: 'Pezinok',
  pickupZip: '82105',
  pickupCode: '004467',
  subject: 'Vasa zasielka je pripravena na vyzdvihnutie',
  sender: 'noreply@packeta.com',
  emlBody: 'Dear Matus, your parcel is waiting at the Z-BOX, use code 004467 to open it',
} as const

/** One tracking number per carrier shape declared in src/carriers/*.ts. */
const NUMBERS = {
  posta: 'RR123456789SK',
  packeta: 'Z1172430119',
  gls: '1930144672',
  sps: '70312345678901234',
  spsAlt: 'SKABCDE12FGHJKLMNP',
  dpd: '09876543210987',
  dpdLetter: '09876543210987A',
  dhlJjd: 'JJD0123456789012',
  dhlJvgl: 'JVGL0123456789012',
  dhl3s: '3SABCD123456',
  dhlZeros: '0001234567890123',
} as const

const config: Config = {
  dbPath: ':memory:', port: 8787, defaultPostalCode: SECRETS.defaultPostcode,
  notifier: 'auto', mapPreview: true,
  imap: { host: 'imap.gmail.com', port: 993, user: SECRETS.email, pass: SECRETS.appPassword, mailbox: 'parcels' },
}

const AGENTS: LaunchdReport = {
  agents: [
    { label: 'local.parcels.poller', loaded: true, lastExit: 0 },
    { label: 'local.parcels.web', loaded: true, pid: 55787, lastExit: 0 },
  ],
}

const ENV = { node: 'v24.21.0', os: 'macOS 27.2.0 (darwin 27.2.0)', arch: 'arm64' }

const dirs: string[] = []
function dataDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'parcels-support-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'mail'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/**
 * A database with one of everything the bundle reads, and a sensitive value in every field it must
 * not read: a labelled parcel from a named merchant, waiting at a named pickup point with a locker
 * code, an email whose subject and sender are stored, a carrier failure, an ingest failure, an IMAP
 * watermark and a finished run.
 */
function loadedDb(): Database {
  const db = memDb()
  const id = insertParcel(db, {
    carrier: 'packeta', trackingNumber: NUMBERS.packeta, label: SECRETS.label, merchant: SECRETS.merchant,
    postalCode: SECRETS.pickupZip, source: 'email', sourceMessageId: '<abc@packeta.com>',
  })
  appendEvents(db, id, [{
    occurredAtRaw: '2026-10-27 18:00', occurredAtTz: 'Europe/Bratislava', status: 'ready_for_pickup',
    occurredAt: new Date(NOW.getTime() - 3_600_000), description: `Ready at ${SECRETS.pickupName}`,
    location: SECRETS.pickupCity,
  }])
  updateParcelState(db, id, {
    status: 'ready_for_pickup',
    pickup: {
      kind: 'zbox', name: SECRETS.pickupName, street: SECRETS.pickupStreet,
      city: SECRETS.pickupCity, postalCode: SECRETS.pickupZip, lat: 48.28, lon: 17.26,
    },
  })
  recordPickupCode(db, id, SECRETS.pickupCode, 1, NOW)
  const delivered = insertParcel(db, { carrier: 'gls', trackingNumber: NUMBERS.gls, source: 'manual' })
  updateParcelState(db, delivered, { status: 'delivered', deliveredAt: NOW })
  db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note)
    VALUES ('<junk@x>', ?, ?, ?, ?, 0, 'no tracking number found in this message')
  `).run(NOW.toISOString(), SECRETS.sender, SECRETS.subject, `/tmp/mail/${SECRETS.emailLocalPart}.eml`)
  db.prepare('INSERT INTO raw_responses (parcel_id, carrier, fetched_at, body) VALUES (?, ?, ?, ?)')
    .run(id, 'packeta', NOW.toISOString(), JSON.stringify({ number: NUMBERS.packeta, name: SECRETS.pickupName }))
  recordHealth(db, 'packeta', 'ok', undefined, NOW)
  recordHealth(db, 'gls', 'transport', `transport for ${NUMBERS.gls}`, NOW)
  recordIngest(db, { ok: false, error: `getaddrinfo ENOTFOUND imap.gmail.com for ${SECRETS.email}` }, NOW)
  saveImapState(db, `${SECRETS.email} imap.gmail.com:993`, 'parcels', { uidValidity: '12', lastUid: 601 }, NOW)
  const run = startRun(db, 'poller', NOW)
  finishRun(db, run, {
    counts: { polled: 2, newEvents: 1, mailRead: 3, created: 0, failures: 1 },
    summary: `polled 2 parcel(s), 1 new event(s), 1 carrier failure(s) (gls: transport: transport for ${NUMBERS.gls})`,
  }, NOW)
  db.prepare('INSERT INTO last_poll (id, polled_at_ms) VALUES (1, ?)').run(NOW.getTime())
  return db
}

/**
 * The same database with its three free-text diagnostic fields rewritten to carry nothing sensitive.
 *
 * `carrier_health.last_error_detail`, `ingest_status.last_error` and `poll_runs.summary` are
 * allow-listed verbatim - they are the diagnosis - and any of them can legitimately quote a tracking
 * number or an address, which is exactly why the redaction pass exists. Blanking them leaves a
 * database in which NOTHING the bundle reads has any business producing a placeholder, which is what
 * makes it possible to assert that the allow-list is doing the work rather than the final pass.
 */
function cleanDb(): Database {
  const db = loadedDb()
  db.prepare("UPDATE carrier_health SET last_error_detail = 'connection reset by peer'").run()
  db.prepare("UPDATE ingest_status SET last_error = 'getaddrinfo ENOTFOUND imap.gmail.com'").run()
  db.prepare("UPDATE poll_runs SET summary = 'polled 2 parcel(s), 1 new event(s)'").run()
  return db
}

const deps = (over: Partial<SupportDeps> = {}): SupportDeps => ({
  db: over.db ?? loadedDb(), config, version: '0.1.0 (0db9a83)', now: NOW,
  env: ENV, launchd: AGENTS, dataDir: dataDir(), ...over,
})

const bundle = (over: Partial<SupportDeps> = {}): string => buildSupportBundle(deps(over))

describe('the support bundle says what is running', () => {
  test('the app version and commit', () => {
    expect(bundle()).toContain('0.1.0 (0db9a83)')
  })

  test('Node, OS and architecture', () => {
    const text = bundle()
    expect(text).toContain('v24.21.0')
    expect(text).toContain('macOS 27.2.0 (darwin 27.2.0)')
    expect(text).toContain('arm64')
  })

  test('the schema user_version, so a stale database is visible', () => {
    expect(bundle()).toMatch(/user_version\s+\d+/)
  })

  test('whether each launchd agent is loaded, and its last exit', () => {
    const text = bundle()
    for (const label of SUPPORT_AGENTS) expect(text).toContain(label)
    expect(text).toMatch(/local\.parcels\.poller.*loaded/)
    expect(text).toMatch(/local\.parcels\.web.*pid 55787/)
    expect(text).toMatch(/last exit 0/)
  })

  test('an agent launchctl does not list is reported as not loaded, not omitted', () => {
    const text = bundle({ launchd: { agents: [{ label: 'local.parcels.poller', loaded: false }], error: undefined } })
    expect(text).toMatch(/local\.parcels\.poller\s+not loaded/)
  })

  test('a launchctl that could not be asked says so rather than claiming nothing is loaded', () => {
    expect(bundle({ launchd: { agents: [], error: 'launchctl: command not found' } }))
      .toContain('launchctl: command not found')
  })
})

describe('the support bundle says what the app is doing', () => {
  test('the carrier health rows, with the failure streak', () => {
    const text = bundle()
    expect(text).toContain('carrier health')
    expect(text).toMatch(/packeta/)
    expect(text).toMatch(/gls/)
    expect(text).toMatch(/transport/)
  })

  test('the ingest status and its last error', () => {
    expect(bundle()).toMatch(/ingest/i)
    expect(bundle()).toContain('ENOTFOUND')
  })

  test('the run log, with what each run did', () => {
    const text = bundle()
    expect(text).toContain('poll runs')
    expect(text).toContain('poller')
    expect(text).toContain('polled 2 parcel(s), 1 new event(s)')
  })

  test('whether an IMAP watermark exists, without naming the account', () => {
    const text = bundle()
    expect(text).toMatch(/watermark:\s+present/)
    expect(text).not.toContain(SECRETS.email)
  })

  test('no watermark is stated as absent, not left out', () => {
    const db = memDb()
    expect(buildSupportBundle(deps({ db }))).toMatch(/watermark:\s+none/)
  })

  test('counts: parcels by status and by carrier, messages, the attention queue, the mail dir', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'mail', '1.eml'), 'x'.repeat(1000))
    writeFileSync(join(dir, 'mail', '2.eml'), 'x'.repeat(1000))
    const text = buildSupportBundle(deps({ dataDir: dir }))
    expect(text).toMatch(/ready_for_pickup 1/)
    expect(text).toMatch(/delivered 1/)
    expect(text).toMatch(/packeta 1/)
    expect(text).toMatch(/gls 1/)
    expect(text).toMatch(/Messages:\s+1/)
    expect(text).toMatch(/Attention queue:\s+1 message/)
    expect(text).toMatch(/Mail dir:\s+2 file/)
  })

  /**
   * The attention count must be the one /attention itself shows, which since the `ignored` column is
   * `PENDING` and not "unparsed and unassigned". A bundle that reported 600 waiting messages where
   * the page shows 56 would send the author looking for a fault that is not there. Ignored mail is
   * counted too, separately: it is a real number and a different question.
   */
  test('ignored mail is counted apart from the attention queue, as the page counts it', () => {
    const db = loadedDb()
    db.prepare(`
      INSERT INTO messages (message_id, received_at, from_addr, subject, parsed_ok, ignored)
      VALUES ('<news@x>', ?, ?, ?, 0, 1)
    `).run(NOW.toISOString(), SECRETS.sender, SECRETS.subject)
    const text = buildSupportBundle(deps({ db }))
    expect(text).toMatch(/Messages:\s+2/)
    expect(text).toMatch(/Attention queue:\s+1 message\(s\) waiting, 1 ignored/)
  })

  test('the config shape: port, notifier, map preview, mail host, port and mailbox', () => {
    const text = bundle()
    expect(text).toMatch(/Port:\s+8787/)
    expect(text).toMatch(/Notifier:\s+auto/)
    expect(text).toMatch(/Map preview:\s+on/)
    expect(text).toMatch(/Mail:\s+configured/)
    expect(text).toContain('imap.gmail.com:993')
    expect(text).toContain('parcels')
  })

  test('mail that is not configured is said to be not configured', () => {
    const text = bundle({ config: { ...config, imap: undefined } })
    expect(text).toMatch(/Mail:\s+not configured/)
  })
})

describe('the support bundle never carries a secret', () => {
  test('not the stored App Password, with one genuinely configured', () => {
    expect(config.imap?.pass).toBe(SECRETS.appPassword)
    expect(bundle()).not.toContain(SECRETS.appPassword)
  })

  test('not the user email address, with one genuinely configured', () => {
    expect(config.imap?.user).toBe(SECRETS.email)
    const text = bundle()
    expect(text).not.toContain(SECRETS.email)
    expect(text).not.toContain(SECRETS.emailLocalPart)
  })

  test('not a tracking number, from any field the carriers write', () => {
    const text = bundle()
    for (const n of Object.values(NUMBERS)) expect(text).not.toContain(n)
  })

  test('not a parcel label, merchant, pickup point, address or locker code', () => {
    const text = bundle()
    for (const key of ['label', 'merchant', 'pickupName', 'pickupStreet', 'pickupCity', 'pickupCode'] as const) {
      expect(text, `leaked ${key}`).not.toContain(SECRETS[key])
    }
  })

  test('not a message subject or sender', () => {
    const text = bundle()
    expect(text).not.toContain(SECRETS.subject)
    expect(text).not.toContain(SECRETS.sender)
  })

  test('not the default postcode', () => {
    expect(bundle()).not.toContain(SECRETS.defaultPostcode)
  })

  test('not the body of a stored .eml', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'mail', '1.eml'), SECRETS.emlBody)
    expect(buildSupportBundle(deps({ dataDir: dir }))).not.toContain('your parcel is waiting')
  })

  /**
   * The test that keeps the other tests in this block honest. Every one of them would also pass if the
   * generator read the wrong field and the final redaction pass hid the mistake - which is the one
   * thing that pass is explicitly NOT there for. So: a database and a config with every sensitive
   * field set, but with the three free-text fields that may legitimately quote one blanked, and no log
   * tails at all. A placeholder anywhere in the result now means a field is leaking.
   */
  test('the allow-list, not the final pass, is what keeps the secrets out', () => {
    const text = buildSupportBundle(deps({ db: cleanDb(), dataDir: dataDir() }))
    expect(text, 'a field the bundle reads leaked a mail address').not.toContain(REDACTED_EMAIL)
    expect(text, 'a field the bundle reads leaked a tracking number').not.toContain(REDACTED_NUMBER)
  })
})

describe('the final redaction pass over the assembled text', () => {
  /**
   * Exact equality, not merely "the number is gone": a shape that matches only the first fifteen
   * characters of a sixteen-digit number removes the number and leaves a digit of it behind, which
   * reads as a pass and is not one. The whole token goes, and nothing around it moves.
   */
  test('every carrier number shape is replaced, whole and in one piece', () => {
    for (const [carrier, number] of Object.entries(NUMBERS)) {
      expect(redactSensitive(`error: lookup failed for ${number} at 18:06`), `${carrier} (${number})`)
        .toBe(`error: lookup failed for ${REDACTED_NUMBER} at 18:06`)
    }
  })

  test('a bare number longer than any carrier writes is still taken whole', () => {
    expect(redactSensitive('ref 12345678901234567890 done')).toBe(`ref ${REDACTED_NUMBER} done`)
  })

  test('an email address is replaced, domain and all', () => {
    const out = redactSensitive('auth failed for friend.surname@gmail.com (535)')
    expect(out).not.toContain('friend.surname')
    expect(out).not.toContain('gmail.com')
    expect(out).toContain('(535)')
  })

  test('an email whose local part is itself number-shaped loses the domain too', () => {
    expect(redactSensitive('1930144672@example.org')).not.toContain('example.org')
  })

  test('short numbers, ports, timestamps and versions survive, or the bundle is useless', () => {
    const out = redactSensitive('2026-10-27T18:06:03.466Z imap.gmail.com:993 took 1234ms, v24.21.0, exit 0')
    expect(out).toContain('2026-10-27T18:06:03.466Z')
    expect(out).toContain('imap.gmail.com:993')
    expect(out).toContain('1234ms')
    expect(out).toContain('v24.21.0')
  })

  test('a tracking number in a poll.log tail is redacted, which is the whole point', () => {
    const dir = dataDir({
      'poll.log': `2026-10-27T18:06:03.466Z polled 2 parcel(s), 1 carrier failure(s) (gls: transport for ${NUMBERS.gls})\n`,
    })
    const text = buildSupportBundle(deps({ dataDir: dir }))
    expect(text).not.toContain(NUMBERS.gls)
    expect(text).toContain('carrier failure(s)')
  })

  test('a tracking number inside a stack trace in poll.err.log is redacted too', () => {
    const dir = dataDir({
      'poll.err.log': `Error: GLS said no for ${NUMBERS.posta}\n    at fetchOne (/app/dist/carriers/gls.js:120:11)\n`,
    })
    const text = buildSupportBundle(deps({ dataDir: dir }))
    expect(text).not.toContain(NUMBERS.posta)
    expect(text).toContain('at fetchOne')
  })

  test('an email address in a log tail is redacted', () => {
    const dir = dataDir({ 'poll.log': `mail ingest failed for ${SECRETS.email}\n` })
    expect(buildSupportBundle(deps({ dataDir: dir }))).not.toContain(SECRETS.email)
  })
})

describe('the support bundle is a size somebody can paste', () => {
  test('a log longer than the tail budget is cut, and the bundle says it was cut', () => {
    const dir = dataDir({ 'poll.log': `${'y'.repeat(LOG_TAIL_BYTES * 3)}\n` })
    const text = buildSupportBundle(deps({ dataDir: dir }))
    expect(text).toMatch(/truncated/i)
    expect(text.length).toBeLessThan(LOG_TAIL_BYTES * 3)
  })

  test('the tail kept is the END of the log: the newest lines are the ones that matter', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n')
    const dir = dataDir({ 'poll.log': `${lines}\n` })
    const text = buildSupportBundle(deps({ dataDir: dir }))
    expect(text).toContain('line 399')
    expect(text).not.toContain('line 0 ')
  })

  test('a log that is not there is stated as absent, not skipped silently', () => {
    const text = buildSupportBundle(deps({ dataDir: dataDir() }))
    expect(text).toContain('data/poll.log (not present)')
    expect(text).toContain('data/poll.err.log (not present)')
  })

  // The normal state of poll.err.log on a working machine, and a different answer from "not there":
  // one means the poller has never run, the other that it has never complained.
  test('a log that is there and empty is stated as empty', () => {
    const text = buildSupportBundle(deps({ dataDir: dataDir({ 'poll.err.log': '' }) }) )
    expect(text).toContain('data/poll.err.log (empty)')
  })

  test('the whole bundle is capped, and says so when the cap bit', () => {
    const dir = dataDir({ 'poll.log': `${'y'.repeat(50_000)}\n`, 'poll.err.log': `${'y'.repeat(50_000)}\n` })
    const text = buildSupportBundle(deps({ dataDir: dir, limits: { maxBytes: 3_000, logTailBytes: 20_000 } }))
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3_000)
    expect(text).toMatch(/cut to fit/i)
  })

  test('a real bundle stays well inside the cap', () => {
    expect(Buffer.byteLength(bundle())).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES)
  })
})

describe('the download filename', () => {
  test('names the app and the day', () => {
    expect(supportBundleFilename(new Date('2026-10-28T23:30:00Z'))).toBe('parcels-support-2026-10-29.txt')
  })
})

describe('launchdAgents reads launchctl list', () => {
  const LIST = 'PID\tStatus\tLabel\n55787\t0\tlocal.parcels.web\n-\t78\tlocal.parcels.poller\n-\t0\tcom.apple.other\n'

  test('a running agent, a loaded-but-idle one, and its last exit', () => {
    const r = launchdAgents(SUPPORT_AGENTS, () => LIST)
    expect(r.error).toBeUndefined()
    expect(r.agents).toEqual([
      { label: 'local.parcels.poller', loaded: true, lastExit: 78 },
      { label: 'local.parcels.web', loaded: true, pid: 55787, lastExit: 0 },
    ])
  })

  test('a label launchctl does not list is not loaded', () => {
    const r = launchdAgents(['local.parcels.nope'], () => LIST)
    expect(r.agents).toEqual([{ label: 'local.parcels.nope', loaded: false }])
  })

  test('launchctl that cannot be run is an error, never an exception', () => {
    const r = launchdAgents(SUPPORT_AGENTS, () => { throw new Error('ENOENT launchctl') })
    expect(r.agents).toEqual([])
    expect(r.error).toContain('ENOENT launchctl')
  })
})

describe('the Support section on /health and the download route', () => {
  const support: WebDeps['support'] = { env: ENV, launchd: AGENTS }
  const server = (db: Database, dir: string, extra: Partial<WebDeps> = {}) => buildServer({
    db, config, now: () => NOW, version: '0.1.0 (0db9a83)', notifier: { send: async () => {} },
    support: { ...support, dataDir: dir }, ...extra,
  })

  test('GET /health offers the button, and does not render a bundle until it is pressed', async () => {
    const res = await server(loadedDb(), dataDir()).inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Support')
    expect(res.body).toContain('action="/support#support"')
    expect(res.body).not.toContain('id="support-bundle"')
  })

  test('POST /support renders the bundle in a selectable block on the Health page', async () => {
    const res = await server(loadedDb(), dataDir()).inject({ method: 'POST', url: '/support' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('id="support-bundle"')
    expect(res.body).toContain('0.1.0 (0db9a83)')
    expect(res.body).toContain('href="/support.txt"')
  })

  test('the page block and the download are the same bytes from the same generator', async () => {
    const db = loadedDb()
    const dir = dataDir({ 'poll.log': 'something happened\n' })
    const page = await server(db, dir).inject({ method: 'POST', url: '/support' })
    const file = await server(db, dir).inject({ method: 'GET', url: '/support.txt' })
    const expected = buildSupportBundle({
      db, config, version: '0.1.0 (0db9a83)', now: NOW, env: ENV, launchd: AGENTS, dataDir: dir,
    })
    expect(file.body).toBe(expected)
    expect(page.body).toContain(escapeHtml(expected))
  })

  test('the download is a plain-text attachment with the day in its name', async () => {
    const res = await server(loadedDb(), dataDir()).inject({ method: 'GET', url: '/support.txt' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${supportBundleFilename(NOW)}"`)
  })

  test('neither response adds a script, and the CSP is the one every page sends', async () => {
    const CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
    const db = loadedDb()
    const dir = dataDir()
    for (const res of [
      await server(db, dir).inject({ method: 'GET', url: '/health' }),
      await server(db, dir).inject({ method: 'POST', url: '/support' }),
      await server(db, dir).inject({ method: 'GET', url: '/support.txt' }),
    ]) {
      expect(res.headers['content-security-policy']).toBe(CSP)
      expect(res.body).not.toMatch(/<script|onclick=|javascript:/i)
    }
  })

  test('the served bundle carries no secret either, end to end', async () => {
    const dir = dataDir({ 'poll.log': `failed for ${NUMBERS.packeta} and ${SECRETS.email}\n` })
    const res = await server(loadedDb(), dir).inject({ method: 'GET', url: '/support.txt' })
    for (const secret of [...Object.values(SECRETS), ...Object.values(NUMBERS)]) {
      expect(res.body, `leaked ${secret}`).not.toContain(secret)
    }
  })
})

describe('redaction keeps pace with the carriers', () => {
  /**
   * The redaction pass restates every carrier's number shape. That knowledge lives in the adapters,
   * so the two can drift - and the drift is silent and one-directional: a widened shape stops being
   * redacted and the bundle starts carrying real numbers. GLS widened from 11 digits to 10-12 during
   * this project, so this is a thing that happens rather than a thing that might.
   *
   * Every registered carrier is asked for a number it claims, and the redactor must hide it.
   */
  const SAMPLES: Record<string, string[]> = {
    posta: ['RA123456785SK'],
    packeta: ['Z1234567890'],
    gls: ['1234567890', '123456789012'],          // the 10 and the 12, both ends of the range
    sps: ['70312345678901', 'SKABCDE12ABCDEFGHJ'],
    dpd: ['01234567890123', '01234567890123X'],
    dhl: ['JJD0099999999', 'JVGL9999999999', '3SBCC000123456', '0001234567890123'],
  }

  test('every shape a registered carrier claims is redacted out of a bundle', async () => {
    const { allAdapters } = await import('../src/carriers/registry.js')
    const ids = allAdapters().map(a => a.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const samples = SAMPLES[id]
      // A carrier added without a sample here is the drift this test exists to catch.
      expect(samples, `no redaction sample for carrier "${id}"`).toBeDefined()
      for (const n of samples!) {
        expect(allAdapters().some(a => a.matches(n)), `${id} should claim ${n}`).toBe(true)
        expect(redactSensitive(`carrier said: ${n} failed`)).not.toContain(n)
      }
    }
  })

  test('a number embedded in a log line is redacted, not just a bare one', () => {
    const line = '2026-10-27T18:06:00Z polled 3 parcel(s), 2 carrier failure(s) (gls: transport for 1930144672)'
    expect(redactSensitive(line)).not.toContain('1930144672')
    expect(redactSensitive(line)).toContain(REDACTED_NUMBER)
  })
})
