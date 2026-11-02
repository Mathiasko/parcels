import { describe, expect, test } from 'vitest'
import { recordPoll } from '../src/core/sleepgap.js'
import type { Database } from '../src/db/index.js'
import { recordIngest } from '../src/db/ingest-status.js'
import { failRun, startRun } from '../src/db/poll-runs.js'
import { buildServer } from '../src/web/server.js'
import type { Config } from '../src/core/config.js'
import { config, memDb, NOW } from './poll-helpers.js'

const MIN = 60_000
const imap: Config['imap'] = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'pw', mailbox: 'parcels' }
const HEADLINE = '<p class="orn-empty" aria-hidden="true">Nothing<br>to collect</p>'

/** The page without its stylesheet, so a selector in the CSS can neither satisfy nor fail an assertion. */
async function dash(db: Database, opts: { mail?: Config['imap']; url?: string } = {}): Promise<string> {
  const mail = 'mail' in opts ? opts.mail : imap
  const app = buildServer({ db, config: { ...config, imap: mail }, now: () => NOW, notifier: { send: async () => {} } })
  const res = await app.inject({ method: 'GET', url: opts.url ?? '/' })
  return res.body.replace(/<style>[\s\S]*?<\/style>/g, '')
}

/** A normal moment: the poller finished three minutes ago and Gmail answered. */
const checkedJustNow = (): Database => {
  const db = memDb()
  recordPoll(db, NOW.getTime() - 3 * MIN)
  recordIngest(db, { ok: true }, new Date(NOW.getTime() - 3 * MIN))
  return db
}

const waitingMail = (db: Database): void => {
  db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note)
    VALUES ('<m@x>', ?, 'shop@example.com', 'Your pickup', '/tmp/m.eml', 0, 'no tracking number found in this message')
  `).run(new Date(NOW.getTime() - 60 * MIN).toISOString())
}

describe('the empty dashboard says "Nothing to collect" only when it has looked and nothing waits', () => {
  test('when all is well: the headline, and the stamp and the line give the time of the check', async () => {
    const body = await dash(checkedJustNow())
    expect(body).toContain(HEADLINE)
    expect(body).toContain('<p class="checked">Checked Mon 26 Oct, 10:57</p>')
    // 10:00 UTC less three minutes, in Bratislava (CET from 25 Oct), with October as X.
    const stamp = /<span class="orn-stamp" aria-hidden="true">[\s\S]*?<\/span>/.exec(body)?.[0] ?? ''
    expect(stamp).toContain('#postmark-ring-checked')
    expect(stamp).toContain('>26·X·26<')
    expect(stamp).toContain('>10:57<')
  })

  test('the plain sentence stays, for Classic and for a screen reader', async () => {
    expect(await dash(checkedJustNow())).toContain('<p class="empty">Nothing in flight. Parcels appear here when a shipping email arrives')
  })

  const refusals: Array<[string, (db: Database) => void, { mail?: Config['imap']; url?: string }?]> = [
    ['Gmail is not connected', () => {}, { mail: undefined }],
    ['an email waits on Attention', waitingMail],
    ['Gmail could not be read on the last run', db => recordIngest(db, { ok: false, error: 'offline' }, NOW)],
    ['the app has not checked for over two hours of the day', db => recordPoll(db, NOW.getTime() - 3 * 60 * MIN)],
  ]
  test.each(refusals)('not while %s', async (_name, spoil, opts) => {
    const db = checkedJustNow()
    spoil(db)
    const body = await dash(db, opts)
    expect(body).not.toContain('orn-empty')
    expect(body).not.toContain('orn-stamp')
    expect(body).not.toContain('class="checked"')
    expect(body).toContain('Nothing in flight.')
  })

  test('not on a new install, which has never checked', async () => {
    expect(await dash(memDb())).not.toContain('orn-empty')
  })

  test('not on the page of a refresh that did not finish', async () => {
    const db = checkedJustNow()
    const run = startRun(db, 'web', new Date(NOW.getTime() - 5 * MIN))
    failRun(db, run, 'the database was locked', new Date(NOW.getTime() - 4 * MIN))
    const body = await dash(db, { url: `/?run=${run}` })
    expect(body).toContain('The refresh did not finish.')
    expect(body).not.toContain('orn-empty')
  })

  test('it comes back once Gmail answers again', async () => {
    const db = checkedJustNow()
    recordIngest(db, { ok: false, error: 'offline' }, NOW)
    recordIngest(db, { ok: true }, NOW)
    expect(await dash(db)).toContain(HEADLINE)
  })
})

describe('when the all-clear is withheld, the empty dashboard says why', () => {
  const lede = (body: string) => /<p class="lede">([\s\S]*?)<\/p>/.exec(body)?.[1]?.replace(/<[^>]+>/g, '')

  test('it has not checked lately, with the time it last did', async () => {
    const db = memDb()
    recordPoll(db, NOW.getTime() - 3 * 60 * MIN)
    expect(lede(await dash(db))).toBe('Not checked since Mon 26 Oct, 08:00, so this may be out of date — see Health.')
  })

  test('Gmail could not be read', async () => {
    const db = checkedJustNow()
    recordIngest(db, { ok: false, error: 'offline' }, NOW)
    expect(lede(await dash(db))).toBe('Gmail could not be read, so this may be out of date — see Health.')
  })

  test('a stale Gmail failure says nothing once no mailbox is connected: the Gmail notice has it', async () => {
    const db = checkedJustNow()
    recordIngest(db, { ok: false, error: 'offline' }, NOW)
    const body = await dash(db, { mail: undefined })
    expect(lede(body)).toBeUndefined()
    expect(body).toContain('Gmail is not connected yet.')
  })

  test('both reasons at once are both said', async () => {
    const db = memDb()
    recordPoll(db, NOW.getTime() - 3 * 60 * MIN)
    recordIngest(db, { ok: false, error: 'offline' }, NOW)
    const said = lede(await dash(db))
    expect(said).toContain('Not checked since')
    expect(said).toContain('Gmail could not be read')
  })

  test('a normal day and a new install print no lede', async () => {
    expect(lede(await dash(checkedJustNow()))).toBeUndefined()
    expect(lede(await dash(memDb()))).toBeUndefined()
  })
})

describe('the header', () => {
  const headerOf = (body: string) => /<header>[\s\S]*?<\/header>/.exec(body)?.[0] ?? ''

  test('sits outside the page frame, so a theme can run it the full width of the window', async () => {
    const body = await dash(checkedJustNow())
    expect(body.indexOf('<header>')).toBeLessThan(body.indexOf('<div class="frame">'))
  })

  test('carries Refresh on the dashboard and on no other page', async () => {
    const db = checkedJustNow()
    expect(headerOf(await dash(db))).toContain('<form class="hd-refresh" method="post" action="/refresh">')
    expect(headerOf(await dash(db, { url: '/history' }))).not.toContain('action="/refresh"')
  })

  test('keeps Health\'s trouble dot in one span with its word, so the column-flex link keeps them on one line', async () => {
    const db = checkedJustNow()
    db.prepare(`INSERT INTO carrier_health (carrier, consecutive_failures, last_error_at, last_error_detail) VALUES ('packeta', 2, ?, 'x')`).run(NOW.toISOString())
    expect(headerOf(await dash(db))).toContain('<span class="lb">Health<span class="dot"></span><span class="vh"> carrier problem</span></span>')
  })
})
