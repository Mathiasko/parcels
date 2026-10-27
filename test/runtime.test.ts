import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { clearDpdCaches, dpdAdapter, setDpdAuthStore } from '../src/carriers/dpd.js'
import { initRuntime } from '../src/core/runtime.js'
import type { HttpClient } from '../src/core/types.js'
import { config } from './poll-helpers.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/dpd/${name}`, import.meta.url), 'utf8')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parcels-runtime-')); setDpdAuthStore(undefined); clearDpdCaches() })
afterEach(() => { setDpdAuthStore(undefined); clearDpdCaches(); rmSync(dir, { recursive: true, force: true }) })

/** Serves DPD's Firebase -> OAuth chain and a not-found answer, with no network. */
const dpdStub: HttpClient = async url => {
  const body = url.includes('firebaseinstallations') ? fixture('firebase-installations.json')
    : url.includes('firebaseremoteconfig') ? fixture('firebase-config.json')
    : url.includes('/oauth/token') ? fixture('oauth-token.json')
    : fixture('not-found.json')
  const status = url.includes('/parcels/details/') ? 400 : 200
  return { status, headers: {}, text: async () => body, json: async <T>() => JSON.parse(body) as T }
}

test('initRuntime makes a DPD poll persist its auth beside the database', async () => {
  const dbPath = join(dir, 'parcels.db')
  initRuntime({ ...config, dbPath })
  await dpdAdapter.fetch([{ number: '01234567890123' }], dpdStub)
  expect(existsSync(join(dir, 'dpd-auth.json'))).toBe(true)
})

test('without initRuntime the same poll leaves no auth file (memory-only fallback)', async () => {
  await dpdAdapter.fetch([{ number: '01234567890123' }], dpdStub)
  expect(existsSync(join(dir, 'dpd-auth.json'))).toBe(false)
})

test('every entry point that can poll calls initRuntime(config)', () => {
  // The three are separate processes with no exports to drive, so guard the wiring at the source.
  for (const entry of ['poll.ts', 'cli.ts', 'server.ts']) {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8')
    expect(source, entry).toMatch(/\binitRuntime\(config\)/)
    expect(source, entry).not.toMatch(/setDpdAuthStore/)   // one place sets it
  }
})

test('poll.ts and cli.ts build their run with buildPollDeps, so they cannot drift', () => {
  for (const entry of ['poll.ts', 'cli.ts']) {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8')
    expect(source, entry).toMatch(/runPoll\(buildPollDeps\(/)
  }
})
