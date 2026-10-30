import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { MoveInResult } from '../../app/move-in.js'
import { firstRunHandler, NOT_A_POSTCODE, PAGE_CSP, readPages, type FirstRunDeps } from '../../app/protocol.js'

const pages = readPages(join(import.meta.dirname, '../../app/pages'))

function setup(firstRun: FirstRunDeps['firstRun'], result: MoveInResult = { ok: true }) {
  const configPath = join(mkdtempSync(join(tmpdir(), 'parcels-protocol-')), 'Parcels', 'config.json')
  const started: string[] = []
  let quits = 0
  let moves = 0
  const handle = firstRunHandler({
    firstRun, configPath, pages,
    start: path => started.push(path),
    moveIn: async () => { moves++; return result },
    quit: () => { quits++ },
    log: () => {},
  })
  const post = (host: string, body: string, headers: Record<string, string> = {}) => handle(new Request(`parcels://${host}/`, {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  }))
  return { handle, post, configPath, started, quits: () => quits, moves: () => moves }
}

const MOVE_IN: FirstRunDeps['firstRun'] = { kind: 'move-in', clone: '/Users/a/Desktop/parcels', plists: [] }

test('GET serves the page of this first run, with the stylesheet and the CSP', async () => {
  const s = setup({ kind: 'welcome' })
  const res = await s.handle(new Request('parcels://welcome/'))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP)
  const body = await res.text()
  expect(body).toContain('<h1>Welcome to Parcels</h1>')
  expect(body).toContain('--signal:light-dark(#2a4bd1,#98a9ff)')
  expect(body).not.toContain('{{')
  // The other first run's page is not served.
  expect((await s.handle(new Request('parcels://move-in/'))).status).toBe(404)
  expect((await s.handle(new Request('parcels://welcome/x'))).status).toBe(404)
})

test('the move-in page names the clone, escaped', async () => {
  const s = setup({ kind: 'move-in', clone: '/Users/a/<b>', plists: [] })
  const body = await (await s.handle(new Request('parcels://move-in/'))).text()
  expect(body).toContain('installed in <span class="mono">/Users/a/&lt;b&gt;</span>.')
})

test('a postcode is saved, the server started, and /settings shown', async () => {
  const s = setup({ kind: 'welcome' })
  const res = await s.post('welcome', 'postcode=811+01')
  expect(res.status).toBe(204)
  expect(JSON.parse(readFileSync(s.configPath, 'utf8')).defaultPostalCode).toBe('81101')
  expect(s.started).toEqual(['/settings'])
  // A second press does nothing more.
  expect((await s.post('welcome', 'postcode=01001')).status).toBe(204)
  expect(s.started).toEqual(['/settings'])
  expect(JSON.parse(readFileSync(s.configPath, 'utf8')).defaultPostalCode).toBe('81101')
})

test('a bad postcode re-renders the page with the error and what was typed', async () => {
  const s = setup({ kind: 'welcome' })
  const res = await s.post('welcome', 'postcode=8110%22')
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain(NOT_A_POSTCODE)
  expect(body).toContain('value="8110&quot;"')
  expect(existsSync(s.configPath)).toBe(false)
  expect(s.started).toEqual([])
})

test('Move in moves, starts the server and shows the dashboard', async () => {
  const s = setup(MOVE_IN)
  expect((await s.post('move-in', 'action=move')).status).toBe(204)
  expect(s.moves()).toBe(1)
  expect(s.started).toEqual(['/'])
})

test('a failed move shows the result page with the step and the reason', async () => {
  const s = setup(MOVE_IN, { ok: false, step: 'check', reason: 'The copied database failed its check: <bad>', oldInstall: 'running' })
  const res = await s.post('move-in', 'action=move')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP)
  const body = await res.text()
  expect(body).toContain('Checking the copy did not work.')
  expect(body).toContain('The copied database failed its check: &lt;bad&gt;')
  expect(body).toContain('Nothing was moved, and <span class="mono">/Users/a/Desktop/parcels</span> is as it was.')
  expect(body).toContain('You can try again, or quit and go on using the old install.')
  expect(body).not.toContain('install-agents.sh')
  expect(s.started).toEqual([])
})

test('a failed move whose old install could not be started again says so, and how to start it', async () => {
  const s = setup(MOVE_IN, { ok: false, step: 'copy', reason: 'x.', oldInstall: 'not-running' })
  const body = await (await s.post('move-in', 'action=move')).text()
  expect(body).toContain('Nothing was moved, but the old install in <span class="mono">/Users/a/Desktop/parcels</span> is not running now.')
  expect(body).toContain('To start it again, open Terminal in that folder and run scripts/install-agents.sh. Or try moving in again.')
  expect(body).not.toContain('is as it was')
  expect(body).not.toContain('go on using the old install')
})

test('Not now (quit) quits', async () => {
  const s = setup(MOVE_IN)
  expect((await s.post('move-in', 'action=quit')).status).toBe(204)
  expect(s.quits()).toBe(1)
  expect(s.moves()).toBe(0)
})

test('a post from anywhere but a parcels: page is refused', async () => {
  const s = setup(MOVE_IN)
  expect((await s.post('move-in', 'action=move', { origin: 'http://127.0.0.1:8787' })).status).toBe(403)
  expect(s.moves()).toBe(0)
  expect((await s.post('move-in', 'action=move', { origin: 'parcels://move-in' })).status).toBe(204)
})

test('an unknown action is refused', async () => {
  const s = setup(MOVE_IN)
  expect((await s.post('move-in', 'action=delete')).status).toBe(400)
  expect(s.moves()).toBe(0)
})
