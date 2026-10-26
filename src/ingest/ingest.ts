import { readFileSync } from 'node:fs'
import type { Database } from '../db/index.js'
import type { CarrierAdapter } from '../core/types.js'
import { findParcel, insertParcel, setArchived } from '../db/parcels.js'
import { storeMessage } from '../db/messages.js'
import { extract, type Extraction } from './extract.js'
import { fetchMessages, type FetchDeps, type ImapConfig, type RawMessage } from './imap.js'

/** Mail older than this creates its parcel already archived: in the database, never polled. */
export const ARCHIVE_AFTER_DAYS = 30
const DAY = 86_400_000

export interface ReprocessDeps {
  now: Date
  adapters: CarrierAdapter[]
  defaultPostalCode: string
}

export interface IngestDeps extends ReprocessDeps {
  imap: ImapConfig
  /** Where raw .eml files are written (`<id>.eml`). */
  mailDir: string
  client?: FetchDeps['client']
  maxBytes?: number
}

export interface IngestReport {
  /** Messages new to the database this run (the label is re-read in full; known ones are skipped). */
  read: number
  /** Parcels created. */
  created: number
  /** Messages attached to a parcel that already existed. */
  linked: number
  /** Of `created`, how many were archived on arrival because the mail was old. */
  archivedOld: number
  /** Messages that yielded no parcel and now wait in the web UI's needs-attention list. */
  needsAttention: number
  /** Messages that threw while being stored or placed; rolled back whole, so the next run fetches them again. */
  failed: number
  /** Set (with every count at zero) when the mailbox could not be read at all. */
  error?: string
}

const emptyReport = (): IngestReport => ({ read: 0, created: 0, linked: 0, archivedOld: 0, needsAttention: 0, failed: 0 })

interface Item {
  /** `messages.id`; 0 until `place`'s `store` step has run for a message that is not stored yet. */
  id: number
  receivedAt: Date
  oversize?: boolean
  extraction: Extraction
}

const keyOf = (e: Extraction) => `${e.carrier}:${e.number}`

/**
 * Reads the mailbox label (read-only: see `fetchMessages`), stores each new message and its raw .eml,
 * and turns the ones that name a parcel into parcels. Mail that does not yield a tracking number is
 * kept, unassigned, for the needs-attention page; nothing is dropped and nothing is guessed.
 *
 * A failure to reach the mailbox rejects; a failure on one message does not stop the others.
 */
export async function ingestMessages(db: Database, deps: IngestDeps): Promise<IngestReport> {
  const known = new Set((db.prepare('SELECT message_id FROM messages').all() as Array<{ message_id: string }>).map(r => r.message_id))
  const raws = await fetchMessages({
    config: deps.imap, client: deps.client, maxBytes: deps.maxBytes, known: id => known.has(id),
  })

  const items: Array<Item & { raw: RawMessage }> = await Promise.all(raws.map(async raw => ({
    raw, id: 0, receivedAt: raw.receivedAt, oversize: raw.oversize,
    extraction: raw.oversize ? { confidence: 'none' as const } : await extract(raw.raw),
  })))

  const report = { ...emptyReport(), read: raws.length }
  place(db, items, deps, report, it => { it.id = storeMessage(db, it.raw, deps.mailDir) })
  return report
}

/**
 * Re-runs extraction over messages that are stored but still unassigned, from the .eml on disk: after
 * a parser fix the mail does not need to still exist upstream, and IMAP is not touched.
 */
export async function reprocessMessages(db: Database, deps: ReprocessDeps): Promise<IngestReport> {
  const rows = db.prepare(`
    SELECT id, received_at, raw_path FROM messages
    WHERE parsed_ok = 0 AND parcel_id IS NULL AND raw_path IS NOT NULL ORDER BY received_at, id
  `).all() as Array<{ id: number; received_at: string; raw_path: string }>

  const items: Item[] = []
  for (const r of rows) {
    let buf: Buffer
    try { buf = readFileSync(r.raw_path) } catch { continue }   // file gone: it stays in needs-attention as it was
    items.push({ id: r.id, receivedAt: new Date(r.received_at), extraction: await extract(buf) })
  }
  const report = { ...emptyReport(), read: items.length }
  place(db, items, deps, report)
  return report
}

