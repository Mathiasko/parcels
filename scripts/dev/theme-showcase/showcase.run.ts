// A showcase of every card state, for looking at a theme and for diffing two commits (see README.md).
//
//   export PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
//   THEME=postal|classic OUT=<dir> [FRAMES=1 [STRICT=0]] [SCENES=dash,settings] [KEEP=1] \
//     command npx vitest run --config scripts/dev/theme-showcase/vitest.config.ts
//
// One long "test" that seeds throw-away databases through the REAL db helpers (parcels, events, pickup
// codes, poll runs, activity log, collected marks), builds the REAL web server on them (fake clock, fake
// calendar, silent notifier, dead HttpClient) and asks it for each scene's page with `inject`: no socket
// is opened, so there is no port at all, let alone 8787. Every network API and every child process is
// blocked (persona-sim's guards); Chrome and ImageMagick run through the guard's saved execFile.
//
// Each page is saved with what it loads from the server inlined (fonts, images), and shot from that copy
// with headless Chrome (own profile, dead proxy, no resolver) at 1280 and 390 px, light and dark, with
// reduced motion forced. The 390 shot goes through a 390 px iframe, because headless Chrome will not make
// a window that narrow. The copy also gets a 4 px magenta `html::after`, after everything on the page; the
// shot is cropped at its first row, which is exactly the page's height. (Auto-trim cannot work: the Postal
// paper grain has no flat colour to trim.)
//
// With FRAMES=1 it also writes frozen motion frames, at 0, 50 and 100 % of each motion, to <OUT>/motion/.
// THEME unset leaves `appearance` out of the config, which is what a commit from before themes needs.
process.env.TZ = 'Europe/Bratislava'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vitest'
import { blocked, installGuards, realExecFile } from '../persona-sim/lib/guard.js'
import { openDb, type Database } from '../../../src/db/index.js'
import { insertParcel, updateParcelState } from '../../../src/db/parcels.js'
import { appendEvents } from '../../../src/db/events.js'
import { recordPickupCode } from '../../../src/db/pickup-codes.js'
import { finishRun, startRun } from '../../../src/db/poll-runs.js'
import { markCollected } from '../../../src/core/collected.js'
import { buildServer } from '../../../src/web/server.js'
import type { CanonicalStatus, CarrierId, HttpClient, ParcelEvent, PickupPoint } from '../../../src/core/types.js'

