// End-to-end harness for the fake parcel-mail corpus (test/fixtures/fake-mail/).
//
//   N=$HOME/.nvm/versions/node/v24.21.0/bin
//   $N/node node_modules/.bin/vitest run --config scripts/dev/fake-mail/vitest.config.ts
//
// One long "test" that: builds a throw-away config (from config.example.json) + database + mailDir in a
// mktemp dir; feeds the corpus through the REAL ingest + poll path (src/core/poll.ts runPoll) with an
// injected read-only IMAP fake, in date-ordered batches with a stepped clock; answers carrier polls from
// a canned world (world.ts) via fake adapters; blocks every network API so nothing can leak; then
// starts the real web server (fake calendar, fake notifier) on a random loopback port, saves the HTML
// of every page and screenshots them with headless Chrome (own profile dir, background networking off).
// Outputs land in test/fixtures/fake-mail/{out,html,shots}/. Env: KEEP=1 keeps the temp dir,
// SHOTS=0 skips Chrome.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { simpleParser } from 'mailparser'
import { openDb } from '../../../src/db/index.js'
import { claimRun } from '../../../src/db/poll-runs.js'
import { recordPollRun, runPoll, summarize } from '../../../src/core/poll.js'
import { recordPoll } from '../../../src/core/sleepgap.js'
import { allAdapters } from '../../../src/carriers/registry.js'
import { getParcel } from '../../../src/db/parcels.js'
import { getPickupCode } from '../../../src/db/pickup-codes.js'
import { listEvents } from '../../../src/db/events.js'
import { buildServer } from '../../../src/web/server.js'
import type { Carrier, CarrierAdapter, CarrierId, HttpClient } from '../../../src/core/types.js'
import type { Notification } from '../../../src/notify/types.js'
import { fakeImap, type FakeMessage } from '../../../test/imap-fake.js'
import { addPosta, answer, local } from './world.js'

