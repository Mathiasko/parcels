export type CarrierId = 'posta' | 'packeta' | 'gls' | 'sps' | 'dpd' | 'dhl' | 'ppl'

/**
 * Carriers that are never polled: everything known about their parcels comes from ingested mail
 * (design spec §6.7). DHL is one because its tracking API needs a key the user cannot currently get
 * (their developer app is `revoked`) and dhl.com answers automated requests with a stated prohibition
 * and an active block — so there is nothing to poll, rather than an adapter nobody has written yet.
 *
 * Declared as data here, next to `CarrierId`, because the views and the backoff rules know a parcel's
 * carrier id and nothing else; making them import the adapter registry to ask "is this one polled?"
 * would drag every carrier's HTTP code into the web process. The registered carrier declares the same
 * fact in the type system (`EmailOnlyCarrier`), and `test/carriers/dhl.test.ts` asserts the two agree,
 * so they cannot drift apart.
 */
const EMAIL_ONLY_CARRIERS: ReadonlySet<CarrierId> = new Set<CarrierId>(['dhl'])

export const isEmailOnlyCarrier = (id: CarrierId): boolean => EMAIL_ONLY_CARRIERS.has(id)
export const emailOnlyCarriers = (): CarrierId[] => [...EMAIL_ONLY_CARRIERS]

export type CanonicalStatus =
  | 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'ready_for_pickup'
  | 'delivered'   | 'failed_attempt' | 'returning' | 'returned'
  | 'problem'     | 'unknown'

/**
 * The statuses a parcel never leaves: nothing polls it again and it moves to history. One list so the
 * poller's tiers, the active/history queries and the views cannot disagree about which they are.
 */
export const TERMINAL_STATUSES: readonly CanonicalStatus[] = ['delivered', 'returned']

export const isTerminalStatus = (s: CanonicalStatus): boolean => TERMINAL_STATUSES.includes(s)

export interface FetchInput { number: string; postalCode?: string }

export type FetchResult =
  | { ok: true; number: string
      status: CanonicalStatus; statusRaw: string; statusDetail?: string
      events: ParcelEvent[]
      pickup?: PickupPoint
      retainedTill?: Date
      raw: unknown }
  | { ok: false; number: string
      reason: 'not_found' | 'needs_postcode' | 'gated' | 'transport' }

export interface ParcelEvent {
  occurredAtRaw: string      // carrier's original string, kept verbatim
  occurredAtTz:  string      // e.g. 'Europe/Bratislava'
  occurredAt:    Date        // normalised to UTC
  status: CanonicalStatus
  code?: string
  description: string
  location?: string
}

/** An event inserted by this run, tagged with the parcel it belongs to. */
export type NewEvent = ParcelEvent & { parcelId: number }

export interface PickupPoint {
  kind: 'post_office' | 'zbox' | 'parcelshop' | 'locker' | 'unknown'
  name?: string; street?: string; city?: string; postalCode?: string
  lat?: number; lon?: number
}

/** A carrier that is polled over HTTP: the adapter contract of design spec §5. */
export interface CarrierAdapter {
  id: CarrierId
  matches(number: string): boolean     // shape test, manual entry only
  needsPostalCode: boolean
  batchSize: number                    // posta: 100, others: 1
  // Deliberate deviation from the design spec: the HttpClient is injected as a
  // second parameter so adapters are testable against fixtures without module mocking.
  fetch(inputs: FetchInput[], http: HttpClient): Promise<FetchResult[]>
}

/**
 * A carrier that is never polled; its parcels are tracked entirely from ingested mail (§6.7).
 *
 * Chosen over a `pollable: false` flag on `CarrierAdapter` because this way "never polled" is a fact
 * the compiler keeps: an email-only carrier has no `fetch`, no `batchSize` and no postcode question,
 * because none of them mean anything for a carrier nobody asks — so the poller cannot call it even
 * by mistake, and a reviewer can see that from the type rather than by trusting a runtime guard. It
 * is registered like any other carrier, which is what lets the ingest create its parcels: being
 * unpollable is a state, not the absence of an adapter.
 */
export interface EmailOnlyCarrier {
  id: CarrierId
  matches(number: string): boolean
  /** Always `false`. The declared discriminant; `isPollable` is the only thing that reads it. */
  pollable: false
}

/** Everything the registry holds: a polled adapter, or a carrier whose updates arrive by email. */
export type Carrier = CarrierAdapter | EmailOnlyCarrier

/** Narrows to the adapters that can actually be fetched. `CarrierAdapter` has no `pollable` key. */
export const isPollable = (c: Carrier): c is CarrierAdapter => !('pollable' in c)

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T>(): Promise<T>
}

export type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>
