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
