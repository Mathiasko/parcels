/**
 * Postal: cream paper with grain, DM Serif Display headings, Libre Franklin text, Courier Prime for the
 * mono bits. Tokens, fonts and a little scoped CSS over today's markup, then the ornaments (stamps, badges,
 * edges, the postmark: postal-ornaments.ts) that style the neutral hooks the views carry; no motion yet.
 * The colours are the spec's §3.1 values, every §5 contrast pair checked by test/themes.test.ts. The
 * fonts are in assets/fonts/ (see its README for the licences and ranges).
 */
import type { Theme, ThemeFont } from './types.js'
import { POSTAL_ORNAMENTS } from './postal-ornaments.js'
import { svgUrl } from './svg-url.js'

/** From assets/fonts/README.md, verbatim; every family and weight uses these two. */
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

/** One family/weight/style in both subsets; `stem` is the fontsource file name up to the subset. */
const subsets = (family: string, stem: string, tail: string, style: ThemeFont['style'], weight: string): ThemeFont[] => [
  { family, file: `${stem}-latin-${tail}.woff2`, style, weight, unicodeRange: LATIN },
  { family, file: `${stem}-latin-ext-${tail}.woff2`, style, weight, unicodeRange: LATIN_EXT },
]

/**
 * A grain tile as a CSS `url()`. The SVG source is the paper-grain rule of the Postal moodboard
 * (`.grain`, light; `.dk.grain`, dark): feTurbulence noise tinted by `matrix`, percent-encoded by `svgUrl`.
 */
const grain = (matrix: string): string =>
  svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='${matrix}'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`)

const GRAIN_LIGHT = grain('0 0 0 0 .35  0 0 0 0 .27  0 0 0 0 .15  0 0 0 .55 0')
const GRAIN_DARK = grain('0 0 0 0 .95  0 0 0 0 .85  0 0 0 0 .7  0 0 0 .16 0')
const SHADOW_DARK = '0 1px 0 rgba(0,0,0,.4),0 16px 30px -14px rgba(0,0,0,.7)'

const ROOT = ':root[data-theme="postal"]'
const DARK = `--texture:${GRAIN_DARK};--shadow-card:${SHADOW_DARK}`

export const postal: Theme = {
  id: 'postal',
  name: 'Postal',
  colors: {
    paper: { light: '#f3ead7', dark: '#211c18' },
    surface: { light: '#fbf6ea', dark: '#2c2620' },
    hover: { light: '#f1e7d2', dark: '#362f27' },
    rule: { light: '#e6dcc6', dark: '#3a332b' },
    'rule-s': { light: '#d9cbb0', dark: '#4b4237' },
    edge: { light: '#857559', dark: '#8f826e' },
    ink: { light: '#1d2433', dark: '#f1e8d6' },
    'ink-2': { light: '#5a4f3f', dark: '#c3b6a0' },
    'ink-3': { light: '#6a5d48', dark: '#ab9d87' },
    signal: { light: '#f6c21c', dark: '#f7c948' },
    'signal-ink': { light: '#7a5600', dark: '#f7c948' },
    'on-signal': { light: '#1d2433', dark: '#241a00' },
    'signal-wash': { light: '#f9e7a8', dark: '#3b3118' },
    warn: { light: '#b3261e', dark: '#ff8a7a' },
    'on-warn': { light: '#fbf6ea', dark: '#2a0d08' },
    'warn-wash': { light: '#f7e0d6', dark: '#3f241f' },
    ok: { light: '#23468c', dark: '#9db8ff' },
    'ok-wash': { light: '#e2e6f0', dark: '#222a3d' },
    'btn-hover': { light: '#2f3a52', dark: '#ffffff' },
  },
  tokens: {
    'font-display': '"DM Serif Display",Georgia,serif',
    'font-body': '"Libre Franklin","Helvetica Neue",sans-serif',
    'font-mono': '"Courier Prime","Courier New",monospace',
    'radius-card': '6px',
    'radius-badge': '3px',
    'radius-btn': '4px',
    'shadow-card': '0 1px 0 rgba(90,70,30,.08),0 14px 26px -16px rgba(80,55,15,.45)',
    texture: GRAIN_LIGHT,
  },
  fonts: [
    ...subsets('DM Serif Display', 'dm-serif-display', '400-normal', 'normal', '400'),
    ...subsets('DM Serif Display', 'dm-serif-display', '400-italic', 'italic', '400'),
    // The file's wght axis is 100-900; the spec uses 400-800.
    ...subsets('Libre Franklin', 'libre-franklin', 'wght-normal', 'normal', '400 800'),
    ...subsets('Courier Prime', 'courier-prime', '400-normal', 'normal', '400'),
    ...subsets('Courier Prime', 'courier-prime', '700-normal', 'normal', '700'),
  ],
  // DM Serif Display has only a 400, so the display elements say 400 rather than let the browser fake a
  // bold. The dark grain and shadow can't be `light-dark()` pairs (it takes no images), so they are swapped
  // under data-mode="dark", and under data-mode="system" while the OS is dark. Pages always render a
  // data-mode, so there is no rule for a missing one.
  css: [
    `${ROOT} h1,${ROOT} .card-h h2,${ROOT} .pk-h h2,${ROOT} .pk-h .where{font-weight:400}`,
    // Base CSS masks the timeline rail with solid paper behind the day headings and the glyphs. Over the
    // grained page those would show as flat patches, so the page grain and the masks' grain are all
    // viewport-fixed: one texture, the same alignment, and the masks vanish into the page. The masks take
    // --texture, so the dark swap below reaches them. :not(.dotg) keeps the dot glyph without a background
    // (this selector would otherwise outrank the base .er .gl.dotg{background:none}).
    `${ROOT} body{background-attachment:fixed}`,
    `${ROOT} .day>span,${ROOT} .er .gl:not(.dotg){background-image:var(--texture);background-attachment:fixed}`,
    // Courier Prime has a smaller x-height than the system mono, so it reads small at the base .8125rem.
    `${ROOT} .mono{font-size:.875rem}`,
    `${ROOT}[data-mode="dark"]{${DARK}}`,
    `@media(prefers-color-scheme:dark){${ROOT}[data-mode="system"]{${DARK}}}`,
    POSTAL_ORNAMENTS,
  ].join('\n'),
}
