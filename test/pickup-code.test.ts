import { test, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openDb, type Database } from '../src/db/index.js'
import { insertParcel, updateParcelState, deleteParcel } from '../src/db/parcels.js'
import { getPickupCode, needsPickupCodeCheck, recordPickupCode, pickupCodesFor } from '../src/db/pickup-codes.js'
import { extractPickupCode } from '../src/ingest/extract.js'
import { runPickupCodes } from '../src/core/pickup-code.js'

let db: Database
beforeEach(() => { db = openDb(':memory:') })

const NOW = new Date('2026-10-27T10:00:00Z')

function readyParcel(number = 'Z1234567890'): number {
  const id = insertParcel(db, { carrier: 'packeta', trackingNumber: number, source: 'manual' })
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX', street: 'Hlavna 6', city: 'Bratislava' } })
  return id
}

/** A message row pointing at an .eml, as the ingest writes them. */
function mail(parcelId: number, path: string, receivedAt = '2026-10-26T17:19:00Z'): void {
  db.prepare(
    'INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parcel_id) VALUES (?, ?, ?, ?, ?, 1, ?)',
  ).run(`<${path}@test>`, receivedAt, 'noreply@packeta.sk', 'Zásielka je pripravená na vyzdvihnutie', path, parcelId)
}

// --- extraction ---------------------------------------------------------------------------------

test('reads the code out of the pickup email, digits spaced one per cell', () => {
  expect(extractPickupCode('Kód pre otvorenie schránky 9 8 7 6 5 4 Miesto, kde je vaša zásielka uložená'))
    .toBe('987654')
})

test('a leading zero survives, because the code is text and not a number', () => {
  expect(extractPickupCode('Kód pre otvorenie schránky 0 0 4 4 6 7 Miesto')).toBe('004467')
  expect(extractPickupCode('Kód pre otvorenie schránky 0 0 7 0 1 8 Miesto')).toBe('007018')
})

test('the instructions sentence, which repeats the phrase with no digits, is not matched', () => {
  // The real mail says this further down; anchoring on the phrase alone picks the wrong occurrence.
  expect(extractPickupCode(
    'Kód pre otvorenie schránky alebo stiahnutá aktuálna verzia aplikácie Packeta. Zapnuté Bluetooth.',
  )).toBeUndefined()
})

test('the first occurrence wins when the mail carries both the code and the instructions', () => {
  const body = 'Kód pre otvorenie schránky 6 5 7 0 9 1 Miesto, kde je vaša zásielka uložená Z-BOX. '
    + 'Kód pre otvorenie schránky alebo stiahnutá aktuálna verzia aplikácie Packeta'
  expect(extractPickupCode(body)).toBe('657091')
})

test('a staffed pickup point has no code to find', () => {
  expect(extractPickupCode('Zásielka je pripravená na výdaj. Vyzdvihnite si ju na pobočke.')).toBeUndefined()
})

test('the Czech spelling is read too', () => {
  expect(extractPickupCode('Kód pro otevření schránky 1 2 3 4 5 6 Místo')).toBe('123456')
})

test('a run of digits that is too short or too long is not a code', () => {
  expect(extractPickupCode('Kód pre otvorenie schránky 1 2 3 koniec')).toBeUndefined()
  expect(extractPickupCode('Kód pre otvorenie schránky 1 2 3 4 5 6 7 8 9 0 1 2 koniec')).toBeUndefined()
})

// --- storage ------------------------------------------------------------------------------------

test('a found code is never looked for again; a missing one is only re-checked when new mail arrives', () => {
  const id = readyParcel()
  expect(needsPickupCodeCheck(db, id, 0)).toBe(true)          // never checked

  recordPickupCode(db, id, undefined, 2, NOW)                 // looked at 2 mails, found nothing
  expect(needsPickupCodeCheck(db, id, 2)).toBe(false)         // same mail: do not re-read from disk
  expect(needsPickupCodeCheck(db, id, 3)).toBe(true)          // a third mail arrived: worth another look

  recordPickupCode(db, id, '405162', 3, NOW)
  expect(needsPickupCodeCheck(db, id, 9)).toBe(false)         // found is found: a locker code does not change
  expect(getPickupCode(db, id)).toBe('405162')
})

test('re-recording the same parcel keeps the code a later scan did not find again', () => {
  // The reminder mail repeats the code, but a scan that reads a different mail first must not blank it.
  const id = readyParcel()
  recordPickupCode(db, id, '657091', 1, NOW)
  recordPickupCode(db, id, undefined, 2, NOW)
  expect(getPickupCode(db, id)).toBe('657091')
})

test('a leading-zero code round-trips through the database unchanged', () => {
  const id = readyParcel()
  recordPickupCode(db, id, '004467', 1, NOW)
  expect(getPickupCode(db, id)).toBe('004467')
  expect(pickupCodesFor(db, [id]).get(id)).toBe('004467')
})

test('deleting a parcel takes its code with it and leaves no dangling reference', () => {
  const id = readyParcel()
  recordPickupCode(db, id, '405162', 1, NOW)
  deleteParcel(db, id)
  expect(db.prepare('SELECT count(*) AS n FROM pickup_codes').get()).toEqual({ n: 0 })
  expect(db.pragma('foreign_key_check')).toEqual([])
})

