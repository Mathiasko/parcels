import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { host } from './host.js'

/**
 * What is running, for the Health page: `0.1.0 (0db9a83)`, or `0.1.0` from an unpacked tarball, or
 * `unknown` when even `package.json` cannot be read.
 *
 * Never throws. A version string is decoration on a diagnostics page; it must not be the reason the
 * page that tells you what is broken is itself broken.
 *
 * The commit is read only when `root/.git` exists. Without that guard `git rev-parse` would walk up
 * and answer with the commit of whatever repository happens to contain the directory - so a tarball
 * unpacked inside another checkout would claim a commit whose code it does not contain.
 */
export function resolveVersion(root: string): string {
  let version: string | undefined
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const v = (pkg as { version?: unknown }).version
    if (typeof v === 'string' && v !== '') version = v
  } catch { /* missing, unreadable or malformed: "unknown" is the honest answer */ }
  if (version === undefined) return 'unknown'

  // `.git` is a directory in a normal clone and a file in a worktree; both count.
  if (!existsSync(join(root, '.git'))) return version
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5_000 })
    const commit = r.status === 0 ? r.stdout.trim() : ''
    return /^[0-9a-f]{4,40}$/.test(commit) ? `${version} (${commit})` : version
  } catch {
    return version   // no git on PATH, or it could not be spawned
  }
}

/** `<repo root>`; this file sits two levels below it in both `src/` and `dist/`. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The checkout this process is running from. Exported so the update machinery (core/update.ts) and
 * the version string cannot disagree about which directory they are talking about - one answer, one
 * place, whether the code is running out of `src/` under vitest or out of `dist/` under launchd.
 */
export const repoRoot = (): string => REPO_ROOT

let cached: string | undefined

/**
 * The version of this program. In the git install that is the checkout, resolved once per process and
 * remembered: the web server asks for it while it is being built, so no request ever spawns `git`.
 *
 * In the app it is the version the app was built as, which the main process passes as
 * `PARCELS_APP_VERSION`; the bundle has no `.git` to ask. That is a plain environment read, so it is
 * not cached and a test can change it. An app that was started without the variable falls back to
 * the checkout answer rather than reporting nothing.
 */
export const appVersion = (): string => {
  if (host() === 'app' && process.env.PARCELS_APP_VERSION) return process.env.PARCELS_APP_VERSION
  return (cached ??= resolveVersion(REPO_ROOT))
}
