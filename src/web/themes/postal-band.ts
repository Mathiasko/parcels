/**
 * Postal's header: a full-width navy sign, its lower edge perforated like a stamp, holding the name and the
 * page's actions on one row and the pages on the next. It restyles the same `<nav>` Classic uses: the rows come
 * from flex `order` and a line break made by `nav::before`, so the links' order in the document does not change.
 *
 * The band stays navy in both modes rather than following `--ink`, which turns cream in dark and would light up
 * the top of a dark page, so its colours are its own (their contrast is checked in test/postal-band.test.ts).
 */
import { svgUrl } from './svg-url.js'

const R = ':root[data-theme="postal"]'

export const BAND = {
  fill: { light: '#1d2433', dark: '#10141d' },
  text: '#f1e8d6',
  textQuiet: '#c9bda6',
  buttonText: '#1d2433',
  trouble: '#ff8a7a',
} as const

/** A colour for the stylesheet, which carries no raw "#" (see svg-url.ts). */
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ')})`
const TEXT = rgb(BAND.text)
const QUIET = rgb(BAND.textQuiet)
const ON_BUTTON = rgb(BAND.buttonText)

/** The hole pitch and depth of the perforated edge, in px. */
const PERF_PITCH = 15
const PERF_DEPTH = 9

/** The app icon's small drawing (assets/icon/app-icon-small.svg), without its shadow or postmark wave. */
const MARK = svgUrl("<svg xmlns='http://www.w3.org/2000/svg' viewBox='100 100 824 824'><mask id='m'><rect x='100' y='100' width='824' height='824' fill='white'/><g fill='black'><circle cx='416' cy='192' r='40'/><circle cx='608' cy='192' r='40'/><circle cx='416' cy='832' r='40'/><circle cx='608' cy='832' r='40'/><circle cx='256' cy='288' r='40'/><circle cx='256' cy='416' r='40'/><circle cx='256' cy='608' r='40'/><circle cx='256' cy='736' r='40'/><circle cx='768' cy='288' r='40'/><circle cx='768' cy='416' r='40'/><circle cx='768' cy='608' r='40'/><circle cx='768' cy='736' r='40'/></g></mask><rect x='100' y='100' width='824' height='824' rx='185' fill='#23468c'/><rect x='256' y='192' width='512' height='640' fill='#fbf6ea' mask='url(#m)'/><rect x='320' y='256' width='384' height='512' fill='#f6c21c'/><rect x='384' y='384' width='256' height='192' fill='#c78a3c'/><rect x='384' y='384' width='256' height='64' fill='#e0a95a'/><rect x='480' y='384' width='64' height='192' fill='#1d2433'/><circle cx='704' cy='688' r='152' fill='none' stroke='#b3261e' stroke-width='52'/></svg>")

/** The nav's page links: everything but the name and Add parcel. */
const PAGES = `${R} header nav a:not(.brand):not(.add)`

/** The dashboard's own title row: the band has taken its Refresh, and the current tab already names the page. */
const TITLE_ROW = `${R} .head:has(>form[action="/refresh"])`

