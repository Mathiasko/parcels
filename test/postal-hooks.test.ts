import { describe, expect, test } from 'vitest'
import { glyph, SPRITE, type GlyphName } from '../src/web/views/glyphs.js'
import { quietIndicator, statusIndicator, userMarkIndicator } from '../src/web/views/format.js'
import { BASE_CSS, STYLE } from '../src/web/views/style.js'
import { classic } from '../src/web/themes/classic.js'
import { themeCss } from '../src/web/themes/index.js'
import { buildServer } from '../src/web/server.js'
import { insertParcel, updateParcelState } from '../src/db/parcels.js'
import { config, memDb, NOW } from './poll-helpers.js'

const NAMES: GlyphName[] = [
  'pre_transit', 'in_transit', 'out_for_delivery', 'ready_for_pickup', 'delivered',
  'failed_attempt', 'problem', 'returning', 'returned', 'unknown',
]
const text = (h: unknown) => String(h)

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
