import { describe, expect, test } from 'vitest'
import { COLOR_TOKENS, SHAPE_TOKENS, type Theme } from '../src/web/themes/types.js'
import { DEFAULT_THEME, THEMES, themeById, themeCss } from '../src/web/themes/index.js'
import { classic } from '../src/web/themes/classic.js'
import { postal } from '../src/web/themes/postal.js'
import { AIRMAIL_REPEAT, POSTAL_ORNAMENTS, RUBBER_OPACITY } from '../src/web/themes/postal-ornaments.js'
import { POSTAL_MOTION } from '../src/web/themes/postal-motion.js'
import { createHash } from 'node:crypto'
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

/** Every block that `opener` (a global regex ending at its "{") starts, as [start, end) spans, with its nesting. */
function blocks(css: string, opener: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of css.matchAll(opener)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    out.push([m.index, i])
  }
  return out
}
/** `css` with every block `opener` starts cut out. */
const withoutBlocks = (css: string, opener: RegExp): string =>
  blocks(css, opener).reverse().reduce((s, [a, b]) => s.slice(0, a) + s.slice(b), css)

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

  test('the grain decodes back to exactly its SVG: % is escaped first, so no escape is doubled or bare', () => {
    for (const texture of [postal.tokens.texture, /--texture:(url\("[^"]*"\))/.exec(postal.css ?? '')![1]!]) {
      const data = /^url\("data:image\/svg\+xml;utf8,([^"]*)"\)$/.exec(texture)![1]!
      // every % starts a valid escape
      expect(data).not.toMatch(/%(?![0-9A-F]{2})/)
      expect(data).toContain("width='100%25' height='100%25'")
      const svg = decodeURIComponent(data)
      expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' width='180' height='180'>/)
      expect(svg).toContain("<rect width='100%' height='100%' filter='url(#n)'/></svg>")
      expect(svg.endsWith('</svg>')).toBe(true)
    }
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
    // every selector (text before a "{") starts with the scope; a @keyframes block holds no selectors
    const media = withoutBlocks(own, /@keyframes\s+[\w-]+\s*\{/g).replace(/@media[^{]*\{/g, '')
    for (const m of media.matchAll(/(?:^|\})([^{}]+)\{/g)) {
      for (const sel of m[1].split(',')) expect(sel.trim().startsWith(':root[data-theme="postal"]'), sel).toBe(true)
    }
  })

  test('the timeline masks carry the page grain, fixed like the body, and the dot glyph stays bare', () => {
    const own = postal.css ?? ''
    expect(own).toContain(':root[data-theme="postal"] body{background-attachment:fixed}')
    expect(own).toContain(':root[data-theme="postal"] .day>span,:root[data-theme="postal"] .er .gl:not(.dotg){background-image:var(--texture);background-attachment:fixed}')
    // the masks keep their paper colour from the base, and nothing here gives .dotg a background
    expect(own.replace(':not(.dotg)', '')).not.toContain('.dotg')
    expect(own).not.toMatch(/\.er \.gl\{/)
    expect(own).not.toMatch(/\.day>span\{[^}]*background(-color)?:/)
    // they take --texture, so the dark swap (which only sets --texture) reaches them
    expect(own).toContain('[data-mode="dark"]{--texture:')
    // Classic's CSS has none of it
    expect(classic.css ?? '').not.toMatch(/background-attachment|\.mono|\.day>span/)
    expect(themeCss(classic)).not.toContain('background-attachment')
  })

  test('sets mono text a step larger, for Courier Prime\'s small x-height', () => {
    expect(postal.css ?? '').toContain(':root[data-theme="postal"] .mono{font-size:.875rem}')
    // the plain .code line is left alone; the ornaments style only .code-plate (and its .code-l)
    expect(postal.css ?? '').not.toMatch(/\.code(?![\w-])/)
    expect(themeCss(classic)).not.toContain('.875rem')
    expect(STYLE).not.toContain('</')
  })

  test('lets a button grow instead of clipping a wrapped label, keeping each one-line height as its minimum', () => {
    const own = postal.css ?? ''
    const R = ':root[data-theme="postal"]'
    // [selector, the base CSS's fixed height, which becomes the minimum]
    const heights: Array<[string, string]> = [
      ['button:not(.link)', '2rem'], ['button.pri:not(.link)', '2.25rem'], ['.toolbar button:not(.link)', '2.25rem'],
      ['.calf button:not(.link)', '1.75rem'], ['.got button:not(.link)', '1.75rem'],
    ]
    // every rule is `sel1,sel2{decls}`; find the one whose selector list holds `sel`
    const rules = [...own.matchAll(/(?:^|\n)([^{}\n@][^{}\n]*)\{([^}]*)\}/g)].map(m => ({ sels: m[1]!.split(','), decls: m[2]! }))
    const declsFor = (sel: string): string[] => rules.filter(r => r.sels.includes(`${R} ${sel}`)).map(r => r.decls)
    expect(declsFor('button:not(.link)').join(';')).toContain('height:auto')
    expect(declsFor('button:not(.link)').join(';')).toContain('padding-block:')
    for (const [sel, min] of heights) expect(declsFor(sel).join(';'), sel).toContain(`min-height:${min}`)
    // a one-line label is ~19px tall: .25rem of padding on a 1.75rem button would push it past its minimum
    for (const sel of ['.calf button:not(.link)', '.got button:not(.link)']) expect(declsFor(sel).join(';'), sel).toContain('padding-block:.125rem')
    // the base CSS's fixed heights are what Postal overrides; they are not touched
    expect(STYLE).toContain('button{font-size:.8125rem;font-weight:600;height:2rem;')
    // a link-style button stays as the base made it: no rule that names button.link sets a height
    const linkRules = rules.filter(r => r.sels.some(s => s.includes('button.link')))
    for (const r of linkRules) expect(r.decls, r.sels.join(',')).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:/)
  })

  test('swaps in the dark grain and shadow for dark, and for system under prefers-color-scheme', () => {
    const own = postal.css ?? ''
    expect(own).toContain(':root[data-theme="postal"][data-mode="dark"]{--texture:url("data:image/svg+xml;utf8,%3Csvg ')
    expect(own).toContain('@media(prefers-color-scheme:dark){:root[data-theme="postal"][data-mode="system"]{--texture:url(')
    expect(own.match(/--shadow-card:0 1px 0 rgba\(0,0,0,\.4\),0 16px 30px -14px rgba\(0,0,0,\.7\)/g)).toHaveLength(2)
    expect(own).toContain('0 0 0 0 .95  0 0 0 0 .85  0 0 0 0 .7  0 0 0 .16 0')
    // no "<" and no "#" (the ">" of a child combinator is fine); "</" would end the inline <style>
    expect(own).not.toMatch(/<|#/)
    expect(own).not.toContain('</')
  })
})

/** `fg` laid over `bg` at `alpha`, as #rrggbb: what the eye sees of a translucent ink. */
const over = (fg: string, bg: string, alpha: number): string => '#' + [1, 3, 5].map(i => {
  const c = Math.round(alpha * parseInt(fg.slice(i, i + 2), 16) + (1 - alpha) * parseInt(bg.slice(i, i + 2), 16))
  return c.toString(16).padStart(2, '0')
}).join('')

describe('Postal ornaments', () => {
  const R = ':root[data-theme="postal"]'
  const own = stripComments(POSTAL_ORNAMENTS)

  test('are part of Postal\'s css, and of no other theme', () => {
    expect(POSTAL_ORNAMENTS.length).toBeGreaterThan(0)
    expect(postal.css ?? '').toContain(POSTAL_ORNAMENTS)
    expect(themeCss(classic)).not.toMatch(/orn-|code-plate|\.gc\b/)
  })

  test('scope every selector to data-theme="postal"', () => {
    const media = own.replace(/@media\([^)]*\)\{/g, '')
    const sels = [...media.matchAll(/(?:^|\})([^{}]+)\{/g)].flatMap(m => m[1]!.split(','))
    expect(sels.length).toBeGreaterThan(10)
    for (const sel of sels) expect(sel.trim().startsWith(R), sel).toBe(true)
  })

  test('every data URL is percent-encoded, with no "<", "#" or "</", and decodes back to an SVG', () => {
    expect(own).not.toMatch(/<|#/)
    expect(own).not.toContain('</')
    const urls = [...own.matchAll(/url\("data:image\/svg\+xml;utf8,([^"]*)"\)/g)].map(m => m[1]!)
    expect(urls.length).toBeGreaterThan(0)
    // no other kind of url() sneaks in (the SVGs' own filter references are inside their data)
    expect(own.replace(/url\("data:image\/svg\+xml;utf8,[^"]*"\)/g, '')).not.toContain('url(')
    for (const data of urls) {
      expect(data).not.toMatch(/%(?![0-9A-F]{2})/)
      const svg = decodeURIComponent(data)
      expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg'/)
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  test('swap the glyphs: Classic\'s hidden, the Postal alternates shown', () => {
    expect(own).toContain(`${R} .gc{display:none}`)
    expect(own).toContain(`${R} .gp{display:inline}`)
  })

  test('show every hook they style', () => {
    for (const hook of ['.orn-place', '.orn-rubber', '.orn-empty', '.orn-postmark']) {
      expect(own, hook).toMatch(new RegExp(`\\${hook}\\{[^}]*display:(block|inline|inline-block)`))
    }
    for (const kind of ['box', 'counter', 'plain']) expect(own).toContain(`.code-plate[data-kind=${kind}]`)
    for (const s of ['ready_for_pickup', 'out_for_delivery', 'delivered', 'collected']) expect(own).toContain(`[data-status=${s}]`)
    expect(own).toContain('.card[data-status=out_for_delivery]::before')
    expect(own).toContain('.card[data-status=failed_attempt]::before')
  })

  test('have no motion: no keyframes, animation or transition (Task 6 owns those)', () => {
    expect(own).not.toMatch(/@keyframes|animation|transition/)
  })

  test('the postmark never takes a selection, and blends as ink in light only', () => {
    expect(own).toMatch(/\.orn-postmark\{[^}]*user-select:none/)
    expect(own).toMatch(/--orn-blend:multiply/)
    expect(own).toMatch(/\[data-mode="dark"\]\{[^}]*--orn-blend:normal/)
    expect(own).toMatch(/@media\(prefers-color-scheme:dark\)\{[^{}]*\[data-mode="system"\]\{[^}]*--orn-blend:normal/)
  })

  test('yellow is only ever a fill: no text is coloured --signal, and stamp text is --on-signal', () => {
    expect(own).not.toMatch(/(^|[;{])color:var\(--signal\)/)
    expect(own).toMatch(/\.code-plate\[data-kind=box\]\{[^}]*color:var\(--on-signal\)/)
  })

  test('the rubber stamp\'s warn ink, at its opacity over the card, keeps 5.5:1 headroom in both modes (the grain mask thins the strokes)', () => {
    expect(RUBBER_OPACITY).toBeGreaterThan(0)
    expect(RUBBER_OPACITY).toBeLessThanOrEqual(1)
    expect(own).toContain(`opacity:${RUBBER_OPACITY}`)
    for (const mode of MODES) {
      const surface = postal.colors.surface[mode]
      const ratio = contrast(over(postal.colors.warn[mode], surface, RUBBER_OPACITY), surface)
      expect(ratio >= 5.5, `${mode}: rubber on surface is ${ratio.toFixed(2)}:1`).toBe(true)
    }
  })

  test('the blend fixture lays a colour over another', () => {
    expect(over('#000000', '#ffffff', 1)).toBe('#000000')
    expect(over('#000000', '#ffffff', 0)).toBe('#ffffff')
    expect(over('#ff0000', '#0000ff', 0.5)).toBe('#800080')
  })
})

describe('Postal motion', () => {
  const R = ':root[data-theme="postal"]'
  const NO_PREF = /@media\(prefers-reduced-motion:no-preference\)\{/g
  const own = stripComments(POSTAL_MOTION)
  /** The body of `@keyframes <name>{…}`, or undefined. */
  const keyframes = (name: string): string | undefined => {
    const [span] = blocks(own, new RegExp(`@keyframes ${name}\\{`, 'g'))
    return span && own.slice(span[0], span[1]).replace(/^[^{]*\{/, '').slice(0, -1)
  }
  /** The declarations of the rule whose selector list is exactly `sel`. */
  const rule = (sel: string): string | undefined => {
    for (const m of own.matchAll(/(?<=^|[{}])([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.trim() === sel) return m[2]
    return undefined
  }

  test('is part of Postal\'s css, after the ornaments, and of no other theme', () => {
    expect(POSTAL_MOTION.length).toBeGreaterThan(0)
    const css = postal.css ?? ''
    expect(css).toContain(POSTAL_MOTION)
    expect(css.indexOf(POSTAL_MOTION)).toBeGreaterThan(css.indexOf(POSTAL_ORNAMENTS))
    expect(themeCss(classic)).not.toMatch(/@keyframes|animation|transition|translate|rotate/)
  })

  test('is one prefers-reduced-motion:no-preference block, and Postal has no keyframes, animation or transition outside it', () => {
    expect(blocks(own, NO_PREF)).toEqual([[0, own.length]])
    for (const css of [stripComments(postal.css ?? ''), stripComments(themeCss(postal))]) {
      expect(blocks(css, NO_PREF)).toHaveLength(1)
      expect(withoutBlocks(css, NO_PREF)).not.toMatch(/animation|@keyframes|transition/)
    }
  })

  test('has the board\'s keyframes, none of them a name the base stylesheet uses, and nothing repeats forever', () => {
    const names = [...own.matchAll(/@keyframes ([\w-]+)\{/g)].map(m => m[1])
    expect(names.sort()).toEqual(['deal', 'inkin', 'march', 'slam', 'thud'])
    for (const n of names) expect(BASE_CSS).not.toContain(`@keyframes ${n}{`)
    expect(own).not.toContain('infinite')
  })

  test('scopes every selector to data-theme="postal"', () => {
    const inner = withoutBlocks(own, /@keyframes\s+[\w-]+\s*\{/g).replace(/@media[^{]*\{/g, '')
    const sels = [...inner.matchAll(/(?:^|\})([^{}]+)\{/g)].flatMap(m => m[1]!.split(','))
    expect(sels.length).toBeGreaterThan(8)
    for (const sel of sels) expect(sel.trim().startsWith(R), sel).toBe(true)
  })

  test('slams the postmark down and dips its notice or status line 3px, without a stacking context over the postmark', () => {
    expect(rule(`${R} .orn-postmark.just-collected`)).toMatch(/^animation:slam \.55s /)
    expect(rule(`${R} .notice:has(>div>.orn-postmark.just-collected),${R} .status:has(>.orn-postmark.just-collected)`)).toMatch(/^animation:thud \.55s /)
    const thud = keyframes('thud')!
    expect(thud).toContain('top:3px')
    // the parcel page's postmark is under the status line's words only while no ancestor makes a stacking context
    expect(thud).not.toMatch(/transform|translate|scale|rotate|filter|opacity|z-index/)
    // the postmark's big start never gives the parcel page a sideways scroll
    expect(rule(`${R} .frame:has(.status>.orn-postmark.just-collected)`)).toBe('overflow-x:clip')
  })

  test('the tilted ornaments keep their tilt: slam and inkin leave transform alone, and end on the static rules', () => {
    for (const name of ['slam', 'inkin']) {
      const kf = keyframes(name)!
      expect(kf, name).not.toMatch(/transform/)
      // no 100% keyframe: the end is the element's own static values, whatever they are
      expect(kf, name).not.toMatch(/(^|\})(100%|to)[,{]/)
    }
    // the slam's rotate adds to the postmark's resting -10deg: -26deg at the start, as on the board
    expect(keyframes('slam')).toMatch(/^0%\{[^}]*rotate:-16deg/)
  })

  test('deals the cards in once per load, 60ms apart up to the sixth', () => {
    expect(rule(`${R} .card`)).toMatch(/(^|;)animation:deal \.5s cubic-bezier\(\.2,\.8,\.2,1\) 360ms both(;|$)/)
    for (let n = 1; n <= 6; n++) expect(rule(`${R} .card:nth-child(${n} of .card)`), `card ${n}`).toBe(`animation-delay:${n * 60}ms`)
    expect(own).not.toContain('nth-child(7')
  })

  /** Every element a Postal motion animates, as its selector after the scope. */
  const ANIMATED = ['.card', '.card[data-status=out_for_delivery]::before', '.card.just-arrived .code-plate b', '.orn-postmark.just-collected',
    '.notice:has(>div>.orn-postmark.just-collected)', '.status:has(>.orn-postmark.just-collected)']

  test('animates exactly these elements', () => {
    const animated = [...own.matchAll(/(?<=^|[{}])([^{}]+)\{animation:(?!none)[^}]*\}/g)].flatMap(m => m[1]!.split(/,(?![^(]*\))/))
      .map(s => s.trim().replace(`${R} `, ''))
    expect(animated.sort()).toEqual([...ANIMATED].sort())
  })

  test('replays nothing on a page that reloads itself every few seconds while a refresh runs', () => {
    // the march would restart on every reload and never stop; the deal would re-deal; a one-shot would repeat
    const reloading = `${R}:has(meta[http-equiv=refresh])`
    expect(rule(ANIMATED.map(s => `${reloading} ${s}`).join(','))).toBe('animation:none')
  })

  test('prints everything at rest, never a card or code caught at opacity 0', () => {
    const [print] = blocks(own, /@media print\{/g)
    expect(print).toBeDefined()
    expect(own.slice(print![0], print![1])).toBe(`@media print{${ANIMATED.map(s => `${R} ${s}`).join(',')}{animation:none}}`)
    // it comes after the rules it overrides, at the same specificity
    expect(print![0]).toBeGreaterThan(own.lastIndexOf('{animation:inkin'))
  })

  test('inks in the code of a card that just arrived, keeping a PIN stamp\'s shadow', () => {
    expect(rule(`${R} .card.just-arrived .code-plate b`)).toMatch(/^animation:inkin \.5s \.25s /)
    expect(keyframes('inkin')).toMatch(/^0%\{[^}]*filter:var\(--orn-ink-filter,\) blur\(3px\)/)
    expect(own).toContain(`${R} .code-plate[data-kind=counter] b,${R} .code-plate[data-kind=plain] b{--orn-ink-filter:var(--orn-stamp-shadow)}`)
  })

  test('marches the airmail edge three times, then stops, by exactly one repeat of its stripes', () => {
    const decl = /animation:(march [^;}]*)/.exec(rule(`${R} .card[data-status=out_for_delivery]::before`) ?? '')?.[1]
    expect(decl?.split(' ')).toContain('3')
    // -45deg stripes repeating every AIRMAIL_REPEAT px repeat every AIRMAIL_REPEAT*sqrt(2) px across; the
    // stripe image shrinks by that from one repeat wider than the bar to the bar itself
    const shift = (AIRMAIL_REPEAT * Math.SQRT2).toFixed(4)
    expect(keyframes('march')).toBe(`from{background-size:calc(100% + ${shift}px) 100%}to{background-size:100% 100%}`)
  })

  test('lifts a hovered card with translate and rotate, so it never fights the deal\'s transform', () => {
    expect(own).toContain(`${R} .card:hover{translate:0 -3px;rotate:-.8deg}`)
    expect(rule(`${R} .card`)).toMatch(/(^|;)transition:translate \.2s ease-out,rotate \.2s ease-out(;|$)/)
    expect(own).not.toMatch(/:hover\{[^}]*transform/)
  })

  test('presses a button 1px down', () => {
    expect(rule(`${R} button:active`)).toBe('translate:0 1px')
  })

  test('leaves Classic\'s css exactly as it was before Postal had motion', () => {
    const css = themeCss(classic)
    expect(css.length).toBe(1069)
    expect(createHash('sha256').update(css).digest('hex')).toBe('59c7e6bd777ce227b4952ca2aef3fc1d3dbd7deac2805faf3781ca37da8df51e')
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
