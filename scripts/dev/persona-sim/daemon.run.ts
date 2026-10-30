// The persona simulator's long-lived process. Started by `sim start` (sim.mjs) as one vitest "test" that
// does not end until `sim stop`, because vitest is how this repo runs src/ TypeScript without build outputs.
//
// It builds a throw-away world in $SIM_DIR (config from config.example.json, database, mail dir), runs the
// REAL web server in app mode on a random loopback port (fake calendar, recording notifier, fake carriers
// answering from the persona's scenario, fake release feed), and listens for commands on a second loopback
// port. The clock is fake (Date only), every network API and every child process is blocked (lib/guard.ts).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { simpleParser } from 'mailparser'
import { blocked, installGuards, realExecFile } from './lib/guard.js'
import { World, ZONE, type WParcel } from './lib/world.js'
import { formatPage } from './lib/page-text.js'
import { labelled } from './lib/gmail-filter.mjs'
import { buildEml } from '../fake-mail/mime.mjs'
import { openDb } from '../../../src/db/index.js'
import { claimRun } from '../../../src/db/poll-runs.js'
import { recordPollRun, runPoll } from '../../../src/core/poll.js'
import { recordPoll } from '../../../src/core/sleepgap.js'
import { allAdapters } from '../../../src/carriers/registry.js'
import { readyCount } from '../../../src/db/parcels.js'
import { buildServer, refreshIdle } from '../../../src/web/server.js'
import { POLL_SLOTS } from '../../../src/core/schedule.js'
import { appUpdateStatusPath, checkAppRelease, stagingDir, writeAppUpdateStatus, type AppUpdateStatus } from '../../../src/core/app-update.js'
import { setMainChannel, type ToMain } from '../../../src/core/app-ipc.js'
import { STYLE } from '../../../src/web/views/style.js'
import { DEFAULT_APPEARANCE } from '../../../src/core/appearance.js'
import { getUpdateCheck, recordUpdateInstalled } from '../../../src/db/update-state.js'
import type { Carrier, CarrierAdapter, HttpClient } from '../../../src/core/types.js'
import type { Notification } from '../../../src/notify/types.js'
import { fakeImap, type FakeMessage } from '../../../test/imap-fake.js'
import { firstRunHandler, OLD_INSTALL, readPages } from '../../../app/protocol.js'
import { fillPage } from '../../../app/first-run.js'

const ROOT = resolve(__dirname, '../../..')
const HERE = __dirname
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAGICK = '/opt/homebrew/bin/magick'
const run = promisify(realExecFile)

interface Scenario {
  meta: { id: string; fullName: string; email: string; day0: string; postcode: string; town: string; away: number[]; firstRun: 'welcome' | 'move-in'; clone?: string; release?: { at: string; tag: string; body: string } }
  parcels: WParcel[]
  mails: Array<{ id: string; at?: string; trigger?: { afterCollect: string; min: number }; cond?: { notCollected?: string }; about: string; spec: Record<string, unknown> & { from: string; subject: string } }>
}
interface InboxMail {
  n: number; id: string; at: Date; labelled: boolean; uid?: number; eml: Buffer
  fromName: string; fromAddr: string; to: string; subject: string; text: string; snippet: string; attachments: string[]
}
interface Note extends Notification { at: Date }

