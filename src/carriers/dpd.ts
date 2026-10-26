import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseNaive } from '../core/time.js'
import type {
  CanonicalStatus, CarrierAdapter, FetchInput, FetchResult, HttpClient, HttpResponse, ParcelEvent, PickupPoint,
} from '../core/types.js'
import { isNoticeCode, resolveMilestone, scanCodeStatus } from './dpd-codes.js'

const FALLBACK_ZONE = 'Europe/Bratislava'
const INSTALLATIONS_URL = 'https://firebaseinstallations.googleapis.com/v1/projects/consignee-portal/installations'
const REMOTE_CONFIG_URL = 'https://firebaseremoteconfig.googleapis.com/v1/projects/959401347543/namespaces/firebase:fetch'
const OAUTH_URL = 'https://www.dpdgroup.com/concept/webservice/oauth/token?grant_type=client_credentials'
const DETAILS_URL = 'https://www.dpdgroup.com/concept/webservice/v10/parcels/details/'

const APP_ID = '1:959401347543:android:8d1a84133332291109e392'
const PACKAGE = 'com.dpdgroup.chatbot.lemny.prod'
const FIREBASE_HEADERS = {
  'X-Goog-Api-Key': 'AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc',
  'X-Android-Package': PACKAGE,
  'X-Android-Cert': '3872ACD98DE975F69C68CAF5119A5A1B2024B873',
  'Content-Type': 'application/json',
}
const APP_HEADERS = {
  'User-Agent': 'myDPD/3.79.14 (Android)',
  Accept: 'application/json',
  'Content-Type': 'application/json',
}

// Shape only. A bare 14-digit number cannot be attributed to DPD Slovakia: other DPD networks, BRT, SEUR,
// Ciblex and DHL eCommerce UK share it, and a parcel keeps the depot prefix of the network that sent it.
// The optional 15th character is a check character (ISO/IEC 7064 MOD 37,36), deliberately not verified:
// the algorithm has never been confirmed against a real label, and a wrong one would reject good numbers.
const NUMBER_SHAPE = /^\d{14}[0-9A-Z]?$/

/** The access token is renewed this long before DPD says it expires. */
const EXPIRY_MARGIN_MS = 60_000
/** The Basic credential changes only when DPD rotates it; a refusal from OAuth renews it sooner. */
const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A failure of the credential chain, already classified for the caller. */
class ChainError extends Error {
  constructor(readonly reason: 'gated' | 'transport', detail: string) {
    super(detail)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// ---------------------------------------------------------------------------------------------------
// Credential chain: Firebase installation -> Remote Config (Basic credential) -> OAuth (access token)

export interface TokenCache {
  get(): { token: string; expiresAt: number } | undefined
  set(token: string, expiresAt: number): void
}

export function createTokenCache(): TokenCache {
  let entry: { token: string; expiresAt: number } | undefined
  return {
    get: () => entry,
    set: (token, expiresAt) => { entry = { token, expiresAt } },
  }
}

/**
 * Module-level on purpose: the orchestrator wraps the HttpClient afresh for every chunk, so anything keyed
 * on the client object would never hit. Both the access token and the Basic credential behind it live here.
 * Behind this in-memory layer sits an optional file (see `setDpdAuthStore`), because the poller exits after
 * every run and would otherwise start cold, with a new Firebase installation id, every hour.
 */
const tokenCache = createTokenCache()
let credential: { value: string; at: number } | undefined
const inflight = new WeakMap<TokenCache, Promise<string>>()

let storePath: string | undefined
let storeLoaded = false

/**
 * Where the last-known-good Basic credential and access token are kept between runs, or undefined for
 * memory only (the default, and what tests get). The entry points call this with a path derived from the
 * database location: launchd runs with an arbitrary working directory, so nothing here relies on cwd.
 */
export function setDpdAuthStore(path: string | undefined): void {
  storePath = path
  storeLoaded = false
}

/** `dpd-auth.json` next to the database, or undefined for an in-memory database. */
export function authStorePathFor(dbPath: string): string | undefined {
  return dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'dpd-auth.json')
}

/** Forgets the cached credential and token (memory only; the file is untouched). For tests. */
export function clearDpdCaches(): void {
  credential = undefined
  tokenCache.set('', 0)
  inflight.delete(tokenCache)
  storeLoaded = false
}

/** Fills the empty in-memory layer from the file, once. Never throws: a bad file is just a cold start. */
function loadStore(): void {
  if (!storePath || storeLoaded) return
  storeLoaded = true
  try {
    const stored = parseJson(readFileSync(storePath, 'utf8'))
    if (!isObject(stored)) throw new Error('not a JSON object')
    const c = stored.credential
    if (!credential && isObject(c) && asString(c.value) && Number.isFinite(c.at)) {
      credential = { value: c.value as string, at: c.at as number }
    }
    const t = stored.token
    if (!tokenCache.get()?.token && isObject(t) && asString(t.token) && Number.isFinite(t.expiresAt)) {
      tokenCache.set(t.token as string, t.expiresAt as number)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`dpd: ignoring unreadable auth store ${storePath}: ${message(err)}`)
    }
  }
}

