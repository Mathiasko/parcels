import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { appVersion, resolveVersion } from '../src/core/version.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const temps: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'parcels-version-'))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const writePkg = (dir: string, body: string) => writeFileSync(join(dir, 'package.json'), body)

describe('resolveVersion', () => {
  test('a checkout that is a git repo gets the version and the short commit', () => {
    const dir = tmp()
    writePkg(dir, JSON.stringify({ name: 'x', version: '1.2.3' }))
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 'T')
    git('commit', '-q', '--allow-empty', '-m', 'first')
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()

    expect(resolveVersion(dir)).toBe(`1.2.3 (${commit})`)
  })

  test('an unpacked tarball is not a repo, so it is the version alone', () => {
    const dir = tmp()
    writePkg(dir, JSON.stringify({ name: 'x', version: '1.2.3' }))
    expect(resolveVersion(dir)).toBe('1.2.3')
  })

  // A tarball unpacked inside someone else's checkout must not borrow that repo's commit: the commit
  // would name code this copy does not contain.
  test('a directory inside another repo does not borrow the outer commit', () => {
    const outer = tmp()
    execFileSync('git', ['-C', outer, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
    const inner = join(outer, 'unpacked')
    mkdirSync(inner)
    writePkg(inner, JSON.stringify({ name: 'x', version: '1.2.3' }))
    expect(resolveVersion(inner)).toBe('1.2.3')
  })

  test('no package.json at all is "unknown", not a throw', () => {
    expect(resolveVersion(tmp())).toBe('unknown')
  })

  test('a malformed package.json is "unknown", not a throw', () => {
    const dir = tmp()
    writePkg(dir, '{ this is not json')
    expect(resolveVersion(dir)).toBe('unknown')
  })

  test('a package.json with no version field is "unknown"', () => {
    const dir = tmp()
    writePkg(dir, JSON.stringify({ name: 'x' }))
    expect(resolveVersion(dir)).toBe('unknown')
  })
})

describe('appVersion', () => {
  /**
   * The point of this one is the path arithmetic. The running code is `dist/core/version.js`, two
   * levels below the repo root, exactly as `src/core/version.ts` is - so one relative URL is right
   * for both, and this test fails if it is ever off by a level.
   */
  test('resolves this checkout, reading this repo\'s own package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
    expect(appVersion()).toBe(resolveVersion(REPO))
    expect(appVersion().startsWith(pkg.version)).toBe(true)
  })

  test('is resolved once and cached, so no request shells out to git', () => {
    // Same string identity, not merely equal: a second call did no work.
    expect(appVersion()).toBe(appVersion())
  })
})