test('persona simulator', async () => {
  const persona = process.env.SIM_PERSONA!
  const DIR = process.env.SIM_DIR!
  if (!persona || !DIR) throw new Error('SIM_PERSONA and SIM_DIR are required')
  const S: Scenario = JSON.parse(readFileSync(join(HERE, 'scenarios', persona, 'scenario.json'), 'utf8'))
  const restoreGuards = installGuards()
  const log = (s: string) => console.log(`[sim ${persona}] ${s}`)

  // ---------------------------------------------------------------- clock
  const day0 = DateTime.fromISO(S.meta.day0, { zone: ZONE }).startOf('day')
  const T = (at: string): Date => {
    const m = /^D(-?\d+) (\d{2}):(\d{2})$/.exec(at)
    if (!m) throw new Error(`bad time ${at}`)
    return day0.plus({ days: Number(m[1]) }).set({ hour: Number(m[2]), minute: Number(m[3]) }).toJSDate()
  }
  const at = (day: number, hm: string) => T(`D${day} ${hm}`)
  const dayOf = (d: Date) => Math.floor(DateTime.fromJSDate(d, { zone: ZONE }).startOf('day').diff(day0, 'days').days + 0.5)
  const hm = (d: Date) => DateTime.fromJSDate(d, { zone: ZONE }).toFormat('HH:mm')
  const dayName = (d: number) => day0.plus({ days: d }).setLocale('en').toFormat('cccc d LLLL yyyy')
  const END_HM = '22:00'
  const SETUP = at(0, '20:30')
  let clock = at(0, '19:00')
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
  const setClock = (d: Date) => { clock = d; vi.setSystemTime(d) }

  // ---------------------------------------------------------------- the temp world
  const supportDir = join(DIR, 'support')
  const dataDir = join(supportDir, 'data')
  for (const d of [dataDir, join(DIR, 'shots'), join(DIR, 'html'), join(DIR, 'logs'), join(DIR, 'welcome'), join(DIR, 'Applications', 'Parcels.app')]) mkdirSync(d, { recursive: true })
  const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'))
  const port = await freePort()
  const { imap: exampleImap, ...noImap } = example
  const cfgDoc: Record<string, unknown> = { ...noImap, dbPath: join(dataDir, 'parcels.db'), port, pickupCalendar: '' }
  const configPath = join(supportDir, 'sim-config.json')
  writeFileSync(configPath, JSON.stringify(cfgDoc, null, 2))
  const config = { ...cfgDoc, notifier: 'auto' } as never as Parameters<typeof buildServer>[0]['config']
  const mailDir = join(dataDir, 'mail')
  const db = openDb((config as { dbPath: string }).dbPath)
  const world = new World(S.parcels, T)

  // ---------------------------------------------------------------- mail
  const pending: Array<{ id: string; at: Date; cond?: { notCollected?: string }; spec: Scenario['mails'][number]['spec'] }> =
    S.mails.filter(m => m.at).map(m => ({ id: m.id, at: T(m.at!), ...(m.cond && { cond: m.cond }), spec: m.spec }))
  const inbox: InboxMail[] = []
  const label: Array<FakeMessage & { arrivalAt: Date }> = []
  let nextUid = 5001
  const localStr = (d: Date) => DateTime.fromJSDate(d, { zone: ZONE }).toFormat('yyyy-LL-dd HH:mm')
  async function deliver(p: (typeof pending)[number]) {
    if (p.cond?.notCollected && world.collected.has(p.cond.notCollected)) return
    const eml: Buffer = buildEml({ ...p.spec, date: localStr(p.at) })
    const parsed = await simpleParser(eml)
    const from = parsed.from?.value[0]
    const text = (parsed.text ?? '').trim()
    const isLabelled = labelled(ROOT, { from: p.spec.from, subject: p.spec.subject })
    const m: InboxMail = {
      n: inbox.length + 1, id: p.id, at: p.at, labelled: isLabelled, eml,
      fromName: from?.name || from?.address || '', fromAddr: from?.address ?? '', to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]!.text : parsed.to.text) : '',
      subject: parsed.subject ?? '', text, snippet: text.replace(/\s+/g, ' ').slice(0, 120), attachments: parsed.attachments.map(a => a.filename ?? '(attachment)'),
    }
    inbox.push(m)
    if (isLabelled) {
      m.uid = nextUid++
      label.push({ uid: m.uid, messageId: parsed.messageId, subject: m.subject, from: m.fromAddr, date: parsed.date ?? p.at, internalDate: new Date(p.at.getTime() + 30_000), source: eml, arrivalAt: p.at })
    }
  }
  const labelNow = () => label.filter(m => m.arrivalAt <= clock)
  // Mail from before day 0's evening is already in the mailbox when Parcels is installed.
  for (const p of [...pending].sort((a, b) => a.at.getTime() - b.at.getTime())) if (p.at <= clock) await deliver(p)

  // ---------------------------------------------------------------- carriers, notifier, release feed
  const deadHttp: HttpClient = async url => {
    blocked.network.push(`HttpClient ${url}`)
    throw new Error('persona-sim: HttpClient disabled')
  }
  const adapters: Carrier[] = allAdapters().map((real): Carrier => {
    if (!('fetch' in real)) return real
    const a: CarrierAdapter = {
      id: real.id, matches: real.matches, needsPostalCode: false, batchSize: real.batchSize,
      fetch: async inputs => inputs.map(i => world.answer(real.id, i.number, clock)),
    }
    return a
  })
  const notes: Note[] = []
  const notifier = { send: async (n: Notification) => { notes.push({ ...n, at: clock }) } }
  let version = '0.1.0'
  process.env.PARCELS_APP_VERSION = version
  const release = S.meta.release
  const releaseJson = async (): Promise<unknown> => release && clock >= T(release.at)
    ? { tag_name: release.tag, body: release.body, draft: false, prerelease: false }
    : { tag_name: `v${version}`, body: '', draft: false, prerelease: false }
  const appCheck = () => checkAppRelease(version, releaseJson)
  const appEvents: string[] = []
  setMainChannel((m: ToMain) => {
    if (m.type === 'install') appEvents.push(`install ${m.version}`)
    if (m.type === 'reveal') appEvents.push('reveal')
  })

  // A mailbox whose contents follow the clock: each connect sees the label as it is at that moment.
  let cur = fakeImap(labelNow()).client
  const rollingImap = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === 'connect') cur = fakeImap(labelNow()).client
      const v = (cur as unknown as Record<string | symbol, unknown>)[prop]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cur) : v
    },
  })

  // ---------------------------------------------------------------- the web server
  let server: ReturnType<typeof buildServer>
  const calendar = { listWritable: async () => ['Domov', 'Práca'], add: async () => ({ uid: 'sim-uid', calendar: 'Domov' }) }
  async function startWeb() {
    server = buildServer({
      db, config, configPath, now: () => clock, notifier, calendar, http: deadHttp, adapters,
      imapClient: () => fakeImap(labelNow()).client as never, ingestClient: rollingImap as never,
      version, tileDir: join(dataDir, 'tiles'),
      support: { dataDir, env: { node: process.version, platform: 'darwin', arch: 'arm64', hostname: `${persona}-mac` } as never, launchd: { agents: [] } as never },
      update: { root: DIR, dataDir, run: async () => ({ code: 1, stdout: '', stderr: 'disabled in simulator' }) as never, spawn: (() => { throw new Error('spawn disabled in simulator') }) as never },
      app: {
        supportDir, logDir: join(DIR, 'logs'), appBundle: join(DIR, 'Applications', 'Parcels.app'), version, startedAt: clock, restarts: () => 0,
        check: appCheck,
        stage: async d => {
          const dir = join(stagingDir(d.appBundle, d.version), 'Parcels.app')
          mkdirSync(dir, { recursive: true })
          const st: AppUpdateStatus = { state: 'staged', version: d.version, staged: dir, startedAt: clock }
          writeAppUpdateStatus(appUpdateStatusPath(d.supportDir), st)
          return st
        },
      },
    })
    await server.listen({ port, host: '127.0.0.1' })
  }
  await startWeb()
  const origin = `http://127.0.0.1:${port}`
  const headers = { host: `127.0.0.1:${port}` }

  // ---------------------------------------------------------------- first-run pages (app/pages)
  const pages = readPages(join(ROOT, 'app', 'pages'))
  let firstRunDone: string | undefined
  const firstRun = firstRunHandler({
    firstRun: S.meta.firstRun === 'move-in' ? { kind: 'move-in', clone: S.meta.clone ?? '/Users/you/parcels', plists: ['local.parcels.web.plist', 'local.parcels.poller.plist'] } : { kind: 'welcome' },
    configPath: join(DIR, 'welcome', 'config.json'),
    pages,
    start: path => { firstRunDone = path },
    moveIn: async () => ({ ok: true }) as never,
    quit: () => { appEvents.push('quit') },
    log: s => log(`first-run: ${s}`),
  })
  const firstRunPath = S.meta.firstRun === 'move-in' ? 'move-in' : 'welcome'

  // ---------------------------------------------------------------- setup and polls
  let setupDone = false
  const samples: Array<{ at: Date; label: string; n: number }> = []
  function completeSetup() {
    const c = config as { imap?: unknown; defaultPostalCode: string }
    const welcome = join(DIR, 'welcome', 'config.json')
    if (existsSync(welcome)) c.defaultPostalCode = JSON.parse(readFileSync(welcome, 'utf8')).defaultPostalCode
    else if (!process.env.SIM_KEEP_EXAMPLE_POSTCODE) c.defaultPostalCode = S.meta.postcode
    const mine = c.imap as { user?: string } | undefined
    c.imap = { ...exampleImap, ...(mine ?? {}), user: mine?.user && !/your\.address/.test(mine.user) ? mine.user : S.meta.email, pass: 'fake fake fake fake', mailbox: 'parcels' }
    const doc = JSON.parse(readFileSync(configPath, 'utf8'))
    writeFileSync(configPath, JSON.stringify({ ...doc, defaultPostalCode: c.defaultPostalCode, imap: c.imap }, null, 2))
    setupDone = true
  }
  async function poll(t: Date) {
    const claim = claimRun(db, 'poller', t)
    if (!claim.claimed) { log(`slot ${localStr(t)} not claimed`); return }
    const imap = (config as { imap?: never }).imap
    await recordPollRun(db, claim.id, runPoll({
      db, http: deadHttp, adapters, config, now: t, notifier,
      cause: { actor: 'poller', runId: claim.id, at: t },
      ...(imap && { ingest: { imap, mailDir, client: fakeImap(labelNow()).client } }),
      updateCheck: { check: appCheck },
    }), () => t)
    recordPoll(db, t.getTime())
  }

  type Ev = { at: Date; kind: 0 | 1 | 2 | 3; run: () => Promise<void> | void }
  async function advance(target: Date) {
    const evs: Ev[] = []
    for (const p of pending) if (p.at > clock && p.at <= target) evs.push({ at: p.at, kind: 0, run: () => deliver(p) })
    if (!setupDone && SETUP > clock && SETUP <= target) evs.push({ at: SETUP, kind: 1, run: async () => { completeSetup(); await poll(SETUP) } })
    for (let d = Math.max(0, dayOf(clock)); d <= dayOf(target); d++) {
      for (const s of POLL_SLOTS) {
        const t = at(d, `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`)
        if (t > clock && t <= target && (setupDone || t > SETUP)) evs.push({ at: t, kind: 2, run: () => poll(t) })
      }
      for (const [h, name] of [['08:00', 'morning'], ['13:00', 'midday'], ['21:00', 'evening']] as const) {
        const t = at(d, h)
        if (t > clock && t <= target) evs.push({ at: t, kind: 3, run: () => { samples.push({ at: t, label: name, n: readyCount(db) }) } })
      }
    }
    evs.sort((a, b) => a.at.getTime() - b.at.getTime() || a.kind - b.kind)
    for (const e of evs) { setClock(e.at); await e.run() }
    setClock(target)
  }

  // ---------------------------------------------------------------- what the person perceives
  const away = (d: number) => S.meta.away.includes(d)
  function digest(from: Date, to: Date): string {
    const out: string[] = []
    for (let d = dayOf(new Date(from.getTime() + 1)); d <= dayOf(to); d++) {
      const lo = new Date(Math.max(from.getTime(), at(d - 1, END_HM).getTime()))
      const hi = new Date(Math.min(to.getTime(), at(d, END_HM).getTime()))
      if (hi <= lo) continue
      const inWin = (t: Date) => t > lo && t <= hi
      const partial = hi < at(d, END_HM)
      out.push(`══ Day ${d} · ${dayName(d)}${partial ? ` · until ${hm(hi)}` : ''} ══${away(d) ? '   (you are away from home today)' : ''}`)
      if (d === 0 && inWin(SETUP)) out.push(`20:30  Setup finished (simulated): Gmail is connected with an App Password, the filter is imported and the "parcels" label is visible over IMAP. Parcels now reads that label.`)
      const sm = samples.filter(s => inWin(s.at))
      out.push(`Menu-bar icon (parcels ready to collect): ${sm.length ? sm.map(s => `${s.label} ${hm(s.at)} → ${s.n}`).join(' · ') : '(no reading in this stretch)'}${partial ? ` · now ${hm(hi)} → ${readyCount(db)}` : ''}`)
      const ns = notes.filter(n => inWin(n.at))
      out.push(ns.length ? `Notifications (${ns.length}):` : 'Notifications: none')
      for (const n of ns) out.push(...noteLines(n))
      const ms = inbox.filter(m => inWin(m.at))
      out.push(ms.length ? `New mail in Gmail (${ms.length}):` : 'New mail in Gmail: none')
      for (const m of ms) out.push(...mailLines(m))
      out.push('')
    }
    return out.join('\n')
  }
  const noteLines = (n: Note) => [`  ${hm(n.at)}  [Parcels] ${n.title}`, ...n.message.split('\n').map(l => `         ${l}`), ...(n.url ? [`         (clicking it opens ${n.url.replace(/^https?:\/\/[^/]+/, '')})`] : [])]
  const mailLines = (m: InboxMail) => [
    `  #${m.n} ${hm(m.at)}  ${m.fromName}${m.fromAddr && m.fromAddr !== m.fromName ? ` <${m.fromAddr}>` : ''}${m.labelled ? '   [label: parcels]' : ''}`,
    `      ${m.subject || '(no subject)'}`,
    `      ${m.snippet}${m.text.length > 120 ? '…' : ''}${m.attachments.length ? `  📎 ${m.attachments.join(', ')}` : ''}`,
  ]

  // ---------------------------------------------------------------- page access
  async function get(path: string): Promise<{ status: number; type: string; body: string; path: string }> {
    let p = path
    for (let i = 0; i < 5; i++) {
      const res = await server.inject({ method: 'GET', url: p, headers })
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { p = String(res.headers.location).replace(origin, ''); continue }
      return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: res.body, path: p }
    }
    throw new Error('too many redirects')
  }
  async function appPage(name: string, method: 'GET' | 'POST' = 'GET', form?: URLSearchParams): Promise<{ status: number; body: string; note?: string }> {
    if (name === 'first-run') name = firstRunPath
    if (name === 'result') {
      const body = fillPage(pages.result, { clone: S.meta.clone ?? '/Users/you/parcels', step: 'Copying your parcels and settings', reason: 'The disk is full: 0 bytes free on Macintosh HD.', ...DEFAULT_APPEARANCE, ...OLD_INSTALL.running }, STYLE)
      return { status: 200, body, note: 'This page appears only if moving in fails; it is shown here with sample text.' }
    }
    const res = await firstRun(new Request(`parcels://${name}/`, method === 'POST' ? { method, body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}))
    return { status: res.status, body: await res.text() }
  }
  function readme(slug?: string): string {
    const md = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const parts = md.split(/^(?=## )/m)
    const slugOf = (h: string) => h.replace(/^##\s*/, '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
    const secs = parts.filter(p => p.startsWith('## ')).map(p => ({ slug: slugOf(p.split('\n')[0]!), title: p.split('\n')[0]!.replace(/^##\s*/, ''), body: p }))
    if (!slug) return ['README.md sections (open one with: sim text readme:<name>):', ...secs.map(s => `  readme:${s.slug}   ${s.title}`)].join('\n')
    const s = secs.find(x => x.slug === slug)
    return s ? s.body.trimEnd() : `No README section "${slug}". Run: sim text readme`
  }

  async function text(path: string): Promise<string> {
    if (path === 'readme' || path.startsWith('readme:')) return readme(path.split(':')[1])
    if (path.startsWith('app:')) {
      const r = await appPage(path.slice(4))
      const name = path.slice(4) === 'first-run' ? firstRunPath : path.slice(4)
      return `${r.note ? `(${r.note})\n` : ''}${formatPage(r.body.replace(/action="parcels:\/\/([\w-]+)\/"/g, 'action="app:$1"'), `app:${name}`, r.status)}`
    }
    if (!path.startsWith('/')) return `Not a page: "${path}". Use a path like /settings, app:first-run or readme.`
    const r = await get(path)
    if (/html/.test(r.type)) return formatPage(r.body, r.path, r.status)
    return `PAGE ${r.path}  (HTTP ${r.status}, ${r.type})\n\n${r.body.slice(0, 20000)}`
  }

  async function post(path: string, pairs: string[]): Promise<string> {
    path = path.replace(/^parcels:\/\/([\w-]+)\/?$/, 'app:$1').replace(/#.*$/, '')
    const form = new URLSearchParams()
    for (const p of pairs) { const i = p.indexOf('='); if (i < 1) return `Not name=value: "${p}"`; form.append(p.slice(0, i), p.slice(i + 1)) }
    const before = readyCount(db)
    const n0 = notes.length
    const out: string[] = []
    if (path.startsWith('app:')) {
      const r = await appPage(path.slice(4), 'POST', form)
      if (r.status === 204) out.push(`The first-run page accepted it. The window now shows the dashboard at ${firstRunDone ?? '/'} (see: sim text ${firstRunDone ?? '/'}).`)
      else out.push(formatPage(r.body.replace(/action="parcels:\/\/([\w-]+)\/"/g, 'action="app:$1"'), path, r.status))
      if (path === 'app:welcome' && r.status === 204) {
        const pc = JSON.parse(readFileSync(join(DIR, 'welcome', 'config.json'), 'utf8')).defaultPostalCode
        ;(config as { defaultPostalCode: string }).defaultPostalCode = pc
        const doc = JSON.parse(readFileSync(configPath, 'utf8'))
        writeFileSync(configPath, JSON.stringify({ ...doc, defaultPostalCode: pc }, null, 2))
      }
    } else {
      if (!path.startsWith('/')) return `Not a page: "${path}"`
      const res = await server.inject({ method: 'POST', url: path, payload: form.toString(), headers: { ...headers, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' } })
      await refreshIdle(server)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = String(res.headers.location).replace(origin, '')
        out.push(`→ HTTP ${res.statusCode}, the browser goes to ${loc}`, '')
        const r = await get(loc)
        out.push(/html/.test(r.type) ? formatPage(r.body, r.path, r.status) : r.body.slice(0, 20000))
      } else {
        const type = String(res.headers['content-type'] ?? '')
        out.push(`→ HTTP ${res.statusCode}`, '', /html/.test(type) ? formatPage(res.body, path, res.statusCode) : res.body.slice(0, 20000))
      }
    }
    const ev = appEvents.splice(0)
    for (const e of ev) {
      if (e.startsWith('install ')) {
        const v = e.slice(8)
        out.push('', `Parcels quits and opens again on version ${v}.`)
        await server.close(); version = v; process.env.PARCELS_APP_VERSION = v
        // What the new app's server does at start (core/app-host.ts settleUpdateStatus, which is not exported).
        writeAppUpdateStatus(appUpdateStatusPath(supportDir), { state: 'installed', version: v, finishedAt: clock })
        const check = getUpdateCheck(db)
        if (check?.state === 'behind' && check.version === v) recordUpdateInstalled(db, undefined, clock)
        await startWeb()
      } else if (e === 'reveal') out.push('', `Finder opens a window on the Parcels data folder (~/Library/Application Support/Parcels).`)
      else if (e === 'quit') out.push('', 'Parcels quits. (In the simulator the app keeps running so you can carry on.)')
    }
    const fired = notes.slice(n0)
    if (fired.length) out.push('', 'Notifications that appeared:', ...fired.flatMap(noteLines))
    const after = readyCount(db)
    if (after !== before) out.push('', `Menu-bar icon: ${before} → ${after}`)
    return out.join('\n')
  }

  async function shot(path: string, width: number, dark: boolean, outFile?: string): Promise<string> {
    const slug = path.replace(/^\//, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'dashboard'
    const file = resolve(outFile ?? join(DIR, 'shots', `${slug}-${width}${dark ? '-dark' : ''}.png`))
    let html: string
    let live: string | undefined
    if (path.startsWith('app:')) html = (await appPage(path.slice(4))).body
    else {
      const r = await get(path)
      html = r.body
      live = `${origin}${r.path}`
      // Inline what the page loads from this server, so the saved copy (needed for the 390 frame) is complete.
      for (const src of new Set([...html.matchAll(/src="(\/[^"]+)"/g)].map(m => m[1]!))) {
        const res = await server.inject({ method: 'GET', url: src.replace(/&amp;/g, '&'), headers })
        if (res.statusCode === 200) html = html.split(`src="${src}"`).join(`src="data:${res.headers['content-type']};base64,${res.rawPayload.toString('base64')}"`)
      }
    }
    const saved = join(DIR, 'html', `${slug}.html`)
    writeFileSync(saved, html)
    let url: string
    let winW = width
    if (width <= 400) {
      const wrap = join(DIR, 'html', `${slug}-frame-${width}.html`)
      writeFileSync(wrap, `<!doctype html><body style="margin:0;background:#888"><iframe src="file://${saved}" style="border:0;width:${width}px;height:6000px;display:block"></iframe></body>`)
      url = `file://${wrap}`
      winW = 600
    } else url = live ?? `file://${saved}`
    const height = 6000
    await run(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(DIR, 'chrome-profile')}`, '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--metrics-recording-only', '--no-pings', '--disable-breakpad', '--disable-crash-reporter', '--allow-file-access-from-files',
      // Anything but loopback goes to a dead proxy, and nothing resolves: Chrome cannot reach the network either.
      '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
      ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
      `--window-size=${winW},${height}`, `--screenshot=${file}`, url,
    ], { timeout: 90_000 })
    if (!existsSync(file)) throw new Error(`Chrome wrote no screenshot for ${url}`)
    try {
      const box = (await run(MAGICK, [file, '-crop', `${width}x${height}+0+0`, '+repage', '-fuzz', '2%', '-format', '%@', 'info:'])).stdout
      const m = /^\d+x(\d+)\+\d+\+(\d+)$/.exec(String(box).trim())
      const h = m ? Math.min(height, Number(m[1]) + Number(m[2]) + 24) : height
      await run(MAGICK, [file, '-crop', `${width}x${h}+0+0`, '+repage', file])
    } catch { /* no ImageMagick: the full window stays */ }
    return `Screenshot of ${path} at ${width} px${dark ? ', dark mode' : ''}: ${file}\nLook at it with your image viewer (e.g. the Read tool on that path).`
  }

  function mail(nArg?: string): string {
    if (!nArg) {
      if (!inbox.length) return 'Gmail inbox: empty.'
      return ['Gmail inbox, newest first (open one with: sim mail <number>):', ...[...inbox].reverse().map(m => `  #${m.n}  ${DateTime.fromJSDate(m.at, { zone: ZONE }).setLocale('en').toFormat('ccc d LLL HH:mm')} (day ${dayOf(m.at)})  ${m.fromName}  —  ${m.subject || '(no subject)'}${m.labelled ? '   [label: parcels]' : ''}`)].join('\n')
    }
    const m = inbox.find(x => x.n === Number(nArg.replace('#', '')))
    if (!m) return `No mail #${nArg}.`
    return [`From:    ${m.fromName} <${m.fromAddr}>`, `To:      ${m.to}`, `Date:    Day ${dayOf(m.at)}, ${DateTime.fromJSDate(m.at, { zone: ZONE }).setLocale('en').toFormat('ccc d LLL yyyy HH:mm')}`, `Subject: ${m.subject || '(no subject)'}`, `Labels:  Inbox${m.labelled ? ', parcels' : ''}`, ...(m.attachments.length ? [`Attachments: ${m.attachments.join(', ')}`] : []), '', m.text || '(no text)'].join('\n')
  }

  function status(): string {
    const d = dayOf(clock)
    return [
      `Persona: ${persona} (${S.meta.fullName}, ${S.meta.town})`,
      `Simulated time: Day ${d} of 14 · ${DateTime.fromJSDate(clock, { zone: ZONE }).setLocale('en').toFormat('cccc d LLLL yyyy, HH:mm')}${away(d) ? ' · you are away from home' : ''}`,
      `Setup: ${setupDone ? 'done' : `not yet - it is completed by your first "sim day"`}`,
      `Dashboard: ${origin}/`,
      `Menu-bar icon: ${readyCount(db)}`,
      `Gmail: ${inbox.length} mails so far (sim mail)`,
      `Guards: network attempts blocked ${blocked.network.length}, processes blocked ${blocked.processes.length}`,
    ].join('\n')
  }

  async function day(untilHm?: string): Promise<string> {
    const from = clock
    let d = clock >= at(dayOf(clock), END_HM) ? dayOf(clock) + 1 : dayOf(clock)
    // The first step also finishes setup day: day 0's evening (setup completes at 20:30), then day 1.
    if (!setupDone && d === 0) { await advance(at(0, END_HM)); d = 1 }
    if (d > 14) return 'Day 14 is over: the 14 days are done. Use sim text / sim shot to look around, then sim stop.'
    let target = at(d, END_HM)
    if (untilHm) {
      if (!/^\d{2}:\d{2}$/.test(untilHm)) return `--until wants HH:MM, like 07:40`
      target = at(d, untilHm)
      if (target <= clock) return `It is already ${hm(clock)} on day ${dayOf(clock)}; ${untilHm} has passed. Use sim day without --until to finish the day.`
      if (target > at(d, END_HM)) target = at(d, END_HM)
    }
    await advance(target)
    return digest(from, clock)
  }

  /** Operator check: the guards really refuse a network call and osascript. The attempts are not counted. */
  async function selftest(): Promise<string> {
    const n = blocked.network.length, p = blocked.processes.length
    const lines: string[] = []
    try { await fetch('https://tracking.packeta.com/'); lines.push('fetch: NOT BLOCKED') } catch (e) { lines.push(`fetch https://tracking.packeta.com/: blocked (${(e as Error).message})`) }
    try { (await import('node:child_process')).spawn('osascript', ['-e', 'return 1']); lines.push('osascript: NOT BLOCKED') } catch (e) { lines.push(`spawn osascript: blocked (${(e as Error).message})`) }
    try { (await import('node:child_process')).execFile('/bin/launchctl', ['list']); lines.push('launchctl: NOT BLOCKED') } catch (e) { lines.push(`execFile launchctl: blocked (${(e as Error).message})`) }
    try { (await import('node:net')).connect(993, 'imap.gmail.com'); lines.push('IMAP connect: NOT BLOCKED') } catch (e) { lines.push(`net.connect imap.gmail.com:993: blocked (${(e as Error).message})`) }
    blocked.network.splice(n); blocked.processes.splice(p)
    return lines.join('\n')
  }

  function collect(code: string): string {
    const d = dayOf(clock)
    if (away(d)) return `You are away from home today (day ${d}); none of your pickup points is in reach.`
    const r = world.collect(code, clock)
    if (r.ok && r.parcel) {
      for (const m of S.mails) if (m.trigger?.afterCollect === r.parcel.key) pending.push({ id: m.id, at: new Date(clock.getTime() + m.trigger.min * 60_000), spec: m.spec })
    }
    return `${DateTime.fromJSDate(clock, { zone: ZONE }).toFormat('HH:mm')}  ${r.message}`
  }

  // ---------------------------------------------------------------- control channel
  const token = randomBytes(16).toString('hex')
  let queue: Promise<unknown> = Promise.resolve()
  let stop!: () => void
  const stopped = new Promise<void>(r => { stop = r })
  const control = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      queue = queue.then(async () => {
        let reply: { ok: boolean; out: string }
        try {
          const { token: t, cmd, args = [] } = JSON.parse(body) as { token: string; cmd: string; args: string[] }
          if (t !== token) throw new Error('bad token')
          const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
          const plainArgs = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && !['--dark', '--keep'].includes(args[i - 1]!)))
          let out: string
          switch (cmd) {
            case 'day': out = await day(flag('--until')); break
            case 'status': out = status(); break
            case 'text': out = await text(plainArgs[0] ?? '/'); break
            case 'post': out = await post(plainArgs[0] ?? '', plainArgs.slice(1)); break
            case 'shot': out = await shot(plainArgs[0] ?? '/', Number(flag('--width') ?? 1280), args.includes('--dark'), flag('--out')); break
            case 'mail': out = mail(plainArgs[0]); break
            case 'collect': out = collect(plainArgs.join(' ')); break
            case 'selftest': out = await selftest(); break
            case 'stop': out = `Stopped. Network attempts blocked: ${blocked.network.length}${blocked.network.length ? ` (${blocked.network.join('; ')})` : ''}. Processes blocked: ${blocked.processes.length}${blocked.processes.length ? ` (${blocked.processes.join('; ')})` : ''}.`; setTimeout(stop, 50); break
            default: out = `Unknown command ${cmd}`
          }
          reply = { ok: true, out }
        } catch (err) {
          reply = { ok: false, out: `simulator error: ${err instanceof Error ? err.stack ?? err.message : String(err)}` }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      })
    })
  })
  await new Promise<void>(r => control.listen(0, '127.0.0.1', () => r()))
  const controlPort = (control.address() as AddressInfo).port
  writeFileSync(join(DIR, 'state.json'), JSON.stringify({ persona, dir: DIR, url: `${origin}/`, port, controlPort, token, workerPid: process.pid, startedAt: new Date().toISOString() }, null, 2))
  log(`dashboard ${origin}/ control ${controlPort}`)

  await stopped
  await server!.close()
  await new Promise<void>(r => control.close(() => r()))
  db.close()
  setMainChannel(undefined)
  writeFileSync(join(DIR, 'guard-report.json'), JSON.stringify(blocked, null, 2))
  restoreGuards()
  vi.useRealTimers()
}, 7 * 24 * 3_600_000)

/** A free loopback port that is not 8787 (the live install's). */
async function freePort(): Promise<number> {
  for (;;) {
    const p = await new Promise<number>((res, rej) => {
      const s = net.createServer()
      s.once('error', rej)
      s.listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => res(n)) })
    })
    if (p !== 8787) return p
  }
}
