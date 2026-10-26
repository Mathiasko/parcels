export type CarrierId = 'posta' | 'packeta' | 'gls' | 'sps' | 'dpd'

export type CanonicalStatus =
  | 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'ready_for_pickup'
  | 'delivered'   | 'failed_attempt' | 'returning' | 'returned'
  | 'problem'     | 'unknown'

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

export interface CarrierAdapter {
  id: CarrierId
  matches(number: string): boolean     // shape test, manual entry only
  needsPostalCode: boolean
  batchSize: number                    // posta: 100, others: 1
  // Deliberate deviation from the design spec: the HttpClient is injected as a
  // second parameter so adapters are testable against fixtures without module mocking.
  fetch(inputs: FetchInput[], http: HttpClient): Promise<FetchResult[]>
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T>(): Promise<T>
}

export type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>
