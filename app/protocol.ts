import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Protocol } from 'electron'
import { DEFAULT_APPEARANCE, type Appearance } from '../src/core/appearance.js'
import { FONT_HEADERS, readFont } from '../src/web/fonts.js'
import { STYLE } from '../src/web/views/style.js'
import { fillPage, normalisePostcode, writeWelcomeConfig, type FirstRun } from './first-run.js'
import type { MoveInResult } from './move-in.js'

/**
 * The `parcels://` pages of a first run: Welcome and Move in (spec §4). They are static HTML from
 * app/pages, filled in here, and their forms post back to `parcels://`, where this handler acts. This
 * module never imports Electron at run time (only its types), so the handler is tested as a plain
 * function of a `Request`.
 */

export const SCHEME = 'parcels'

/**
 * The pages' CSP: no scripts, no fetches, no frames, inline style only, and forms post only to
 * `parcels:`. Two things are let in, for the themes: fonts from `parcels:` (the allowlisted
 * /fonts/<file> route below) and `data:` images (the paper grain, an inline SVG in the stylesheet).
 */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src parcels:; img-src data:; form-action parcels:"

/** Where the theme fonts are served, on whichever first-run host is active. */
const FONT_PATH = '/fonts/'

export const NOT_A_POSTCODE = 'That is not a postcode. Five digits, like 81101.'

/** What each step of a move is called on the result page. */
const STEP_WORDS: Record<Exclude<MoveInResult, { ok: true }>['step'], string> = {
  stop: 'Stopping the old install',
  copy: 'Copying your parcels and settings',
  check: 'Checking the copy',
  park: 'Setting the old install aside',
}

/**
 * The result page's lines about the old install, around its folder: whether it runs as before, or
 * did not start again and how to start it.
 */
export const OLD_INSTALL = {
  running: {
    ledeStart: 'Nothing was moved, and ',
    ledeEnd: ' is as it was.',
    next: 'You can try again, or quit and go on using the old install.',
  },
  'not-running': {
    ledeStart: 'Nothing was moved, but the old install in ',
    ledeEnd: ' is not running now.',
    next: 'To start it again, open Terminal in that folder and run scripts/install-agents.sh. Or try moving in again.',
  },
} as const

export interface Pages { welcome: string; moveIn: string; result: string }

/** The three page templates, read once at startup: a missing one is found then, not when a button is pressed. */
export function readPages(dir: string): Pages {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8')
  return { welcome: read('welcome.html'), moveIn: read('move-in.html'), result: read('result.html') }
}

export interface FirstRunDeps {
  firstRun: Exclude<FirstRun, { kind: 'ready' }>
  configPath: string
  pages: Pages
  /** The theme fonts (`assets/fonts`); only the allowlisted names in it are ever served. */
  fontDir: string
  /** The theme and mode the pages wear; absent is the defaults, since a first run has no config yet. */
  appearance?: Appearance
  /** Starts the server, then shows `path` on the dashboard once it answers. Called once. */
  start: (path: string) => void
  /** The move itself, with launchctl and the folders already bound. */
  moveIn: () => Promise<MoveInResult>
  quit: () => void
  log: (line: string) => void
}

const page = (body: string, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, 'cache-control': 'no-store' },
})

const plain = (status: number, text: string) => new Response(text, {
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': PAGE_CSP },
})

/**
 * "Done, nothing to show": the window stays on the page it has until the main process loads the
 * dashboard, which it does as soon as the server answers.
 */
const noContent = () => new Response(null, { status: 204, headers: { 'content-security-policy': PAGE_CSP } })

export function firstRunHandler(d: FirstRunDeps): (req: Request) => Promise<Response> {
  const { theme, mode } = d.appearance ?? DEFAULT_APPEARANCE
  const welcomePage = (error: string, postcode: string) => page(fillPage(d.pages.welcome, { error, postcode, theme, mode }, STYLE))
  const clone = d.firstRun.kind === 'move-in' ? d.firstRun.clone : ''

  /** Set once the app is set up: from then on the buttons have nothing left to do. */
  let done = false
  /** A move under way. A second press waits for the same move instead of starting another. */
  let moving: Promise<MoveInResult> | undefined

  const welcome = async (form: URLSearchParams): Promise<Response> => {
    if (done) return noContent()
    const typed = form.get('postcode') ?? ''
    const postcode = normalisePostcode(typed)
    if (postcode === undefined) return welcomePage(NOT_A_POSTCODE, typed)
    try {
      writeWelcomeConfig(d.configPath, postcode)
    } catch (err) {
      d.log(`welcome: could not write the config: ${err instanceof Error ? err.message : String(err)}`)
      return welcomePage(`Parcels could not save your postcode: ${err instanceof Error ? err.message : String(err)}. Try again.`, typed)
    }
    d.log(`welcome: wrote ${d.configPath}`)
    done = true
    d.start('/settings')
    return noContent()
  }

  const move = async (form: URLSearchParams): Promise<Response> => {
    const action = form.get('action')
    if (action === 'quit') {
      d.quit()
      return noContent()
    }
    if (action !== 'move') return plain(400, 'Unknown action.')
    if (done) return noContent()
    moving ??= d.moveIn().finally(() => { moving = undefined })
    const result = await moving
    if (result.ok) {
      if (!done) {
        done = true
        d.log(`move in: done from ${clone}`)
        d.start('/')
      }
      return noContent()
    }
    d.log(`move in: failed at ${result.step}: ${result.reason}`)
    return page(fillPage(d.pages.result, { clone, step: STEP_WORDS[result.step], reason: result.reason, theme, mode, ...OLD_INSTALL[result.oldInstall] }, STYLE))
  }

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url)
      const which = url.host === 'welcome' && d.firstRun.kind === 'welcome' ? 'welcome'
        : url.host === 'move-in' && d.firstRun.kind === 'move-in' ? 'move-in'
          : undefined
      if (which === undefined) return plain(404, 'There is no such page.')
      if (url.pathname.startsWith(FONT_PATH)) {
        if (req.method !== 'GET') return plain(405, 'Not allowed.')
        // The raw (still percent-encoded) name, checked against the allowlist before any disk access.
        const bytes = readFont(d.fontDir, url.pathname.slice(FONT_PATH.length))
        if (!bytes) return plain(404, 'There is no such font.')
        return new Response(new Uint8Array(bytes), { status: 200, headers: { ...FONT_HEADERS, 'content-security-policy': PAGE_CSP } })
      }
      if (url.pathname !== '/') return plain(404, 'There is no such page.')
      if (req.method === 'GET') {
        return which === 'welcome' ? welcomePage('', '') : page(fillPage(d.pages.moveIn, { clone, theme, mode }, STYLE))
      }
      if (req.method !== 'POST') return plain(405, 'Not allowed.')
      // Only the first-run pages themselves may post here. Electron may leave the header out of a
      // custom-scheme request; when it is there, it must be ours.
      const origin = req.headers.get('origin')
      if (origin !== null && !origin.startsWith(`${SCHEME}://`)) {
        d.log(`first run: refused a post from ${origin}`)
        return plain(403, 'Not allowed.')
      }
      const form = new URLSearchParams(await req.text())
      return which === 'welcome' ? await welcome(form) : await move(form)
    } catch (err) {
      d.log(`first run: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      return plain(500, 'Something went wrong. Quit Parcels and open it again.')
    }
  }
}

/** Serves the first-run pages on `parcels://` in the window's (default) session. */
export function registerFirstRun(protocol: Pick<Protocol, 'handle'>, d: FirstRunDeps): void {
  protocol.handle(SCHEME, firstRunHandler(d))
}
