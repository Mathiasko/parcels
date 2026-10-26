import { test, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/core/config.js'

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
