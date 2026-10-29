import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { CHANGE_MAX, CHANGES_SHOWN, REASON_MAX, type UpdateCheck } from './update.js'
import { readZipEntries, unsafeUnpackedTree, unsafeZipEntry, ZipFormatError, type ZipEntry } from './zip-check.js'

/**
 * Updating the Mac app from GitHub Releases (spec §5.2).
 *
 * Two halves. `checkAppRelease` asks GitHub for the newest published release and answers in the same
 * `UpdateCheck` shape the git updater does, so the Health page, the notification rules and the daily
 * rate limit need not know which engine is behind them. `stageUpdate` downloads that release and
 * proves it is ours before anything can run it: the zip must match its published checksum, unpack to a
 * real `Parcels.app`, pass `codesign --verify --deep --strict`, and be signed by the very certificate
 * this app was signed with. The checksum only proves the download arrived intact (it comes from the
 * same release as the zip); the certificate is what proves who made it. Nothing here swaps the app:
 * that is the main process's job, after the user asks for it.
 *
 * Neither half ever throws at its caller. A check is called from inside a poll, and a failed staging
 * is something the user reads on the Health page, so every failure is a value with a plain sentence.
 */

export const RELEASES_URL = 'https://api.github.com/repos/Mathiasko/parcels/releases/latest'

/** Where a release's files are downloaded from when no override is given. */
export const releaseDownloadBase = (version: string): string =>
  `https://github.com/Mathiasko/parcels/releases/download/v${version}`

/**
 * Absolute paths, not bare names: `execFile` would otherwise look the tool up on `PATH`, and a
 * `codesign` earlier on the path that always says yes would defeat the whole check.
 */
export const DITTO = '/usr/bin/ditto'
export const CODESIGN = '/usr/bin/codesign'
export const PLUTIL = '/usr/bin/plutil'

/**
 * The bundle identifier electron-builder gives the app (its `appId`). Pinned because the certificate
 * alone does not say which app it signed: the spike app, and every older Parcels, carry the same one.
 */
export const APP_BUNDLE_ID = 'local.parcels.app'

/** How long one `ditto` or `codesign` may take. Unpacking 280 MB is seconds; this is generous. */
export const RUN_TIMEOUT_MS = 5 * 60_000
/** How long the release check may take before it counts as unreachable. */
export const CHECK_TIMEOUT_MS = 30_000
/** How long one download may take. The zip is about 130 MB, so a slow line needs minutes. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** `SHA256SUMS` is a handful of lines; anything bigger is not one, and is not read into memory. */
const SUMS_MAX_BYTES = 64 * 1024

// --- versions -----------------------------------------------------------------------------------------

/**
 * `x.y.z` with an optional `-suffix` (local test builds such as `0.2.0-a`), and an optional leading
 * `v` (the tag). Deliberately narrow: the version ends up in file names and paths, so anything with a
 * slash, a dot-dot or a space must never get through.
 */
const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,39}))?$/

interface Parsed { nums: [number, number, number]; suffix?: string }

const parseVersion = (v: string): Parsed | undefined => {
  const m = VERSION.exec(v)
  if (!m) return undefined
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], ...(m[4] !== undefined && { suffix: m[4] }) }
}

/** True for a version this module accepts, without its leading `v`. */
export const isVersion = (v: string): boolean => !v.startsWith('v') && parseVersion(v) !== undefined

/**
 * Orders two versions. Numbers compare as numbers ("0.10.0" is after "0.9.1"), a leading `v` is
 * ignored, and a `-suffix` build sorts before the same plain version, with suffixes compared as text
 * (enough for local test builds; this is not a full semver implementation, and need not be).
 *
 * Throws on something that is not a version, because there is no honest answer to give: callers
 * validate first.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new RangeError(`not a version: ${JSON.stringify(pa ? b : a)}`)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! > pb.nums[i]! ? 1 : -1
  }
  if (pa.suffix === pb.suffix) return 0
  if (pa.suffix === undefined) return 1
  if (pb.suffix === undefined) return -1
  return pa.suffix > pb.suffix ? 1 : -1
}

// --- the check ----------------------------------------------------------------------------------------

/** An HTTP answer outside 2xx, carrying its status so the check can say which kind of refusal it was. */
export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpError'
  }
}

/** Control characters out, ends trimmed, as the git updater does for every line it shows. */
const clean = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

const blocked = (reason: string): UpdateCheck => ({ state: 'blocked', behind: 0, changes: [], reason: reason.slice(0, REASON_MAX) })

/**
 * Says why the check could not be made, in a sentence for the Health page. 403 and 429 are both how
 * GitHub says "too many unauthenticated requests"; the daily rate limit means tomorrow's try is fresh.
 */
