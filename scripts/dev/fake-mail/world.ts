// The canned "carrier side" of the fake world: what each carrier's tracking API would answer for each
// fake number at a given moment. Used by fake adapters in harness.run.ts; nothing here touches a network.
import type { CanonicalStatus, CarrierId, FetchResult, ParcelEvent, PickupPoint } from '../../../src/core/types.js'

/** Europe/Bratislava wall time 'YYYY-MM-DD HH:MM' -> Date (CEST until 2026-10-25 03:00, CET after). */
export function local(s: string): Date {
  const naive = new Date(`${s.replace(' ', 'T')}:00Z`)
  const summer = naive < new Date('2026-10-25T03:00:00Z')
  return new Date(naive.getTime() - (summer ? 2 : 1) * 3_600_000)
}

interface WorldEvent { at: string; status: CanonicalStatus; text: string; location?: string }
interface WorldParcel {
  carrier: CarrierId
  events: WorldEvent[]
  /** Pickup point the carrier reports once (and while) the parcel is ready_for_pickup. */
  pickup?: PickupPoint
  retainedTill?: string
}

const ZONE: Record<CarrierId, string> = {
  packeta: 'Europe/Prague', dpd: 'Europe/Bratislava', gls: 'Europe/Bratislava', sps: 'Europe/Bratislava', posta: 'Europe/Bratislava', dhl: 'UTC',
}
/** Carriers whose real adapters can only code the NEWEST event (prose-only timelines). */
const PROSE_ONLY = new Set<CarrierId>(['packeta', 'gls', 'sps'])

const Z = (n: number) => `Z22222222${String(n).padStart(2, '0')}`
const DPD = (n: number) => `015053333333${String(n).padStart(2, '0')}`
const GLS = (n: number) => `904444444${String(n).padStart(2, '0')}`

const ZBOX_A: PickupPoint = { kind: 'zbox', name: 'Z-BOX Testovo, Hlavná 5 (OC Fiktív)', street: 'Hlavná 5', city: 'Testovo' }
const ZBOX_B: PickupPoint = { kind: 'zbox', name: 'Z-BOX Testovo, Nová 8 (Lidl)', street: 'Nová 8', city: 'Testovo' }

const pk = (at: string, status: CanonicalStatus, text: string): WorldEvent => ({ at, status, text })

