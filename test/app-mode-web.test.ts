import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildServer, type WebDeps } from '../src/web/server.js'
import { healthPage } from '../src/web/views/health.js'
import { setMainChannel, type ToMain } from '../src/core/app-ipc.js'
import {
  appUpdateStatusPath, stagingDir, writeAppUpdateStatus, type AppUpdateStatus,
} from '../src/core/app-update.js'
import { UPDATE_STALE_MS, type UpdateCheck } from '../src/core/update.js'
import { getUpdateCheck, recordUpdateCheck } from '../src/db/update-state.js'
import { buildNotifications } from '../src/notify/rules.js'
import type { Database } from '../src/db/index.js'
import { config, memDb, NOW } from './poll-helpers.js'

/**
 * The web app when the Mac app runs it (`WebDeps.app` set): Health, Settings, the support bundle and
 * the update routes speak about the app. Nothing here touches the network, a real app bundle,
 * launchctl or ~/Library: every path is a temporary directory, the release check and the staging are
 * fakes, and messages to the main process are captured through `setMainChannel`.
 */

const DAY = 86_400_000

const BEHIND: UpdateCheck = {
  state: 'behind', behind: 1, version: '0.4.0', upstream: 'GitHub Releases',
  changes: ['Notifications name the parcel', 'A faster first start'],
}
const CURRENT: UpdateCheck = { state: 'current', behind: 0, changes: [], version: '0.4.0', upstream: 'GitHub Releases' }

const ENV = { node: 'v24.22.1', os: 'macOS 27.2.0 (darwin 27.2.0)', arch: 'arm64' }

const form = (fields: Record<string, string> = {}) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

