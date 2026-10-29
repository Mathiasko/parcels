import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { host, resourceRoot } from '../src/core/host.js'
import { appVersion, repoRoot } from '../src/core/version.js'

const temps: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('host', () => {
  test('an environment without PARCELS_HOST is the git install; PARCELS_HOST=app is the app', () => {
    expect(host({})).toBe('git')
    expect(host({ PARCELS_HOST: 'app' })).toBe('app')
  })

  test('only the exact word "app" counts, so a stray value cannot switch the wording and behaviour', () => {
    expect(host({ PARCELS_HOST: 'App' })).toBe('git')
    expect(host({ PARCELS_HOST: '' })).toBe('git')
    expect(host({ PARCELS_HOST: 'git' })).toBe('git')
  })
})

describe('resourceRoot', () => {
  test('in the app it is the folder the main process passed, which holds gmail-filter.xml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parcels-resources-'))
    temps.push(dir)
    writeFileSync(join(dir, 'gmail-filter.xml'), '<feed/>')
    expect(resourceRoot({ PARCELS_HOST: 'app', PARCELS_RESOURCES: dir })).toBe(dir)
  })

  test('in the git install it is the checkout, even if PARCELS_RESOURCES happens to be set', () => {
    expect(resourceRoot({})).toBe(repoRoot())
    expect(resourceRoot({ PARCELS_RESOURCES: '/elsewhere' })).toBe(repoRoot())
  })

  test('the app without PARCELS_RESOURCES falls back to the checkout rather than to an empty path', () => {
    expect(resourceRoot({ PARCELS_HOST: 'app' })).toBe(repoRoot())
    expect(resourceRoot({ PARCELS_HOST: 'app', PARCELS_RESOURCES: '' })).toBe(repoRoot())
  })

  test('with no argument it reads the process environment', () => {
    vi.stubEnv('PARCELS_HOST', 'app')
    vi.stubEnv('PARCELS_RESOURCES', '/somewhere/Resources')
    expect(resourceRoot()).toBe('/somewhere/Resources')
  })
})

describe('appVersion under the app host', () => {
  test('is the version the app was built as, from PARCELS_APP_VERSION', () => {
    vi.stubEnv('PARCELS_HOST', 'app')
    vi.stubEnv('PARCELS_APP_VERSION', '0.3.0')
    expect(appVersion()).toBe('0.3.0')
  })

  test('without PARCELS_APP_VERSION it falls back to the checkout resolution', () => {
    const git = appVersion()
    vi.stubEnv('PARCELS_HOST', 'app')
    vi.stubEnv('PARCELS_APP_VERSION', '')
    expect(appVersion()).toBe(git)
  })

  test('the git install ignores PARCELS_APP_VERSION', () => {
    const git = appVersion()
    vi.stubEnv('PARCELS_APP_VERSION', '9.9.9')
    expect(appVersion()).toBe(git)
  })
})