// --- the poll-side scan -------------------------------------------------------------------------

const FIXTURE = new URL('./fixtures/mail/packeta-ready-zbox.eml', import.meta.url)

test('the scan reads the parcel\'s own stored mail and finds nothing to fetch', async () => {
  const id = readyParcel()
  mail(id, '/mail/1.eml')
  const body = readFileSync(FIXTURE)
  const report = await runPickupCodes({ db, now: NOW, readMail: () => body })
  expect(report.scanned).toBe(1)
  // Whatever the fixture holds, the outcome is recorded so the next poll does not re-read it.
  expect(needsPickupCodeCheck(db, id, 1)).toBe(false)
})

test('the newest mail is read first, so a reminder does not override the original', async () => {
  const id = readyParcel()
  mail(id, '/mail/old.eml', '2026-10-20T10:00:00Z')
  mail(id, '/mail/new.eml', '2026-10-26T10:00:00Z')
  const read = (p: string) => Buffer.from(
    `Subject: x\r\n\r\nKód pre otvorenie schránky ${p === '/mail/new.eml' ? '1 1 1 1 1 1' : '2 2 2 2 2 2'} Miesto`,
  )
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(getPickupCode(db, id)).toBe('111111')
})

test('an unreadable .eml does not stop the parcel\'s other mail being tried', async () => {
  const id = readyParcel()
  mail(id, '/mail/broken.eml', '2026-10-26T10:00:00Z')
  mail(id, '/mail/good.eml', '2026-10-20T10:00:00Z')
  const read = (p: string) => {
    if (p === '/mail/broken.eml') throw new Error('ENOENT')
    return Buffer.from('Subject: x\r\n\r\nKód pre otvorenie schránky 0 0 4 4 6 7 Miesto')
  }
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(getPickupCode(db, id)).toBe('004467')
})

test('a parcel that is not waiting for collection is never scanned', async () => {
  const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z999', source: 'manual' })
  updateParcelState(db, id, { status: 'in_transit' })
  mail(id, '/mail/1.eml')
  let read = false
  const report = await runPickupCodes({ db, now: NOW, readMail: () => { read = true; return Buffer.from('') } })
  expect(report.scanned).toBe(0)
  expect(read).toBe(false)
})

test('a second poll does not re-read mail it has already scanned', async () => {
  const id = readyParcel()
  mail(id, '/mail/1.eml')
  const body = Buffer.from('Subject: x\r\n\r\nKód pre otvorenie schránky 9 8 7 6 5 4 Miesto')
  let reads = 0
  const read = () => { reads++; return body }
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(reads).toBe(1)
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(reads).toBe(1)   // nothing new arrived, so nothing was opened again
  expect(getPickupCode(db, id)).toBe('987654')
})

// --- what the reader sees -----------------------------------------------------------------------

test('the code is shown on the parcel page and on the dashboard card', async () => {
  const { buildServer } = await import('../src/web/server.js')
  const { config } = await import('./poll-helpers.js')
  const id = readyParcel()
  recordPickupCode(db, id, '004467', 1, NOW)
  const app = buildServer({ db, config })

  const detail = (await app.inject({ method: 'GET', url: `/parcel/${id}` })).body
  expect(detail).toContain('004467')              // leading zero intact all the way to the page
  expect(detail).toContain('Open the box with')

  const dash = (await app.inject({ method: 'GET', url: '/' })).body
  expect(dash).toContain('004467')
})

test('a pickup with no code says nothing at all about codes', async () => {
  const { buildServer } = await import('../src/web/server.js')
  const { config } = await import('./poll-helpers.js')
  const id = readyParcel()
  recordPickupCode(db, id, undefined, 1, NOW)     // looked, there is none: normal for a staffed point
  const body = (await buildServer({ db, config }).inject({ method: 'GET', url: `/parcel/${id}` })).body
  expect(body).not.toContain('Open the box with')
  expect(body).not.toContain('class="code"')
})

test('a parcel no longer waiting does not show a code it once had', async () => {
  const { buildServer } = await import('../src/web/server.js')
  const { config } = await import('./poll-helpers.js')
  const id = readyParcel()
  recordPickupCode(db, id, '405162', 1, NOW)
  updateParcelState(db, id, { status: 'delivered' })
  const body = (await buildServer({ db, config }).inject({ method: 'GET', url: `/parcel/${id}` })).body
  expect(body).not.toContain('405162')
})

test('the code never reaches a notification: banners show on the lock screen', async () => {
  const { buildNotifications } = await import('../src/notify/rules.js')
  const id = readyParcel()
  recordPickupCode(db, id, '405162', 1, NOW)
  const notes = buildNotifications(db, [{ parcelId: id, status: 'ready_for_pickup' }] as never, NOW, 8787)
  expect(notes.length).toBeGreaterThan(0)   // a pointless assertion if nothing was built
  for (const n of notes) expect(`${n.title} ${n.message} ${n.url ?? ''}`).not.toContain('405162')
})

test('the digits are found when the mail separates them with newlines, one per table cell', () => {
  // How the real .eml renders: this is what made a live poll find nothing while the unit tests passed.
  expect(extractPickupCode('Kód pre otvorenie schránky\n9\n8\n7\n6\n5\n4\nMiesto, kde je vaša zásielka')).toBe('987654')
})