let root: string
let posted: ToMain[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'parcels-app-web-'))
  posted = []
  setMainChannel(m => { posted.push(m) })
})
afterEach(() => {
  setMainChannel(undefined)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** A server in app mode, on a temp support folder, a temp "Applications" folder and fakes for every effect. */
function appServer(opts: {
  db?: Database
  configDoc?: Record<string, unknown>
  stage?: NonNullable<WebDeps['app']>['stage']
  check?: () => Promise<UpdateCheck>
  restarts?: number
  now?: Date
} = {}) {
  const db = opts.db ?? memDb()
  const supportDir = join(root, 'Application Support', 'Parcels')
  mkdirSync(supportDir, { recursive: true })
  const appBundle = join(root, 'Applications', 'Parcels.app')
  mkdirSync(appBundle, { recursive: true })
  const logDir = join(root, 'Logs')
  mkdirSync(logDir, { recursive: true })
  const configPath = join(supportDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(opts.configDoc ?? {
    defaultPostalCode: '81101', dbPath: 'data/parcels.db', port: 8797, notifier: 'osascript', mapPreview: true,
  }, null, 2), { mode: 0o600 })
  const stages: unknown[] = []
  const gitRuns: unknown[] = []
  const now = opts.now ?? NOW
  const app = buildServer({
    db,
    config,
    configPath,
    now: () => now,
    notifier: { send: async () => {} },
    support: { env: ENV, launchd: { agents: [] } },
    // The git updater's seams, recording: in app mode none of them may ever be used.
    update: {
      root: join(root, 'no-checkout'),
      dataDir: join(root, 'git-data'),
      run: args => { gitRuns.push(args); return { status: 0, stdout: 'state current\n', stderr: '' } },
      spawn: (command) => { gitRuns.push(command); return { unref: () => {} } },
    },
    app: {
      supportDir,
      logDir,
      appBundle,
      version: '0.3.0',
      startedAt: new Date(now.getTime() - 2 * DAY - 3_600_000),
      restarts: () => opts.restarts ?? 0,
      stage: opts.stage ?? (async d => {
        stages.push(d)
        return { state: 'downloading', version: d.version, startedAt: now }
      }),
      check: opts.check ?? (async () => BEHIND),
    },
  })
  return {
    app, db, supportDir, appBundle, logDir, configPath, stages, gitRuns,
    statusPath: appUpdateStatusPath(supportDir),
    get: (url: string) => app.inject({ method: 'GET', url }),
    post: (url: string, f: Record<string, string> = {}) => app.inject({ method: 'POST', url, ...form(f) }),
  }
}

/** A server in git mode, as today: no `app`. */
function gitServer() {
  return buildServer({ db: memDb(), config, now: () => NOW, version: '0.1.0 (ffa1f20)', notifier: { send: async () => {} } })
}

const GIT_WORDS = ['launchctl', 'launchd', 'scripts/', 'update.sh', 'git']

describe('Health in app mode', () => {
  test('names no launchd agent, script or git, and says how long the app has been running', async () => {
    const s = appServer()
    // The worst case for the wording: a check that found something, a status file, and an overdue poller.
    recordUpdateCheck(s.db, BEHIND, new Date(NOW.getTime() - 3_600_000))
    const body = (await s.get('/health')).body
    for (const word of GIT_WORDS) expect(body, word).not.toContain(word)
    expect(body).toContain('running for')
    expect(body).toContain('Parcels 0.3.0, running for 2 days; restarted 0 times; next check at ')
  })

  test('the App line counts restarts as the app host reports them', async () => {
    const s = appServer({ restarts: 2 })
    expect((await s.get('/health')).body).toContain('restarted 2 times')
  })

  test('the App line says when the next scheduled check is, in the page\'s own time', () => {
    const page = healthPage([], { configured: false }, { overdue: false }, { now: NOW, health: [] }, '0.3.0',
      [], undefined, [], {}, {
        version: '0.3.0', startedAt: new Date(NOW.getTime() - 2 * DAY - 60_000), restarts: 0,
        // 15:30 in Bratislava on the same day as NOW (10:00Z is 11:00 there).
        nextSlot: new Date('2026-10-26T14:30:00Z'),
      }).toString()
    expect(page).toContain('Parcels 0.3.0, running for 2 days; restarted 0 times; next check at 15:30.')
  })

  test('an overdue poller points at the menu-bar icon, not at a launchd agent', () => {
    const page = healthPage([], { configured: false }, { overdue: true, lastPollAt: new Date(NOW.getTime() - 5 * 3_600_000) },
      { now: NOW, health: [] }, '0.3.0', [], undefined, [], {}, {
        version: '0.3.0', startedAt: NOW, restarts: 0, nextSlot: new Date(NOW.getTime() + 3_600_000),
      }).toString()
    expect(page).toContain('Check that Parcels is running (its icon is in the menu bar).')
    expect(page).not.toContain('launchd')
  })

  test('the update section explains the app updater, and offers Update now when a newer release exists', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    const body = (await s.get('/health')).body
    expect(body).toContain('Checks GitHub for a newer Parcels. Updating downloads it, checks it is signed by the same certificate as this one, and restarts the app.')
    expect(body).toContain('0.4.0')
    expect(body).toContain('Notifications name the parcel')
    expect(body).toMatch(/<form method="post" action="\/update#update"><button>Update now<\/button><\/form>/)
    expect(body).not.toContain('Restart to update')
  })

  test('the Running line is the app\'s own version, never the release a check found', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, CURRENT, NOW)
    const body = (await s.get('/health')).body
    expect(body).toContain('Running <b class="mono sel">0.3.0</b>.')
    expect(body).not.toContain('Running <b class="mono sel">0.4.0</b>')
  })

  test('while downloading the page reloads itself and offers no button', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, { state: 'downloading', version: '0.4.0', startedAt: new Date(NOW.getTime() - 60_000) })
    const body = (await s.get('/health')).body
    expect(body).toContain('<meta http-equiv="refresh"')
    expect(body).not.toContain('Update now</button>')
    expect(body).not.toContain('Check for updates</button>')
  })

  test('a download that stopped answering long ago does not keep the page busy for ever', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, { state: 'downloading', version: '0.4.0', startedAt: new Date(NOW.getTime() - UPDATE_STALE_MS - 60_000) })
    const body = (await s.get('/health')).body
    expect(body).not.toContain('<meta http-equiv="refresh"')
    expect(body).toContain('Update now</button>')
  })

  test('a staged update offers Restart to update', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, { state: 'staged', version: '0.4.0', staged: join(stagingDir(s.appBundle, '0.4.0'), 'Parcels.app'), startedAt: NOW })
    const body = (await s.get('/health')).body
    expect(body).toMatch(/<form method="post" action="\/update\/restart#update"><button>Restart to update<\/button><\/form>/)
    expect(body).not.toContain('Update now</button>')
  })

  test('a failed update prints its reason', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, {
      state: 'failed', version: '0.4.0', startedAt: NOW, finishedAt: NOW,
      reason: 'The new version is not signed by the same certificate as this one, so it was not installed.',
    })
    const body = (await s.get('/health')).body
    expect(body).toContain('The new version is not signed by the same certificate as this one, so it was not installed.')
  })

  test('an installed update of the running version says so', async () => {
    const s = appServer()
    writeAppUpdateStatus(s.statusPath, { state: 'installed', version: '0.3.0', finishedAt: NOW })
    expect((await s.get('/health')).body).toContain('Updated to 0.3.0.')
  })

  test('an installed status for some other version is not claimed', async () => {
    const s = appServer()
    writeAppUpdateStatus(s.statusPath, { state: 'installed', version: '0.2.0', finishedAt: NOW })
    expect((await s.get('/health')).body).not.toContain('Updated to')
  })

  test('the git updater\'s status file is not read in app mode', async () => {
    const s = appServer()
    mkdirSync(join(root, 'git-data'), { recursive: true })
    writeFileSync(join(root, 'git-data', 'update-status.json'), JSON.stringify({ state: 'running', startedAt: NOW.toISOString() }))
    const body = (await s.get('/health')).body
    expect(body).not.toContain('<meta http-equiv="refresh"')
    expect(body).not.toContain('Fetching the new code')
  })
})