const ROOT = resolve(__dirname, '../../..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAGICK = existsSync('/opt/homebrew/bin/magick') ? '/opt/homebrew/bin/magick' : 'magick'
const exec = promisify(realExecFile)
const ZONE = 'Europe/Bratislava'
const THEMES = ['postal', 'classic']
/** The window height. A page taller than this has no marker in the shot, and the shot fails. */
const H = 6000
/** Friday 6 November 2026, 14:15 in Bratislava. */
const NOW = new Date('2026-11-06T13:15:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** The end-of-page marker: after everything, so the crop at its first row keeps the whole page and none of it. */
const MARKER = '<style>html::after{content:"";display:block;height:4px;background:#f0f}</style>'

// ------------------------------------------------------------------------------------------------ seeds
type World = 'board' | 'empty' | 'refreshing'
interface Seeded { db: Database; ids: Record<string, number> }

const ev = (status: CanonicalStatus, minutesAgo: number, description: string): ParcelEvent => {
  const at = new Date(NOW.getTime() - minutesAgo * MIN)
  return { occurredAt: at, occurredAtRaw: at.toISOString(), occurredAtTz: ZONE, status, description }
}
interface Seed {
  key: string; carrier: CarrierId; number: string; merchant?: string; seenDaysAgo: number
  events: ParcelEvent[]; pickup?: PickupPoint; code?: string; tillDays?: number
  /** Moved to ready by the finished run, so `/?run=<run>` marks its card `just-arrived`. */
  byRun?: true
  /** Marked collected this many minutes before NOW. */
  collectedMinAgo?: number
}
const place = (kind: PickupPoint['kind'], name: string, street: string): PickupPoint =>
  ({ kind, name, street, city: 'Bratislava', postalCode: '81101' })
/** Every card state the dashboard has, with fake numbers, shops and places. */
const BOARD: Seed[] = [
  { key: 'zbox', carrier: 'packeta', number: 'Z9990000001', merchant: 'Kníhkupectvo Vzor', seenDaysAgo: 3, byRun: true,
    pickup: place('zbox', 'Z-BOX Vzorová 12', 'Vzorová 12'), code: '631285', tillDays: 6,
    events: [ev('pre_transit', 3 * 24 * 60, 'Zásielka bola podaná'), ev('in_transit', 2 * 24 * 60, 'Zásielka je na ceste'), ev('ready_for_pickup', 4, 'Zásielka čaká v Z-BOXe')] },
  { key: 'locker', carrier: 'sps', number: 'SPS9990000002', merchant: 'Čajovňa Príklad', seenDaysAgo: 2,
    pickup: place('locker', 'Balíkomat Ukážková 3', 'Ukážková 3'), code: '4821', tillDays: 3,
    events: [ev('in_transit', 30 * 60, 'Parcel in transit'), ev('ready_for_pickup', 3 * 60, 'Parcel stored in the locker')] },
  { key: 'parcelshop', carrier: 'gls', number: '99900000003', merchant: 'Example Sports', seenDaysAgo: 4,
    pickup: place('parcelshop', 'GLS ParcelShop Trafika Vzor', 'Fiktívna 7'), code: '7731', tillDays: 5,
    events: [ev('in_transit', 2 * 24 * 60, 'The parcel is in transit'), ev('ready_for_pickup', 24 * 60, 'The parcel is ready for pickup at the ParcelShop')] },
  { key: 'post_office', carrier: 'posta', number: 'RR999000004SK', merchant: 'Obchod Ukážka', seenDaysAgo: 5,
    pickup: place('post_office', 'Pošta Bratislava 99', 'Námestie Vzoru 1'), code: '2059', tillDays: 1,
    events: [ev('in_transit', 3 * 24 * 60, 'Zásielka je na ceste'), ev('ready_for_pickup', 2 * 24 * 60, 'Zásielka je uložená na pošte')] },
  { key: 'plain', carrier: 'dpd', number: '09990000000005', merchant: 'Example Garden', seenDaysAgo: 2, code: '5512',
    events: [ev('in_transit', 26 * 60, 'Parcel is on its way'), ev('ready_for_pickup', 5 * 60, 'Parcel is ready for collection')] },
  { key: 'out', carrier: 'ppl', number: '99900000006', merchant: 'Elektro Vzor', seenDaysAgo: 2,
    events: [ev('in_transit', 22 * 60, 'Parcel in transit'), ev('out_for_delivery', 2 * 60, 'Parcel is out for delivery')] },
  { key: 'failed', carrier: 'posta', number: 'RR999000007SK', merchant: 'Kvetinárstvo Ukážka', seenDaysAgo: 3,
    events: [ev('in_transit', 28 * 60, 'Zásielka je na ceste'), ev('failed_attempt', 3 * 60, 'Adresát nezastihnutý')] },
  { key: 'transit', carrier: 'packeta', number: 'Z9990000008', merchant: 'Example Store', seenDaysAgo: 1,
    events: [ev('pre_transit', 20 * 60, 'Zásielka bola podaná'), ev('in_transit', 5 * 60, 'Zásielka je v triediacom centre')] },
  // Off the dashboard (collected), so `/` stays the eight above; `/?collected=` and its page show it.
  { key: 'collected', carrier: 'packeta', number: 'Z9990000009', merchant: 'Hračky Vzor', seenDaysAgo: 4, collectedMinAgo: 10,
    pickup: place('zbox', 'Z-BOX Námestie 4', 'Námestie 4'), code: '402277', tillDays: 4,
    events: [ev('in_transit', 2 * 24 * 60, 'Zásielka je na ceste'), ev('ready_for_pickup', 24 * 60, 'Zásielka čaká v Z-BOXe')] },
]

function seed(world: World, dbPath: string): Seeded {
  rmSync(dbPath, { force: true })
  const db = openDb(dbPath)
  const ids: Record<string, number> = {}
  if (world === 'refreshing') {
    // A run two minutes old is still running (well inside RUN_STALE_MS): its page shows the spinner.
    ids.run = startRun(db, 'web', new Date(NOW.getTime() - 2 * MIN))
    return { db, ids }
  }
  // The poller's last run, so the lede reads like a normal day.
  const run = startRun(db, 'poller', new Date(NOW.getTime() - 3 * MIN))
  if (world === 'board') {
    for (const s of BOARD) {
      const id = insertParcel(db, { carrier: s.carrier, trackingNumber: s.number, merchant: s.merchant, source: 'email',
        firstSeenAt: new Date(NOW.getTime() - s.seenDaysAgo * DAY) })
      appendEvents(db, id, s.events)
      const last = s.events.at(-1)!
      updateParcelState(db, id, {
        status: last.status, statusRaw: last.description, pickup: s.pickup, lastChangedAt: last.occurredAt,
        retainedTill: s.tillDays === undefined ? undefined : new Date(NOW.getTime() + s.tillDays * DAY),
      }, s.byRun ? { actor: 'poller', runId: run, at: new Date(NOW.getTime() - 3 * MIN + 20_000) } : { actor: 'poller', at: last.occurredAt })
      if (s.code) recordPickupCode(db, id, s.code, 1, last.occurredAt)
      if (s.collectedMinAgo !== undefined) {
        const outcome = markCollected(db, id, { actor: 'web', at: new Date(NOW.getTime() - s.collectedMinAgo * MIN) })
        if (!outcome.ok) throw new Error(`showcase: could not mark ${s.key} collected (${outcome.reason})`)
      }
      ids[s.key] = id
    }
  }
  finishRun(db, run, { counts: { polled: world === 'board' ? 8 : 0, newEvents: world === 'board' ? 1 : 0, failures: 0 }, summary: '' },
    new Date(NOW.getTime() - 2 * MIN))
  ids.run = run
  return { db, ids }
}

// ------------------------------------------------------------------------------------------------ scenes
interface Scene {
  name: string; world: World; url: (ids: Record<string, number>) => string
  /** What the page must say whatever the commit: the scene really is the state it is named after. */
  has: Array<string | RegExp>
  /** The Phase B hooks the scene exists to show; checked only on a build that has themes (`data-theme`). */
  hooks: Array<string | RegExp>
  /** Only for motion frames, never shot as a static scene. */
  framesOnly?: true
}
const cards = (n: number) => new RegExp(`^(?:[\\s\\S]*?<article class="card[ "]){${n}}(?![\\s\\S]*<article class="card[ "])`)
const SCENES: Scene[] = [
  { name: 'dash', world: 'board', url: () => '/', has: [cards(8), 'Open the box with', 'Show this PIN at the counter:', 'Adresát nezastihnutý'],
    hooks: ['data-kind="box"', 'data-kind="counter"', 'data-kind="plain"', '<span class="orn-rubber" aria-hidden="true">Adresát nezastihnutý</span>',
      'data-status="out_for_delivery"', 'data-status="in_transit"'] },
  { name: 'dash-empty', world: 'empty', url: () => '/', has: ['<p class="empty">'], hooks: ['<p class="orn-empty" aria-hidden="true">'] },
  { name: 'dash-collected-notice', world: 'board', url: ids => `/?collected=${ids.collected}`, has: [cards(8), 'class="undo"'],
    hooks: ['<div class="notice just-collected"', '<span class="orn-postmark just-collected" aria-hidden="true">'] },
  { name: 'dash-arrived', world: 'board', url: ids => `/?run=${ids.run}`, has: [cards(8), 'Polled 8 parcels.'],
    // exactly one card is just-arrived (the stylesheet names the class too, so count only cards)
    hooks: [/^(?![\s\S]*class="card just-arrived[\s\S]*class="card just-arrived)[\s\S]*<article class="card just-arrived" data-status="ready_for_pickup">/] },
  { name: 'parcel-box', world: 'board', url: ids => `/parcel/${ids.zbox}`, has: ['Open the box with', '631285'], hooks: ['data-kind="box"', 'Z-BOX · Packeta'] },
  { name: 'parcel-counter', world: 'board', url: ids => `/parcel/${ids.parcelshop}`, has: ['Show this PIN at the counter:', '7731'],
    hooks: ['data-kind="counter"', 'ParcelShop · GLS'] },
  { name: 'parcel-collected', world: 'board', url: ids => `/parcel/${ids.collected}?collected=1`, has: ['Z9990000009'],
    hooks: ['<span class="orn-postmark just-collected" aria-hidden="true">', '>6·XI·26</text>', '>14:05</text>'] },
  { name: 'parcel-failed', world: 'board', url: ids => `/parcel/${ids.failed}`, has: ['Adresát nezastihnutý'], hooks: ['data-status="failed_attempt"'] },
  { name: 'settings', world: 'board', url: () => '/settings', has: ['parcels@example.invalid'], hooks: ['name="theme"'] },
  { name: 'refreshing', world: 'refreshing', url: ids => `/?run=${ids.run}`, has: ['Refreshing.', 'class="spin"'], hooks: [], framesOnly: true },
]

// ------------------------------------------------------------------------------------------------ motion
/**
 * A frozen motion. `keyframes`: the frames keep only these @keyframes in the page's CSS (every other
 * animation has no keyframes, so its element sits in its static, end state) and pause every animation at
 * the same point. `state`: the rules with `pseudo` whose selector matches `rule` are copied with the pseudo
 * replaced by the class `frz-on`, which `target` puts on one element; their declarations become a
 * `to{}`-only keyframe from the element's own style, frozen the same way, so 50 % is the linear midpoint.
 */
interface Motion {
  name: string; scene: string
  /** The theme the motion belongs to: on that theme's pages a skip fails the run (unless STRICT=0). */
  theme?: string
  keyframes?: string[]
  state?: { pseudo: ':hover' | ':active'; rule: RegExp; target: (html: string) => string }
}
/** Adds `frz-on` to the first opening tag `re` matches (group 1 is the tag). */
const onFirst = (re: RegExp) => (html: string): string => {
  const m = re.exec(html)
  if (!m) throw new Error(`showcase: no element for ${re}`)
  const tag = m[1]!
  const marked = /\sclass="/.test(tag) ? tag.replace(/\sclass="/, ' class="frz-on ') : tag.replace(/^<(\w+)/, '<$1 class="frz-on"')
  const at = m.index + m[0].length - tag.length
  return html.slice(0, at) + marked + html.slice(at + tag.length)
}
const firstCard = onFirst(/(<article class="card[^>]*>)/)
/** The first card's "Mark as collected": the first button that is not folded away in a closed <details>. */
const markButton = onFirst(/<article class="card[\s\S]*?action="\/parcel\/\d+\/collected"[^>]*>[\s\S]*?(<button\b[^>]*>)/)
/** Spec §3.3 and Postal's motion (src/web/themes/postal-motion.ts), with the board's keyframe names. */
const MOTIONS: Motion[] = [
  { name: 'slam', scene: 'parcel-collected', theme: 'postal', keyframes: ['slam', 'thud'] },
  { name: 'deal-in', scene: 'dash', theme: 'postal', keyframes: ['deal'] },
  { name: 'ink-settle', scene: 'dash-arrived', theme: 'postal', keyframes: ['inkin'] },
  { name: 'airmail-march', scene: 'dash', theme: 'postal', keyframes: ['march'] },
  { name: 'hover-lift', scene: 'dash', theme: 'postal', state: { pseudo: ':hover', rule: /\.card:hover$/, target: firstCard } },
  { name: 'button-press', scene: 'dash', theme: 'postal', state: { pseudo: ':active', rule: /button[^\s]*:active$/, target: markButton } },
  // The mechanism's own proof, on what every theme already has: the refresh spinner and a button's hover.
  { name: 'proof-spin', scene: 'refreshing', keyframes: ['spin'] },
  { name: 'proof-button-hover', scene: 'dash', state: { pseudo: ':hover', rule: /^button:hover$/, target: markButton } },
]
const PCTS = [0, 50, 100]

/** `@keyframes <name>{…}` blocks, with their nesting. */
function keyframeBlocks(css: string): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = []
  const re = /@keyframes\s+([\w-]+)\s*\{/g
  for (let m; (m = re.exec(css));) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    out.push({ name: m[1]!, start: m.index, end: i })
    re.lastIndex = i
  }
  return out
}
const dropKeyframes = (css: string, keep: Set<string>) =>
  keyframeBlocks(css).reverse().reduce((s, b) => (keep.has(b.name) ? s : s.slice(0, b.start) + s.slice(b.end)), css)

/** Splits a selector list at its top-level commas. */
function selectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/**
 * Whether a selector can match on a page in `theme`: every theme is in the one stylesheet, so a rule scoped
 * to another theme's `:root[data-theme]` never applies. Without a theme (a build from before themes),
 * only unscoped rules exist.
 */
const forTheme = (theme: string | undefined) => (sel: string): boolean => {
  const scope = /^:root\[data-theme="([\w-]+)"\]/.exec(sel.trim())
  return !scope || scope[1] === theme
}

/** The page's CSS for one frame, or undefined when the page's theme has nothing for this motion. */
function frameCss(css: string, theme: string | undefined, m: Motion, pct: number): string | undefined {
  let extra = ''
  let keep: Set<string>
  const applies = forTheme(theme)
  if (m.keyframes) {
    keep = new Set(m.keyframes)
    if (!keyframeBlocks(css).some(b => keep.has(b.name))) return undefined
    // ... and a rule of this theme runs one of them (innermost rules: an @media block is taken as applying)
    const runs = (decls: string) => [...decls.matchAll(/animation(?:-name)?\s*:([^;]*)/g)].some(d => d[1]!.split(/[\s,]+/).some(w => keep.has(w)))
    if (![...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(r => runs(r[2]!) && selectors(r[1]!).some(applies))) return undefined
  } else {
    const { pseudo, rule } = m.state!
    keep = new Set()
    // Innermost rules only: a :hover rule inside an @media block is taken as if the block applied.
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = selectors(r[1]!).filter(s => s.includes(pseudo) && rule.test(s) && applies(s))
      if (!sels.length) continue
      const name = `frz-s${keep.size}`
      keep.add(name)
      extra += `@keyframes ${name}{to{${r[2]!.replace(/\s*!important/g, '')}}}`
      extra += `${sels.map(s => s.split(pseudo).join('.frz-on')).join(',')}{animation-name:${name}!important}`
    }
    if (!keep.size) return undefined
  }
  const freeze = `*,*::before,*::after{transition:none!important;animation-duration:1000s!important;animation-delay:${-pct * 10}s!important;`
    + 'animation-iteration-count:1!important;animation-fill-mode:both!important;animation-play-state:paused!important}'
  return `${dropKeyframes(css, keep)}${extra}${freeze}`
}

// ------------------------------------------------------------------------------------------------ shots
const deadHttp: HttpClient = async url => {
  blocked.network.push(`HttpClient ${url}`)
  throw new Error('theme-showcase: HttpClient disabled')
}

async function chrome(profile: string, htmlFile: string, out: string, width: number, dark: boolean, reduced: boolean, wrapDir: string) {
  let url = `file://${htmlFile}`
  let winW = width
  if (width <= 400) {
    const wrap = join(wrapDir, `${out.split('/').pop()}.frame.html`)
    writeFileSync(wrap, `<!doctype html><body style="margin:0;background:#888"><iframe src="file://${htmlFile}" style="border:0;width:${width}px;height:${H}px;display:block"></iframe></body>`)
    url = `file://${wrap}`
    winW = 600
  }
  await exec(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--metrics-recording-only', '--no-pings', '--disable-breakpad', '--disable-crash-reporter', '--allow-file-access-from-files',
    '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1',
    ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
    ...(reduced ? ['--force-prefers-reduced-motion'] : []),
    `--window-size=${winW},${H}`, `--screenshot=${out}`, url,
  ], { timeout: 90_000 })
  if (!existsSync(out)) throw new Error(`Chrome wrote no screenshot for ${url}`)
  // The first magenta row of a column the marker spans is where the page ends.
  const col = String((await exec(MAGICK, [out, '-crop', `1x${H}+2+0`, '+repage', '-depth', '8', 'txt:-'], { maxBuffer: 16 << 20 })).stdout)
  let end: number | undefined
  for (const line of col.split('\n')) {
    const m = /^0,(\d+): \((\d+),(\d+),(\d+)/.exec(line)
    if (m && Number(m[2]) >= 250 && Number(m[3]) <= 5 && Number(m[4]) >= 250) { end = Number(m[1]); break }
  }
  if (end === undefined) throw new Error(`no end-of-page marker in ${out}: is the page taller than ${H}px?`)
  await exec(MAGICK, [out, '-crop', `${width}x${end}+0+0`, '+repage', out])
  const sd = Number(String((await exec(MAGICK, [out, '-format', '%[fx:standard_deviation]', 'info:'])).stdout))
  const size = String((await exec(MAGICK, [out, '-format', '%wx%h', 'info:'])).stdout)
  return { sd, size }
}

const sizeOf = async (f: string) => String((await exec(MAGICK, [f, '-format', '%wx%h', 'info:'])).stdout)

/** How many pixels differ between two shots (any channel, any amount), or Infinity when their sizes differ. */
async function diffPx(a: string, b: string): Promise<number> {
  if (await sizeOf(a) !== await sizeOf(b)) return Infinity
  return Number(String((await exec(MAGICK, [a, b, '-compose', 'difference', '-composite', '-colorspace', 'gray', '-threshold', '0',
    '-format', '%[fx:round(mean*w*h)]', 'info:'])).stdout))
}

/**
 * How far apart two shots are once anti-aliasing is averaged out: the largest grey difference (0-255) after
 * both are box-averaged 4 by 4, or Infinity when their sizes differ. An element that has run an animation
 * keeps a compositor layer, so its text and ink edges anti-alias a little differently from a page that never
 * animated (single pixels, mostly under 40/255); a wrong end state (a lost tilt, a missing postmark, a moved
 * card) differs over whole areas, far above REST_TOLERANCE.
 */
async function blurredDiff(a: string, b: string): Promise<number> {
  if (await sizeOf(a) !== await sizeOf(b)) return Infinity
  return Number(String((await exec(MAGICK, [a, b, '-compose', 'difference', '-composite', '-colorspace', 'gray',
    '-filter', 'box', '-resize', '25%', '-format', '%[fx:round(maxima*255)]', 'info:'])).stdout))
}
const REST_TOLERANCE = 16

async function pool<T>(items: T[], n: number, fn: (item: T, worker: number) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async (_, w) => {
    while (next < items.length) await fn(items[next++]!, w)
  }))
}

// ------------------------------------------------------------------------------------------------ run
test('theme showcase', async () => {
  const THEME = process.env.THEME || undefined
  if (THEME && !THEMES.includes(THEME)) throw new Error(`THEME must be one of ${THEMES.join(', ')}`)
  if (!process.env.OUT) throw new Error('OUT=<dir> is required')
  const OUT = resolve(process.env.OUT)
  const FRAMES = process.env.FRAMES === '1'
  // A theme's own motion skipped on its own pages fails the run; STRICT=0 (an older commit) only records it.
  const STRICT = process.env.STRICT !== '0'
  const only = process.env.SCENES?.split(',').filter(Boolean)
  // A fixed folder, not mktemp: no temp path differs between two runs (the settings page shows the
  // database's path). One showcase at a time.
  const WORK = join(tmpdir(), 'parcels-theme-showcase')
  rmSync(WORK, { recursive: true, force: true })
  for (const d of ['html', 'wrap', 'tiles', 'data']) mkdirSync(join(WORK, d), { recursive: true })
  mkdirSync(OUT, { recursive: true })

  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const restoreGuards = installGuards()
  const worlds = new Map<World, Seeded & { server: ReturnType<typeof buildServer> }>()
  try {
    // ---- config: config.example.json with fake mail, never config.json ----
    const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'))
    const cfgDoc: Record<string, unknown> = {
      ...example, dbPath: join(WORK, 'data', 'parcels.db'), port: 47100, pickupCalendar: '',
      imap: { host: 'imap.example.invalid', port: 993, user: 'parcels@example.invalid', pass: 'not-a-real-password', mailbox: 'parcels' },
      ...(THEME && { appearance: { theme: THEME, mode: 'system' } }),
    }
    const configPath = join(WORK, 'config.json')
    writeFileSync(configPath, JSON.stringify(cfgDoc, null, 2))
    const config = { ...cfgDoc } as never as Parameters<typeof buildServer>[0]['config']
    const calendar = { listWritable: async () => ['Domov', 'Práca'], add: async () => ({ uid: 'showcase-uid', calendar: 'Domov' }) }

    for (const w of ['board', 'empty', 'refreshing'] as const) {
      const s = seed(w, w === 'board' ? cfgDoc.dbPath as string : join(WORK, 'data', `${w}.db`))
      const server = buildServer({
        db: s.db, config, configPath, now: () => NOW, notifier: { send: async () => {} }, calendar, http: deadHttp,
        imapClient: () => { throw new Error('theme-showcase: no IMAP') }, version: 'showcase', tileDir: join(WORK, 'tiles'),
        support: { dataDir: join(WORK, 'data'), env: { node: 'v24', platform: 'darwin', arch: 'arm64', hostname: 'showcase-mac' } as never, launchd: { agents: [] } as never },
        update: { root: WORK, dataDir: join(WORK, 'data'), run: async () => ({ code: 1, stdout: '', stderr: 'disabled' }) as never, spawn: (() => { throw new Error('spawn disabled') }) as never },
      })
      worlds.set(w, { ...s, server })
    }

    // ---- pages: each scene's HTML, with what it loads from the server inlined ----
    const pages = new Map<string, string>()
    const manifest: string[] = [`theme: ${THEME ?? '(unset)'}  now: ${NOW.toISOString()}`]
    const wanted = SCENES.filter(s => (!only || only.includes(s.name)) && (!s.framesOnly || FRAMES))
    for (const sc of wanted) {
      const { server, ids } = worlds.get(sc.world)!
      const url = sc.url(ids)
      const res = await server.inject({ method: 'GET', url, headers: { host: '127.0.0.1' } })
      expect(res.statusCode, `${sc.name} ${url}`).toBe(200)
      let html = res.body
      for (const src of new Set([...html.matchAll(/src="(\/[^"]+)"/g)].map(m => m[1]!))) {
        const r = await server.inject({ method: 'GET', url: src.replace(/&amp;/g, '&'), headers: { host: '127.0.0.1' } })
        if (r.statusCode === 200) html = html.split(`src="${src}"`).join(`src="data:${r.headers['content-type']};base64,${r.rawPayload.toString('base64')}"`)
      }
      for (const font of new Set([...html.matchAll(/url\((\/fonts\/[\w.-]+)\)/g)].map(m => m[1]!))) {
        const r = await server.inject({ method: 'GET', url: font, headers: { host: '127.0.0.1' } })
        if (r.statusCode === 200) html = html.split(`url(${font})`).join(`url(data:font/woff2;base64,${r.rawPayload.toString('base64')})`)
      }
      // A copy must not reload itself (a running run's page asks to).
      html = html.replace(/<meta http-equiv="refresh"[^>]*>/, '')
      for (const want of sc.has) expect(html, `${sc.name}: ${want}`).toMatch(typeof want === 'string' ? new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : want)
      const themed = /<html [^>]*data-theme=/.test(html)
      if (themed) for (const want of sc.hooks) expect(html, `${sc.name} hook: ${want}`).toMatch(typeof want === 'string' ? new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : want)
      pages.set(sc.name, html)
      manifest.push(`${sc.name.padEnd(22)} ${url.padEnd(26)} ${res.statusCode}  hooks: ${themed ? (sc.hooks.length ? 'all present' : 'none expected') : 'not checked (a build without themes)'}`)
    }

    // ---- static shots ----
    const jobs = wanted.filter(s => !s.framesOnly).flatMap(sc => [1280, 390].flatMap(width => [false, true].map(dark => ({ sc, width, dark }))))
    const lines: string[] = []
    for (const [name, html] of pages) writeFileSync(join(WORK, 'html', `${name}.html`), html.replace('</head>', `${MARKER}</head>`))
    await pool(jobs, 4, async ({ sc, width, dark }, w) => {
      const htmlFile = join(WORK, 'html', `${sc.name}.html`)
      const file = `${sc.name}-${width}${dark ? '-dark' : ''}.png`
      const { sd, size } = await chrome(join(WORK, `chrome-${w}`), htmlFile, join(OUT, file), width, dark, true, join(WORK, 'wrap'))
      lines.push(`${file.padEnd(36)} ${size.padEnd(10)} sd=${sd.toFixed(4)}`)
      expect(sd, `${file} is blank`).toBeGreaterThan(0.01)
    })
    manifest.push('', ...lines.sort())

    // ---- motion frames ----
    if (FRAMES) {
      const dir = join(OUT, 'motion')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const report: string[] = []
      /** The page theme's own motions that were skipped. */
      const missing: string[] = []
      const offRest: string[] = []
      const frameJobs: Array<{ m: Motion; pct: number; htmlFile: string }> = []
      for (const m of MOTIONS) {
        const base = pages.get(m.scene)
        if (!base) { report.push(`${m.name}: skipped (scene ${m.scene} not rendered)`); continue }
        const page = m.state ? m.state.target(base) : base
        const css = /<style>([\s\S]*?)<\/style>/.exec(page)![1]!
        const theme = /<html [^>]*data-theme="([\w-]+)"/.exec(page)?.[1]
        const per = PCTS.map(pct => frameCss(css, theme, m, pct))
        if (per.some(c => c === undefined)) {
          const what = m.keyframes ? `rule running @keyframes ${m.keyframes.join('/')}` : `${m.state!.pseudo} rule matching ${m.state!.rule}`
          report.push(`${m.name}: skipped (theme ${theme ?? '(none)'} has no ${what})`)
          if (STRICT && m.theme && m.theme === theme) missing.push(m.name)
          continue
        }
        PCTS.forEach((pct, i) => {
          const htmlFile = join(WORK, 'html', `motion-${m.name}-${pct}.html`)
          writeFileSync(htmlFile, page.replace(css, () => per[i]!).replace('</head>', `${MARKER}</head>`))
          frameJobs.push({ m, pct, htmlFile })
        })
      }
      await pool(frameJobs, 4, async ({ m, pct, htmlFile }, w) => {
        const { sd } = await chrome(join(WORK, `chrome-${w}`), htmlFile, join(dir, `${m.name}-${pct}.png`), 1280, false, false, join(WORK, 'wrap'))
        expect(sd, `${m.name}-${pct} is blank`).toBeGreaterThan(0.01)
      })
      for (const m of MOTIONS.filter(x => frameJobs.some(j => j.m === x))) {
        const f = (p: number) => join(dir, `${m.name}-${p}.png`)
        const [a, b, c] = [await diffPx(f(0), f(50)), await diffPx(f(50), f(100)), await diffPx(f(0), f(100))]
        // A keyframe motion's 100 % against the scene's static shot (reduced motion): a motion ends on the
        // static page. (A hover or a press rests as the page without them, which is the static page as is.)
        const still = join(OUT, `${m.scene}-1280.png`)
        let rest = 'n/a'
        if (m.keyframes && existsSync(still)) {
          const [px, avg] = [await diffPx(f(100), still), await blurredDiff(f(100), still)]
          rest = `${px} px, ${avg}/255 averaged 4x4`
          if (avg > REST_TOLERANCE) offRest.push(`${m.name} (${rest})`)
        }
        report.push(`${m.name}: pixels differing 0→50 ${a}, 50→100 ${b}, 0→100 ${c}; 100 % vs the static shot: ${rest}`)
        // A frozen motion moves: its middle frame differs from at least one end.
        expect(a > 0 || b > 0, `${m.name}: the three frames are the same`).toBe(true)
      }
      writeFileSync(join(dir, 'frames.txt'), `${report.join('\n')}\n`)
      expect(missing, 'motions of this theme that were skipped').toEqual([])
      expect(offRest, `motions whose 100 % frame is off the static page (over ${REST_TOLERANCE}/255 averaged 4x4)`).toEqual([])
      manifest.push('', 'motion frames (1280, light, motion allowed):', ...report)
    }

    writeFileSync(join(OUT, 'scenes.txt'), `${manifest.join('\n')}\n`)
    console.log(manifest.join('\n'))
    expect(blocked.network, 'network attempts').toEqual([])
    expect(blocked.processes, 'process starts').toEqual([])
  } finally {
    for (const { server, db } of worlds.values()) { await server.close(); db.close() }
    restoreGuards()
    vi.useRealTimers()
    if (process.env.KEEP !== '1') rmSync(WORK, { recursive: true, force: true })
    else console.log(`kept ${WORK}`)
  }
}, 900_000)
