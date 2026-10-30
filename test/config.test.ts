import { test, expect, describe } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadRuntimeConfig, validateConfig, DEFAULT_NOTIFICATIONS, CURRENT_FILTER_VERSION } from '../src/core/config.js'

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/config/${name}`, import.meta.url))

test('loadConfig applies defaults when fields are absent', () => {
  const c = loadConfig(fixturePath('minimal.json'))
  expect(c.port).toBe(8787)
  expect(c.dbPath).toBe('data/parcels.db')
  expect(c.notifier).toBe('auto')
})
test('loadConfig throws a named error when defaultPostalCode is missing', () => {
  expect(() => loadConfig(fixturePath('no-zip.json'))).toThrow(/defaultPostalCode/)
})
test('loadConfig leaves imap undefined when absent', () => {
  expect(loadConfig(fixturePath('minimal.json')).imap).toBeUndefined()
})
test('loadConfig turns the map preview on by default and takes false as the opt-out', () => {
  expect(loadConfig(fixturePath('minimal.json')).mapPreview).toBe(true)
  expect(loadConfig(fixturePath('no-map-preview.json')).mapPreview).toBe(false)
})
test('loadConfig rejects a mapPreview that is not a boolean', () => {
  expect(() => loadConfig(fixturePath('bad-map-preview.json'))).toThrow(/mapPreview/)
})

test('loadRuntimeConfig resolves a relative dbPath against the config file, not the cwd', () => {
  const c = loadRuntimeConfig(fixturePath('minimal.json'))
  expect(c.dbPath).toBe(fileURLToPath(new URL('./fixtures/config/data/parcels.db', import.meta.url)))
})

describe('appearance', () => {
  const base = { defaultPostalCode: '81101' }

  test('absent, or an empty block, is the defaults: Postal, following the system', () => {
    expect(validateConfig(base).appearance).toEqual({ theme: 'postal', mode: 'system' })
    expect(validateConfig({ ...base, appearance: {} }).appearance).toEqual({ theme: 'postal', mode: 'system' })
  })

  test('a given theme and mode are kept, and a missing half takes its default', () => {
    expect(validateConfig({ ...base, appearance: { theme: 'classic', mode: 'dark' } }).appearance)
      .toEqual({ theme: 'classic', mode: 'dark' })
    expect(validateConfig({ ...base, appearance: { mode: 'light' } }).appearance)
      .toEqual({ theme: 'postal', mode: 'light' })
  })

  test('a result never shares its object with another, so a caller cannot change the defaults', () => {
    const a = validateConfig(base).appearance!
    a.theme = 'classic'
    expect(validateConfig(base).appearance).toEqual({ theme: 'postal', mode: 'system' })
  })

  test.each([[null], ['dark'], [[]]])('rejects an appearance that is not an object (%j)', (appearance) => {
    expect(() => validateConfig({ ...base, appearance })).toThrow(/"appearance" must be an object/)
  })

  test.each([['Postal'], ['kraft']])('rejects the unknown theme %j, naming the label and the allowed values', (theme) => {
    expect(() => validateConfig({ ...base, appearance: { theme } }, 'my.json'))
      .toThrow(/config my\.json: "appearance\.theme" must be one of postal, classic/)
  })

  test('rejects an unknown mode, naming the label and the allowed values', () => {
    expect(() => validateConfig({ ...base, appearance: { mode: 'auto' } }, 'my.json'))
      .toThrow(/config my\.json: "appearance\.mode" must be one of system, light, dark/)
  })

  test('keys inside appearance that this version does not know are not an error', () => {
    expect(() => validateConfig({ ...base, appearance: { theme: 'classic', extra: 1 } })).not.toThrow()
  })
})

describe('the notifications block', () => {
  const base = { defaultPostalCode: '81101' }

  test('absent means the defaults: progress off, the daily reminder and delivered on', () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({ progress: false, dailyReminder: true, delivered: true })
    expect(validateConfig(base).notifications).toEqual({ progress: false, dailyReminder: true, delivered: true })
  })

  test('a partial block keeps its keys and fills the rest from the defaults', () => {
    expect(validateConfig({ ...base, notifications: { progress: true } }).notifications)
      .toEqual({ progress: true, dailyReminder: true, delivered: true })
  })

  test('the returned block is a copy, so a caller cannot change the defaults', () => {
    const n = validateConfig(base).notifications
    n.progress = true
    expect(DEFAULT_NOTIFICATIONS.progress).toBe(false)
  })

  test('a switch that is not a boolean is rejected by name', () => {
    expect(() => validateConfig({ ...base, notifications: { delivered: 'no' } })).toThrow(/"notifications.delivered" must be true or false/)
  })

  test('a key that is not a switch is rejected by name', () => {
    expect(() => validateConfig({ ...base, notifications: { sound: true } })).toThrow(/"notifications.sound" is not a setting/)
  })

  test('a block that is not an object is rejected', () => {
    expect(() => validateConfig({ ...base, notifications: [] })).toThrow(/"notifications" must be an object/)
    expect(() => validateConfig({ ...base, notifications: 1 })).toThrow(/"notifications" must be an object/)
  })
})

describe('the filter version', () => {
  const base = { defaultPostalCode: '81101' }

  test('absent means 1: a filter imported before versions existed', () => {
    expect(validateConfig(base).filterVersion).toBe(1)
  })

  test('a stored version is taken as it is, and this build ships version 2', () => {
    expect(validateConfig({ ...base, filterVersion: 2 }).filterVersion).toBe(2)
    expect(CURRENT_FILTER_VERSION).toBe(2)
  })

  test.each([0, 1.5, -1, '2', null, true])('%j is not a version', (bad) => {
    expect(() => validateConfig({ ...base, filterVersion: bad })).toThrow(/"filterVersion" must be a whole number from 1/)
  })
})
