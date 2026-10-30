import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildServer, CSP, type WebDeps } from '../src/web/server.js'
import type { Database } from '../src/db/index.js'
import type { ImapProbeLike } from '../src/ingest/imap-probe.js'
import type { ImapConfig } from '../src/ingest/imap.js'
import { fakeImap, type FakeImap } from './imap-fake.js'
import { config, memDb, NOW } from './poll-helpers.js'
import { settingsValues, applySettings } from '../src/web/settings.js'
import { listActivity } from '../src/db/activity-log.js'

const PASS = 'abcdefghijklmnop'

const IMAP = { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: PASS, mailbox: 'parcels' }

function configFile(over: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'parcels-web-cfg-')), 'config.json')
  writeFileSync(path, JSON.stringify({
    defaultPostalCode: '81101', dbPath: 'data/parcels.db', port: 8787, notifier: 'auto', mapPreview: true, imap: IMAP,
    ...over,
  }, null, 2) + '\n', { mode: 0o600 })
  return path
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const imapOf = (path: string) => read(path).imap as Record<string, unknown>

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

const fields = (over: Record<string, string> = {}) => ({
  defaultPostalCode: '81101', notifier: 'auto', mapPreview: 'true',
  imapHost: 'imap.gmail.com', imapPort: '993', imapUser: 'you@gmail.com', imapMailbox: 'parcels', imapPass: '',
  ...over,
})

/** A server bound to a throwaway config file and a fake mailbox: no network, and the real config.json is never touched. */
function harness(over: Record<string, unknown> = {}, mail?: FakeImap, extra: Partial<WebDeps> = {}) {
  const db: Database = memDb()
  const path = configFile(over)
  const fake = mail ?? fakeImap([])
  const seen: ImapConfig[] = []
  const app = buildServer({
    db, config, configPath: path, now: () => NOW, notifier: { send: async () => {} },
    imapClient: (c: ImapConfig): ImapProbeLike => { seen.push(c); return fake.client },
    ...extra,
  })
  return {
    db, path, mail: fake, seen,
    get: (url: string) => app.inject({ method: 'GET', url }),
    post: (url: string, f: Record<string, string> = {}) => app.inject({ method: 'POST', url, ...form(f) }),
  }
}

describe('GET /settings', () => {
  test('renders the values that are in the config file right now', async () => {
    const h = harness({ defaultPostalCode: '81101', notifier: 'osascript', mapPreview: false })
    const res = await h.get('/settings')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('value="81101"')
    expect(res.body).toContain('value="imap.gmail.com"')
    expect(res.body).toContain('value="you@gmail.com"')
    expect(res.body).toContain('value="parcels"')
    expect(res.body).toContain('value="993"')
    // the chosen option of each closed set is the selected one
    expect(res.body).toMatch(/<option value="osascript" selected/)
    expect(res.body).toMatch(/<option value="false" selected/)
  })

  test('the stored password is never in the HTML; the page says only whether one is set', async () => {
    const withPass = await harness().get('/settings')
    expect(withPass.body).not.toContain(PASS)
    expect(withPass.body).toMatch(/\bset\b/i)
    expect(withPass.body).not.toMatch(/not set/i)
    const without = await harness({ imap: { ...IMAP, pass: undefined } }).get('/settings')
    expect(without.body).toMatch(/not set/i)
    expect(without.body).not.toContain(PASS)
  })

  test('port and the database path are shown as read-only, with the reason', async () => {
    const res = await harness().get('/settings')
    expect(res.body).not.toMatch(/name="port"/)
    expect(res.body).not.toMatch(/name="dbPath"/)
    expect(res.body).toMatch(/restart/i)
  })

  test('says that the poller picks a change up on its next run', async () => {
    expect((await harness().get('/settings')).body).toMatch(/next (hourly )?poll|next run/i)
  })

  test('the page is still a zero-JavaScript page', async () => {
    const res = await harness().get('/settings')
    expect(res.body).not.toContain('<script')
    expect(res.body).not.toMatch(/\son[a-z]+=/)
    expect(res.headers['content-security-policy']).toBe(
      CSP)
  })

  test('the nav links to it from every page', async () => {
    const h = harness()
    for (const url of ['/', '/health', '/settings']) {
      expect((await h.get(url)).body).toContain('href="/settings"')
    }
  })
})

