import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { checkAppBundle, isVersion, stagingDir, type BundleRefusal, type RunResult } from '../src/core/app-update.js'

/**
 * Putting a staged update in place of the running app (spec §5.2, §10.3).
 *
 * The app cannot replace its own bundle while it runs, so it writes a small `sh` script, starts it
 * detached and quits. The script waits for the app's process to end, renames the old bundle aside,
 * moves the staged one into its place and opens it. If the move fails it puts the old bundle back,
 * opens that, and leaves a marker; the reopened app reads the marker and shows the staged copy in
 * Finder, so the user can finish by dragging it in. The spike proved this sequence on this Mac,
 * under macOS's App Management protection, with no prompt.
 */

/** How long the script waits for the old app to exit before it gives up and swaps nothing. */
export const SWAP_WAIT_SECONDS = 60

/**
 * A value for `sh`, single-quoted. Inside single quotes nothing is special except the closing quote,
 * so an embedded one is written as quote, backslash-quote, quote: close, a literal quote, reopen. A
 * path then stays a value whatever it contains (`$(...)`, a backtick, a space, a newline).
 */
export const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

export interface SwapParams {
  /** The PID of the app's main process, which the script waits for. */
  pid: number
  /** The installed bundle, which the staged one replaces. */
  app: string
  /** The staged bundle, `<stagingDir>/Parcels.app`. */
  staged: string
  version: string
  /** Where a failed swap leaves the version and the staged path for the reopened app. */
  marker: string
  /** The bound on the wait; tests shorten it. */
  waitSeconds?: number
}

/** A path the script may be given: absolute (it removes and renames things), and without a NUL. */
const usablePath = (p: string): boolean => p !== '' && isAbsolute(p) && !p.includes('\0')

/**
 * The swap as a POSIX `sh` script. Every path is assigned once, single-quoted, and used only as
 * `"$var"` afterwards, so no value is ever read as code. Throws on a PID, version or path it could not
 * write safely: a caller that gets that far has a bug, and a script that renames the wrong folder
 * is far worse than none.
 *
 * Waiting: `kill -0` alone is true for any process that has the PID, and after Parcels quits the
 * number can be given to another program, which could keep the script waiting for nothing. So the
 * process must also still be running an executable inside the app (`ps -o comm=` reports the path
 * it was started from, which for an app LaunchServices opens is the bundle's real path). When `ps`
 * says nothing, the process ended between the two questions and the next round sees that. The wait is
 * also bounded: past `waitSeconds` the script gives up, swaps nothing and opens the old app, which
 * still has the update ready on its Health page.
 *
 * `open` runs with ELECTRON_RUN_AS_NODE removed (spec §10): `open` passes its environment on, and
 * with that variable set the app's binary runs as plain Node and exits at once. It is looked up on
 * PATH, which the main process sets to the system folders, and which a test points at a stub.
 *
 * A marker is written before the app is opened, so the app finds it when it starts. It holds the
 * version on its first line and the staged path after it, because a path may contain anything but NUL.
 */
