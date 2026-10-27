import { expect, test, vi } from 'vitest'
import type { PollDeps, PollReport } from '../src/core/poll.js'

// Capture what the entry points hand to runPoll; the real one would open a mailbox.
const calls: PollDeps[] = []
vi.mock('../src/core/poll.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/core/poll.js')>()),
  runPoll: async (deps: PollDeps): Promise<PollReport> => {
    calls.push(deps)
    return { polled: 0, newEvents: [], failures: [], notifications: [] } as unknown as PollReport
  },
}))

const { runCli } = await import('../src/cli.js')
const { buildPollDeps } = await import('../src/core/runtime.js')
const { config, memDb } = await import('./poll-helpers.js')

const imap = { host: 'imap.example.com', port: 993, user: 'u@example.com', pass: 'x', mailbox: 'parcels' }

test('cli poll passes an ingest option when imap is configured, same as the scheduled poller', async () => {
  calls.length = 0
  const db = memDb()
  const cfg = { ...config, dbPath: '/tmp/parcels-test/parcels.db', imap }
  const code = await runCli(['poll'], { db, config: cfg, out: () => {}, err: () => {}, http: { get: async () => { throw new Error('no network') } } as never, adapters: [], notifier: { send: async () => {} } as never })
  expect(code).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.ingest).toEqual({ imap, mailDir: '/tmp/parcels-test/mail' })
})

test('cli poll passes no ingest option when imap is not configured', async () => {
  calls.length = 0
  await runCli(['poll'], { db: memDb(), config: { ...config, imap: undefined }, out: () => {}, err: () => {}, adapters: [], notifier: { send: async () => {} } as never })
  expect(calls[0]!.ingest).toBeUndefined()
})

test('buildPollDeps lets a caller override pieces without losing ingest', () => {
  const deps = buildPollDeps(memDb(), { ...config, dbPath: '/tmp/parcels-test/parcels.db', imap }, { forceAll: true, adapters: [] })
  expect(deps.forceAll).toBe(true)
  expect(deps.adapters).toEqual([])
  expect(deps.ingest?.mailDir).toBe('/tmp/parcels-test/mail')
})
