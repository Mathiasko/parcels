import { describe, expect, test } from 'vitest'
import { glyph, SPRITE, type GlyphName } from '../src/web/views/glyphs.js'
import { quietIndicator, statusIndicator, userMarkIndicator } from '../src/web/views/format.js'
import { BASE_CSS, STYLE } from '../src/web/views/style.js'
import { classic } from '../src/web/themes/classic.js'
import { themeCss } from '../src/web/themes/index.js'
import { buildServer } from '../src/web/server.js'
import { insertParcel, updateParcelState } from '../src/db/parcels.js'
import { appendEvents } from '../src/db/events.js'
import { recordPickupCode } from '../src/db/pickup-codes.js'
import { codeKind, placeName, postmark, postmarkDate, rubberText } from '../src/web/views/ornaments.js'
import { markCollected } from '../src/core/collected.js'
import { finishRun, startRun } from '../src/db/poll-runs.js'
import { pickupCodeLine } from '../src/web/views/index.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config, ev, memDb, NOW } from './poll-helpers.js'

const NAMES: GlyphName[] = [
  'pre_transit', 'in_transit', 'out_for_delivery', 'ready_for_pickup', 'delivered',
  'failed_attempt', 'problem', 'returning', 'returned', 'unknown',
]
const text = (h: unknown) => String(h)
const viewsDir = new URL('../src/web/views', import.meta.url).pathname

