import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { appendRotating } from '../../app/logs.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'parcels-logs-')); dirs.push(d); return d }

test('appendRotating creates the folder and the file, and appends', () => {
  const path = join(temp(), 'Logs', 'Parcels', 'server.log')
  appendRotating(path, 'one\n')
  appendRotating(path, 'two\n')
  expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n')
  // Logs can quote a mail subject or a tracking number, so only the user may read them.
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('a chunk that would pass the limit moves the old content to <path>.1 and starts afresh', () => {
  const path = join(temp(), 'server.log')
  appendRotating(path, 'a'.repeat(8), 10)
  appendRotating(path, 'bb', 10)
  expect(readFileSync(path, 'utf8')).toBe('a'.repeat(8) + 'bb')
  expect(existsSync(`${path}.1`)).toBe(false)
  appendRotating(path, 'c', 10)
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('a'.repeat(8) + 'bb')
  expect(readFileSync(path, 'utf8')).toBe('c')
})

test('rotating again replaces the old <path>.1, so only one old file is kept', () => {
  const dir = temp()
  const path = join(dir, 'server.log')
  writeFileSync(`${path}.1`, 'ancient')
  appendRotating(path, 'x'.repeat(10), 10)
  appendRotating(path, 'y', 10)
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(10))
  expect(readFileSync(path, 'utf8')).toBe('y')
})

test('a single chunk larger than the limit is written rather than dropped or rotated into an empty file', () => {
  const path = join(temp(), 'server.log')
  appendRotating(path, 'z'.repeat(20), 10)
  expect(readFileSync(path, 'utf8')).toBe('z'.repeat(20))
  expect(existsSync(`${path}.1`)).toBe(false)
})

test('the limit counts bytes, not characters', () => {
  const path = join(temp(), 'server.log')
  appendRotating(path, 'ľšč', 10) // six bytes in UTF-8
  appendRotating(path, 'žýá', 10) // six more: twelve would pass ten
  expect(readFileSync(`${path}.1`, 'utf8')).toBe('ľšč')
  expect(readFileSync(path, 'utf8')).toBe('žýá')
})