function unreachable(err: unknown): UpdateCheck {
  const status = statusOf(err)
  if (status === 403 || status === 429) return blocked('GitHub refused the check (rate limit); it is retried tomorrow.')
  if (status === 404) return blocked('GitHub has no published release of Parcels yet; it is checked again tomorrow.')
  if (status !== undefined) return blocked(`GitHub answered the check with HTTP ${status}; it is retried tomorrow.`)
  return blocked('GitHub could not be reached to check for a new version; it is retried tomorrow.')
}

/**
 * The release notes as the "what's new" list: every non-empty line, with a leading markdown bullet
 * removed, because the page draws its own list and a "- " in front of each item would be noise.
 */
function changesFrom(body: unknown): string[] {
  if (typeof body !== 'string') return []
  const out: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const t = clean(line).replace(/^[-*]\s+/, '')
    if (t === '') continue
    out.push(t.slice(0, CHANGE_MAX))
    if (out.length === CHANGES_SHOWN) break
  }
  return out
}

const UPSTREAM = 'GitHub Releases'

/**
 * Asks GitHub for the newest release and compares it with `current`.
 *
 * `version` in the answer is the release's version, not this app's: it is what an update would
 * download. A draft or a prerelease is never offered (`/latest` already leaves them out; the guard is
 * for a different `url`). Never throws: every failure, including a reply of the wrong shape, is
 * `blocked` with one sentence.
 */
export async function checkAppRelease(
  current: string, fetchJson: (url: string) => Promise<unknown>, url: string = RELEASES_URL,
): Promise<UpdateCheck> {
  try {
    if (!parseVersion(current)) {
      return blocked(`This app's own version (${clean(current).slice(0, 40)}) could not be read, so no release was compared with it.`)
    }
    let raw: unknown
    try {
      raw = await fetchJson(url)
    } catch (err) {
      return unreachable(err)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return blocked('GitHub answered the check with something that is not a release; it is retried tomorrow.')
    }
    const r = raw as Record<string, unknown>
    if (typeof r.tag_name !== 'string') {
      return blocked('GitHub answered the check without a version number; it is retried tomorrow.')
    }
    const tag = r.tag_name
    if (!parseVersion(tag)) {
      return blocked(`The newest release on GitHub is not named like a version (${clean(tag).slice(0, 40)}), so it was not offered.`)
    }
    const version = tag.replace(/^v/, '')
    if (r.draft === true || r.prerelease === true || compareVersions(version, current) <= 0) {
      return { state: 'current', behind: 0, changes: [], version, upstream: UPSTREAM }
    }
    return { state: 'behind', behind: 1, changes: changesFrom(r.body), version, upstream: UPSTREAM }
  } catch {
    // Nothing above should throw; this is the promise that a surprise still cannot fail a poll.
    return blocked('The check for a new version went wrong; it is retried tomorrow.')
  }
}

/**
 * The real `fetchJson` for `checkAppRelease`: GitHub's JSON media type, a user agent (GitHub refuses
 * requests without one), and a time limit so a stalled connection cannot hold a poll open.
 */
export const githubFetchJson = (version: string) => async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `Parcels/${version}` },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(res.status, url)
  }
  return res.json()
}

// --- checksums ----------------------------------------------------------------------------------------

/**
 * Reads `shasum -a 256` output: `<64 hex>  <name>`, or `<64 hex> *<name>` for binary mode. Every other
 * line is ignored. Hashes are lowercased; a name listed twice keeps its first hash.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](\S.*?)\s*$/.exec(line)
    if (m && !out.has(m[2]!)) out.set(m[2]!, m[1]!.toLowerCase())
  }
  return out
}

/** SHA-256 of a file, streamed: the zip is about 130 MB and must not be read into memory at once. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

// --- the status file ----------------------------------------------------------------------------------

export type AppUpdateStatus =
  | { state: 'downloading'; version: string; startedAt: Date }
  | { state: 'staged'; version: string; staged: string; startedAt: Date }
  | { state: 'failed'; version: string; reason: string; startedAt: Date; finishedAt: Date }
  | { state: 'installed'; version: string; finishedAt: Date }

export const appUpdateStatusPath = (supportDir: string): string => join(supportDir, 'updates', 'status.json')

const date = (v: unknown): Date | undefined => {
  if (typeof v !== 'string') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Reads the status file, trusting nothing in it: a missing, half-written or hand-edited file is no
 * status at all rather than an exception on the Health page. The version must be a version and the
 * dates real dates, because the page prints the one and computes with the other. Never throws.
 */
