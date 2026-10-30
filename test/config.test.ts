import { test, expect, describe } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadRuntimeConfig, validateConfig } from '../src/core/config.js'

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