describe('Settings in app mode', () => {
  test('hides the notifier, names no config file, and offers Show in Finder', async () => {
    const s = appServer()
    const body = (await s.get('/settings')).body
    expect(body).not.toContain('name="notifier"')
    expect(body).toContain('action="/app/reveal-data"')
    expect(body).toContain('Parcels keeps its settings and data in Application Support/Parcels.')
    expect(body).toContain('Show in Finder')
    expect(body).not.toContain('config.json')
    for (const word of ['launchctl', 'scripts/']) expect(body).not.toContain(word)
  })

  test('the Show in Finder button is not part of the settings form, so Enter in a field still saves', async () => {
    const body = (await appServer().get('/settings')).body
    // Its own form, outside the settings form; the button reaches it with the `form` attribute.
    const open = '<form method="post" action="/settings">'
    const start = body.indexOf(open) + open.length
    const settingsForm = body.slice(start, body.indexOf('</form>', start))
    expect(settingsForm).not.toContain('<form')
    expect(settingsForm).toMatch(/<button form="reveal-data"[^>]*>Show in Finder<\/button>/)
    expect(body).toMatch(/<form method="post" action="\/app\/reveal-data" id="reveal-data"><\/form>/)
  })

  test('saving keeps the notifier that is in the file, although the form no longer sends it', async () => {
    const s = appServer()
    const res = await s.post('/settings', { defaultPostalCode: '01001', mapPreview: 'true', imapHost: '', imapPort: '', imapUser: '', imapMailbox: '', imapPass: '' })
    expect(res.statusCode).toBe(303)
    const saved = JSON.parse(readFileSync(s.configPath, 'utf8')) as Record<string, unknown>
    expect(saved.defaultPostalCode).toBe('01001')
    expect(saved.notifier).toBe('osascript')
  })

  test('a file with no notifier stays without one, and the save does not log it as changed', async () => {
    const s = appServer({ configDoc: { defaultPostalCode: '81101', dbPath: 'data/parcels.db', port: 8797 } })
    const res = await s.post('/settings', { defaultPostalCode: '01001', mapPreview: 'true', imapHost: '', imapPort: '', imapUser: '', imapMailbox: '', imapPass: '' })
    expect(res.statusCode).toBe(303)
    const saved = JSON.parse(readFileSync(s.configPath, 'utf8')) as Record<string, unknown>
    expect('notifier' in saved).toBe(false)
    const fields = (s.db.prepare("SELECT detail FROM activity_log WHERE kind = 'settings_saved'").get() as { detail: string }).detail
    expect(fields).not.toContain('notifier')
  })

  test('Show in Finder asks the app to reveal the support folder, and comes back to Advanced', async () => {
    const s = appServer()
    const res = await s.post('/app/reveal-data')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/settings#adv')
    expect(posted).toEqual([{ type: 'reveal', path: s.supportDir }])
  })

  test('the Advanced section can be linked to', async () => {
    expect((await appServer().get('/settings')).body).toContain('<details class="adv" id="adv">')
  })
})