const ROOT = resolve(__dirname, '../../..')
const FIX = join(ROOT, 'test/fixtures/fake-mail')
const OUT = join(FIX, 'out')
const HTML = join(FIX, 'html')
const SHOTS = join(FIX, 'shots')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// ------------------------------------------------------------------------------------------------
// Network guard: every way Node could reach the network throws (and is recorded). Loopback only.
// ------------------------------------------------------------------------------------------------
const leaks: string[] = []
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i
function guardNetwork(): () => void {
  const saved = {
    fetch: globalThis.fetch, connect: net.Socket.prototype.connect, lookup: dns.lookup,
    httpReq: http.request, httpGet: http.get, httpsReq: https.request, httpsGet: https.get, tls: tls.connect,
  }
  const deny = (what: string) => (...args: unknown[]): never => {
    leaks.push(`${what} ${JSON.stringify(args[0])?.slice(0, 200)}`)
    throw new Error(`fake-mail harness: network disabled (${what})`)
  }
  globalThis.fetch = deny('fetch') as typeof fetch
  http.request = deny('http.request') as typeof http.request
  http.get = deny('http.get') as typeof http.get
  https.request = deny('https.request') as typeof https.request
  https.get = deny('https.get') as typeof https.get
  ;(tls as { connect: unknown }).connect = deny('tls.connect')
  ;(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (LOOPBACK.test(host)) return (saved.lookup as (...a: unknown[]) => unknown)(host, ...rest)
    return deny('dns.lookup')(host)
  }
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const a = args[0] as { host?: string; path?: string } | number | string
    const host = typeof a === 'object' && a !== null ? (a.path ? 'localhost' : a.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost'
    if (!LOOPBACK.test(host)) return deny('net.connect')(a)
    return (saved.connect as (...x: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect
  return () => {
    globalThis.fetch = saved.fetch
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    http.request = saved.httpReq; http.get = saved.httpGet; https.request = saved.httpsReq; https.get = saved.httpsGet
    ;(tls as { connect: unknown }).connect = saved.tls
  }
}

/** The HttpClient handed to runPoll and the server: refuses, and records, every call. */
const deadHttp: HttpClient = async url => {
  leaks.push(`HttpClient ${url}`)
  throw new Error('fake-mail harness: HttpClient disabled')
}

// ------------------------------------------------------------------------------------------------
// Fake adapters: real `matches` (so /add and canonicalNumber behave), canned answers from world.ts.
// DHL stays the real email-only carrier (it has no fetch).
// ------------------------------------------------------------------------------------------------
let clock = new Date(0)
const pollCalls: Array<{ at: string; carrier: CarrierId; number: string; answer: string }> = []
function fakeAdapters(): Carrier[] {
  return allAdapters().map((real): Carrier => {
    if (!('fetch' in real)) return real
    const a: CarrierAdapter = {
      id: real.id, matches: real.matches, needsPostalCode: false, batchSize: real.batchSize,
      fetch: async inputs => inputs.map(i => {
        const r = answer(real.id, i.number, clock)
        pollCalls.push({ at: clock.toISOString(), carrier: real.id, number: i.number, answer: r.ok ? r.status : r.reason })
        return r
      }),
    }
    return a
  })
}

/** Europe/Bratislava wall clock for a Date, for logs. */
const bt = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Europe/Bratislava' }).slice(0, 16)

interface CorpusEntry {
  file: string; date: string; arrival: string; exercises: string; bytes: number
  expect: { parcel?: string; parcels?: string[]; archived?: boolean; ignored?: boolean; attention?: boolean; code?: string; note?: string; duplicateOf?: string }
}

test('fake-mail corpus end to end', async () => {
  const restore = guardNetwork()
  const tmp = mkdtempSync(join(tmpdir(), 'parcels-fakemail-'))
  for (const d of [OUT, HTML, SHOTS]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
  const log: string[] = []
  const say = (s: string) => { log.push(s); console.log(s) }
  let server: Awaited<ReturnType<typeof buildServer>> | undefined
  try {
    // ---- config: from config.example.json, never config.json ----
    const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'))
    const dataDir = join(tmp, 'data')
    mkdirSync(dataDir, { recursive: true })
    const cfgDoc = { ...example, dbPath: join(dataDir, 'parcels.db'), port: 0, pickupCalendar: '' }
    const configPath = join(tmp, 'config.json')
    writeFileSync(configPath, JSON.stringify(cfgDoc, null, 2))
    const config = { ...cfgDoc, notifier: 'auto' as const }
    const mailDir = join(dataDir, 'mail')
    const db = openDb(config.dbPath)

    // ---- corpus -> fake IMAP messages, UIDs ascending by arrival ----
    const corpus: CorpusEntry[] = JSON.parse(readFileSync(join(FIX, 'corpus.json'), 'utf8'))
    const ordered = [...corpus].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.file.localeCompare(b.file))
    const fake: Array<FakeMessage & { file: string; arrivalAt: Date }> = []
    for (const [i, c] of ordered.entries()) {
      const source = readFileSync(join(FIX, c.file))
      const p = await simpleParser(source)
      const arrivalAt = local(c.arrival)
      fake.push({
        uid: 1000 + i, file: c.file, arrivalAt, source,
        messageId: p.messageId, subject: p.subject ?? '', from: p.from?.value[0]?.address ?? '',
        date: p.date ?? arrivalAt, internalDate: new Date(arrivalAt.getTime() + 30_000),
      })
    }
    // posta numbers are computed by the generator; take them from the corpus expectations
    const posta = corpus.map(c => c.expect.parcel).filter((p): p is string => !!p && p.startsWith('posta:EB'))
    const eb = (suffix: string) => posta.find(p => p.includes(`666666${suffix}`))!.slice(6)
    addPosta(eb('01'), eb('02'))

    // ---- runs: setup day 2026-10-15 09:00 (backlog), then 4 slots a day ----
    const slots: Date[] = [local('2026-10-15 09:00')]
    for (let d = 15; d <= 30; d++) for (const h of ['13:00', '17:00', '21:00', ...(d > 15 ? ['09:00'] : [])].sort()) {
      const s = local(`2026-10-${d} ${h}`)
      if (s > slots[0]!) slots.push(s)
    }
    slots.sort((a, b) => a.getTime() - b.getTime())
    const adapters = fakeAdapters()
    const notifications: Array<Notification & { at: string }> = []
    const notifier = { send: async (n: Notification) => { notifications.push({ ...n, at: bt(clock) }) } }
    const imap = config.imap
    const reports: unknown[] = []
    for (const slot of slots) {
      clock = slot
      const visible = fake.filter(m => m.arrivalAt <= slot)
      const claim = claimRun(db, 'poller', slot)
      if (!claim.claimed) throw new Error('run not claimed')
      const report = await recordPollRun(db, claim.id, runPoll({
        db, http: deadHttp, adapters, config, now: slot, notifier,
        cause: { actor: 'poller', runId: claim.id, at: slot },
        ingest: { imap, mailDir, client: fakeImap(visible).client },
      }), () => slot)
      recordPoll(db, slot.getTime())
      reports.push({ at: bt(slot), ...report, newEvents: report.newEvents.length })
      const ing = report.ingest
      if (ing?.read || report.newEvents.length || report.failures.length || ing?.error) {
        say(`${bt(slot)}  ${summarize(report)}`)
      }
    }
    const FINAL = local('2026-10-30 21:30')
    clock = FINAL

    // ---- state dump ----
    const parcels = (db.prepare('SELECT id FROM parcels ORDER BY id').all() as { id: number }[]).map(r => {
      const p = getParcel(db, r.id)!
      const ev = listEvents(db, r.id)
      return { ...p, code: getPickupCode(db, r.id), events: ev.map(e => `${bt(e.occurredAt)} [${e.status}] ${e.description}`) }
    })
    const messages = db.prepare('SELECT id, message_id, received_at, from_addr, subject, parcel_id, parsed_ok, ignored, parse_note FROM messages ORDER BY received_at, id').all() as Array<Record<string, unknown>>
    writeFileSync(join(OUT, 'parcels.json'), JSON.stringify(parcels, null, 2))
    writeFileSync(join(OUT, 'messages.json'), JSON.stringify(messages, null, 2))
    writeFileSync(join(OUT, 'notifications.json'), JSON.stringify(notifications, null, 2))
    writeFileSync(join(OUT, 'poll-calls.json'), JSON.stringify(pollCalls, null, 2))
    writeFileSync(join(OUT, 'runs.json'), JSON.stringify(reports, null, 2))

    // ---- expectation check, per mail ----
    const byMid = new Map(messages.map(m => [m.message_id as string, m]))
    const pById = new Map(parcels.map(p => [p.id, p]))
    const key = (p: { carrier: string; trackingNumber: string }) => `${p.carrier}:${p.trackingNumber}`
    const rows: string[] = []
    let mismatches = 0
    for (const m of fake) {
      const c = corpus.find(x => x.file === m.file)!
      const row = byMid.get(m.messageId!)
      const parcel = row?.parcel_id ? pById.get(row.parcel_id as number) : undefined
      const actual = parcel
        ? `parcel ${key(parcel)}${parcel.archivedAt ? ' (archived)' : ''}${parcel.code ? ` code ${parcel.code}` : ''}`
        : row?.ignored ? 'ignored' : row ? `attention: ${row.parse_note}` : 'NOT STORED'
      const e = c.expect
      let ok: boolean
      if (e.parcels) ok = e.parcels.every(k => parcels.some(p => key(p) === k))
      else if (e.parcel) ok = !!parcel && key(parcel) === e.parcel && (e.archived === undefined || !!parcel.archivedAt === e.archived) && (e.code === undefined || parcel.code === e.code)
      else if (e.ignored) ok = !!row?.ignored && !parcel
      else ok = !parcel && !!row && !row.ignored
      if (!ok) mismatches++
      rows.push(`| ${ok ? 'ok' : '**MISMATCH**'} | \`${m.file}\` | ${e.parcels ? e.parcels.join(' + ') : e.parcel ?? (e.ignored ? 'ignored' : 'attention')}${e.archived ? ' (archived)' : ''}${e.code ? ` code ${e.code}` : ''} | ${actual.replace(/\|/g, '/')} |`)
    }
    const attention = messages.filter(m => !m.parcel_id && !m.parsed_ok && !m.ignored)
    const summary = [
      `# Harness results (generated)`, '',
      `Run at fake time ${bt(FINAL)} (Europe/Bratislava). ${fake.length} mails, ${slots.length} poll runs.`, '',
      `- parcels created: ${parcels.length} (active ${parcels.filter(p => !p.archivedAt && !['delivered', 'returned'].includes(p.status)).length}, archived ${parcels.filter(p => p.archivedAt).length}, delivered ${parcels.filter(p => p.status === 'delivered').length}, returned ${parcels.filter(p => p.status === 'returned').length})`,
      `- messages stored: ${messages.length}; needs-attention: ${attention.length}; ignored: ${messages.filter(m => m.ignored).length}`,
      `- notifications sent: ${notifications.length}; carrier polls: ${pollCalls.length}`,
      `- network attempts blocked: ${leaks.length}${leaks.length ? `\n  - ${leaks.join('\n  - ')}` : ''}`,
      `- expectation mismatches: ${mismatches}`, '',
      '| Verdict | Mail | Expected | Actual |', '|---|---|---|---|', ...rows, '',
      '## Parcels', '',
      '| id | carrier | number | status | archived | merchant | pickup | code | till | events |', '|---|---|---|---|---|---|---|---|---|---|',
      ...parcels.map(p => `| ${p.id} | ${p.carrier} | ${p.trackingNumber} | ${p.status} | ${p.archivedAt ? 'yes' : ''} | ${(p.merchant ?? '').replace(/\|/g, '/')} | ${p.pickup ? JSON.stringify(p.pickup).replace(/\|/g, '/') : ''} | ${p.code ?? ''} | ${p.retainedTill ? bt(p.retainedTill) : ''} | ${p.events.length} |`),
      '', '## Run log', '', '```', ...log, '```', '',
      '## Notifications', '', ...notifications.map(n => `- ${n.at} **${n.title}** — ${n.message}`), '',
    ].join('\n')
    writeFileSync(join(OUT, 'RESULTS.md'), summary)

    // ---- web server: injected clock, calendar, notifier, IMAP; no osascript, no network ----
    const calendar = {
      listWritable: async () => ['Domov', 'Práca'],
      add: async () => ({ uid: 'fake-uid', calendar: 'Domov' }),
    }
    server = buildServer({
      db, config, configPath, now: () => FINAL, notifier, calendar, http: deadHttp, adapters,
      imapClient: () => fakeImap([]).client as never, ingestClient: fakeImap(fake).client as never,
      version: 'fake-mail-harness', tileDir: join(dataDir, 'tiles'),
      support: { dataDir, env: { node: process.version, platform: 'darwin', arch: 'arm64', hostname: 'fake-host' } as never, launchd: { agents: [] } as never },
      update: {
        root: tmp, dataDir,
        run: async () => ({ code: 1, stdout: '', stderr: 'disabled in harness' }) as never,
        spawn: (() => { throw new Error('spawn disabled in harness') }) as never,
      },
    })
    const pages: Array<[string, string]> = [
      ['dashboard', '/'], ['attention', '/attention'], ['health', '/health'], ['settings', '/settings'],
      ['history', '/history'], ['add', '/add'],
      ...parcels.map((p): [string, string] => [`parcel-${String(p.id).padStart(2, '0')}-${p.carrier}-${p.trackingNumber}`, `/parcel/${p.id}`]),
    ]
    const statusLines: string[] = []
    for (const [name, url] of pages) {
      const res = await server.inject({ method: 'GET', url, headers: { host: '127.0.0.1' } })
      writeFileSync(join(HTML, `${name}.html`), res.body)
      statusLines.push(`${res.statusCode} ${url} ${name}`)
      expect(res.statusCode, url).toBe(200)
    }
    writeFileSync(join(OUT, 'pages.txt'), `${statusLines.join('\n')}\n`)

    if (process.env.SHOTS !== '0') {
      await server.listen({ port: 0, host: '127.0.0.1' })
      const port = (server.server.address() as net.AddressInfo).port
      if (port === 8787) throw new Error('refusing to use port 8787')
      say(`server on 127.0.0.1:${port}`)
      const profile = join(tmp, 'chrome-profile')
      const run = promisify(execFile)
      const shot = async (file: string, url: string, width: number, height: number, dark: boolean) => {
        const args = [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
          `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update',
          '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-features=Translate,OptimizationHints,MediaRouter',
          '--metrics-recording-only', '--no-pings', '--disable-breakpad', '--disable-crash-reporter', '--allow-file-access-from-files',
          ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
          `--window-size=${width},${height}`, `--screenshot=${join(SHOTS, file)}`, url,
        ]
        await run(CHROME, args, { timeout: 60_000 })
        // Crop to the content (needs ImageMagick; skipped silently without it). A 390 shot is taken
        // through a 390px iframe in a wider window - headless Chrome will not make a window that
        // narrow - so it is first cut to the iframe's width.
        const w = url.startsWith('file:') && file.includes('-390') ? 390 : width
        try {
          const box = (await run('magick', [join(SHOTS, file), '-crop', `${w}x${height}+0+0`, '+repage', '-fuzz', '2%', '-format', '%@', 'info:'])).stdout
          const m = /^\d+x(\d+)\+\d+\+(\d+)$/.exec(box.trim())
          const h = m ? Math.min(height, Number(m[1]) + Number(m[2]) + 24) : height
          await run('magick', [join(SHOTS, file), '-crop', `${w}x${h}+0+0`, '+repage', join(SHOTS, file)])
        } catch { /* no ImageMagick: keep the full window */ }
      }
      // The server forbids framing (CSP frame-ancestors 'none'), so the 390px iframe frames the SAVED
      // html (inline CSS, same bytes the server sent) from a wrapper file.
      const wrap = join(tmp, 'wrap')
      mkdirSync(wrap, { recursive: true })
      const narrow = (name: string) => {
        const f = join(wrap, `${name}.html`)
        writeFileSync(f, `<!doctype html><body style="margin:0;background:#888"><iframe src="file://${join(HTML, `${name}.html`)}" style="border:0;width:390px;height:6000px;display:block"></iframe></body>`)
        return `file://${f}`
      }
      const http_ = (url: string) => `http://127.0.0.1:${port}${url}`
      for (const [name, url] of pages.slice(0, 6)) {
        await shot(`${name}-1280.png`, http_(url), 1280, 6000, false)
        await shot(`${name}-390.png`, narrow(name), 600, 6000, false)
        await shot(`${name}-1280-dark.png`, http_(url), 1280, 6000, true)
      }
      for (const [name, url] of pages.slice(6)) {
        await shot(`${name}-1280.png`, http_(url), 1280, 3000, false)
        await shot(`${name}-390.png`, narrow(name), 600, 4000, false)
      }
      for (const [name, url] of pages.slice(6, 9)) await shot(`${name}-1280-dark.png`, http_(url), 1280, 3000, true)
    }
    writeFileSync(join(OUT, 'leaks.txt'), leaks.join('\n'))
    expect(leaks).toEqual([])
  } finally {
    await server?.close()
    restore()
    if (process.env.KEEP !== '1') rmSync(tmp, { recursive: true, force: true })
    else console.log(`kept ${tmp}`)
  }
}, 900_000)
