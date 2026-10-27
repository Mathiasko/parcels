import { test, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig, loadRuntimeConfig } from '../src/core/config.js'

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