describe('the settings page speaks to the person setting up Gmail', () => {
  test('a click-by-click guide, open until mail is set up, naming every button as Gmail names it', async () => {
    const fresh = (await harness({ imap: undefined }).get('/settings')).body
    expect(fresh).toContain('<details class="guide" open>')
    const guide = /<details class="guide"[\s\S]*?<\/details>/.exec(fresh)![0]
    // In the order they are clicked.
    const order = ['/gmail-filter.xml', 'Import filters', 'Choose File', 'Open file', 'Apply new filters to existing email',
      'Create filters', 'Show in IMAP', 'App passwords', '<strong>Create</strong>', 'Save settings']
    const at = order.map(w => guide.indexOf(w))
    expect(at.every(i => i > -1), JSON.stringify(at)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    // Straight to the pages, not to "find Settings, then the tab".
    expect(guide).toContain('href="https://mail.google.com/mail/u/0/#settings/filters"')
    expect(guide).toContain('href="https://mail.google.com/mail/u/0/#settings/labels"')
    expect(guide).toContain('href="https://myaccount.google.com/apppasswords"')
    // It sits before the fields it ends by sending you to, and folds away once mail is saved.
    expect(fresh.indexOf('<details class="guide"')).toBeLessThan(fresh.indexOf('name="imapUser"'))
    const done = (await harness().get('/settings')).body
    expect(done).toContain('<details class="guide"><summary>')
  })

  test('the filter it tells you to import is a download from this server, the very file in the checkout', async () => {
    const res = await harness().get('/gmail-filter.xml')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/xml')
    expect(res.headers['content-disposition']).toBe('attachment; filename="gmail-filter.xml"')
    expect(res.body).toBe(readFileSync(join(import.meta.dirname, '..', 'gmail-filter.xml'), 'utf8'))
  })

  test('the account field is a Gmail address that a password manager understands', async () => {
    const body = (await harness().get('/settings')).body
    expect(body).toContain('Gmail address<input type="email" name="imapUser"')
    expect(body).toMatch(/<input type="email" name="imapUser"[^>]*autocomplete="username"/)
    expect(body).toMatch(/<input type="email" name="imapUser"[^>]*placeholder="you@gmail.com"/)
    expect(body).toContain('Gmail label<input name="imapMailbox"')
  })

  test('the App Password box asks for a NEW password, so Safari does not offer the Google one', async () => {
    const body = (await harness().get('/settings')).body
    expect(body).toMatch(/<input type="password" name="imapPass"[^>]*autocomplete="new-password"/)
    expect(body).not.toMatch(/name="imapPass"[^>]*autocomplete="off"/)
  })

  test('Save is the one primary action, and it comes after the fields', async () => {
    const body = (await harness().get('/settings')).body
    expect(body.match(/class="pri"/g)).toHaveLength(1)
    const save = body.indexOf('<button class="pri">Save settings</button>')
    expect(save).toBeGreaterThan(body.indexOf('name="imapPass"'))
    expect(save).toBeGreaterThan(body.indexOf('name="defaultPostalCode"'))
    // The connection test is still there, as a secondary button after Save.
    const test = body.indexOf('<form method="post" action="/settings/test#test"><button>')
    expect(test).toBeGreaterThan(save)
  })

  test('the technical parts are under a collapsed Advanced, and nothing outside it is jargon', async () => {
    const h = harness()
    const body = (await h.get('/settings?saved=1')).body
    const start = body.indexOf('<details class="adv"><summary>Advanced</summary>')
    expect(start).toBeGreaterThan(-1)
    const advanced = body.slice(start, body.indexOf('</details>', start))
    expect(advanced).toContain('name="notifier"')
    expect(advanced).toContain('<table class="stats">')
    const outside = body.replace(advanced, '')
    for (const jargon of [/config\.json/, /launchctl/, /separate process/, /\bpoller\b/i, /terminal-notifier/, /osascript/, h.path]) {
      expect(outside).not.toMatch(jargon)
    }
  })
})

describe('saving runs the connection test', () => {
  test('a save that changed the mail settings is tested at once, and the answer is on the page it lands on', async () => {
    const h = harness({}, fakeImap([], { exists: 7 }))
    const res = await h.post('/settings', fields({ imapMailbox: 'zasielky' }))
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toMatch(/^\/settings\?saved=1&test=\d+$/)
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]!.mailbox).toBe('zasielky')
    const page = (await h.get(String(res.headers.location))).body
    expect(page).toMatch(/Saved\./)
    expect(page).toMatch(/Connected/)
    expect(page).toContain('zasielky')
    expect(page).not.toContain(PASS)
    // Reading the page again dials nothing: the answer was found by the save.
    await h.get(String(res.headers.location))
    expect(h.seen).toHaveLength(1)
    // ...and the button now offers to test again.
    expect(page).toContain('<button>Test again</button>')
  })

  test('a save that touched no mail setting does not dial the mail server', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ defaultPostalCode: '04001' }))
    expect(res.headers.location).toBe('/settings?saved=1')
    expect(h.seen).toEqual([])
  })

  test('a failing test after a save is shown too, with what to do', async () => {
    const err = Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true })
    const h = harness({}, fakeImap([], { connectError: err }))
    const res = await h.post('/settings', fields({ imapPass: 'zyxwvutsrqponmlk' }))
    const page = (await h.get(String(res.headers.location))).body
    expect(page).toMatch(/Authentication failed/)
    expect(page).toContain('https://myaccount.google.com/apppasswords')
  })

  test('a stale or forged test id shows no result', async () => {
    const body = (await harness().get('/settings?saved=1&test=999')).body
    expect(body).not.toMatch(/Connected|Authentication failed/)
  })
})

