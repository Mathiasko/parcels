import { describe, expect, test } from 'vitest'
import { BAND, POSTAL_BAND } from '../src/web/themes/postal-band.js'
import { postal } from '../src/web/themes/postal.js'
import { BASE_CSS, STYLE } from '../src/web/views/style.js'
import { contrast } from './theme-contrast.js'

const MODES = ['light', 'dark'] as const

describe('Postal\'s post-office band', () => {
  test.each(MODES)('its words are readable in %s', mode => {
    const band = BAND.fill[mode]
    expect(contrast(BAND.text, band)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(BAND.textQuiet, band)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(BAND.buttonText, BAND.text)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(BAND.trouble, band)).toBeGreaterThanOrEqual(3)
  })

  test('is part of Postal\'s css', () => {
    expect(postal.css ?? '').toContain(POSTAL_BAND)
  })

  test('scopes every selector to Postal, so Classic never sees it', () => {
    const inner = POSTAL_BAND.replace(/@media[^{]*\{/g, '')
    const selectors = [...inner.matchAll(/(?:^|\})([^{}]+)\{/g)].flatMap(m => m[1]!.split(','))
    expect(selectors.length).toBeGreaterThan(10)
    for (const s of selectors) expect(s.trim().startsWith(':root[data-theme="postal"]'), s).toBe(true)
  })

  test('the Refresh and the Checked line are hidden by the base, ahead of any theme', () => {
    expect(BASE_CSS).toContain('.hd-refresh,.checked{display:none}')
    expect(STYLE.indexOf('.hd-refresh,.checked{display:none}')).toBeLessThan(STYLE.indexOf(':root[data-theme='))
  })
})
