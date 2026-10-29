/**
 * Where the app is running from, and the offer to move it (spec §2.1). The update swap renames the
 * bundle and puts the new one in its place, so it needs a folder that stays put and can be written:
 * a disk image is read-only and goes away when ejected, an App Translocation copy is a read-only
 * mount macOS makes for a quarantined app opened where it was downloaded, and ~/Downloads is where
 * people tidy things away from.
 */

/** The question, and why it is asked. Shown as the dialog's message and its detail. */
export const MOVE_QUESTION = 'Move Parcels to your Applications folder?'
export const MOVE_DETAIL = 'It needs to live there to update itself.'

/**
 * True when `bundlePath` is somewhere an app cannot update itself: on a mounted volume (a disk image
 * or a USB stick), in an App Translocation copy, or in the user's Downloads folder. An empty path (a
 * binary outside any bundle) is never unstable: there is nothing to move.
 */
export function isUnstableLocation(bundlePath: string, home: string): boolean {
  if (bundlePath === '') return false
  const downloads = `${home.replace(/\/+$/, '')}/Downloads/`
  return bundlePath.startsWith('/Volumes/') || bundlePath.includes('/AppTranslocation/') || bundlePath.startsWith(downloads)
}

export interface MoveOfferDeps {
  /** `app.isPackaged`. A dev run is node_modules' Electron.app, which must never be offered a move. */
  packaged: boolean
  /** The running app's bundle (`bundlePath(process.execPath)`). */
  bundle: string
  home: string
  /** Asks the question; true for yes. */
  ask: () => Promise<boolean>
  /**
   * `app.moveToApplicationsFolder()`: true when it moved the app, which then quits and relaunches
   * from Applications. It shows its own dialog when an app of that name is already there.
   */
  move: () => boolean
  log: (line: string) => void
}

export type MoveOffer = 'not-packaged' | 'stable' | 'declined' | 'moved' | 'not-moved' | 'failed'

/**
 * Offers to move the app into Applications when it runs from an unstable place, and says what came of
 * it. Called once per launch, so a "no" is not asked again until the next launch, where the app is
 * still in the wrong place and the question is still worth asking.
 *
 * Never throws: whatever goes wrong with the dialog or the move, the app is better off running where
 * it is than not running at all, so a failure is logged and reported as `failed`.
 */
export async function offerMoveToApplications(d: MoveOfferDeps): Promise<MoveOffer> {
  if (!d.packaged) return 'not-packaged'
  if (!isUnstableLocation(d.bundle, d.home)) return 'stable'
  try {
    if (!(await d.ask())) {
      d.log(`location: left in ${d.bundle} at the user's word`)
      return 'declined'
    }
    if (d.move()) {
      d.log(`location: moved from ${d.bundle} to Applications; relaunching`)
      return 'moved'
    }
    d.log(`location: the move from ${d.bundle} did not happen`)
    return 'not-moved'
  } catch (err) {
    d.log(`location: could not move from ${d.bundle}: ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
}