describe('POST /settings', () => {
  test('saves, redirects, and the page then shows what is on disk rather than what the process started with', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ defaultPostalCode: '81101', notifier: 'terminal-notifier' }))
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/settings?saved=1')
    expect(read(h.path)).toMatchObject({ defaultPostalCode: '81101', notifier: 'terminal-notifier' })
    const after = await h.get('/settings?saved=1')
    expect(after.body).toContain('value="81101"')
    expect(after.body).toMatch(/saved/i)
  })

  test('a change made to the file by anything else also shows up, without a restart', async () => {
    const h = harness()
    writeFileSync(h.path, JSON.stringify({ ...read(h.path), defaultPostalCode: '04001' }, null, 2))
    expect((await h.get('/settings')).body).toContain('value="04001"')
  })

  test('an empty password box leaves the stored password alone', async () => {
    const h = harness()
    await h.post('/settings', fields({ imapMailbox: 'parcely', imapPass: '' }))
    expect(imapOf(h.path)).toMatchObject({ mailbox: 'parcely', pass: PASS })
  })

  test('changing the server, port or account with a blank password is refused: the stored password stays with its own server', async () => {
    // Anything that can reach 127.0.0.1 could otherwise point the stored App Password at its own TLS
    // server and press "test". The stored password only ever goes back to where it was saved for.
    for (const over of [
      { imapHost: 'imap.attacker.example' },
      { imapPort: '1993' },
      { imapUser: 'someone-else@gmail.com' },
    ] as Array<Record<string, string>>) {
      const h = harness()
      const before = readFileSync(h.path, 'utf8')
      const res = await h.post('/settings', fields({ ...over, imapPass: '' }))
      expect(res.statusCode, JSON.stringify(over)).toBe(400)
      expect(res.body).toMatch(/re-enter the App Password when changing the server or account/i)
      expect(readFileSync(h.path, 'utf8')).toBe(before)
      // ...and nothing was dialled with it either.
      await h.post('/settings/test')
      expect(h.seen.every(c => c.host === 'imap.gmail.com' && c.port === 993 && c.user === 'you@gmail.com')).toBe(true)
    }
  })

  test('changing the server or account WITH a new password is allowed', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ imapHost: 'imap.fastmail.com', imapPass: 'zyxwvutsrqponmlk' }))
    expect(res.statusCode).toBe(303)
    expect(imapOf(h.path)).toMatchObject({ host: 'imap.fastmail.com', pass: 'zyxwvutsrqponmlk' })
  })

  test('a host that differs only by case or surrounding space is the same server', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ imapHost: ' IMAP.gmail.com ', imapPass: '' }))
    expect(res.statusCode).toBe(303)
    expect(imapOf(h.path).pass).toBe(PASS)
  })

  test('a password in the box replaces the stored one', async () => {
    const h = harness()
    await h.post('/settings', fields({ imapPass: 'zyxw vuts rqpo nmlk' }))
    expect(imapOf(h.path).pass).toBe('zyxwvutsrqponmlk')
  })

  test('the file keeps mode 600 and its unknown keys', async () => {
    const h = harness({ somethingElse: { kept: true } })
    await h.post('/settings', fields({ defaultPostalCode: '81101' }))
    expect(statSync(h.path).mode & 0o777).toBe(0o600)
    expect(read(h.path).somethingElse).toEqual({ kept: true })
  })

  test('invalid input is refused with a message, and the file is not written at all', async () => {
    for (const [over, pattern] of [
      [{ defaultPostalCode: 'nowhere' }, /postcode/i],
      [{ notifier: 'carrier-pigeon' }, /notifier/i],
      [{ mapPreview: 'maybe' }, /map preview/i],
      [{ imapPort: 'ninety-three' }, /port/i],
    ] as Array<[Record<string, string>, RegExp]>) {
      const h = harness()
      const before = readFileSync(h.path, 'utf8')
      const res = await h.post('/settings', fields(over))
      expect(res.statusCode, JSON.stringify(over)).toBe(400)
      expect(res.body).toMatch(pattern)
      expect(readFileSync(h.path, 'utf8')).toBe(before)
    }
  })

  test('a rejected form comes back filled in as it was typed, still without the password', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ defaultPostalCode: 'nowhere', imapUser: 'typed@gmail.com', imapPass: PASS }))
    expect(res.body).toContain('value="nowhere"')
    expect(res.body).toContain('value="typed@gmail.com"')
    expect(res.body).not.toContain(PASS)
  })

  test('a crafted POST cannot change the port or the database path', async () => {
    const h = harness()
    const res = await h.post('/settings', fields({ port: '9999', dbPath: '/tmp/evil.db' }))
    expect(res.statusCode).toBe(303)
    expect(read(h.path)).toMatchObject({ port: 8787, dbPath: 'data/parcels.db' })
  })

  test('a saved postcode is used by the rest of the running server, not only by the page', async () => {
    const h = harness()
    await h.post('/settings', fields({ defaultPostalCode: '04001' }))
    const added = await h.post('/add', { number: 'RA123456785SK', carrier: 'posta' })
    expect(added.statusCode).toBe(303)
    const parcel = await h.get(String(added.headers.location))
    expect(parcel.body).toContain('04001')
  })
})

