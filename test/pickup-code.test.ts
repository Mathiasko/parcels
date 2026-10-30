import { describe, test, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Database } from '../src/db/index.js'
import { getParcel, insertParcel, updateParcelState, deleteParcel, setPickupCoords } from '../src/db/parcels.js'
import { getPickupCode, needsPickupCodeCheck, recordPickupCode, pickupCodesFor } from '../src/db/pickup-codes.js'
import { extractPickupCode, mailText } from '../src/ingest/extract.js'
import { runPickupCodes } from '../src/core/pickup-code.js'
import { runPoll } from '../src/core/poll.js'
import type { Notification } from '../src/notify/types.js'
import { bodyHttp, config, okResult, stubAdapter } from './poll-helpers.js'
import type { CarrierId, PickupPoint } from '../src/core/types.js'

let db: Database
beforeEach(() => { db = openDb(':memory:') })

const NOW = new Date('2026-10-27T10:00:00Z')

function readyParcel(number = 'Z1234567890'): number {
  const id = insertParcel(db, { carrier: 'packeta', trackingNumber: number, source: 'manual' })
  // A pickup point the carrier located fully, postcode and all: these tests are about the opening
  // code, and a point with a blank worth filling would have the location pass open the mail too.
  updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX', street: 'Hlavna 6', city: 'Bratislava', postalCode: '821 01' } })
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

describe('pickup PINs for every carrier', () => {
  // Read through `mailText`, exactly as the pickup-code pass reads a stored mail, so the tests see the
  // same text (charset decoded, html flattened) the pass does.
  const corpus = (name: string) => mailText(readFileSync(new URL(`./fixtures/fake-mail/${name}.eml`, import.meta.url)))
  const real = (name: string) => mailText(readFileSync(new URL(`./fixtures/mail/${name}.eml`, import.meta.url)))

  test.each([
    ['20-gls-ready-glsbox-pin', '402211'],                    // GLS BOX: "použite PIN kód 402211."
    ['43-dpd-pickup-station-ready-pin', '120477'],            // DPD Pickup Station: "PIN: 120477"
    ['44-posta-balikobox-pin', '631285'],                     // pošta BalíkoBOX: "PIN kód na otvorenie schránky:"
    ['28-sps-balikovo-cp1250-base64', '551902'],              // SPS Balíkovo: "Verifikačný kód: 551902."
    ['26-packeta-ready-zbox-code-leading-zero', '040712'],    // Z-BOX, the leading zero kept
    ['31-zasilkovna-cz-ready-iso8859-2', '918273'],           // Czech Z-BOX, one digit per line
  ])('corpus mail %s gives %s', async (name, code) => {
    expect(extractPickupCode(await corpus(name))).toBe(code)
  })

  // Both real mails print an anonymised PIN of six zeros; it is still the code they print.
  test('the real GLS pickup mail gives the PIN it prints', async () => {
    expect(extractPickupCode(await real('gls-ready-for-pickup'))).toBe('000000')
  })

  test('the real DPD Pickup Station mail gives the PIN it prints', async () => {
    expect(extractPickupCode(await real('dpd-pickup-station'))).toBe('000000')
  })

  test('a PPL ParcelShop mail: the PIN, not the parcel number printed before it', () => {
    expect(extractPickupCode('Dobrý den,\nzásilka 40888888801 je připravena k vyzvednutí na PPL Parcelshop Testovice, Hlavní 1.\nPIN pro vyzvednutí: 402211\nVyzvedněte ji do 5. 11. 2026.'))
      .toBe('402211')
  })

  test('a Czech box PIN with its digits spaced', () => {
    expect(extractPickupCode('PIN kód pro otevření schránky: 7 7 3 1 2 0')).toBe('773120')
  })

  test.each([
    ['a phone number with no PIN label', 'Zákaznícka linka 0905 123 456'],
    ['a tracking number', 'Číslo zásielky: 90444444401'],
    ['a "PIN" sentence that names a phone', 'PIN: 0905123456 (telefón kuriéra)'],
    ['a "PIN" sentence that names an order', 'Objednávka č. 123456, PIN kód 4711 nájdete v objednávke'],
    ['a promo "PIN" with no digits after it', 'Nový PIN kód k vašej karte získate v aplikácii!'],
    ['a 3-digit run', 'PIN: 123'],
    ['an 11-digit run', 'PIN: 12345678901'],
    ['the DPD line that mentions the PIN but prints none', 'Vašu zásielku môže prevziať aj osoba, ktorej poskytnete PIN kód.'],
  ])('%s is not a code', (_what, text) => {
    expect(extractPickupCode(text)).toBeUndefined()
  })
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

// --- the pickup point the carrier never gave ----------------------------------------------------

const GLS_MAIL = readFileSync(new URL('./fixtures/mail/gls-ready-for-pickup.eml', import.meta.url))

/** What that fixture's block says, which is what the fill must produce. */
const FROM_MAIL = {
  kind: 'locker',
  name: 'ExampleBox Testville - Príklad (Example Mall)',
  street: 'Príkladová 6',
  city: 'Testville',
  postalCode: '00001',
} as const

/** A parcel waiting for collection, with exactly the pickup point the carrier gave (or none at all). */
function waiting(pickup?: PickupPoint, carrier: CarrierId = 'gls'): number {
  const id = insertParcel(db, { carrier, trackingNumber: carrier === 'gls' ? '000000000001' : 'Z1234567891', source: 'manual' })
  updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS', pickup })
  mail(id, '/mail/gls.eml')
  return id
}

const pickupOf = (id: number) => getParcel(db, id)?.pickup

test('a parcel the carrier gave no pickup point for gets one from its own mail', async () => {
  const id = waiting()
  const report = await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(FROM_MAIL)
  expect(report.points).toBe(1)
})

test('the carrier\'s own pickup point is never overwritten', async () => {
  const carrierPoint: PickupPoint = { kind: 'parcelshop', name: 'Lekáreň Nádej', street: 'Mateja Belu 24', city: 'Kalinovo' }
  const id = waiting(carrierPoint)
  const report = await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(carrierPoint)
  expect(report.points).toBe(0)
})

test('a pickup point with no location detail keeps what it has and gains the street and postcode', async () => {
  // SPS answers `{ kind: 'parcelshop' }` and DPD `{ kind: 'parcelshop' }` with nothing else: a card
  // with no address and a map pin that would land in the middle of a town, or nowhere at all.
  const id = waiting({ kind: 'parcelshop', city: 'TESTVILLE' })
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual({
    kind: 'parcelshop',                 // the carrier said what sort of place it is; the mail does not
    name: FROM_MAIL.name,
    street: FROM_MAIL.street,
    postalCode: FROM_MAIL.postalCode,
    city: 'TESTVILLE',                  // the carrier's own spelling of the town, not the mail's
  })
})

test('a name and a postcode the carrier did give are kept, not replaced by the mail\'s', async () => {
  const id = waiting({ kind: 'zbox', name: 'Z-BOX Testville', city: 'Testville', postalCode: '00009' })
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual({
    kind: 'zbox', name: 'Z-BOX Testville', street: FROM_MAIL.street, city: 'Testville', postalCode: '00009',
  })
})

test('a postal district number does not make it a different town', async () => {
  // The carrier writes the district ("Bratislava 5"), the mail writes the town. Refusing the fill
  // over that digit would lose the street for nothing.
  const id = waiting({ kind: 'parcelshop', city: 'Testville 5' })
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)?.street).toBe(FROM_MAIL.street)
  expect(pickupOf(id)?.city).toBe('Testville 5')
})

test('the postcode the carrier never sends is added to the point it did give', async () => {
  // Packeta's API sends a name, a street and a town, and no postcode at all; the mail has one. Note
  // the carrier's own spelling of the street has no diacritics, and is the spelling that is kept.
  const id = waiting({ kind: 'zbox', name: 'Z-BOX Testville', street: 'Prikladova 6', city: 'Testville' })
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual({
    kind: 'zbox', name: 'Z-BOX Testville', street: 'Prikladova 6', city: 'Testville', postalCode: '00001',
  })
})

test('a postcode is not taken from a mail that is talking about another street', async () => {
  const other: PickupPoint = { kind: 'zbox', name: 'Z-BOX Testville', street: 'Other Street 9', city: 'Testville' }
  const id = waiting(other)
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(other)
})

test('nor from a mail about a different house number on the same street', async () => {
  // Two doors on one street are two places, and a long street can cross a postcode boundary.
  const nextDoor: PickupPoint = { kind: 'zbox', name: 'Z-BOX', street: 'Príkladová 12', city: 'Testville' }
  const id = waiting(nextDoor)
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(nextDoor)
})

test('a parcel the carrier has located is not opened at all', async () => {
  const id = waiting({ kind: 'locker', name: 'ExampleBox', street: 'Example Street 1', city: 'Testville', postalCode: '00009' })
  recordPickupCode(db, id, '000000', 1, NOW)        // the code pass is settled, so only a location could want this mail
  let reads = 0
  const report = await runPickupCodes({ db, now: NOW, readMail: () => { reads++; return GLS_MAIL } })
  expect(reads).toBe(0)
  expect(report.scanned).toBe(0)
})

test('the newest mail decides where the parcel is', async () => {
  // A parcel moved to another box gets a second mail; the older one must not win.
  const id = waiting()
  mail(id, '/mail/moved.eml', '2026-10-26T20:00:00Z')
  const moved = Buffer.from(
    'Subject: x\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
    + 'Odberné miesto:\r\nOtherBox Testville,\r\nOther Street 2,\r\n00002, Testville\r\n',
  )
  const read = (p: string) => (p === '/mail/moved.eml' ? moved : GLS_MAIL)
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(pickupOf(id)).toEqual({
    kind: 'locker', name: 'OtherBox Testville', street: 'Other Street 2', city: 'Testville', postalCode: '00002',
  })
})

test('a pickup point that already has coordinates is left exactly as it was', async () => {
  const located: PickupPoint = { kind: 'zbox', name: 'Z-BOX', city: 'Testville', lat: 48.15127, lon: 17.15755 }
  const id = waiting(located)
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(located)
})

test('the mail is not used when it names a different town than the carrier did', async () => {
  // A redirected parcel, or a mail about an earlier leg: a street from one town under another town's
  // name is the wrong-pin error, so the fill is refused outright.
  const elsewhere: PickupPoint = { kind: 'parcelshop', city: 'Košice' }
  const id = waiting(elsewhere)
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toEqual(elsewhere)
})

test('what the carrier said about the status, its detail and its deadline survives the fill', async () => {
  const id = waiting()
  const till = new Date('2026-11-02T18:00:00Z')
  updateParcelState(db, id, { status: 'ready_for_pickup', statusRaw: 'DELIVEREDPS', statusDetail: 'Balikomat', retainedTill: till, lastPolledAt: NOW })
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  const p = getParcel(db, id)!
  expect(p.pickup).toEqual(FROM_MAIL)
  expect(p.status).toBe('ready_for_pickup')
  expect(p.statusRaw).toBe('DELIVEREDPS')
  expect(p.statusDetail).toBe('Balikomat')
  expect(p.retainedTill).toEqual(till)
  expect(p.lastPolledAt).toEqual(NOW)
})

test('a parcel collected while its mail is being read stays collected', async () => {
  // The other process (a web refresh, or the poller) learns of the delivery while this pass is
  // awaiting the parse. What this pass read before the await must not be written back over it.
  const id = waiting()
  const report = await runPickupCodes({ db, now: NOW, readMail: () => {
    updateParcelState(db, id, { status: 'delivered', statusRaw: 'DELIVERED' })
    return GLS_MAIL
  } })
  const p = getParcel(db, id)!
  expect(p.status).toBe('delivered')
  expect(p.statusRaw).toBe('DELIVERED')
  expect(p.pickup).toBeUndefined()      // a parcel no longer waiting is given no location
  expect(report.points).toBe(0)
})

test('a parcel whose mail has no pickup block is not read again on the next poll', async () => {
  const id = waiting()
  const body = Buffer.from('Subject: x\r\n\r\nVáš balík je na ceste. Odberné miesto zatiaľ nepoznáme.')
  let reads = 0
  const read = () => { reads++; return body }
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(pickupOf(id)).toBeUndefined()
  expect(reads).toBe(1)
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(reads).toBe(1)              // nothing new arrived, so nothing was opened again
})

test('an unreadable .eml does not stop the parcel\'s other mail being tried for a location', async () => {
  const id = waiting()
  mail(id, '/mail/broken.eml', '2026-10-26T20:00:00Z')      // newer, so it is opened first
  const read = (p: string) => {
    if (p === '/mail/broken.eml') throw new Error('ENOENT')
    return GLS_MAIL
  }
  await runPickupCodes({ db, now: NOW, readMail: read })
  expect(pickupOf(id)).toEqual(FROM_MAIL)
})

test('the scan asks nobody: no request leaves the machine', async () => {
  const id = waiting()
  const real = globalThis.fetch
  globalThis.fetch = (() => { throw new Error('the scan must not use the network') }) as typeof fetch
  try {
    await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  } finally { globalThis.fetch = real }
  expect(pickupOf(id)).toEqual(FROM_MAIL)
})

test('a parcel that is not waiting for collection is given no location', async () => {
  const id = insertParcel(db, { carrier: 'gls', trackingNumber: '000000000002', source: 'manual' })
  updateParcelState(db, id, { status: 'in_transit' })
  mail(id, '/mail/gls.eml')
  const report = await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  expect(pickupOf(id)).toBeUndefined()
  expect(report.points).toBe(0)
})

test('the point read from mail is what the parcel page then shows', async () => {
  const { buildServer } = await import('../src/web/server.js')
  const { config } = await import('./poll-helpers.js')
  const id = waiting()
  await runPickupCodes({ db, now: NOW, readMail: () => GLS_MAIL })
  const body = (await buildServer({ db, config }).inject({ method: 'GET', url: `/parcel/${id}` })).body
  expect(body).toContain('Príkladová 6')
  expect(body).toContain('Testville')
})

// --- what the carrier says next poll ------------------------------------------------------------

/** Packeta's point as its API gives it every poll: a name, a street, a town, and never a postcode. */
const PACKETA_POINT: PickupPoint = { kind: 'zbox', name: 'Z-BOX Testville', street: 'Prikladova 6', city: 'Testville' }

/** A Packeta parcel the carrier says is ready at `point`, with the GLS fixture as its stored mail on disk. */
function pollable(point: () => PickupPoint) {
  const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z1234567891', source: 'manual' })
  const path = join(mkdtempSync(join(tmpdir(), 'parcels-pickup-')), 'ready.eml')
  writeFileSync(path, GLS_MAIL)
  mail(id, path)
  const sent: Notification[] = []
  const poll = () => runPoll({
    db, http: bodyHttp(), config, now: NOW, notifier: { send: async n => { sent.push(n) } },
    adapters: [stubAdapter('packeta', ins => ins.map(i => okResult(i.number, [], { status: 'ready_for_pickup', pickup: point() })))],
  })
  return { id, poll, sent }
}

test('a second poll of an unchanged parcel keeps what the mail and the map added, and reads no mail', async () => {
  const { id, poll } = pollable(() => PACKETA_POINT)
  const first = await poll()
  expect(first.codes?.points).toBe(1)
  expect(pickupOf(id)?.postalCode).toBe('00001')
  setPickupCoords(db, id, 48.1, 17.1)                  // as the map step does once it has located it

  const second = await poll()
  expect(second.codes).toBeUndefined()                 // nothing scanned: the mail was not opened again
  expect(pickupOf(id)).toEqual({ ...PACKETA_POINT, postalCode: '00001', lat: 48.1, lon: 17.1 })
})

test('what the carrier does say about the same point still wins', async () => {
  let point = PACKETA_POINT
  const { id, poll } = pollable(() => point)
  await poll()
  setPickupCoords(db, id, 48.1, 17.1)
  point = { ...PACKETA_POINT, name: 'Z-BOX TESTVILLE', postalCode: '00002' }
  await poll()
  expect(pickupOf(id)).toEqual({ ...PACKETA_POINT, name: 'Z-BOX TESTVILLE', postalCode: '00002', lat: 48.1, lon: 17.1 })
})

test('a parcel moved to another point takes the carrier\'s new point whole, and loses the old pin', async () => {
  let point = PACKETA_POINT
  const { id, poll } = pollable(() => point)
  await poll()
  setPickupCoords(db, id, 48.1, 17.1)
  point = { kind: 'zbox', name: 'Z-BOX Testville', street: 'Other Street 9', city: 'Testville' }
  await poll()
  expect(pickupOf(id)).toEqual(point)
})

test('the first announcement of a point carries the address the mail supplied', async () => {
  // GLS gives a Balikomat parcel no point at all; only the mail knows where it is. Read before the
  // notifications are built, so the one banner that announces it can say where to go.
  const { poll, sent } = pollable(() => undefined as unknown as PickupPoint)
  await poll()
  expect(sent.map(n => n.message).join('\n')).toContain(FROM_MAIL.street)
})
