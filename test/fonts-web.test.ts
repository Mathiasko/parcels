import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildServer, CSP, type WebDeps } from '../src/web/server.js'
import { FONT_FILES, FONT_HEADERS, fontDir, readFont } from '../src/web/fonts.js'
import { THEMES } from '../src/web/themes/index.js'
import { config, memDb, NOW } from './poll-helpers.js'

const EXACT_CSP = "default-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
const FONT = 'courier-prime-latin-400-normal.woff2'

const get = (url: string, extra: Partial<WebDeps> = {}) =>
  buildServer({ db: memDb(), config, now: () => NOW, ...extra }).inject({ method: 'GET', url })

/**
 * A font dir holding things that must never be served: a planted .woff2 off the list, a licence, a
 * readme, a font in a subfolder. The dir is `<tmp>/fonts`, and `<tmp>` holds a `config.json` and a
 * `package.json`, so a `../` that escaped the allowlist would land on a real file and serve PLANTED
 * (rather than 404 because there is nothing there).
 */
function plantedDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'parcels-fonts-'))
  writeFileSync(join(root, 'config.json'), 'PLANTED-config-bytes')
  writeFileSync(join(root, 'package.json'), 'PLANTED-package-bytes')
  const dir = join(root, 'fonts')
  mkdirSync(dir)
  writeFileSync(join(dir, 'secret.woff2'), 'PLANTED-secret-bytes')
  writeFileSync(join(dir, 'OFL.txt'), 'PLANTED-licence-bytes')
  writeFileSync(join(dir, 'README.md'), 'PLANTED-readme-bytes')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', FONT), 'PLANTED-nested-bytes')
  return dir
}

describe('the font allowlist', () => {
  test('is every file every theme names, and nothing else', () => {
    const named = THEMES.flatMap(t => t.fonts.map(f => f.file))
    expect(named.length).toBeGreaterThan(0)
    expect([...FONT_FILES].sort()).toEqual([...new Set(named)].sort())
    for (const f of FONT_FILES) expect(f).toMatch(/^[a-z0-9-]+\.woff2$/)
  })

  test('every allowlisted file exists in the real font dir', () => {
    for (const f of FONT_FILES) expect(readFont(fontDir(), f)?.length, f).toBeGreaterThan(1000)
  })

  test('readFont reads only allowlisted names', () => {
    const dir = plantedDir()
    for (const name of ['secret.woff2', 'OFL.txt', 'README.md', `sub/${FONT}`, `../${FONT}`, '../config.json', '../package.json', '', FONT]) {
      expect(readFont(dir, name), name).toBeUndefined()
    }
  })
})

describe('GET /fonts/:file', () => {
  test('serves an allowlisted font with the font headers', async () => {
    const res = await get(`/fonts/${FONT}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('font/woff2')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(FONT_HEADERS).toEqual({ 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' })
    expect(res.rawPayload.equals(readFileSync(join(fontDir(), FONT)))).toBe(true)
  })

  test.each([
    '/fonts/secret.woff2', '/fonts/OFL.txt', '/fonts/README.md', '/fonts/..%2fconfig.json',
    '/fonts/%2e%2e%2fpackage.json', '/fonts/', '/fonts', `/fonts/sub%2f${FONT}`, '/fonts/x.woff2',
  ])('%s is a 404 that reads nothing outside the allowlist', async url => {
    const res = await get(url, { fontDir: plantedDir() })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toMatch(/PLANTED/)
  })

  test('an allowlisted name missing from the directory is a 404, not a 500', async () => {
    const res = await get(`/fonts/${FONT}`, { fontDir: mkdtempSync(join(tmpdir(), 'parcels-fonts-empty-')) })
    expect(res.statusCode).toBe(404)
  })

  test('a font dir given in deps is the one served from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-fonts-fake-'))
    writeFileSync(join(dir, FONT), 'fake font')
    const res = await get(`/fonts/${FONT}`, { fontDir: dir })
    expect(res.body).toBe('fake font')
  })
})

describe('the CSP', () => {
  test('is exactly the two directives wider, on a page and on a font', async () => {
    expect(CSP).toBe(EXACT_CSP)
    expect((await get('/')).headers['content-security-policy']).toBe(EXACT_CSP)
    expect((await get(`/fonts/${FONT}`)).headers['content-security-policy']).toBe(EXACT_CSP)
    expect((await get('/fonts/OFL.txt')).headers['content-security-policy']).toBe(EXACT_CSP)
  })
})