describe('POST /settings/test', () => {
  const resultOf = async (mail: FakeImap, over: Record<string, unknown> = {}) => {
    const h = harness(over, mail)
    const res = await h.post('/settings/test')
    return { res, h }
  }

  test('connected, authenticated, label found: the account and the message count', async () => {
    const { res } = await resultOf(fakeImap([], { exists: 79 }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('you@gmail.com')
    expect(res.body).toContain('79')
    expect(res.body).toContain('parcels')
  })

  test('the answer is under its own heading, where the form posts to (#test), not at the top of the page', async () => {
    const { res } = await resultOf(fakeImap([], { exists: 79 }))
    const heading = res.body.indexOf('<h2 id="test">Test the Gmail connection</h2>')
    expect(heading).toBeGreaterThan(-1)
    expect(res.body.indexOf('<div class="notice')).toBeGreaterThan(heading)
  })

  test('an empty label is its own answer: the filter may simply not be matching yet', async () => {
    const { res } = await resultOf(fakeImap([]))
    expect(res.body).toMatch(/empty/i)
    expect(res.body).toMatch(/filter/i)
    expect(res.body).not.toContain('notice warn')   // an empty label is an answer, not a fault
  })

  test('authentication failure points at the App Password page', async () => {
    const err = Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true })
    const { res } = await resultOf(fakeImap([], { connectError: err }))
    expect(res.body).toMatch(/app password/i)
    expect(res.body).toContain('https://myaccount.google.com/apppasswords')
  })

  test('a missing mailbox names it and gives the Gmail step that causes it', async () => {
    const err = Object.assign(new Error('Unknown Mailbox'), { mailboxMissing: true })
    const { res } = await resultOf(fakeImap([], { lockError: err }))
    expect(res.body).toMatch(/Show in IMAP/)
    expect(res.body).toMatch(/Labels/)
    expect(res.body).toContain('parcels')
  })

  test('a connection failure shows the host and the port', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' })
    const { res } = await resultOf(fakeImap([], { connectError: err }))
    expect(res.body).toContain('imap.gmail.com')
    expect(res.body).toContain('993')
  })

  test('no imap block at all says so plainly and is not dressed up as an error', async () => {
    const h = harness({ imap: undefined })
    const res = await h.post('/settings/test')
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/no mail account/i)
    expect(h.seen).toEqual([])
  })

  test('a failure that is none of the four is reported as itself, not guessed at', async () => {
    const { res } = await resultOf(fakeImap([], { lockError: new Error('server said something odd') }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/refused the request/i)
    expect(res.body).toContain('something odd')
  })

  test('a config file that no longer loads is explained rather than tested or 500ed', async () => {
    const h = harness({ imap: { host: 'imap.gmail.com', port: '993', user: 'you@gmail.com', pass: PASS, mailbox: 'parcels' } })
    const res = await h.post('/settings/test')
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/cannot be loaded/i)
    expect(res.body).toMatch(/imap\.port/)
    expect(res.body).not.toContain(PASS)
    expect(h.seen).toEqual([])                      // nothing was dialled
    expect((await h.get('/settings')).statusCode).toBe(200)
  })

  test('the test never writes to the mailbox', async () => {
    const mail = fakeImap([{ uid: 1, messageId: '<a@x>' }], { exists: 12 })
    const { h } = await resultOf(mail)
    expect(mail.forbidden).toEqual([])
    expect(mail.locks.every(l => l.readOnly && l.released)).toBe(true)
    expect(mail.downloaded).toEqual([])
    expect(h.mail.calls.filter(c => /flag|store|move|delete|copy|append|expunge|search|create|rename/i.test(c))).toEqual([])
  })

  test('it connects with the settings that are saved, including ones saved a moment ago', async () => {
    const h = harness({}, fakeImap([]))
    await h.post('/settings', fields({ imapMailbox: 'zasielky', imapUser: 'other@gmail.com', imapPass: 'zyxwvutsrqponmlk' }))
    await h.post('/settings/test')
    const saved = { ...IMAP, user: 'other@gmail.com', mailbox: 'zasielky', pass: 'zyxwvutsrqponmlk' }
    expect(h.seen).toEqual([saved, saved])          // once by the save itself, once by Test again
  })

  test('the password is in no outcome of the test, not even the one the server echoes back', async () => {
    const leaky = Object.assign(new Error(`LOGIN "you@gmail.com" "${PASS}"`), {
      authenticationFailed: true, responseText: `rejected ${PASS}`,
    })
    for (const mail of [
      fakeImap([], { connectError: leaky }),
      fakeImap([], { lockError: leaky }),
      fakeImap([], { exists: 3 }),
    ]) {
      const { res } = await resultOf(mail)
      expect(res.body).not.toContain(PASS)
    }
  })

  test('the result is a POST-rendered page, so the password cannot reach a URL or a redirect', async () => {
    const { res } = await resultOf(fakeImap([], { exists: 1 }))
    expect(res.statusCode).toBe(200)
    expect(res.headers.location).toBeUndefined()
    const bad = await harness().get('/settings/test')
    expect(bad.statusCode).toBe(404)
  })
})