export const POSTAL_BAND = [
  `${R}{--band:light-dark(${rgb(BAND.fill.light)},${rgb(BAND.fill.dark)})}`,

  // Lines the nav up with the page's column: the frame's left edge, in whichever window.
  `${R} header{position:relative;max-width:none;margin:0 0 calc(2.25rem + ${PERF_DEPTH}px);padding:1rem max(1.5rem,calc((100% - 64rem) / 2 + 1.5rem)) 0;background:var(--band);color:${TEXT}}`,
  `${R} header::after{content:"";position:absolute;left:0;right:0;top:100%;height:${PERF_DEPTH}px;margin-top:-1px;background:radial-gradient(circle at 50% 100%,transparent 4px,var(--band) 4.6px) 0 0/${PERF_PITCH}px ${PERF_DEPTH}px repeat-x}`,
  `${R} header :focus-visible{outline-color:${TEXT}}`,

  `${R} header nav{align-items:flex-end;gap:0}`,
  `${R} header nav::before{content:"";order:3;flex-basis:100%;height:.625rem}`,

  // First row: the name, then Refresh and Add parcel at the right.
  `${R} header nav a.brand{order:0;flex-direction:row;align-items:center;gap:.5rem;align-self:center;margin-right:auto;padding:0;color:${TEXT};font-family:var(--font-display);font-size:1.625rem;font-weight:400;line-height:1}`,
  `${R} header nav a.brand::before{content:"";flex:none;width:2rem;height:2rem;background:${MARK} center/contain no-repeat}`,
  `${R} header nav a.brand::after,${R} header nav a.add::after{display:none}`,
  `${R} .hd-refresh{order:1;display:block;margin:0 .5rem 0 0}`,
  `${R} .hd-refresh button{min-height:2.25rem;background:transparent;border-color:${QUIET};color:${TEXT};white-space:nowrap}`,
  `${R} .hd-refresh button:hover{background:color-mix(in srgb,${TEXT} 14%,transparent)}`,
  `${R} header nav a.add{order:2;flex-direction:row;align-items:center;align-self:center;min-height:2.25rem;margin:0;padding:0 .875rem;border-radius:var(--radius-btn);background:${TEXT};color:${ON_BUTTON};font-size:.8125rem;font-weight:600}`,
  `${R} header nav a.add::before{content:"+\\00a0"}`,
  `${R} header nav a.add:hover{background:white;color:${ON_BUTTON}}`,
  `${R} header nav a.add[aria-current]{box-shadow:0 0 0 2px var(--band),0 0 0 3.5px ${TEXT}}`,

  // Second row: the pages, with the two you rarely open kept apart at the right.
  `${PAGES}{order:4;margin-right:1.5rem;padding:.5rem 0 .625rem;color:${QUIET}}`,
  `${PAGES}:hover{color:${TEXT}}`,
  `${PAGES}[aria-current]{color:${TEXT};box-shadow:inset 0 -3px 0 ${TEXT}}`,
  `${PAGES}[href="/health"]{margin-left:auto}`,
  `${PAGES}[href="/settings"]{margin-right:0}`,
  `${R} header nav .n{background:${TEXT};color:${ON_BUTTON}}`,
  `${R} header nav .dot{background:${rgb(BAND.trouble)}}`,

  // The dashboard's title row gives way to the band, and stays for a screen reader.
  `${TITLE_ROW}{display:block;height:0}`,
  `${TITLE_ROW}>h1{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`,
  `${TITLE_ROW}>form{display:none}`,

  // A phone: tighter, the pages all on one row, and Refresh loses "now" to fit beside Add parcel.
  `@media(max-width:40rem){${R} header nav a.brand{font-size:1.25rem}${R} header nav a.brand::before{width:1.625rem;height:1.625rem}${R} .hd-now{display:none}${R} .hd-refresh{margin-right:.375rem}${R} .hd-refresh button{padding-inline:.625rem}${R} header nav a.add{padding:0 .625rem}${PAGES}{margin-right:.875rem;font-size:.875rem}${PAGES}[href="/health"]{margin-left:0}${PAGES}[href="/settings"]{margin-right:0}}`,
  // The narrowest phones: the mark alone says the name (a screen reader still gets the word), so the buttons fit.
  `@media(max-width:22.5rem){${R} header nav a.brand{font-size:0}}`,

  // On paper a navy band is a waste of ink, and printers drop backgrounds anyway, which would leave cream words.
  `@media print{${R} header{background:none;color:var(--ink)}${R} header::after{display:none}${R} header nav a.brand,${PAGES},${PAGES}[aria-current]{color:var(--ink)}${R} .hd-refresh,${R} header nav a.add{display:none}}`,
].join('\n')