/**
 * Turns each extracted item into a parcel, a link to an existing parcel, or a needs-attention note.
 *
 * Each message is ONE unit: `store` (if it is not stored yet) and the placement share a transaction, so
 * a throw in either (disk full, EACCES on the mail directory, SQLITE_BUSY) rolls that message back
 * whole. It then has no row, is not `known`, and the next run fetches and places it again, instead of
 * being stranded as stored-but-unplaced. The other messages in the batch are unaffected.
 */
function place<T extends Item>(
  db: Database, items: T[], deps: ReprocessDeps, report: IngestReport, store?: (it: T) => void,
): void {
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id - b.id)

  // A parcel is "old" by its NEWEST mail in this batch, not its first: a parcel announced 45 days ago
  // that was updated 2 days ago is still live.
  const newest = new Map<string, number>()
  for (const it of items) {
    if (it.extraction.number) newest.set(keyOf(it.extraction), Math.max(newest.get(keyOf(it.extraction)) ?? 0, it.receivedAt.getTime()))
  }

  for (const it of items) {
    const counts = emptyReport()
    try {
      db.transaction(() => {
        store?.(it)
        placeOne(db, it, deps, counts, newest)
      })()
    } catch (err) {
      report.failed++
      console.error(`ingest: message ${it.id || '(unstored)'} failed and will be retried: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // Counted only once the message's transaction has committed.
    report.created += counts.created
    report.linked += counts.linked
    report.archivedOld += counts.archivedOld
    report.needsAttention += counts.needsAttention
  }
}

function placeOne(db: Database, it: Item, deps: ReprocessDeps, report: IngestReport, newest: Map<string, number>): void {
  const { carrier, number, merchant } = it.extraction
  const note = (text: string) => db.prepare('UPDATE messages SET parse_note = ? WHERE id = ?').run(text, it.id)
  const link = (parcelId: number, text: string | null) =>
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ?, parse_note = ? WHERE id = ?').run(parcelId, text, it.id)

  if (it.oversize) { report.needsAttention++; return }   // storeMessage already noted it
  if (!carrier || !number) {
    note('no tracking number found in this message')
    report.needsAttention++
    return
  }
  if (!deps.adapters.some(a => a.id === carrier)) {
    note(`found ${carrier} number ${number} but no adapter registered for ${carrier}`)
    report.needsAttention++
    return
  }
  const existing = findParcel(db, carrier, number)
  if (existing) {
    // A later mail may name the sender when the first one did not.
    if (merchant && !existing.merchant) db.prepare('UPDATE parcels SET merchant = ? WHERE id = ?').run(merchant, existing.id)
    link(existing.id, null)
    report.linked++
    return
  }
  const row = db.prepare('SELECT message_id FROM messages WHERE id = ?').get(it.id) as { message_id: string }
  const old = deps.now.getTime() - newest.get(keyOf(it.extraction))! > ARCHIVE_AFTER_DAYS * DAY
  const id = insertParcel(db, {
    carrier, trackingNumber: number, merchant, postalCode: deps.defaultPostalCode,
    source: 'email', sourceMessageId: row.message_id,
    // An archived-on-arrival parcel is first seen when its mail was, so history sorts by that.
    // Its status stays 'unknown': status never comes from mail.
    ...(old && { firstSeenAt: it.receivedAt }),
  })
  if (old) {
    setArchived(db, id, deps.now)
    report.archivedOld++
  }
  link(id, old ? `parcel archived on arrival: mail older than ${ARCHIVE_AFTER_DAYS} days` : null)
  report.created++
}