describe('a first-time mail setup asks for two things, not five', () => {
  test('with no mail block the form arrives filled in for Gmail', () => {
    // Setup writes no imap block on purpose, so this is what the friend's first visit shows. Knowing
    // imap.gmail.com and 993 is not something an installer should have to look up.
    const v = settingsValues({ defaultPostalCode: '81101' })
    expect(v.imapHost).toBe('imap.gmail.com')
    expect(v.imapPort).toBe('993')
    expect(v.imapMailbox).toBe('parcels')   // the label gmail-filter.xml applies
    expect(v.imapUser).toBe('')             // the two the reader must supply
    expect(v.passSet).toBe(false)
    expect(v.imapConfigured).toBe(false)    // defaults shown is not the same as mail set up
  })

  test('a saved account is shown as saved, never overwritten by the defaults', () => {
    const v = settingsValues({
      defaultPostalCode: '81101',
      imap: { host: 'imap.fastmail.com', port: 993, user: 'a@b.c', pass: 'x', mailbox: 'Parcels/In' },
    })
    expect(v.imapHost).toBe('imap.fastmail.com')
    expect(v.imapMailbox).toBe('Parcels/In')
    expect(v.imapConfigured).toBe(true)
  })

  test('the defaults alone are not enough to save: the account is still required', () => {
    const r = applySettings({ defaultPostalCode: '81101' }, {
      defaultPostalCode: '81101', notifier: 'auto', mapPreview: 'true',
      imapHost: 'imap.gmail.com', imapPort: '993', imapMailbox: 'parcels', imapUser: '', imapPass: '',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/account to log in as/)
  })

  test('typing only the account and the password is enough', () => {
    const r = applySettings({ defaultPostalCode: '81101' }, {
      defaultPostalCode: '81101', notifier: 'auto', mapPreview: 'true',
      imapHost: 'imap.gmail.com', imapPort: '993', imapMailbox: 'parcels',
      imapUser: 'friend@gmail.com', imapPass: 'abcd efgh ijkl mnop',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.imap).toEqual({
      host: 'imap.gmail.com', port: 993, user: 'friend@gmail.com', pass: 'abcdefghijklmnop', mailbox: 'parcels',
    })
  })
})

describe('Settings chooses the theme and the mode', () => {
  const appExtra = (): Partial<WebDeps> => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-web-app-'))
    return { app: { supportDir: dir, logDir: dir, appBundle: dir, version: '0.3.0', startedAt: NOW, restarts: () => 0 } }
  }
  const modes: Array<[string, Partial<WebDeps>]> = [['git', {}], ['app', appExtra()]]
  const appearanceOf = (path: string) => read(path).appearance
  const logged = (db: Database) => listActivity(db, 10).filter(e => e.kind === 'settings_saved').map(e => e.detail ?? '')

  test.each(modes)('shows the Appearance block with the defaults when the file has none (%s mode)', async (_name, extra) => {
    const body = (await harness({}, undefined, extra).get('/settings')).body
    expect(body).toContain('<h2>Appearance</h2><div class="fields"><label>Theme<select name="theme">')
    expect(body).toContain('<option value="postal" selected>Postal</option>')
    expect(body).toContain('<option value="classic">Classic</option>')
    expect(body).toContain('</select></label><label>Mode<select name="mode">')
    expect(body).toContain('<option value="system" selected>Same as the Mac</option>')
    expect(body).toContain('<option value="light">Light</option>')
    expect(body).toContain('<option value="dark">Dark</option>')
    expect(body).toContain('<span class="meta hint">Light or dark, or follow the Mac.</span></label></div>')
  })

  test.each(modes)('shows the stored values selected (%s mode)', async (_name, extra) => {
    const body = (await harness({ appearance: { theme: 'classic', mode: 'dark' } }, undefined, extra).get('/settings')).body
    expect(body).toContain('<option value="classic" selected>Classic</option>')
    expect(body).toContain('<option value="dark" selected>Dark</option>')
    expect(body).not.toContain('<option value="postal" selected>')
    expect(body).not.toContain('<option value="system" selected>')
  })

  test.each(modes)('a save writes the choice, the next page wears it without a restart, and the log names the fields (%s mode)', async (_name, extra) => {
    const h = harness({}, undefined, extra)
    expect((await h.get('/')).body).toContain('data-theme="postal" data-mode="system"')
    const res = await h.post('/settings', fields({ theme: 'classic', mode: 'dark' }))
    expect(res.statusCode).toBe(303)
    expect(appearanceOf(h.path)).toEqual({ theme: 'classic', mode: 'dark' })
    expect((await h.get('/')).body).toContain('data-theme="classic" data-mode="dark"')
    expect((await h.get('/settings?saved=1')).body).toContain('<option value="classic" selected>Classic</option>')
    const [detail] = logged(h.db)
    expect(detail!.split(' ')).toEqual(expect.arrayContaining(['appearance.theme', 'appearance.mode']))
  })

  test('an unknown theme or mode is refused with the allowed names, and nothing is written', async () => {
    for (const [over, message] of [
      [{ theme: 'kraft' }, 'The theme must be one of Postal, Classic.'],
      [{ mode: 'auto' }, 'The mode must be one of Same as the Mac, Light, Dark.'],
    ] as Array<[Record<string, string>, string]>) {
      const h = harness()
      const before = readFileSync(h.path, 'utf8')
      const res = await h.post('/settings', fields({ theme: 'postal', mode: 'system', ...over }))
      expect(res.statusCode).toBe(400)
      expect(res.body).toContain(message)
      expect(readFileSync(h.path, 'utf8')).toBe(before)
      expect(logged(h.db)).toEqual([])
    }
  })

  test('a form without theme or mode (a stale tab) keeps what is stored and logs no appearance change', async () => {
    const h = harness({ appearance: { theme: 'classic', mode: 'light' } })
    const res = await h.post('/settings', fields({ defaultPostalCode: '04001' }))
    expect(res.statusCode).toBe(303)
    expect(appearanceOf(h.path)).toEqual({ theme: 'classic', mode: 'light' })
    expect(logged(h.db)[0]).toBe('defaultPostalCode')
  })

  test('a failed save re-renders the typed choice, and a stale form re-renders the stored one', async () => {
    const h = harness({ appearance: { theme: 'classic', mode: 'light' } })
    const typed = await h.post('/settings', fields({ defaultPostalCode: 'nope', theme: 'postal', mode: 'dark' }))
    expect(typed.statusCode).toBe(400)
    expect(typed.body).toContain('<option value="postal" selected>Postal</option>')
    expect(typed.body).toContain('<option value="dark" selected>Dark</option>')
    const stale = await h.post('/settings', fields({ defaultPostalCode: 'nope' }))
    expect(stale.body).toContain('<option value="classic" selected>Classic</option>')
    expect(stale.body).toContain('<option value="light" selected>Light</option>')
  })

  test('writing the defaults over an absent block changes nothing and logs nothing', async () => {
    const h = harness()
    expect((await h.post('/settings', fields({ theme: 'postal', mode: 'system' }))).statusCode).toBe(303)
    expect(logged(h.db)).toEqual([''])
  })

  test('only the mode changing logs only the mode', async () => {
    const h = harness({ appearance: { theme: 'classic', mode: 'light' } })
    await h.post('/settings', fields({ theme: 'classic', mode: 'dark' }))
    expect(logged(h.db)).toEqual(['appearance.mode'])
  })

  test('other keys inside a stored appearance object survive a save', async () => {
    const h = harness({ appearance: { theme: 'classic', mode: 'light', accent: 'teal' } })
    await h.post('/settings', fields({ theme: 'postal', mode: 'dark' }))
    expect(appearanceOf(h.path)).toEqual({ theme: 'postal', mode: 'dark', accent: 'teal' })
  })

  test('settingsValues reads the effective choice: the defaults when absent', () => {
    expect(settingsValues({ defaultPostalCode: '81101' })).toMatchObject({ theme: 'postal', mode: 'system' })
    expect(settingsValues({ defaultPostalCode: '81101', appearance: { theme: 'classic' } })).toMatchObject({ theme: 'classic', mode: 'system' })
  })
})
