// The carrier side of a persona's world: what each tracking API answers for each fake number at a given
// moment. Unlike scripts/dev/fake-mail/world.ts it reacts to the persona: a parcel at a pickup point stays
// there until the persona collects it (`sim collect`, with the right code), and one never collected goes
// back to the sender after its deadline. Nothing here touches a network.
import { DateTime } from 'luxon'
import type { CanonicalStatus, CarrierId, FetchResult, ParcelEvent, PickupPoint } from '../../../../src/core/types.js'

export const ZONE = 'Europe/Bratislava'

export interface WEvent { at: string; status: CanonicalStatus; text: string; location?: string }
export interface WParcel {
  key: string; carrier: CarrierId | 'alza'; number: string; label: string; owner?: 'me' | 'flatmate'
  events: WEvent[]
  ready?: {
    at: string; text: string; location?: string; pickup?: PickupPoint; till: string; code?: string
    hours: '24/7' | 'shop' | 'post'; where: string; noPickupInApi?: boolean; needsId?: boolean
  }
  collect?: { lagMin: number; text: string; location?: string }
  expire?: { returningText: string; returnedText: string; returnAfterH?: number }
  cod?: string
  emailOnly?: boolean
}

const CARRIER_ZONE: Record<CarrierId, string> = {
  packeta: 'Europe/Prague', dpd: ZONE, gls: ZONE, sps: ZONE, posta: ZONE, dhl: 'UTC',
}
/** Carriers whose real adapters can only code the NEWEST event (prose-only timelines). */
const PROSE_ONLY = new Set<CarrierId>(['packeta', 'gls', 'sps'])
const H = 3_600_000

export class World {
  readonly collected = new Map<string, Date>()
  constructor(readonly parcels: WParcel[], readonly T: (at: string) => Date) {}

  byKey(key: string): WParcel | undefined { return this.parcels.find(p => p.key === key) }

  /** The parcel's whole timeline as of `now`, oldest first. */
  timeline(p: WParcel, now: Date): Array<{ at: Date; status: CanonicalStatus; text: string; location?: string }> {
    const out = p.events.map(e => ({ at: this.T(e.at), status: e.status, text: e.text, ...(e.location && { location: e.location }) }))
    if (p.ready) {
      out.push({ at: this.T(p.ready.at), status: 'ready_for_pickup', text: p.ready.text, ...(p.ready.location && { location: p.ready.location }) })
      const c = this.collected.get(p.key)
      if (c && p.collect) {
        out.push({ at: new Date(c.getTime() + p.collect.lagMin * 60_000), status: 'delivered', text: p.collect.text, ...(p.collect.location && { location: p.collect.location }) })
      } else if (!c && p.expire) {
        const back = this.returningAt(p)!
        out.push({ at: back, status: 'returning', text: p.expire.returningText })
        out.push({ at: new Date(back.getTime() + 72 * H), status: 'returned', text: p.expire.returnedText })
      }
    }
    return out.filter(e => e.at <= now).sort((a, b) => a.at.getTime() - b.at.getTime())
  }

  returningAt(p: WParcel): Date | undefined {
    if (!p.ready) return undefined
    return new Date(this.T(p.ready.till).getTime() + (p.expire?.returnAfterH ?? 8) * H)
  }