/** Writes the in-memory layer to the file (mode 600, via a rename so a crash cannot leave half a file). */
function saveStore(): void {
  if (!storePath) return
  try {
    const token = tokenCache.get()
    const body = JSON.stringify({ credential, token: token?.token ? token : undefined })
    mkdirSync(dirname(storePath), { recursive: true })
    const tmp = `${storePath}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, storePath)
  } catch (err) {
    console.warn(`dpd: could not write auth store ${storePath}: ${message(err)}`)
  }
}

/** Drops a credential or token DPD refused, in memory and in the file, so the next run does not reload it. */
function forget(cache: TokenCache): void {
  credential = undefined
  cache.set('', 0)
  if (cache === tokenCache) saveStore()
}

/** 400/401/403 from Firebase mean our app identity or the project moved; anything else is DPD or Google being down. */
function firebaseFailure(step: string, res: HttpResponse): ChainError {
  const gated = res.status === 400 || res.status === 401 || res.status === 403
  return new ChainError(gated ? 'gated' : 'transport', `${step} answered ${res.status}`)
}

/** A Firebase installation id: 22 base64url characters whose first four bits are 0111. */
function newFid(): string {
  const bytes = randomBytes(17)
  bytes[0] = 0x70 | (bytes[0]! & 0x0f)
  return bytes.toString('base64url').slice(0, 22)
}

/**
 * Asks Firebase Remote Config for `basic_dpd_token`. It is a value DPD can rotate at will, which is why it is
 * read here instead of being written into the source.
 */
async function fetchCredential(http: HttpClient): Promise<string> {
  const install = await http(INSTALLATIONS_URL, {
    method: 'POST',
    headers: FIREBASE_HEADERS,
    body: JSON.stringify({ fid: newFid(), appId: APP_ID, authVersion: 'FIS_v2', sdkVersion: 'a:18.0.0' }),
  })
  if (install.status !== 200) throw firebaseFailure('firebase installations', install)
  const installed = parseJson(await install.text())
  const authToken = isObject(installed) && isObject(installed.authToken) ? asString(installed.authToken.token) : undefined
  const fid = isObject(installed) ? asString(installed.fid) : undefined
  if (!authToken || !fid) throw new ChainError('transport', 'firebase installations answer has no fid or authToken')

  const config = await http(REMOTE_CONFIG_URL, {
    method: 'POST',
    headers: { ...FIREBASE_HEADERS, 'X-Goog-Firebase-Installations-Auth': authToken },
    body: JSON.stringify({
      appId: APP_ID, appInstanceId: fid, appInstanceIdToken: authToken,
      languageCode: 'sk-SK', countryCode: 'SK', platformVersion: '36', appVersion: '3.79.14',
      packageName: PACKAGE, sdkVersion: '22.1.2', analyticsUserProperties: {},
    }),
  })
  if (config.status !== 200) throw firebaseFailure('firebase remote config', config)
  const body = parseJson(await config.text())
  const entries = isObject(body) ? body.entries : undefined
  const basic = isObject(entries) ? asString(entries.basic_dpd_token) : undefined
  // The answer parsed but the entry is gone: DPD moved the credential, which is the adapter being broken.
  if (!basic) throw new ChainError('gated', 'firebase remote config has no basic_dpd_token')
  return basic
}

async function requestToken(http: HttpClient, basic: string): Promise<HttpResponse> {
  return http(OAUTH_URL, { method: 'POST', headers: { ...APP_HEADERS, Authorization: `Basic ${basic}` } })
}

async function runChain(http: HttpClient): Promise<{ token: string; expiresAt: number }> {
  let basic = credential && Date.now() - credential.at < CREDENTIAL_TTL_MS ? credential.value : undefined
  let cachedCredential = basic !== undefined
  if (basic === undefined) {
    basic = await fetchCredential(http)
    credential = { value: basic, at: Date.now() }
    saveStore()
  }
  let res = await requestToken(http, basic)
  if ((res.status === 400 || res.status === 401) && cachedCredential) {
    // The cached credential may simply have been rotated: read it again once before giving up.
    credential = undefined
    basic = await fetchCredential(http)
    credential = { value: basic, at: Date.now() }
    saveStore()
    cachedCredential = false
    res = await requestToken(http, basic)
  }
  // Refused straight after being read fresh: the app identity itself no longer works.
  if (res.status === 400 || res.status === 401) throw new ChainError('gated', `oauth refused the credential (${res.status})`)
  if (res.status !== 200) throw new ChainError('transport', `oauth answered ${res.status}`)
  const body = parseJson(await res.text())
  const token = isObject(body) ? asString(body.access_token) : undefined
  const expiresIn = isObject(body) ? Number(body.expires_in) : NaN
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new ChainError('transport', 'oauth answer has no usable token')
  return { token, expiresAt: Date.now() + expiresIn * 1000 }
}

/**
 * The OAuth access token, from `cache` while it is valid and otherwise from a fresh run of the chain
 * (the Basic credential behind it is itself cached, so usually only the OAuth call is repeated).
 * Concurrent callers share one run. Throws a classified `ChainError` when the chain fails.
 */
export function getAccessToken(http: HttpClient, cache: TokenCache = tokenCache): Promise<string> {
  if (cache === tokenCache) loadStore()
  const hit = cache.get()
  if (hit && Date.now() < hit.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(hit.token)
  let running = inflight.get(cache)
  if (!running) {
    running = runChain(http)
      .then(t => { cache.set(t.token, t.expiresAt); if (cache === tokenCache) saveStore(); return t.token })
      .finally(() => { inflight.delete(cache) })
    inflight.set(cache, running)
  }
  return running
}

// ---------------------------------------------------------------------------------------------------
// Parcel details

interface RawMilestone {
  description?: unknown
  eventDateAndTime?: unknown
  eventDateAndTimeZoneId?: unknown
  city?: unknown
}
interface RawScan {
  date?: unknown; time?: unknown; eventType?: unknown; eventTypeText?: unknown; translation?: unknown
  city?: unknown; pudoId?: unknown; eventDateAndTimeZoneId?: unknown
}

/** `+01:00`, `-0330`, `+02` or `Z`: the zone id DPD puts on `parcelHistory[]` entries. */
const OFFSET_ZONE = /^(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/

/**
 * Parses a zone-less ISO timestamp in the zone DPD names for it: an IANA id, or a fixed offset (the live
 * pre-alert history says `+01:00`). A fixed offset is reported as the equivalent `Etc/GMT` name, so the
 * stored zone is always one Intl and Luxon understand.
 */
function parseWhen(raw: string, zoneId: string): { at: Date; tz: string } {
  const m = OFFSET_ZONE.exec(zoneId)
  if (!m) return parseNaive(raw, zoneId)
  const sign = m[1] ?? '+'
  const hours = m[2] ?? '00'
  const minutes = m[3] ?? '00'
  const at = new Date(`${raw}${sign}${hours}:${minutes}`)
  if (Number.isNaN(at.getTime())) throw new Error(`cannot parse timestamp ${JSON.stringify(raw)} at offset ${zoneId}`)
  const total = Number(hours) * 60 + Number(minutes)
  if (total === 0) return { at, tz: 'UTC' }
  // Etc/GMT names are inverted: UTC+1 is Etc/GMT-1. Half-hour offsets have no such name.
  return { at, tz: total % 60 === 0 ? `Etc/GMT${sign === '+' ? '-' : '+'}${total / 60}` : 'UTC' }
}

function warnUnmapped(kind: string, value: string): void {
  console.warn(`dpd: unmapped ${kind} ${JSON.stringify(value)}, treating as unknown`)
}

const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * DPD lists newest first, so entries sharing a timestamp come in reverse order; flipping them on a tie keeps
 * the sequence deterministic, which matters because a notice takes the status of the event before it.
 */
function sortOldestFirst<T extends { at: Date }>(list: T[]): T[] {
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.at.getTime() - b.item.at.getTime() || b.i - a.i)
    .map(x => x.item)
}

/** Coarse milestones, each with the zone DPD supplied for it. Sorted oldest-first. */
function milestones(body: Record<string, unknown>) {
  const list = array(body.parcelHistory).filter(isObject).map(h => {
    const m = h as RawMilestone
    const raw = asString(m.eventDateAndTime)
    const description = asString(m.description)
    if (!raw || !description) throw new Error('parcelHistory entry without description or eventDateAndTime')
    const { at, tz } = parseWhen(raw, asString(m.eventDateAndTimeZoneId) ?? FALLBACK_ZONE)
    return { description, raw, at, tz, city: asString(m.city) }
  })
  return sortOldestFirst(list)
}

function milestoneEvents(list: ReturnType<typeof milestones>): ParcelEvent[] {
  return list.map((m, i): ParcelEvent => {
    const status = resolveMilestone(m.description, list.slice(0, i).map(e => e.description))
    if (!status && m.description !== 'OTHER') warnUnmapped('milestone', m.description)
    return {
      occurredAtRaw: m.raw, occurredAtTz: m.tz, occurredAt: m.at, status: status ?? 'unknown',
      code: m.description, description: m.description, location: m.city,
    }
  })
}

/**
 * Raw scans from a postcode-verified answer. They carry date and time separately and no zone of their own,
 * so they are read in the zone of the top-level status. Sorted oldest-first.
 */
function scanEvents(scans: RawScan[], zoneId: string): ParcelEvent[] {
  const parsed = scans.map(s => {
    const date = asString(s.date)
    const time = asString(s.time)
    const code = asString(s.eventType)
    if (!date || !time || !code) throw new Error('parcelEvents entry without date, time or eventType')
    const { at, tz } = parseWhen(`${date}T${time}`, asString(s.eventDateAndTimeZoneId) ?? zoneId)
    return { s, code, raw: `${date} ${time}`, at, tz }
  })
  const ordered = sortOldestFirst(parsed)

  // A notice is not a stage: it carries the status already in force (or unknown before any), so it can
  // neither start a notification nor move the parcel.
  let current: CanonicalStatus = 'unknown'
  return ordered.map((p): ParcelEvent => {
    let status = current
    if (!isNoticeCode(p.code)) {
      const mapped = scanCodeStatus(p.code)
      if (!mapped) warnUnmapped('scan code', p.code)
      status = mapped ?? 'unknown'
      if (mapped) current = mapped
    }
    return {
      occurredAtRaw: p.raw, occurredAtTz: p.tz, occurredAt: p.at, status, code: p.code,
      description: asString(p.s.translation) ?? asString(p.s.eventTypeText) ?? p.code,
      location: asString(p.s.city),
    }
  })
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * INFERRED, not live-observed: the postcode-verified shape. `pickupPassParcelShop` is read as the shop's
 * address block, and a `pudoId` on any scan is taken to mean a pickup point is involved even when the
 * block is missing.
 */
function toPickup(body: Record<string, unknown>, scans: RawScan[]): PickupPoint | undefined {
  const shop = isObject(body.pickupPassParcelShop) ? body.pickupPassParcelShop : undefined
  if (!shop) return scans.some(s => asString(s.pudoId)) ? { kind: 'parcelshop' } : undefined
  const pickup: PickupPoint = { kind: 'parcelshop' }
  const name = asString(shop.name)
  const street = asString(shop.street)
  const city = asString(shop.city)
  const postalCode = asString(shop.zipCode) ?? asString(shop.postalCode)
  if (name) pickup.name = name
  if (street) pickup.street = street
  if (city) pickup.city = city
  if (postalCode) pickup.postalCode = postalCode
  const geo = isObject(shop.geoPosition) ? shop.geoPosition : undefined
  const lat = toNumber(geo?.lat)
  const lon = toNumber(geo?.lon)
  if (lat !== undefined && lon !== undefined) { pickup.lat = lat; pickup.lon = lon }
  return pickup
}

function toResult(number: string, body: Record<string, unknown>): FetchResult {
  // An unregistered number is answered 200 with a success-shaped empty shell (receiver all null, `refused`
  // false ...) and none of the keys that carry a parcel: no `status`, `parcelHistory` or `parcelEvents`.
  // That is DPD saying "no such parcel", so it is not_found, not an outage. The test is the ABSENCE of those
  // keys (not a marker field the shell happens to carry), and an empty object is not the shell: anything that
  // has even one of them but cannot be read stays `transport`, so real schema drift still alarms.
  if (Object.keys(body).length > 0 && !('status' in body) && !('parcelHistory' in body) && !('parcelEvents' in body)) {
    return { ok: false, number, reason: 'not_found' }
  }
  const top = isObject(body.status) ? (body.status as RawMilestone) : undefined
  const description = asString(top?.description)
  if (!top || !description) return { ok: false, number, reason: 'transport' }
  const topZone = asString(top.eventDateAndTimeZoneId) ?? FALLBACK_ZONE

  const scans = array(body.parcelEvents).filter(isObject) as RawScan[]
  // Scans are preferred when present. The milestones are then only consulted for the PARCEL_HANDED rule, so
  // one malformed entry among them must not discard an otherwise good answer.
  let history: ReturnType<typeof milestones>
  try {
    history = milestones(body)
  } catch (err) {
    if (scans.length === 0) throw err
    history = []
  }
  const events = scans.length > 0 ? scanEvents(scans, topZone) : milestoneEvents(history)

  // The parcel's status is DPD's own top-level `status`, never the newest event. `PARCEL_HANDED` is judged
  // against the milestones dated before it, as in the history.
  const topRaw = asString(top.eventDateAndTime)
  const topAt = topRaw ? parseWhen(topRaw, topZone).at.getTime() : Infinity
  let status = resolveMilestone(description, history.filter(m => m.at.getTime() < topAt).map(m => m.description))
  if (!status && description !== 'OTHER') warnUnmapped('status', description)
  if (!status) {
    // `OTHER` (or a new value) names no stage: fall back to the newest scan that does. Notices carry the
    // status already in force, so they cannot be what is found here.
    status = events.findLast(e => e.status !== 'unknown')?.status ?? 'unknown'
  }

  const result: FetchResult = { ok: true, number, status, statusRaw: description, events, raw: body }
  const pickup = toPickup(body, scans)
  if (pickup) result.pickup = pickup
  // The pickup pass is what the shop scans; PickupPoint has no field for it.
  const pass = asString(body.pickupPass)
  if (pass) result.statusDetail = pass
  return result   // no retainedTill: DPD supplies no deadline in any shape seen
}

function detailsUrl(number: string, postalCode: string | undefined): string {
  const q = new URLSearchParams({
    parcelType: 'INCOMING', businessUnit: 'DPD-SK', lang: 'sk',
    continueWithoutVerification: postalCode ? 'false' : 'true',
  })
  if (postalCode) q.set('dataForVerification', postalCode)
  return `${DETAILS_URL}${number}?${q}`
}

/** Must be POST with an empty body: GET answers 405. */
async function callDetails(http: HttpClient, token: string, number: string, postalCode: string | undefined) {
  const res = await http(detailsUrl(number, postalCode), {
    method: 'POST',
    headers: { ...APP_HEADERS, Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, text, body: parseJson(text) }
}
type Details = Awaited<ReturnType<typeof callDetails>>

const exceptionType = (d: Details): string | undefined =>
  isObject(d.body) ? asString(d.body.exceptionType) : undefined

async function fetchOne({ number, postalCode }: FetchInput, http: HttpClient): Promise<FetchResult> {
  const transport: FetchResult = { ok: false, number, reason: 'transport' }
  // The check character, if present, is not part of the number DPD knows.
  const digits = number.slice(0, 14)
  const pc = postalCode?.replace(/\s+/g, '') || undefined
  try {
    let token = await getAccessToken(http)
    let sentPostcode = pc
    let res = await callDetails(http, token, digits, sentPostcode)

    // Rejected token: the access token expired early or the credential rotated, so run the chain again and
    // retry once. A second 401 means the adapter is broken.
    if (res.status === 401) {
      forget(tokenCache)
      token = await getAccessToken(http)
      res = await callDetails(http, token, digits, sentPostcode)
    }
    // The postcode was refused, which says nothing about the parcel: ask again without it and take the
    // milestones only. Never `needs_postcode`: that would stop the parcel being polled at all.
    if (res.status === 400 && exceptionType(res) === 'PROVIDE_ZIP_CODE' && sentPostcode) {
      sentPostcode = undefined
      res = await callDetails(http, token, digits, sentPostcode)
    }

    if (res.status === 401 || res.status === 403) return { ok: false, number, reason: 'gated' }   // 403: Cloudflare reached the API path
    if (res.status === 400 || res.status === 404) {
      // Three different 400s: only the discriminator tells them apart. A 404 needs it too: without it the
      // answer came from a gateway or a moved path, not from DPD about this parcel.
      if (exceptionType(res) === 'PARCEL_NOT_FOUND') return { ok: false, number, reason: 'not_found' }
      console.warn(`dpd: ${res.status} for ${number} with exceptionType ${JSON.stringify(exceptionType(res))}`)
      return transport
    }
    if (res.status !== 200) return transport   // 503 means DPD is down, not an answer about the parcel
    if (!isObject(res.body)) return transport
    return toResult(number, res.body)
  } catch (err) {
    if (err instanceof ChainError) {
      console.warn(`dpd: credential chain failed (${err.reason}): ${err.message}`)
      return { ok: false, number, reason: err.reason }
    }
    // Non-JSON or truncated bodies, an unparseable event time and transport errors all land here.
    console.warn(`dpd: could not read the answer for ${number}: ${message(err)}`)
    return transport
  }
}

export const dpdAdapter: CarrierAdapter = {
  id: 'dpd',
  needsPostalCode: true,
  batchSize: 1,
  matches: number => NUMBER_SHAPE.test(number),
  fetch: (inputs, http) => Promise.all(inputs.map(i => fetchOne(i, http))),
}
