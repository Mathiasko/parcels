import { isSafeDownloadUrl } from '../src/core/app-update.js'

/**
 * Whether this app may follow a release feed other than GitHub's (ruling R16).
 *
 * `PARCELS_RELEASES_URL` lets a test build update from a feed served on this Mac, which is how the
 * whole update (check, download, checks, swap, relaunch) is tested end to end without publishing
 * anything. A release build must never follow it: whoever could set an environment variable for the
 * app would otherwise choose the code it installs. So it is honoured only in two cases:
 *
 * - an unpackaged dev run (`npm run app`), which is never on a friend's Mac;
 * - a bundle whose package.json carries `"parcelsDevReleases": true`. Only a test build sets it, with
 *   `electron-builder -c.extraMetadata.parcelsDevReleases=true`; scripts/app/build-release.sh and
 *   scripts/app/check-release-zip.mjs refuse any bundle that carries it, so no release can.
 *
 * The main process decides once, and passes the variable to the server only then; otherwise it
 * removes it from the server's environment, so the server never reads an inherited one.
 */
export const DEV_RELEASES_FLAG = 'parcelsDevReleases'

/** True when a package.json's text sets the flag to exactly `true`. Anything unreadable is false. */
export function hasDevReleasesFlag(packageJson: string | undefined): boolean {
  if (packageJson === undefined) return false
  try {
    const pkg: unknown = JSON.parse(packageJson)
    return typeof pkg === 'object' && pkg !== null && (pkg as Record<string, unknown>)[DEV_RELEASES_FLAG] === true
  } catch {
    return false
  }
}

export interface DevReleasesInput {
  /** `app.isPackaged`. */
  packaged: boolean
  /** Whether the bundle's package.json carries the flag (`hasDevReleasesFlag`). */
  flagged: boolean
  /** The inherited `PARCELS_RELEASES_URL`, if any. */
  url: string | undefined
}

/**
 * The feed URL to hand the server, or undefined to use GitHub's. A URL that is not https, or http on
 * this Mac, is never used, whoever allowed it.
 */
export function devReleasesUrl(i: DevReleasesInput): string | undefined {
  if (i.url === undefined || i.url === '') return undefined
  if (i.packaged && !i.flagged) return undefined
  return isSafeDownloadUrl(i.url) ? i.url : undefined
}