export function swapScript(p: SwapParams): string {
  const wait = p.waitSeconds ?? SWAP_WAIT_SECONDS
  if (!Number.isInteger(p.pid) || p.pid <= 0) throw new RangeError(`not a PID: ${p.pid}`)
  if (!isVersion(p.version)) throw new RangeError(`not a version: ${JSON.stringify(p.version)}`)
  for (const [name, v] of [['app', p.app], ['staged', p.staged], ['marker', p.marker]] as const) {
    if (!usablePath(v)) throw new RangeError(`not an absolute path for ${name}: ${JSON.stringify(v)}`)
  }
  if (!Number.isInteger(wait) || wait <= 0) throw new RangeError(`not a wait: ${wait}`)
  return `#!/bin/sh
# Written by Parcels just before it quit to install ${p.version}. It replaces the app with the staged
# update once the app has exited, then opens it. Safe to delete.

pid=${p.pid}
app=${shQuote(p.app)}
staged=${shQuote(p.staged)}
staging=${shQuote(dirname(p.staged))}
version=${shQuote(p.version)}
marker=${shQuote(p.marker)}
old="$app.old-$version"
tries=${wait * 5}

# True while the app that wrote this script is still running: the PID is alive and still runs an
# executable inside the app, so a PID handed to another program after Parcels quit does not count.
still_running() {
  kill -0 "$pid" 2>/dev/null || return 1
  comm=$(ps -p "$pid" -o comm= 2>/dev/null)
  case "$comm" in
    '') return 0 ;;
    "$app"/*) return 0 ;;
    *) return 1 ;;
  esac
}

relaunch() {
  env -u ELECTRON_RUN_AS_NODE open "$1"
}

failed() {
  printf '%s\\n%s' "$version" "$staged" > "$marker"
}

while still_running; do
  tries=$((tries - 1))
  if [ "$tries" -le 0 ]; then
    # Parcels did not quit. Nothing is swapped; the update stays ready for another try.
    relaunch "$app"
    exit 1
  fi
  sleep 0.2
done

# Only this script makes the .old name; one left by an earlier attempt would swallow the app, since
# mv into an existing folder moves inside it.
rm -rf "$old"
if ! mv "$app" "$old"; then
  failed
  relaunch "$app"
  exit 1
fi
if mv "$staged" "$app"; then
  rm -rf "$old"
  rmdir "$staging" 2>/dev/null
  relaunch "$app"
  exit 0
fi
if mv "$old" "$app"; then
  failed
  relaunch "$app"
else
  failed
  relaunch "$old"
fi
exit 1
`
}

export interface VerifyStagedDeps {
  /** The running app's bundle. */
  appBundle: string
  /** The path the server process asked to install. */
  staged: string
  version: string
  /** The bundled `signing-cert.sha256`. */
  expectedCertSha: string
  /** Runs a program without a shell (`runCommand`); tests pass a fake. */
  run: (cmd: string, args: string[]) => Promise<RunResult>
  /** Where the certificates are extracted to for a moment: `<support>/updates`. */
  workDir: string
}

/**
 * Checks the staged app once more, just before the swap, and says why it will not be installed, or
 * undefined when it may be.
 *
 * The server checked it when it staged it, but it has since sat in a folder the user (and anything
 * running as the user) can write to, and the path arrives in a message from another process. So:
 * the path must be exactly the staging folder Parcels makes beside this bundle for this version; it
 * must still be a real folder, not a link; and it must pass the same signature, certificate and
 * identity checks as at staging (`checkAppBundle`).
 */
export async function verifyStaged(d: VerifyStagedDeps): Promise<BundleRefusal | undefined> {
  const NOT_OURS = 'The update was not where Parcels put it, so it was not installed.'
  if (!isVersion(d.version) || d.appBundle === '' || !isAbsolute(d.appBundle)) return { reason: NOT_OURS }
  const expected = join(stagingDir(d.appBundle, d.version), 'Parcels.app')
  if (d.staged !== expected) return { reason: NOT_OURS, detail: `${d.staged} != ${expected}` }
  let isDir = false
  try {
    const st = lstatSync(d.staged)
    isDir = st.isDirectory() && !st.isSymbolicLink()
  } catch { /* gone */ }
  if (!isDir) return { reason: 'The downloaded update is no longer there, so it was not installed.' }
  return checkAppBundle(d.staged, d.version, d.expectedCertSha, d.run, d.workDir)
}

/**
 * Reads the marker a failed swap left, and removes it whatever it holds, so one failure is reported
 * once. Undefined when there is none, or it does not hold a version and an absolute path.
 */
export function readSwapFailedMarker(path: string): { version: string; staged: string } | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  try {
    const nl = text.indexOf('\n')
    if (nl < 0) return undefined
    const version = text.slice(0, nl)
    const staged = text.slice(nl + 1)
    return isVersion(version) && usablePath(staged) ? { version, staged } : undefined
  } finally {
    rmSync(path, { force: true })
  }
}