describe('the app-only routes are not there under git', () => {
  test('POST /app/reveal-data and POST /update/restart answer 404', async () => {
    const app = gitServer()
    for (const url of ['/app/reveal-data', '/update/restart']) {
      expect((await app.inject({ method: 'POST', url, ...form() })).statusCode, url).toBe(404)
    }
    expect(posted).toEqual([])
  })
})

describe('POST /update/restart', () => {
  const stage = (s: ReturnType<typeof appServer>, over: Partial<Extract<AppUpdateStatus, { state: 'staged' }>> = {}) => {
    const staged = join(stagingDir(s.appBundle, '0.4.0'), 'Parcels.app')
    mkdirSync(staged, { recursive: true })
    writeAppUpdateStatus(s.statusPath, { state: 'staged', version: '0.4.0', staged, startedAt: NOW, ...over })
    return staged
  }

  test('with a staged update it asks the app to install it and says it is restarting', async () => {
    const s = appServer()
    const staged = stage(s)
    const res = await s.post('/update/restart')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Restarting Parcels…')
    expect(res.body).toContain('<meta http-equiv="refresh" content="5;url=/health#update">')
    expect(posted).toEqual([{ type: 'install', staged, version: '0.4.0' }])
  })

  test('with nothing staged it answers 409 and posts nothing', async () => {
    const s = appServer()
    const res = await s.post('/update/restart')
    expect(res.statusCode).toBe(409)
    expect(posted).toEqual([])
  })

  test('a staged path that is not this app\'s staging folder is refused', async () => {
    const s = appServer()
    const elsewhere = join(root, 'elsewhere', 'Parcels.app')
    mkdirSync(elsewhere, { recursive: true })
    writeAppUpdateStatus(s.statusPath, { state: 'staged', version: '0.4.0', staged: elsewhere, startedAt: NOW })
    const res = await s.post('/update/restart')
    expect(res.statusCode).toBe(409)
    expect(posted).toEqual([])
  })

  test('a staged update whose folder has gone is refused', async () => {
    const s = appServer()
    const staged = stage(s)
    rmSync(staged, { recursive: true, force: true })
    expect((await s.post('/update/restart')).statusCode).toBe(409)
    expect(posted).toEqual([])
  })

  test('refuses a cross-site POST like every other write', async () => {
    const s = appServer()
    stage(s)
    const res = await s.app.inject({ method: 'POST', url: '/update/restart', ...form(), headers: { ...form().headers, 'sec-fetch-site': 'cross-site' } })
    expect(res.statusCode).toBe(403)
    expect(posted).toEqual([])
  })
})