describe('glyph alternates', () => {
  test.each(NAMES)('glyph(%s) references both the Classic and the Postal symbol', n => {
    const out = text(glyph(n))
    expect(out).toContain(`<use class="gc" href="#g-${n}"/>`)
    expect(out).toContain(`<use class="gp" href="#gp-${n}"/>`)
  })

  test('a value outside the closed set falls back to the neutral dot on both', () => {
    const out = text(glyph('bogus' as GlyphName))
    expect(out).toContain('href="#g-unknown"')
    expect(out).toContain('href="#gp-unknown"')
  })

  test('the sprite defines a gp- symbol for every name, and every mask it needs is in its defs', () => {
    const sprite = text(SPRITE)
    for (const n of NAMES) {
      expect(sprite, n).toContain(`<symbol id="g-${n}"`)
      expect(sprite, n).toContain(`<symbol id="gp-${n}"`)
    }
    const defs = sprite.slice(sprite.indexOf('<defs>'), sprite.indexOf('</defs>'))
    for (const m of sprite.matchAll(/mask="url\(#([^)]+)\)"/g)) expect(defs).toContain(`<mask id="${m[1]}"`)
    const ids = [...sprite.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('data-status', () => {
  test('the status indicators carry the canonical status', () => {
    expect(text(statusIndicator('failed_attempt'))).toContain('data-status="failed_attempt"')
    expect(text(statusIndicator('delivered'))).toContain('class="st t-ok" data-status="delivered"')
    expect(text(statusIndicator('ready_for_pickup'))).toMatch(/class="b [^"]*" data-status="ready_for_pickup"/)
  })
  test('user marks and quiet indicators carry their own', () => {
    expect(text(userMarkIndicator('collected'))).toContain('data-status="collected"')
    expect(text(userMarkIndicator('received'))).toContain('data-status="received"')
    expect(text(quietIndicator('Archived'))).toContain('data-status="unknown"')
    expect(text(statusIndicator('unknown'))).toContain('data-status="unknown"')
  })

  test('a dashboard card carries its chip status', async () => {
    const db = memDb()
    const ready = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'email' })
    updateParcelState(db, ready, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    const moving = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR2', source: 'email' })
    updateParcelState(db, moving, { status: 'in_transit' })
    const app = buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
    const body = (await app.inject({ method: 'GET', url: '/' })).body
    expect(body).toMatch(/<article class="card" data-status="ready_for_pickup">/)
    expect(body).toMatch(/<article class="card" data-status="in_transit">/)
  })
})

describe('the base rule', () => {
  test('.gp is hidden in the base CSS, outside any theme scope', () => {
    expect(BASE_CSS).toContain('.gp{display:none}')
    expect(STYLE.indexOf('.gp{display:none}')).toBeLessThan(STYLE.indexOf(':root[data-theme='))
  })
  test('Classic does not mention .gp', () => {
    expect(themeCss(classic)).not.toContain('.gp')
  })
})

describe('ornament helpers', () => {
  test.each([['zbox', 'box'], ['locker', 'box'], ['parcelshop', 'counter'], ['post_office', 'counter'],
    [undefined, 'plain'], ['unknown', 'plain']] as const)('codeKind(%s) is %s', (k, want) => {
    expect(codeKind(k)).toBe(want)
  })
  test('placeName names the place, and nothing for a plain code', () => {
    expect(placeName('zbox')).toBe('Z-BOX')
    expect(placeName('locker')).toBe('Box')
    expect(placeName('parcelshop')).toBe('ParcelShop')
    expect(placeName('post_office')).toBe('Post office')
    expect(placeName('unknown')).toBeUndefined()
    expect(placeName(undefined)).toBeUndefined()
  })
  test('rubberText keeps short carrier words and falls back otherwise', () => {
    expect(rubberText('Adresát nezastihnutý')).toBe('Adresát nezastihnutý')
    expect(rubberText('  Adresát   nezastihnutý ')).toBe('Adresát nezastihnutý')
    expect(rubberText('x'.repeat(24))).toBe('x'.repeat(24))
    expect(rubberText('x'.repeat(30))).toBe('Not delivered')
    expect(rubberText('The recipient was not home')).toBe('Not delivered')
    expect(rubberText('one two three four')).toBe('Not delivered')
    expect(rubberText('one two three')).toBe('one two three')
    expect(rubberText('')).toBe('Not delivered')
    expect(rubberText('   ')).toBe('Not delivered')
  })
  test('postmarkDate is day, Roman month and two-digit year, with the time, in the given zone', () => {
    expect(postmarkDate(new Date('2026-11-06T13:05:00Z'), 'Europe/Bratislava')).toEqual({ date: '6·XI·26', time: '14:05' })
    expect(postmarkDate(new Date('2026-12-31T23:30:00Z'), 'Europe/Bratislava')).toEqual({ date: '1·I·27', time: '00:30' })
    expect(postmarkDate(new Date('2026-04-03T10:00:00Z'), 'UTC')).toEqual({ date: '3·IV·26', time: '10:00' })
  })
})

describe('the code plate', () => {
  test('the label words and the single code node are unchanged, whatever the carrier', () => {
    const out = text(pickupCodeLine('631285', 'zbox', 'packeta'))
    expect(out).toContain('<span class="code-l">Open the box with</span>')
    expect(out).toContain('<b class="mono sel">631285</b>')
    expect(text(pickupCodeLine('1', 'parcelshop', 'gls'))).toContain('<span class="code-l">Show this PIN at the counter:</span>')
    expect(text(pickupCodeLine('1', undefined, 'gls'))).toContain('<span class="code-l">PIN</span>')
  })
  test('the plate carries its kind and a hidden place line', () => {
    expect(text(pickupCodeLine('631285', 'zbox', 'packeta'))).toBe(
      '<p class="code code-plate" data-kind="box"><span class="code-l">Open the box with</span> <b class="mono sel">631285</b>'
      + '<span class="orn-place" aria-hidden="true">Z-BOX · Packeta</span></p>')
    expect(text(pickupCodeLine('4022', 'post_office', 'posta'))).toContain(
      '<span class="orn-place" aria-hidden="true">Post office · Slovenská pošta</span>')
    expect(text(pickupCodeLine('4022', 'locker', 'dpd'))).toContain('Box · DPD')
  })
  test('a plain code, or no carrier, has no place line', () => {
    const plain = text(pickupCodeLine('4022', undefined, 'packeta'))
    expect(plain).toContain('data-kind="plain"')
    expect(plain).not.toContain('orn-place')
    const noCarrier = text(pickupCodeLine('4022', 'zbox'))
    expect(noCarrier).toContain('data-kind="box"')
    expect(noCarrier).not.toContain('orn-place')
  })
})

describe('rubber stamp, empty headline and the orn- rule', () => {
  type Db = ReturnType<typeof memDb>
  const ornTags = (body: string) => [...body.matchAll(/<[a-z0-9]+[^>]*class="(?:[^"]* )?orn-[^"]*"[^>]*>/g)].map(m => m[0])
  const page = async (setup: (db: Db) => void, url = '/') => {
    const db = memDb()
    setup(db)
    const app = buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
    return (await app.inject({ method: 'GET', url })).body
  }
  const failed = (description: string) => (db: Db) => {
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z1', source: 'email' })
    appendEvents(db, id, [ev('x', 'failed_attempt', 1, description)])
    updateParcelState(db, id, { status: 'failed_attempt' })
  }
  const withCode = (db: Db) => {
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z4', source: 'email' })
    updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: 'Z-BOX Hlavna 6' } })
    recordPickupCode(db, id, '631285', 1, NOW)
  }

  test('a failed card ends its header with the rubber, in the carrier words when short', async () => {
    const body = await page(failed('Adresát nezastihnutý'))
    expect(body).toMatch(/<article class="card" data-status="failed_attempt">/)
    expect(body).toMatch(/<div class="card-h[^"]*">[\s\S]*<span class="orn-rubber" aria-hidden="true">Adresát nezastihnutý<\/span><\/div>/)
  })
  test('a long sentence falls back to Not delivered', async () => {
    const body = await page(failed('The courier could not reach the recipient at home'))
    expect(body).toContain('<span class="orn-rubber" aria-hidden="true">Not delivered</span></div>')
  })
  test('a failed parcel with no event falls back to Not delivered', async () => {
    const body = await page(db => {
      const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z2', source: 'email' })
      updateParcelState(db, id, { status: 'failed_attempt' })
    })
    expect(body).toContain('<span class="orn-rubber" aria-hidden="true">Not delivered</span></div>')
  })
  test('other cards have no rubber', async () => {
    const body = await page(db => {
      const id = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z3', source: 'email' })
      updateParcelState(db, id, { status: 'in_transit' })
    })
    expect(body).not.toContain('orn-rubber')
  })
  test('the empty dashboard has the headline right before the sentence', async () => {
    const body = await page(() => {})
    expect(body).toContain('<p class="orn-empty" aria-hidden="true">Nothing needs you</p><p class="empty">')
  })
  test('a dashboard with cards has no empty headline', async () => {
    expect(await page(failed('x'))).not.toContain('orn-empty')
  })
  test('the dashboard card, with a code, carries the plate and its place', async () => {
    const body = await page(withCode)
    expect(body).toContain('<p class="code code-plate" data-kind="box">')
    expect(body).toContain('<span class="orn-place" aria-hidden="true">Z-BOX · Packeta</span>')
  })
  test('the parcel page passes the carrier too', async () => {
    const body = await page(withCode, '/parcel/1')
    expect(body).toContain('<span class="orn-place" aria-hidden="true">Z-BOX · Packeta</span>')
  })
  test('every orn- element on the pages is aria-hidden', async () => {
    const collected = (db: Db) => { withCode(db); markCollected(db, 1, { actor: 'web', at: NOW }) }
    const bodies = [await page(() => {}), await page(failed('Adresát nezastihnutý')), await page(withCode),
      await page(collected, '/parcel/1?collected=1'), await page(collected, '/?collected=1')]
    const tags = bodies.flatMap(ornTags)
    expect(tags.filter(t => t.includes('orn-postmark'))).toHaveLength(2)
    expect(tags.length).toBeGreaterThanOrEqual(5)
    for (const t of tags) expect(t, t).toContain('aria-hidden="true"')
  })
  test('the base CSS hides every orn- class in one rule, outside any theme scope', () => {
    const rule = '[class^="orn-"],[class*=" orn-"]{display:none}'
    expect(BASE_CSS).toContain(rule)
    expect(STYLE.indexOf(rule)).toBeLessThan(STYLE.indexOf(':root[data-theme='))
    expect(themeCss(classic)).not.toContain('orn-')
  })
  test('the view sources use only deliberate orn- class names', () => {
    // A class that starts with orn- is hidden under Classic; anything unplanned would silently vanish.
    const allowed = ['orn-place', 'orn-rubber', 'orn-empty', 'orn-postmark']
    const src = [...readdirSync(viewsDir)].filter(f => f.endsWith('.ts')).map(f => readFileSync(join(viewsDir, f), 'utf8')).join('\n')
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const tok of m[1]!.split(/\s+/)) if (tok.startsWith('orn-')) expect(allowed).toContain(tok)
    }
    expect(src).not.toMatch(/class="[^"]*\b[a-z]+ orn[^-]/)
  })
})