export function readAppUpdateStatus(path: string): AppUpdateStatus | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as Record<string, unknown>
    if (typeof o.version !== 'string' || !isVersion(o.version)) return undefined
    const version = o.version
    const startedAt = date(o.startedAt)
    const finishedAt = date(o.finishedAt)
    switch (o.state) {
      case 'downloading':
        return startedAt && { state: 'downloading', version, startedAt }
      case 'staged':
        return startedAt && typeof o.staged === 'string' && o.staged !== ''
          ? { state: 'staged', version, staged: o.staged, startedAt } : undefined
      case 'failed':
        return startedAt && finishedAt && typeof o.reason === 'string'
          ? { state: 'failed', version, reason: o.reason.slice(0, REASON_MAX), startedAt, finishedAt } : undefined
      case 'installed':
        return finishedAt && { state: 'installed', version, finishedAt }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Writes the status through a temporary file and a rename, so the page never reads half of it, and
 * with mode 0600 because it sits in the user's support folder beside the config.
 */
export function writeAppUpdateStatus(path: string, status: AppUpdateStatus): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}`
  // A temporary file left by a crash keeps whatever mode it was created with; start from nothing.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

// --- staging ------------------------------------------------------------------------------------------

export interface RunResult { code: number; stdout: string }

export interface StageDeps {
  version: string
  arch: 'arm64' | 'x64'
  /** The running app's bundle; the staging folder goes beside it, so the later swap is a rename. */
  appBundle: string
  supportDir: string
  download: (url: string, dest: string) => Promise<void>
  /** Runs a program without a shell: `ditto` and `codesign`. Tests always pass a fake. */
  run: (cmd: string, args: string[]) => Promise<RunResult>
  /** The SHA-256 of the leaf certificate this app was signed with (`app/signing-cert.sha256`). */
  expectedCertSha: string
  /** Defaults to the GitHub release; an `http` base is accepted only on this Mac (tests, dev server). */
  releaseBase?: string
  /** The clock, for the status file's times. */
  now?: () => Date
}

/** The staging folder: hidden, beside the app, named for the version it holds. */
export const stagingDir = (appBundle: string, version: string): string =>
  join(dirname(appBundle), `.Parcels-update-${version}`)

/** A failed step: the sentence the user reads, and the detail that only goes to the log. */
class StageFailure extends Error {
  constructor(readonly reason: string, readonly detail?: string) { super(reason) }
}

/** A function declaration, not an arrow, so TypeScript knows the code after a call is unreachable. */
function fail(reason: string, detail?: unknown): never {
  throw new StageFailure(reason, detail === undefined ? undefined : detail instanceof Error ? detail.message : String(detail))
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * True for an address an update may be fetched from: https anywhere, plain http only from this Mac
 * (the dev release server). Anything else would let whoever sits on the network choose the code.
 */
export function isSafeDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))
  } catch {
    return false
  }
}

/**
 * Removes what an earlier attempt left behind: this version's staging and download folders, those of
 * any other version (a crash mid-download, or a staged version a newer release replaced), and the
 * old status file, which describes an attempt that is over. Only names this module creates are
 * touched, matched exactly, because the staging folder sits in /Applications beside other people's apps.
 */
function removeLeftovers(appBundle: string, supportDir: string): void {
  const sweep = (parent: string, pattern: RegExp) => {
    let names: string[]
    try { names = readdirSync(parent) } catch { return }
    for (const name of names) {
      const m = pattern.exec(name)
      if (m && isVersion(m[1]!)) rmSync(join(parent, name), { recursive: true, force: true })
    }
  }
  sweep(dirname(appBundle), /^\.Parcels-update-(.+)$/)
  sweep(join(supportDir, 'updates'), /^(.+)$/)
  rmSync(appUpdateStatusPath(supportDir), { force: true })
}

/**
 * Downloads a release and stages it beside the app, verified, or explains why not.
 *
 * Steps, in order, each one a reason to stop: download the zip and `SHA256SUMS`; compare the zip's
 * SHA-256 with its line there; read the zip's table of contents and refuse any entry that could land
 * outside the staging folder (`zip-check.ts`); unpack with `ditto` into the staging folder, walk what
 * it made against the archive's list (`unsafeUnpackedTree`), and find a real `Parcels.app` in it;
 * `codesign --verify --deep --strict` it; compare its leaf certificate's SHA-256 with
 * `expectedCertSha`; and read its Info.plist, whose bundle identifier must be Parcels's and whose
 * version must be the one that was asked for. On any failure both the staging folder and the
 * downloads are removed, so a half-checked app is never left where the swap could pick it up. On
 * success only the staged app remains. The status file says where it is at every step. Never throws.
 */
export async function stageUpdate(d: StageDeps): Promise<AppUpdateStatus> {
  const now = d.now ?? (() => new Date())
  const startedAt = now()
  const statusPath = appUpdateStatusPath(d.supportDir)
  const save = (s: AppUpdateStatus): boolean => {
    try {
      writeAppUpdateStatus(statusPath, s)
      return true
    } catch (err) {
      console.error(`update: could not write ${statusPath}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  // The version and the architecture become path and file names, so they are checked before any
  // path is built from them; a version such as "../../x" would otherwise point the clean-up anywhere.
  if (!isVersion(d.version) || (d.arch !== 'arm64' && d.arch !== 'x64')) {
    const failed: AppUpdateStatus = {
      state: 'failed', version: String(d.version),
      reason: 'The update named a version or a Mac type this app cannot read, so nothing was downloaded.',
      startedAt, finishedAt: now(),
    }
    // Saved only when the version itself is sound (a bad architecture), because the reader drops a
    // status whose version is not one, and the page would then show nothing at all.
    if (isVersion(d.version)) save(failed)
    return failed
  }

  const { version } = d
  const downloads = join(d.supportDir, 'updates', version)
  const staging = stagingDir(d.appBundle, version)
  const stagedApp = join(staging, 'Parcels.app')
  const zipName = `Parcels-${version}-${d.arch}.zip`
  const clear = () => {
    rmSync(staging, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
  }

  try {
    removeLeftovers(d.appBundle, d.supportDir)
    // A download the page cannot see is one the user cannot follow or retry sensibly, and the same
    // fault (a full disk, a folder that is not writable) would only fail the download later.
    if (!save({ state: 'downloading', version, startedAt })) {
      fail('The update could not record its progress in the support folder, so nothing was downloaded.')
    }

    const base = (d.releaseBase ?? releaseDownloadBase(version)).replace(/\/+$/, '')
    const zipUrl = `${base}/${zipName}`
    const sumsUrl = `${base}/SHA256SUMS`
    if (!isSafeDownloadUrl(zipUrl)) {
      fail('The update was to be downloaded over an insecure connection, so nothing was downloaded.', base)
    }

    // 1. Download.
    mkdirSync(downloads, { recursive: true, mode: 0o700 })
    const zip = join(downloads, zipName)
    const sumsFile = join(downloads, 'SHA256SUMS')
    try {
      await d.download(zipUrl, zip)
      await d.download(sumsUrl, sumsFile)
    } catch (err) {
      fail('The update could not be downloaded, so nothing was changed; try again later.', err)
    }

    // 2. Checksum.
    if (statSync(sumsFile).size > SUMS_MAX_BYTES) fail('The release\'s checksum list is not one, so the update was thrown away.')
    const expected = parseSha256Sums(readFileSync(sumsFile, 'utf8')).get(zipName)
    if (expected === undefined) {
      fail('The release\'s checksum list does not mention this Mac\'s download, so it was thrown away.')
    }
    const actual = await sha256File(zip)
    if (actual !== expected) fail('The download did not match its published checksum, so it was thrown away.', `${actual} != ${expected}`)

    // 3. Before anything unpacks it, prove no entry can land outside the staging folder. The checksum
    // above only shows the zip is the one its release lists; whoever controls the release controls
    // both, and the certificate check cannot run until the app has been unpacked.
    const OUTSIDE = 'The download contains files that would land outside its folder, so it was thrown away.'
    let entries: ZipEntry[] = []
    try {
      entries = await readZipEntries(zip)
    } catch (err) {
      fail('The download is not a zip this app can check, so it was thrown away.', err instanceof ZipFormatError ? err : String(err))
    }
    const unsafe = unsafeZipEntry(entries)
    if (unsafe !== undefined) fail(OUTSIDE, unsafe)

    // Unpack, and find a real app: a symlink named Parcels.app would point the checks, and later
    // the swap, at something outside the staging folder.
    const unpacked = await d.run(DITTO, ['-x', '-k', zip, staging])
    if (unpacked.code !== 0) fail('The download could not be unpacked, so it was not installed.', `ditto exited ${unpacked.code}`)
    // ...and check what ditto actually made, not only what the archive said it would: nothing the
    // archive did not list, and no link that leads out, lexically or on the real file system. On a
    // refusal the clean-up's rmSync removes links themselves and never follows them.
    let unpackedWhy: string | undefined
    try {
      unpackedWhy = unsafeUnpackedTree(staging, entries)
    } catch (err) {
      unpackedWhy = `the unpacked folder could not be read: ${err instanceof Error ? err.message : String(err)}`
    }
    if (unpackedWhy !== undefined) fail(OUTSIDE, unpackedWhy)
    let isApp = false
    try {
      const st = lstatSync(stagedApp)
      isApp = st.isDirectory() && !st.isSymbolicLink()
    } catch { /* missing */ }
    if (!isApp) fail('The download did not contain the Parcels app, so it was not installed.')

    // 4. The signature holds together.
    const verified = await d.run(CODESIGN, ['--verify', '--deep', '--strict', stagedApp])
    if (verified.code !== 0) {
      fail('The new version\'s signature is broken, so it was not installed.', `codesign --verify exited ${verified.code}`)
    }

    // 5. ...and is ours. codesign writes the chain as <prefix>0 (the leaf), <prefix>1, ...; the leaf's
    // SHA-256 is what app/signing-cert.sha256 holds (spec §10).
    const want = d.expectedCertSha.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(want)) {
      fail('This app does not know its own certificate, so it cannot tell whether an update is genuine and installed nothing.')
    }
    const certDir = mkdtempSync(join(downloads, 'cert-'))
    const prefix = join(certDir, 'c')
    const extracted = await d.run(CODESIGN, ['-d', `--extract-certificates=${prefix}`, stagedApp])
    const leaf = `${prefix}0`
    if (extracted.code !== 0 || !existsSync(leaf)) {
      fail('The new version\'s certificate could not be read, so it was not installed.', `codesign -d exited ${extracted.code}`)
    }
    const got = await sha256File(leaf)
    if (got !== want) fail('The new version is not signed by the same certificate as this one, so it was not installed.', `${got} != ${want}`)

    // 6. ...and is this app, at the version asked for. The certificate signs every build ever made
    // with it, so without this an older Parcels with a known flaw, or another app signed with the same
    // identity, would pass as this update.
    const plist = join(stagedApp, 'Contents', 'Info.plist')
    const plistValue = async (key: string): Promise<string | undefined> => {
      const r = await d.run(PLUTIL, ['-extract', key, 'raw', '-o', '-', plist])
      return r.code === 0 ? r.stdout.trim() : undefined
    }
    const bundleId = await plistValue('CFBundleIdentifier')
    const bundleVersion = await plistValue('CFBundleShortVersionString')
    if (bundleId !== APP_BUNDLE_ID || bundleVersion !== version) {
      fail('The download is not the version it claims to be, so it was not installed.',
        `CFBundleIdentifier ${String(bundleId)}, CFBundleShortVersionString ${String(bundleVersion)}`)
    }

    rmSync(downloads, { recursive: true, force: true })
    const staged: AppUpdateStatus = { state: 'staged', version, staged: stagedApp, startedAt }
    save(staged)
    return staged
  } catch (err) {
    const reason = err instanceof StageFailure ? err.reason : 'The update could not be prepared, so nothing was changed; try again later.'
    const detail = err instanceof StageFailure ? err.detail : err instanceof Error ? err.message : String(err)
    console.error(`update: staging ${version} failed: ${reason}${detail ? ` (${detail})` : ''}`)
    try { clear() } catch (e) {
      console.error(`update: could not remove ${basename(staging)}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const failed: AppUpdateStatus = { state: 'failed', version, reason: reason.slice(0, REASON_MAX), startedAt, finishedAt: now() }
    save(failed)
    return failed
  }
}

// --- the real effects ---------------------------------------------------------------------------------

/**
 * Downloads `url` to `dest`, streamed. GitHub's asset URLs redirect to its object storage, so
 * redirects are followed - but the address it ends at must still be a safe one.
 */
export async function defaultDownload(url: string, dest: string): Promise<void> {
  if (!isSafeDownloadUrl(url)) throw new Error(`refusing to download from ${url}: not https`)
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (res.url && !isSafeDownloadUrl(res.url)) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`refusing to download from ${res.url}: redirected away from https`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new HttpError(res.status, url)
  }
  if (!res.body) throw new Error(`no body from ${url}`)
  await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest, { mode: 0o600 }))
}

/**
 * Runs a program with arguments and no shell, so nothing in a path is ever interpreted. Resolves with
 * the exit code rather than rejecting on a non-zero one, because a failed `codesign --verify` is an
 * answer, not an accident; a program that could not be started or was killed is code -1.
 */
export const runCommand = (cmd: string, args: string[]): Promise<RunResult> => new Promise(resolve => {
  execFile(cmd, args, { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout })
    const code = (err as { code?: unknown }).code
    resolve({ code: typeof code === 'number' ? code : -1, stdout: stdout ?? '' })
  })
})
