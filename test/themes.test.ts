import { describe, expect, test } from 'vitest'
import { COLOR_TOKENS, SHAPE_TOKENS, type Theme } from '../src/web/themes/types.js'
import { DEFAULT_THEME, THEMES, themeById, themeCss } from '../src/web/themes/index.js'
import { classic } from '../src/web/themes/classic.js'
import { postal } from '../src/web/themes/postal.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_APPEARANCE, THEME_IDS } from '../src/core/appearance.js'
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

describe('the registry', () => {
  test('lists Postal then Classic, matching THEME_IDS, with Postal the default', () => {
    expect(THEMES.map(t => t.id)).toEqual(['postal', 'classic'])
    expect(new Set(THEMES.map(t => t.id))).toEqual(new Set(THEME_IDS))
    expect(DEFAULT_THEME).toBe('postal')
    expect(DEFAULT_APPEARANCE.theme).toBe('postal')
    expect(themeById('postal')).toBe(postal)
  })

  test('every font file of every theme exists in assets/fonts as a .woff2, and Classic has none', () => {
    expect(classic.fonts).toEqual([])
    for (const t of THEMES) {
      for (const f of t.fonts) {
        expect(f.file.endsWith('.woff2'), f.file).toBe(true)
        expect(existsSync(join(__dirname, '..', 'assets', 'fonts', f.file)), f.file).toBe(true)
      }
    }
  })
})

describe('Postal', () => {
  const css = themeCss(postal)

  test('holds the brief\'s colours', () => {
    const light = 'paper:#f3ead7 surface:#fbf6ea hover:#f1e7d2 rule:#e6dcc6 rule-s:#d9cbb0 edge:#857559 ink:#1d2433 ink-2:#5a4f3f ink-3:#6a5d48 signal:#f6c21c signal-ink:#7a5600 on-signal:#1d2433 signal-wash:#f9e7a8 warn:#b3261e on-warn:#fbf6ea warn-wash:#f7e0d6 ok:#23468c ok-wash:#e2e6f0 btn-hover:#2f3a52'
    const dark = 'paper:#211c18 surface:#2c2620 hover:#362f27 rule:#3a332b rule-s:#4b4237 edge:#8f826e ink:#f1e8d6 ink-2:#c3b6a0 ink-3:#ab9d87 signal:#f7c948 signal-ink:#f7c948 on-signal:#241a00 signal-wash:#3b3118 warn:#ff8a7a on-warn:#2a0d08 warn-wash:#3f241f ok:#9db8ff ok-wash:#222a3d btn-hover:#ffffff'
    expect(COLOR_TOKENS.map(tok => `${tok}:${postal.colors[tok].light}`).join(' ')).toBe(light)
    expect(COLOR_TOKENS.map(tok => `${tok}:${postal.colors[tok].dark}`).join(' ')).toBe(dark)
  })

  test('has its shape tokens and a percent-encoded grain', () => {
    expect(postal.tokens['font-display']).toBe('"DM Serif Display",Georgia,serif')
    expect(postal.tokens['font-body']).toBe('"Libre Franklin","Helvetica Neue",sans-serif')
    expect(postal.tokens['font-mono']).toBe('"Courier Prime","Courier New",monospace')
    expect(postal.tokens['radius-card']).toBe('6px')
    expect(postal.tokens['radius-badge']).toBe('3px')
    expect(postal.tokens['radius-btn']).toBe('4px')
    expect(postal.tokens['shadow-card']).toBe('0 1px 0 rgba(90,70,30,.08),0 14px 26px -16px rgba(80,55,15,.45)')
    expect(postal.tokens.texture).toMatch(/^url\("data:image\/svg\+xml;utf8,%3Csvg /)
    expect(postal.tokens.texture).toContain('feTurbulence')
    expect(postal.tokens.texture).not.toMatch(/[<>#]/)
    expect(postal.tokens.texture).toContain('filter=\'url(%23n)\'')
  })

  test('loads ten fonts: DM Serif Display 400 roman and italic, Libre Franklin, Courier Prime 400 and 700, latin and latin-ext', () => {
    expect(postal.fonts).toHaveLength(10)
    const keys = postal.fonts.map(f => `${f.family}|${f.style}|${f.weight}`)
    for (const k of ['DM Serif Display|normal|400', 'DM Serif Display|italic|400', 'Libre Franklin|normal|400 800', 'Courier Prime|normal|400', 'Courier Prime|normal|700']) {
      expect(keys.filter(x => x === k), k).toHaveLength(2)
    }
    expect(css).toContain('@font-face{font-family:"Libre Franklin";src:url(/fonts/libre-franklin-latin-wght-normal.woff2) format("woff2");font-style:normal;font-weight:400 800;font-display:swap;unicode-range:U+0000-00FF,U+0131,')
    expect(css).toContain('unicode-range:U+0100-02BA,U+02BD-02C5,')
  })

  test('scopes every rule to data-theme="postal", and sets display weight to 400', () => {
    expect(STYLE).toContain(':root[data-theme="postal"]{')
    const own = stripComments(postal.css ?? '')
    expect(own).toContain('h1')
    for (const sel of ['h1', '.card-h h2', '.pk-h h2', '.pk-h .where']) {
      expect(own).toContain(`:root[data-theme="postal"] ${sel}`)
    }
    expect(own).toMatch(/font-weight:400/)
    // every selector (text before a "{") starts with the scope
    const media = own.replace(/@media\([^)]*\)\{/g, '')
    for (const m of media.matchAll(/(?:^|\})([^{}]+)\{/g)) {
      for (const sel of m[1].split(',')) expect(sel.trim().startsWith(':root[data-theme="postal"]'), sel).toBe(true)
    }
  })

  test('swaps in the dark grain and shadow for dark, and for system under prefers-color-scheme', () => {
    const own = postal.css ?? ''
    expect(own).toContain(':root[data-theme="postal"][data-mode="dark"]{--texture:url("data:image/svg+xml;utf8,%3Csvg ')
    expect(own).toContain('@media(prefers-color-scheme:dark){:root[data-theme="postal"][data-mode="system"]{--texture:url(')
    expect(own.match(/--shadow-card:0 1px 0 rgba\(0,0,0,\.4\),0 16px 30px -14px rgba\(0,0,0,\.7\)/g)).toHaveLength(2)
    expect(own).toContain('0 0 0 0 .95  0 0 0 0 .85  0 0 0 0 .7  0 0 0 .16 0')
    expect(own).not.toMatch(/[<>]|#/)
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