describe('the postmark and the one-shot markers', () => {
  type Db = ReturnType<typeof memDb>
  const MIN = 60_000
  const serverAt = (db: Db, at: Date) => buildServer({ db, config, now: () => at, notifier: { send: async () => {} } })
  /** The page without its inlined stylesheet, so a theme's selectors cannot satisfy an assertion. */
  const get = async (db: Db, url: string, at = NOW) =>
    (await serverAt(db, at).inject({ method: 'GET', url })).body.replace(/<style>[\s\S]*?<\/style>/, '')
  const ready = (db: Db, number: string, place: string, changed: Date, code?: string) => {
    const id = insertParcel(db, { carrier: 'packeta', trackingNumber: number, source: 'email' })
    updateParcelState(db, id, { status: 'ready_for_pickup', pickup: { kind: 'zbox', name: place }, lastChangedAt: changed })
    if (code) recordPickupCode(db, id, code, 1, NOW)
    return id
  }
  const cardOf = (body: string, place: string) => {
    const i = body.indexOf(`<h2>${place}</h2>`)
    return body.slice(body.lastIndexOf('<article', i), i)
  }

  test('the slot: an aria-hidden span, the sprite ring, and the date and time in the display zone', () => {
    const out = text(postmark(new Date('2026-11-06T13:05:00Z'), 'Europe/Bratislava', false))
    expect(out).toMatch(/^<span class="orn-postmark" aria-hidden="true"><svg viewBox="0 0 236 142"><use href="#postmark-ring"\/>/)
    expect(out).toMatch(/<text [^>]*>6·XI·26<\/text><text [^>]*>14:05<\/text>/)
    expect(text(postmark(new Date('2026-11-06T13:05:00Z'), 'Europe/Bratislava', true)))
      .toMatch(/^<span class="orn-postmark just-collected" aria-hidden="true">/)
  })
  test('the sprite has the ring, with its own filter and arc, and the arc names no town', () => {
    const sprite = text(SPRITE)
    expect(sprite).toContain('<symbol id="postmark-ring" viewBox="0 0 236 142">')
    const defs = sprite.slice(sprite.indexOf('<defs>'), sprite.indexOf('</defs>'))
    for (const m of sprite.matchAll(/filter="url\(#([^)]+)\)"/g)) expect(defs).toContain(`<filter id="${m[1]}"`)
    for (const m of sprite.matchAll(/<textPath href="#([^"]+)"/g)) expect(defs).toContain(`<path id="${m[1]}"`)
    expect(sprite).toContain('>PARCELS ✶ COLLECTED ✶</textPath>')
    expect(sprite).not.toContain('FIKTÍVNE')
  })

  test('marking from the parcel page lands on it with ?collected=1, and the postmark slams once', async () => {
    const db = memDb()
    const id = ready(db, 'Z1', 'Z-BOX Hlavna 6', new Date(NOW.getTime() - 5 * 60 * MIN))
    const res = await serverAt(db, NOW).inject({
      method: 'POST', url: `/parcel/${id}/collected`, payload: '', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`/parcel/${id}?collected=1`)
    const now = await get(db, `/parcel/${id}?collected=1`)
    expect(now).toContain('<span class="orn-postmark just-collected" aria-hidden="true">')
    // 26 October 2026 is CET, an hour ahead of UTC.
    expect(now).toMatch(/>26·X·26<\/text><text [^>]*>11:00<\/text>/)
    const later = await get(db, `/parcel/${id}?collected=1`, new Date(NOW.getTime() + 61 * MIN))
    expect(later).toContain('<span class="orn-postmark" aria-hidden="true">')
    expect(later).not.toContain('just-collected')
    const plain = await get(db, `/parcel/${id}`)
    expect(plain).toContain('<span class="orn-postmark" aria-hidden="true">')
    expect(plain).not.toContain('just-collected')
  })
  test('a parcel that is not collected has no postmark, whatever the URL says', async () => {
    const db = memDb()
    const id = ready(db, 'Z1', 'Z-BOX Hlavna 6', NOW)
    expect(await get(db, `/parcel/${id}?collected=1`)).not.toContain('orn-postmark')
    const received = insertParcel(db, { carrier: 'packeta', trackingNumber: 'Z2', source: 'email' })
    updateParcelState(db, received, { status: 'in_transit' })
    markCollected(db, received, { actor: 'web', at: NOW })
    // Marked as received, not collected: the stamp says COLLECTED, so it is not put on this one.
    expect(await get(db, `/parcel/${received}?collected=1`)).not.toContain('orn-postmark')
    expect(await get(db, `/?collected=${received}`)).not.toContain('orn-postmark')
  })
  test('the dashboard notice for a recent mark carries just-collected and the postmark', async () => {
    const db = memDb()
    const id = ready(db, 'Z1', 'Z-BOX Hlavna 6', NOW)
    markCollected(db, id, { actor: 'web', at: new Date(NOW.getTime() - 10 * MIN) })
    const body = await get(db, `/?collected=${id}`)
    expect(body).toMatch(/<div class="notice just-collected" role="status"><div><div class="undo">[\s\S]*?<\/div><span class="orn-postmark just-collected" aria-hidden="true">[\s\S]*?>10:50<\/text><\/svg><\/span><\/div><\/div>/)
    expect(await get(db, '/')).not.toContain('orn-postmark')
  })

  test('/?run=<finished> marks the cards whose parcel turned ready with a code after the run started', async () => {
    const db = memDb()
    const run = startRun(db, 'web', new Date(NOW.getTime() - 10 * MIN))
    ready(db, 'Z1', 'Z-BOX New', new Date(NOW.getTime() - 5 * MIN), '631285')
    ready(db, 'Z2', 'Z-BOX Old', new Date(NOW.getTime() - 30 * MIN), '111111')
    ready(db, 'Z3', 'Z-BOX Codeless', new Date(NOW.getTime() - 5 * MIN))
    finishRun(db, run, { counts: { polled: 3, newEvents: 3, failures: 0 }, summary: '' }, NOW)
    const body = await get(db, `/?run=${run}`)
    expect(cardOf(body, 'Z-BOX New')).toMatch(/^<article class="card just-arrived" data-status="ready_for_pickup">/)
    expect(cardOf(body, 'Z-BOX Old')).toMatch(/^<article class="card" data-status="ready_for_pickup">/)
    expect(cardOf(body, 'Z-BOX Codeless')).toMatch(/^<article class="card" data-status="ready_for_pickup">/)
    expect(await get(db, '/')).not.toContain('just-arrived')
  })
  test('a running run, or an unknown one, marks nothing', async () => {
    const db = memDb()
    // Two minutes old: well inside RUN_STALE_MS, so it is still running rather than reaped.
    const run = startRun(db, 'web', new Date(NOW.getTime() - 2 * MIN))
    ready(db, 'Z1', 'Z-BOX New', new Date(NOW.getTime() - MIN), '631285')
    const body = await get(db, `/?run=${run}`)
    expect(body).toContain('Refreshing.')
    expect(body).not.toContain('just-arrived')
    expect(await get(db, '/?run=999')).not.toContain('just-arrived')
  })
})
