import { describe, expect, test } from 'vitest'
import { DEV_RELEASES_FLAG, devReleasesUrl, hasDevReleasesFlag } from '../../app/dev-releases.js'

// Ruling R16: PARCELS_RELEASES_URL is followed only by an unpackaged dev run or a bundle built with the
// test flag. The decision is made from injected values; no app, no environment and no network.
const URL_LOCAL = 'http://127.0.0.1:8899/releases/latest'

describe('which runs may follow a test release feed', () => {
  test('a packaged release build never does, whatever the environment says', () => {
    expect(devReleasesUrl({ packaged: true, flagged: false, url: URL_LOCAL })).toBeUndefined()
    expect(devReleasesUrl({ packaged: true, flagged: false, url: 'https://example.com/releases/latest' })).toBeUndefined()
  })

  test('a packaged test build carrying the flag does', () => {
    expect(devReleasesUrl({ packaged: true, flagged: true, url: URL_LOCAL })).toBe(URL_LOCAL)
  })

  test('an unpackaged dev run does', () => {
    expect(devReleasesUrl({ packaged: false, flagged: false, url: URL_LOCAL })).toBe(URL_LOCAL)
  })

  test('no variable, or an empty one, means GitHub', () => {
    expect(devReleasesUrl({ packaged: false, flagged: true, url: undefined })).toBeUndefined()
    expect(devReleasesUrl({ packaged: true, flagged: true, url: '' })).toBeUndefined()
  })

  test('an address that is neither https nor this Mac is never followed, even where a feed is allowed', () => {
    expect(devReleasesUrl({ packaged: true, flagged: true, url: 'http://example.com/releases/latest' })).toBeUndefined()
    expect(devReleasesUrl({ packaged: false, flagged: false, url: 'file:///tmp/latest' })).toBeUndefined()
    expect(devReleasesUrl({ packaged: false, flagged: false, url: 'nonsense' })).toBeUndefined()
  })
})

describe('reading the flag from package.json', () => {
  test('only an exact true counts', () => {
    expect(hasDevReleasesFlag(JSON.stringify({ name: 'parcels', [DEV_RELEASES_FLAG]: true }))).toBe(true)
    expect(hasDevReleasesFlag(JSON.stringify({ name: 'parcels', [DEV_RELEASES_FLAG]: 'true' }))).toBe(false)
    expect(hasDevReleasesFlag(JSON.stringify({ name: 'parcels', [DEV_RELEASES_FLAG]: false }))).toBe(false)
    expect(hasDevReleasesFlag(JSON.stringify({ name: 'parcels' }))).toBe(false)
  })

  test('a missing or broken package.json is no flag', () => {
    expect(hasDevReleasesFlag(undefined)).toBe(false)
    expect(hasDevReleasesFlag('{ not json')).toBe(false)
    expect(hasDevReleasesFlag('null')).toBe(false)
  })
})
