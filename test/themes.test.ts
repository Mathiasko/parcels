import { describe, expect, test } from 'vitest'
import { COLOR_TOKENS, SHAPE_TOKENS, type Theme } from '../src/web/themes/types.js'
import { DEFAULT_THEME, THEMES, themeById, themeCss } from '../src/web/themes/index.js'
import { classic } from '../src/web/themes/classic.js'
import { BASE_CSS, STYLE } from '../src/web/views/style.js'
import { contrast } from './theme-contrast.js'

const MODES = ['light', 'dark'] as const

/** Spec §5: text pairs at 4.5:1, glyph and control-border pairs at 3:1, as [foreground, background]. */
const PAIRS: ReadonlyArray<readonly [number, string, string]> = [
  ...['ink', 'ink-2', 'ink-3'].flatMap(fg => ['paper', 'surface', 'hover'].map(bg => [4.5, fg, bg] as const)),
  [4.5, 'signal-ink', 'paper'],
  [4.5, 'signal-ink', 'surface'],
  [4.5, 'on-signal', 'signal'],
  [4.5, 'on-warn', 'warn'],
  [4.5, 'warn', 'surface'],
  [4.5, 'ok', 'surface'],
  [3, 'edge', 'paper'],
  [3, 'edge', 'surface'],
]

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the theme contract', () => {
  test('every theme defines every colour token in both modes, and every shape token', () => {
    expect(THEMES.length).toBeGreaterThan(0)
    for (const t of THEMES) {
      for (const tok of COLOR_TOKENS) {
        for (const mode of MODES) {
          const value = (t.colors as Partial<Record<string, { light?: string; dark?: string }>>)[tok]?.[mode]
          expect(typeof value === 'string' && value.trim() !== '', `${t.id} --${tok} ${mode}`).toBe(true)
        }
      }
      for (const tok of SHAPE_TOKENS) {
        const value = (t.tokens as Partial<Record<string, string>>)[tok]
        expect(typeof value === 'string' && value.trim() !== '', `${t.id} --${tok}`).toBe(true)
      }
    }
  })

  test('every theme meets the contrast minimums of spec §5 in both modes', () => {
    for (const t of THEMES) {
      for (const mode of MODES) {
        for (const [min, fg, bg] of PAIRS) {
          const ratio = contrast(t.colors[fg as keyof Theme['colors']][mode], t.colors[bg as keyof Theme['colors']][mode])
          expect(ratio >= min, `${t.id} ${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBe(true)
        }
      }
    }
  })

  test('the contrast fixture measures WCAG contrast and takes only #rrggbb', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBe(1)
    expect(() => contrast('#fff', '#000000')).toThrow(/#rrggbb/)
  })

  test('the registry finds a theme by id, and the default is Postal', () => {
    expect(themeById('classic')).toBe(classic)
    expect(themeById('nope')).toBeUndefined()
    expect(DEFAULT_THEME).toBe('postal')
    expect(new Set(THEMES.map(t => t.id)).size).toBe(THEMES.length)
  })
})

describe('Classic', () => {
  test('holds the colours the stylesheet had before themes, with signal-ink equal to signal', () => {
    const light = 'paper:#f5f3ee surface:#fdfcf9 hover:#f0ede5 rule:#e3dfd5 rule-s:#d2cdc0 edge:#8c877a ink:#1a1915 ink-2:#524f46 ink-3:#6b675c signal:#2a4bd1 signal-ink:#2a4bd1 on-signal:#ffffff signal-wash:#e8ecfb warn:#b83c08 on-warn:#ffffff warn-wash:#fdf0e8 ok:#1b5a44 ok-wash:#e2f0e9 btn-hover:#38362e'
    const dark = 'paper:#151411 surface:#1e1d19 hover:#26241f rule:#2f2d27 rule-s:#3a3830 edge:#7a7669 ink:#ece9e0 ink-2:#b6b2a5 ink-3:#9a968a signal:#98a9ff signal-ink:#98a9ff on-signal:#0c1233 signal-wash:#1d2342 warn:#ff9a6a on-warn:#2a0f03 warn-wash:#34201a ok:#74cdab ok-wash:#1a2b25 btn-hover:#fff'
    expect(COLOR_TOKENS.map(tok => `${tok}:${classic.colors[tok].light}`).join(' ')).toBe(light)
    expect(COLOR_TOKENS.map(tok => `${tok}:${classic.colors[tok].dark}`).join(' ')).toBe(dark)
  })

  test('themeCss scopes its tokens to data-theme, as light-dark() pairs, and loads no fonts', () => {
    const css = themeCss(classic)
    expect(css).toContain(':root[data-theme="classic"]{')
    expect(css).toContain('--paper:light-dark(#f5f3ee,#151411)')
    expect(css).toContain('--signal-ink:light-dark(#2a4bd1,#98a9ff)')
    expect(css).toContain('--texture:none')
    expect(css).toContain('--font-body:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Helvetica Neue",sans-serif')
    expect(css).toContain('--font-mono:ui-monospace,"SF Mono",Menlo,monospace')
    expect(css).toContain('--radius-card:12px')
    expect(css).not.toContain('@font-face')
  })
})

describe('themeCss', () => {
  test('emits an @font-face per font, then the theme\'s own css', () => {
    const t: Theme = {
      ...classic,
      id: 'postal',
      fonts: [{ family: 'Test Serif', file: 'test-serif-latin-400-italic.woff2', style: 'italic', weight: '400', unicodeRange: 'U+0000-00FF,U+0131' }],
      css: ':root[data-theme="postal"] h1{font-weight:400}',
    }
    const css = themeCss(t)
    expect(css).toContain(':root[data-theme="postal"]{')
    expect(css).toContain('@font-face{font-family:"Test Serif";src:url(/fonts/test-serif-latin-400-italic.woff2) format("woff2");font-style:italic;font-weight:400;font-display:swap;unicode-range:U+0000-00FF,U+0131}')
    expect(css.endsWith(':root[data-theme="postal"] h1{font-weight:400}')).toBe(true)
  })
})

describe('the page stylesheet', () => {
  test('is the base followed by every theme', () => {
    expect(STYLE).toBe(BASE_CSS + THEMES.map(themeCss).join(''))
  })

  test('never contains "</", which would end the inline <style> early', () => {
    expect(STYLE).not.toContain('</')
  })

  test('the base uses only tokens: no hex colour literal outside comments', () => {
    expect(stripComments(BASE_CSS)).not.toMatch(/:\s*#[0-9a-f]{3,6}/i)
    expect(stripComments(BASE_CSS)).not.toMatch(/--(paper|surface|ink|signal|warn|ok)\s*:/)
  })

  test('takes the mode from data-mode, following the system when there is none', () => {
    expect(STYLE).toContain(':root{color-scheme:light dark}')
    expect(STYLE).toContain(':root[data-mode="light"]{color-scheme:light}')
    expect(STYLE).toContain(':root[data-mode="dark"]{color-scheme:dark}')
    expect(BASE_CSS).not.toContain('prefers-color-scheme')
    for (const t of THEMES) expect(themeCss(t).replace(t.css ?? '', '')).not.toContain('prefers-color-scheme')
  })

  test('takes fonts, radii, shadow, texture and the signal text colour from tokens', () => {
    expect(BASE_CSS).toMatch(/\nbody\{[^}]*font:400 \.9375rem\/1\.4667 var\(--font-body\)/)
    expect(BASE_CSS).toMatch(/\nbody\{[^}]*background:var\(--paper\);background-image:var\(--texture\)/)
    expect(BASE_CSS).toMatch(/\.mono\{font:400 \.8125rem\/1\.3846 var\(--font-mono\)/)
    expect(BASE_CSS).toMatch(/\npre\{[^}]*font:400 \.75rem\/1\.5 var\(--font-mono\)/)
    for (const sel of ['h1', '.card-h h2', '.pk-h h2,.pk-h .where']) {
      expect(BASE_CSS).toMatch(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')}\\{[^}]*font-family:var\\(--font-display\\)`))
    }
    expect(BASE_CSS).toContain('.t-signal{color:var(--signal-ink);--bar:var(--signal-ink)}')
    expect(BASE_CSS).toContain('.clock .due{color:var(--signal-ink)}')
    expect(BASE_CSS).toContain('.b.solid.t-signal{background:var(--signal);color:var(--on-signal)}')
    for (const sel of ['.card', '.pk', '.item']) {
      expect(BASE_CSS).toMatch(new RegExp(`\\n\\${sel}\\{[^}]*border-radius:var\\(--radius-card\\)[^}]*box-shadow:var\\(--shadow-card\\)`))
    }
    expect(BASE_CSS).toMatch(/\n\.bulk\{[^}]*border-radius:var\(--radius-card\)/)
    expect(BASE_CSS).not.toMatch(/border-radius:(4|6|12)px/)
    expect(stripComments(BASE_CSS).match(/border-radius:min\(8px,var\(--radius-card\)\)/g)).toHaveLength(5)
  })
})