describe('POST /update in app mode', () => {
  test('stages the release the check found, without waiting for it, and returns to the update section', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    const res = await s.post('/update')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/health#update')
    expect(s.stages).toEqual([expect.objectContaining({ version: '0.4.0', appBundle: s.appBundle, supportDir: s.supportDir })])
    expect(s.gitRuns).toEqual([])
  })

  test('refuses with 409 unless the stored check is behind', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, CURRENT, NOW)
    expect((await s.post('/update')).statusCode).toBe(409)
    expect(s.stages).toEqual([])
  })

  test('a second press while a download is going starts nothing', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, { state: 'downloading', version: '0.4.0', startedAt: new Date(NOW.getTime() - 60_000) })
    const res = await s.post('/update')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/health#update')
    expect(s.stages).toEqual([])
  })

  test('nor does a second press while this process is still staging, whatever the file says', async () => {
    let release!: (st: AppUpdateStatus) => void
    const calls: unknown[] = []
    const s = appServer({ stage: d => { calls.push(d); return new Promise(r => { release = r }) } })
    recordUpdateCheck(s.db, BEHIND, NOW)
    await s.post('/update')
    await s.post('/update')
    expect(calls).toHaveLength(1)
    release({ state: 'failed', version: '0.4.0', reason: 'x', startedAt: NOW, finishedAt: NOW })
    await vi.waitFor(async () => {
      await s.post('/update')
      expect(calls).toHaveLength(2)
    })
  })

  test('a download that stopped answering long ago does not wedge the button', async () => {
    const s = appServer()
    recordUpdateCheck(s.db, BEHIND, NOW)
    writeAppUpdateStatus(s.statusPath, { state: 'downloading', version: '0.4.0', startedAt: new Date(NOW.getTime() - UPDATE_STALE_MS - 60_000) })
    await s.post('/update')
    expect(s.stages).toHaveLength(1)
  })

  test('a staging that throws anyway is caught, so the server stays up', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = appServer({ stage: async () => { throw new Error('boom') } })
      recordUpdateCheck(s.db, BEHIND, NOW)
      expect((await s.post('/update')).statusCode).toBe(303)
      expect((await s.get('/health')).statusCode).toBe(200)
    } finally { errors.mockRestore() }
  })
})

describe('POST /update/check in app mode', () => {
  test('asks the app\'s release check, stores the answer and returns to the update section', async () => {
    const s = appServer({ check: async () => BEHIND })
    const res = await s.post('/update/check')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/health#update')
    expect(getUpdateCheck(s.db)).toMatchObject({ state: 'behind', version: '0.4.0' })
    expect(s.gitRuns).toEqual([])
  })
})

describe('the support bundle in app mode', () => {
  test('describes the app and tails its log, with no launchd section', async () => {
    const s = appServer({ restarts: 2 })
    writeFileSync(join(s.logDir, 'server.log'), 'first line\n2026-10-26T10:00:00Z listening on http://127.0.0.1:8797\n')
    const body = (await s.post('/support')).body
    expect(body).toContain('Parcels 0.3.0')
    expect(body).toContain('Electron')
    expect(body).toContain('restarts 2')
    expect(body).toContain('listening on http://127.0.0.1:8797')
    expect(body).not.toContain('launchctl')
    expect(body).not.toContain('local.parcels.')
  })
})

describe('the "update available" notification for the app', () => {
  const notify = (db: Database, now = NOW) => buildNotifications(db, [], now, 8797).filter(n => n.groupKey === 'update')

  test('is sent once per new version, keyed on the version because a release has no commit', () => {
    vi.stubEnv('PARCELS_HOST', 'app')
    const db = memDb()
    recordUpdateCheck(db, BEHIND, NOW)
    const first = notify(db)
    expect(first).toHaveLength(1)
    expect(first[0]!.title).toMatch(/Parcels update is available/)
    expect(first[0]!.message).toContain('0.4.0')
    for (const hours of [1, 2, 48]) {
      const at = new Date(NOW.getTime() + hours * 3_600_000)
      recordUpdateCheck(db, BEHIND, at)
      expect(notify(db, at)).toEqual([])
    }
    const later = new Date(NOW.getTime() + 3 * DAY)
    recordUpdateCheck(db, { ...BEHIND, version: '0.5.0' }, later)
    expect(notify(db, later)).toHaveLength(1)
  })

  test('under git a check with no commit is still not announced, as before', () => {
    const db = memDb()
    recordUpdateCheck(db, { ...BEHIND, upstream: 'origin/main' }, NOW)
    expect(notify(db)).toEqual([])
  })
})