  /** What the carrier's tracking API answers for `number` at `now`. Unknown numbers, or no event yet: not_found. */
  answer(carrier: CarrierId, number: string, now: Date): FetchResult {
    const p = this.parcels.find(x => x.number === number && x.carrier === carrier && !x.emailOnly)
    if (!p) return { ok: false, number, reason: 'not_found' }
    const seen = this.timeline(p, now)
    if (seen.length === 0) return { ok: false, number, reason: 'not_found' }
    const latest = seen.at(-1)!
    const zone = CARRIER_ZONE[carrier]
    const events: ParcelEvent[] = seen.map((e, i) => ({
      occurredAtRaw: DateTime.fromJSDate(e.at, { zone }).toFormat("yyyy-LL-dd'T'HH:mm"), occurredAtTz: zone, occurredAt: e.at,
      status: PROSE_ONLY.has(carrier) && i !== seen.length - 1 ? 'unknown' : e.status,
      description: e.text, ...(e.location && { location: e.location }),
    }))
    const ready = latest.status === 'ready_for_pickup' && p.ready
    return {
      ok: true, number, status: latest.status, statusRaw: latest.text, events,
      ...(ready && p.ready!.pickup && !p.ready!.noPickupInApi && { pickup: { ...p.ready!.pickup } }),
      ...(ready && { retainedTill: this.T(p.ready!.till) }),
      // Shaped like a carrier's tracking reply (the page shows it under "Technical details").
      raw: { trackingNumber: number, state: latest.text, events: seen.map(e => ({ time: DateTime.fromJSDate(e.at, { zone }).toISO({ suppressMilliseconds: true }), description: e.text, ...(e.location && { location: e.location }) })).reverse() },
    }
  }

  /**
   * The persona, at a pickup point, using a code or a number. Boxes open only with their code; a counter
   * (shop, post office) also accepts the number. Returns what the person experiences.
   */
  collect(input: string, now: Date): { ok: boolean; message: string; parcel?: WParcel } {
    const want = input.replace(/\s+/g, '').toUpperCase()
    if (!want) return { ok: false, message: 'Type the opening code, PIN or parcel number you want to use.' }
    const local = DateTime.fromJSDate(now, { zone: ZONE })
    const hit = this.parcels.find(p => p.ready && (p.ready.code === want || p.number === want))
    if (!hit || !hit.ready) return { ok: false, message: `Nothing opens and nobody has a parcel for "${input}". Check the code or number.` }
    const r = hit.ready
    if (this.T(r.at) > now) return { ok: false, message: `Nothing opens and nobody has a parcel for "${input}" (yet).` }
    if (this.collected.has(hit.key)) return { ok: false, message: `You already collected that parcel (${r.where}).` }
    if (now > this.T(r.till)) return { ok: false, message: `${r.where}: the parcel is no longer here - its pickup time ran out and it is going back to the sender.` }
    const boxCode = r.hours === '24/7' && r.code !== undefined
    if (boxCode && want !== r.code) return { ok: false, message: `${r.where}: the box asks for the opening code; the parcel number alone does not open it.` }
    const open = this.isOpen(r.hours, local)
    if (!open.ok) return { ok: false, message: `${r.where} is closed now (${local.setLocale('en').toFormat('ccc HH:mm')}). Opening hours: ${open.hours}.` }
    this.collected.set(hit.key, now)
    const how = boxCode ? `you enter ${r.code}, a compartment opens` : r.needsId ? 'you show your ID and the number at the counter' : 'the staff hand it over'
    const pay = hit.cod ? ` You pay ${hit.cod} (cash on delivery).` : ''
    const whose = hit.owner === 'flatmate' ? ' It is addressed to your flatmate.' : ''
    return { ok: true, parcel: hit, message: `${r.where}: ${how} - parcel collected.${pay}${whose}` }
  }

  isOpen(hours: '24/7' | 'shop' | 'post', t: DateTime): { ok: boolean; hours: string } {
    if (hours === '24/7') return { ok: true, hours: 'non-stop' }
    const wd = t.weekday   // 1 = Monday
    const hm = t.hour + t.minute / 60
    if (hours === 'shop') return { ok: wd <= 6 && hm >= 8 && hm < 19, hours: 'Mon-Sat 08:00-19:00' }
    return { ok: (wd <= 5 && hm >= 8 && hm < 18) || (wd === 6 && hm >= 8 && hm < 11), hours: 'Mon-Fri 08:00-18:00, Sat 08:00-11:00' }
  }
}
