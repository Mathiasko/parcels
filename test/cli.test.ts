import { test, expect } from 'vitest'
import { runCli } from '../src/cli.js'
import { allAdapters, register } from '../src/carriers/registry.js'
import { MAX_LABEL } from '../src/web/actions.js'
import { appendEvents } from '../src/db/events.js'
import { findParcel, insertParcel, updateParcelState } from '../src/db/parcels.js'
import type { CarrierAdapter, CarrierId } from '../src/core/types.js'
import { config, memDb, ev } from './poll-helpers.js'

// The registry already holds the real posta adapter. gls and dpd are registered as stand-ins that
// both claim a bare 14-digit number, which is what makes detection ambiguous.
const claims14Digits = (id: CarrierId): CarrierAdapter => ({
  id, matches: n => /^\d{14}$/.test(n), needsPostalCode: true, batchSize: 1, fetch: async () => [],
})
register(claims14Digits('gls'))
register(claims14Digits('dpd'))

async function cli(db: ReturnType<typeof memDb>, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { db, config, out: s => out.push(s), err: s => err.push(s) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('add normalises the number and auto-detects an unambiguous carrier', async () => {
  const db = memDb()
  const r = await cli(db, 'add', 'ra 123-456 785 sk')
  expect(r.code).toBe(0)
  expect(findParcel(db, 'posta', 'RA123456785SK')).toMatchObject({ carrier: 'posta', source: 'manual' })
})

test('add requires --carrier when detection is ambiguous and exits with a clear message', async () => {
  const db = memDb()
  const ambiguous = await cli(db, 'add', '01234567890123')
  expect(ambiguous.code).toBe(1)
  expect(ambiguous.err).toMatch(/gls/)
  expect(ambiguous.err).toMatch(/dpd/)
  expect(ambiguous.err).toMatch(/--carrier/)
  expect(findParcel(db, 'dpd', '01234567890123')).toBeUndefined()
  expect(findParcel(db, 'gls', '01234567890123')).toBeUndefined()

  const unrecognised = await cli(db, 'add', 'hello')
  expect(unrecognised.code).toBe(1)
  expect(unrecognised.err).toMatch(/--carrier/)

  const chosen = await cli(db, 'add', '01234567890123', '--carrier', 'dpd')
  expect(chosen.code).toBe(0)
  expect(findParcel(db, 'dpd', '01234567890123')).toBeDefined()
})

test('add --carrier overrides the shape check', async () => {
  const db = memDb()
  const r = await cli(db, 'add', 'hello', '--carrier', 'posta')
  expect(r.code).toBe(0)
  expect(findParcel(db, 'posta', 'HELLO')).toBeDefined()
})

test('add rejects a duplicate carrier+number with a friendly message, not a stack trace', async () => {
  const db = memDb()
  await cli(db, 'add', 'RA123456785SK')
  const again = await cli(db, 'add', 'ra123456785sk')
  expect(again.code).toBe(1)
  expect(again.err).toMatch(/already tracking RA123456785SK/)
  expect(again.err).not.toMatch(/UNIQUE|SqliteError|\bat .*\(/)
})

test('add defaults the postal code from config', async () => {
  const db = memDb()
  await cli(db, 'add', 'RA123456785SK')
  expect(findParcel(db, 'posta', 'RA123456785SK')?.postalCode).toBe(config.defaultPostalCode)

  await cli(db, 'add', 'RA987654326SK', '--zip', '04001')
  expect(findParcel(db, 'posta', 'RA987654326SK')?.postalCode).toBe('04001')
})

test('add stores what the web form would: postcode without spaces, label within its cap', async () => {
  const db = memDb()
  const r = await cli(db, 'add', 'RA123456785SK', '--zip', '811 01', '--label', 'x'.repeat(500))
  expect(r.code).toBe(0)
  const p = findParcel(db, 'posta', 'RA123456785SK')!
  expect(p.postalCode).toBe('81101')
  expect(p.label).toHaveLength(MAX_LABEL)
})

test('add refuses a number too long to be one, as the web form does', async () => {
  const db = memDb()
  const r = await cli(db, 'add', 'RA'.repeat(30), '--carrier', 'posta')
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/too long/)
  expect(db.prepare('SELECT COUNT(*) n FROM parcels').get()).toEqual({ n: 0 })
})

test('add knows every registered carrier, so a new one cannot be left out of the list', async () => {
  const r = await cli(memDb(), 'add', '1', '--carrier', 'nope')
  for (const c of allAdapters()) expect(r.err).toContain(c.id)
  expect(r.code).toBe(1)
})

test('list prints one line per active parcel with label, carrier and status', async () => {
  const db = memDb()
  const a = insertParcel(db, { carrier: 'posta', trackingNumber: 'RA123456785SK', label: 'Headphones', source: 'manual' })
  updateParcelState(db, a, { status: 'out_for_delivery' })
  insertParcel(db, { carrier: 'dpd', trackingNumber: '01234567890123', label: 'Shoes', source: 'manual' })
  const done = insertParcel(db, { carrier: 'gls', trackingNumber: '31217533227', label: 'Old book', source: 'manual' })
  updateParcelState(db, done, { status: 'delivered' })

  const lines = (await cli(db, 'list')).out.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/Headphones/)
  expect(lines[0]).toMatch(/posta/)
  expect(lines[0]).toMatch(/out_for_delivery/)
  expect(lines[1]).toMatch(/Shoes/)
  expect(lines[1]).toMatch(/dpd/)
  expect(lines[1]).toMatch(/unknown/)
})

test('list also shows a returned parcel, which is outside "active" but not finished business', async () => {
  const db = memDb()
  insertParcel(db, { carrier: 'dpd', trackingNumber: '01234567890123', label: 'Shoes', source: 'manual' })
  const back = insertParcel(db, { carrier: 'posta', trackingNumber: 'RA123456785SK', label: 'Sent back', source: 'manual' })
  updateParcelState(db, back, { status: 'returned' })

  const lines = (await cli(db, 'list')).out.split('\n')
  expect(lines[0]).toMatch(/Shoes/)
  expect(lines[1]).toMatch(/returned to sender/)
  expect(lines[2]).toMatch(/Sent back.*returned/)
  expect(lines).toHaveLength(3)
})

test('show prints the event timeline oldest-first', async () => {
  const db = memDb()
  const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RA123456785SK', label: 'Headphones', source: 'manual' })
  // inserted newest-first so that insertion order cannot be what the output follows
  appendEvents(db, id, [
    ev('2026-10-26 08:00:00', 'out_for_delivery', 3, 'Out for delivery'),
    ev('2026-10-25 12:00:00', 'in_transit', 22, 'Sorted at depot'),
    ev('2026-10-24 09:00:00', 'pre_transit', 49, 'Registered'),
  ])

  const r = await cli(db, 'show', String(id))
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/Headphones/)
  const at = (s: string) => r.out.indexOf(s)
  expect(at('Registered')).toBeGreaterThan(-1)
  expect(at('Registered')).toBeLessThan(at('Sorted at depot'))
  expect(at('Sorted at depot')).toBeLessThan(at('Out for delivery'))

  const missing = await cli(db, 'show', '999')
  expect(missing.code).toBe(1)
  expect(missing.err).toMatch(/no parcel #999/)
})

test('collected marks a parcel in flight as collected, through the same function as the button', async () => {
  const db = memDb()
  const id = insertParcel(db, { carrier: 'posta', trackingNumber: 'RA123456785SK', label: 'Headphones', source: 'manual' })
  updateParcelState(db, id, { status: 'ready_for_pickup' })

  const r = await cli(db, 'collected', String(id))
  expect(r.code).toBe(0)
  expect(r.out).toBe(`#${id} marked collected (it was ready_for_pickup). Undo it on the parcel's page.`)
  expect(findParcel(db, 'posta', 'RA123456785SK')!.status).toBe('delivered')
  const logged = db.prepare("SELECT actor FROM activity_log WHERE kind = 'collected'").all()
  expect(logged).toEqual([{ actor: 'cli' }])

  const again = await cli(db, 'collected', String(id))
  expect(again.code).toBe(1)
  expect(again.err).toBe(`parcel #${id} is not in flight (it is delivered), so there is nothing to mark`)
  expect((await cli(db, 'collected', '999')).err).toMatch(/no parcel #999/)
  expect((await cli(db, 'collected')).err).toMatch(/usage: collected <id>/)
})
