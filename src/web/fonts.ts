import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../core/version.js'
import { THEMES } from './themes/index.js'

/**
 * The only font files that are ever served: exactly the ones a theme's stylesheet names. A request is
 * checked against this set before the disk is touched, and the path is built from the matching name
 * and nothing the client typed - so the licences, the READMEs, subfolders and every other file beside
 * the fonts are unreachable however the URL is spelled.
 */
export const FONT_FILES: ReadonlySet<string> = new Set(THEMES.flatMap(t => t.fonts.map(f => f.file)))

/** Where the fonts live: the checkout's `assets/fonts`, or the same path inside `app.asar` in the packaged app. */
export const fontDir = (): string => join(repoRoot(), 'assets', 'fonts')

/** A given file name is the same bytes forever (the name carries the family, subset, weight and style). */
export const FONT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'font/woff2',
  'cache-control': 'public, max-age=31536000, immutable',
})

/** The font's bytes, or nothing: for a name off the allowlist, and for a listed font that cannot be read. */
export function readFont(dir: string, file: string): Buffer | undefined {
  if (!FONT_FILES.has(file)) return undefined
  try {
    return readFileSync(join(dir, file))
  } catch {
    return undefined
  }
}