export const WORLD: Record<string, WorldParcel> = {
  // P1 Packeta Z-BOX
  [Z(1)]: { carrier: 'packeta', pickup: ZBOX_A, retainedTill: '2026-10-23 23:59', events: [
    pk('2026-10-16 18:10', 'pre_transit', 'Zásielka bola podaná odosielateľom.'),
    pk('2026-10-17 06:40', 'in_transit', 'Zásielka je na ceste.'),
    pk('2026-10-20 08:52', 'ready_for_pickup', 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.'),
    pk('2026-10-22 13:48', 'delivered', 'Zásielka bola vyzdvihnutá.'),
  ] },
  // P2 Packeta výdajné miesto, COD, returned
  [Z(2)]: { carrier: 'packeta', retainedTill: '2026-10-25 20:00',
    pickup: { kind: 'unknown', name: 'Potraviny u Mišky – výdajné miesto', street: 'Pekná cesta 2', city: 'Fiktívne Mesto' }, events: [
      pk('2026-10-18 12:50', 'pre_transit', 'Zásielka bola podaná odosielateľom.'),
      pk('2026-10-19 09:41', 'ready_for_pickup', 'Zásielka bola doručená na výdajné miesto.'),
      pk('2026-10-25 09:30', 'returning', 'Zásielka nebola vyzdvihnutá v úložnej dobe, vraciame ju odosielateľovi.'),
      pk('2026-10-29 15:12', 'returned', 'Zásielka bola vrátená odosielateľovi.'),
    ] },
  // P3 Packeta: box A full, redirected to box B
  [Z(3)]: { carrier: 'packeta', pickup: ZBOX_B, retainedTill: '2026-10-25 23:59', events: [
    pk('2026-10-21 09:50', 'pre_transit', 'Zásielka bola podaná odosielateľom.'),
    pk('2026-10-22 08:55', 'in_transit', 'Z-BOX je plný, zásielku presmerovávame do iného Z-BOXu.'),
    pk('2026-10-22 09:58', 'ready_for_pickup', 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.'),
    pk('2026-10-29 10:57', 'delivered', 'Zásielka bola vyzdvihnutá.'),
  ] },
  // CZ Zásilkovna (Czech prose)
  [Z(4)]: { carrier: 'packeta', retainedTill: '2026-10-24 23:59',
    pickup: { kind: 'zbox', name: 'Z-BOX Testovice, Hlavní 12 (Albert)', street: 'Hlavní 12', city: 'Testovice' }, events: [
      pk('2026-10-20 15:00', 'pre_transit', 'Zásilka byla podána.'),
      pk('2026-10-21 10:55', 'ready_for_pickup', 'Zásilka je připravena k vyzvednutí v Z-BOXu.'),
      pk('2026-10-27 11:56', 'delivered', 'Zásilka byla vyzvednuta.'),
    ] },
  [Z(5)]: { carrier: 'packeta', events: [pk('2026-10-20 06:00', 'in_transit', 'Zásielka je na ceste.')] },
  [Z(6)]: { carrier: 'packeta', events: [pk('2026-10-20 06:00', 'in_transit', 'Zásielka je na ceste.')] },
  [Z(7)]: { carrier: 'packeta', pickup: ZBOX_B, retainedTill: '2026-11-01 23:59', events: [
    pk('2026-10-23 10:00', 'pre_transit', 'Zásielka bola podaná odosielateľom.'),
    pk('2026-10-27 07:00', 'in_transit', 'Zásielka je na ceste.'),
    pk('2026-10-30 11:52', 'ready_for_pickup', 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.'),
  ] },
  [Z(8)]: { carrier: 'packeta', events: [pk('2026-10-23 14:30', 'pre_transit', 'Zásielka bola podaná odosielateľom.')] },
  [Z(10)]: { carrier: 'packeta', events: [pk('2026-10-27 08:00', 'pre_transit', 'Zásielka bola podaná odosielateľom.')] },
  [Z(11)]: { carrier: 'packeta', events: [pk('2026-10-23 12:00', 'in_transit', 'Zásielka je na ceste.')] },
  [Z(12)]: { carrier: 'packeta', events: [pk('2026-10-26 12:00', 'pre_transit', 'Zásielka bola podaná odosielateľom.')] },
  [Z(13)]: { carrier: 'packeta', pickup: ZBOX_B, retainedTill: '2026-11-01 23:59', events: [
    pk('2026-10-28 14:50', 'pre_transit', 'Zásielka bola podaná odosielateľom.'),
    pk('2026-10-30 12:55', 'ready_for_pickup', 'Zásielka bola uložená v Z-BOXe a čaká na vyzdvihnutie.'),
  ] },
  // DPD
  [DPD(1)]: { carrier: 'dpd', events: [
    { at: '2026-10-16 11:40', status: 'pre_transit', text: 'Údaje o zásielke boli prijaté', location: 'Testovo' },
    { at: '2026-10-16 19:02', status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' },
    { at: '2026-10-17 07:12', status: 'out_for_delivery', text: 'Kuriér doručuje', location: 'Testovo' },
    { at: '2026-10-17 10:48', status: 'delivered', text: 'Doručené', location: 'Testovo' },
  ] },
  [DPD(2)]: { carrier: 'dpd', retainedTill: '2026-10-27 23:59',
    pickup: { kind: 'locker', name: 'Pickup Station Testovo (OC Fiktív)', street: 'Hlavná 5', city: 'Testovo', postalCode: '99901' }, events: [
      { at: '2026-10-18 08:30', status: 'pre_transit', text: 'Údaje o zásielke boli prijaté', location: 'Bratislava' },
      { at: '2026-10-19 05:10', status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' },
      { at: '2026-10-24 08:41', status: 'ready_for_pickup', text: 'Uložené v Pickup Station', location: 'Testovo' },
      { at: '2026-10-27 09:33', status: 'delivered', text: 'Vyzdvihnuté v Pickup Station', location: 'Testovo' },
    ] },
  [DPD(3)]: { carrier: 'dpd', events: [
    { at: '2026-10-18 20:00', status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' },
    { at: '2026-10-19 06:50', status: 'out_for_delivery', text: 'Kuriér doručuje', location: 'Testovo' },
    { at: '2026-10-19 17:41', status: 'failed_attempt', text: 'Adresát nezastihnutý', location: 'Testovo' },
    { at: '2026-10-20 07:05', status: 'out_for_delivery', text: 'Kuriér doručuje', location: 'Testovo' },
    { at: '2026-10-20 11:47', status: 'delivered', text: 'Doručené', location: 'Testovo' },
  ] },
  [DPD(4)]: { carrier: 'dpd', events: [
    { at: '2026-10-21 07:30', status: 'out_for_delivery', text: 'Kuriér doručuje', location: 'Testovo' },
  ] },
  [DPD(5)]: { carrier: 'dpd', events: [{ at: '2026-10-24 11:00', status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' }] },
  [DPD(6)]: { carrier: 'dpd', events: [{ at: '2026-10-24 11:00', status: 'in_transit', text: 'Zásielka na ceste', location: 'Senec Hub' }] },
  // GLS
  [GLS(1)]: { carrier: 'gls', retainedTill: '2026-10-31 23:59', events: [   // ready WITHOUT a pickup point, as GLS's DELIVEREDPS answers
    { at: '2026-10-17 14:40', status: 'pre_transit', text: 'Údaje o balíku boli zaregistrované' },
    { at: '2026-10-18 05:20', status: 'in_transit', text: 'Balík je na ceste', location: 'Sered' },
    { at: '2026-10-18 10:52', status: 'ready_for_pickup', text: 'Balík bol doručený do GLS BOXu' },
  ] },
  [GLS(2)]: { carrier: 'gls', events: [
    { at: '2026-10-15 09:00', status: 'pre_transit', text: 'Údaje o balíku boli zaregistrované' },
    { at: '2026-10-16 06:10', status: 'out_for_delivery', text: 'Balík je na doručení' },
    { at: '2026-10-16 18:30', status: 'in_transit', text: 'Balík bol vrátený na depo – adresát požiadal o zmenu termínu', location: 'Testovo' },
    { at: '2026-10-28 12:40', status: 'delivered', text: 'Balík bol doručený' },
  ] },
  [GLS(3)]: { carrier: 'gls', events: [
    { at: '2026-10-24 15:30', status: 'pre_transit', text: 'Údaje o balíku boli zaregistrované' },
    { at: '2026-10-25 04:00', status: 'in_transit', text: 'Balík je na ceste', location: 'Sered' },
  ] },
  [GLS(4)]: { carrier: 'gls', events: [
    { at: '2026-09-24 07:00', status: 'out_for_delivery', text: 'Balík je na doručení' },
    { at: '2026-09-25 13:20', status: 'delivered', text: 'Balík bol doručený' },
  ] },
  // SPS
  SK0FAKE26TEST00001: { carrier: 'sps', retainedTill: '2026-10-23 18:00', pickup: { kind: 'parcelshop' }, events: [
    { at: '2026-10-15 14:00', status: 'pre_transit', text: 'Zásielka prevzatá od odosielateľa' },
    { at: '2026-10-16 05:00', status: 'in_transit', text: 'Zásielka na triediacom centre' },
    { at: '2026-10-20 14:50', status: 'ready_for_pickup', text: 'Zásielka v odbernom mieste' },
    { at: '2026-10-25 08:55', status: 'delivered', text: 'Zásielka vydaná príjemcovi' },
  ] },
  '7035555555555501': { carrier: 'sps', events: [
    { at: '2026-10-24 07:50', status: 'out_for_delivery', text: 'Zásielka na doručení' },
    { at: '2026-10-24 15:20', status: 'failed_attempt', text: 'Adresát nezastihnutý' },
    { at: '2026-10-30 09:50', status: 'delivered', text: 'Zásielka doručená' },
  ] },
  SK0FAKE26TEST00002: { carrier: 'sps', events: [
    { at: '2026-09-10 16:00', status: 'pre_transit', text: 'Zásielka prevzatá od odosielateľa' },
    { at: '2026-09-11 05:00', status: 'in_transit', text: 'Zásielka na triediacom centre' },
    { at: '2026-10-28 08:50', status: 'returning', text: 'Zásielka sa vracia odosielateľovi' },
  ] },
}

/** Posta numbers are computed (S10 check digit), so they are added by the harness from the corpus. */
export function addPosta(eb1: string, eb2: string): void {
  WORLD[eb1] = { carrier: 'posta', events: [
    { at: '2026-10-21 08:00', status: 'pre_transit', text: 'Podanie zásielky', location: 'Bratislava 1' },
    { at: '2026-10-21 22:00', status: 'in_transit', text: 'Zásielka na ceste', location: 'SPU Bratislava' },
    { at: '2026-10-22 16:40', status: 'ready_for_pickup', text: 'Uloženie zásielky na pošte', location: 'Testovo 1' },
    { at: '2026-10-29 08:50', status: 'delivered', text: 'Dodanie zásielky', location: 'Testovo 1' },
  ], pickup: { kind: 'post_office', name: 'Pošta Testovo 1', street: 'Poštová 1', city: 'Testovo', postalCode: '99901' }, retainedTill: '2026-11-05 18:00' }
  WORLD[eb2] = { carrier: 'posta', events: [
    { at: '2026-10-23 08:00', status: 'pre_transit', text: 'Podanie zásielky', location: 'Košice 1' },
    { at: '2026-10-24 09:40', status: 'ready_for_pickup', text: 'Uloženie zásielky v BalíkoBOXe', location: 'Testovo' },
  ], pickup: { kind: 'locker', name: 'BalíkoBOX Testovo – OD Prior', street: 'Hlavná 3', city: 'Testovo', postalCode: '99901' }, retainedTill: '2026-10-27 23:59' }
}

/** What the carrier answers for `number` at `now`. Unknown numbers (and numbers with no event yet) are `not_found`. */
export function answer(carrier: CarrierId, number: string, now: Date): FetchResult {
  const w = WORLD[number]
  if (!w || w.carrier !== carrier) return { ok: false, number, reason: 'not_found' }
  const seen = w.events.filter(e => local(e.at) <= now)
  if (seen.length === 0) return { ok: false, number, reason: 'not_found' }
  const latest = seen.at(-1)!
  const events: ParcelEvent[] = seen.map((e, i) => ({
    occurredAtRaw: e.at.replace(' ', 'T'), occurredAtTz: ZONE[carrier], occurredAt: local(e.at),
    status: PROSE_ONLY.has(carrier) && i !== seen.length - 1 ? 'unknown' : e.status,
    description: e.text, ...(e.location && { location: e.location }),
  }))
  const ready = latest.status === 'ready_for_pickup'
  return {
    ok: true, number, status: latest.status, statusRaw: latest.text, events,
    ...(ready && w.pickup && { pickup: { ...w.pickup } }),
    ...(ready && w.retainedTill && { retainedTill: local(w.retainedTill) }),
    raw: { fake: true, number, events: seen.length },
  }
}
