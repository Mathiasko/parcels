import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// scripts/app/check-fonts.mjs proves the packaged app's app.asar holds every theme font the server
// serves at /fonts/<file>. Here it is run against a fake Parcels.app whose app.asar is made with
// @electron/asar; nothing is built, signed or opened.
const SCRIPT = fileURLToPath(new URL('../../scripts/app/check-fonts.mjs', import.meta.url))
const FONTS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
const asar = createRequire(import.meta.url)('@electron/asar') as {
  createPackage(src: string, dest: string): Promise<void>
}
const repoFonts = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'))

describe('check-fonts.mjs', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-fonts-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A Parcels.app whose app.asar holds package.json and the given files under assets/fonts/. */
  const fakeApp = async (fonts: string[], name = 'Parcels.app') => {
    const src = join(dir, `src-${name}`)
    mkdirSync(join(src, 'assets', 'fonts'), { recursive: true })
    writeFileSync(join(src, 'package.json'), '{}')
    for (const f of fonts) writeFileSync(join(src, 'assets', 'fonts', f), 'font')
    const app = join(dir, name)
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    await asar.createPackage(src, join(app, 'Contents', 'Resources', 'app.asar'))
    return app
  }
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('the repo has fonts to check', () => {
    expect(repoFonts.length).toBeGreaterThan(0)
  })

  test('an app.asar holding every font passes', async () => {
    const r = run(await fakeApp(repoFonts))
    expect(r.code).toBe(0)
    expect(r.out).toContain('ok')
  })

  test('an app.asar missing a font fails and names it', async () => {
    const missing = repoFonts[0]
    const r = run(await fakeApp(repoFonts.slice(1)))
    expect(r.code).toBe(1)
    expect(r.out).toContain(missing)
  })

  test('an app.asar missing every font names each of them', async () => {
    const r = run(await fakeApp([]))
    expect(r.code).toBe(1)
    for (const f of repoFonts) expect(r.out).toContain(f)
  })

  test('an app without an app.asar fails', () => {
    const app = join(dir, 'Empty.app')
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    const r = run(app)
    expect(r.code).toBe(1)
    expect(r.out).toContain('app.asar')
  })

  test('no argument is a usage error', () => {
    const r = run()
    expect(r.code).toBe(2)
    expect(r.out).toContain('usage')
  })
})
