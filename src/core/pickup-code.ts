import { readFileSync } from 'node:fs'
import { simpleParser } from 'mailparser'
import type { Database } from '../db/index.js'
import { listActive } from '../db/parcels.js'
import { needsPickupCodeCheck, recordPickupCode } from '../db/pickup-codes.js'
import { extractPickupCode, htmlToText } from '../ingest/extract.js'

export interface PickupCodeDeps {
  db: Database
  now: Date
  /** Injectable for tests; defaults to reading the stored .eml off disk. */
  readMail?: (path: string) => Buffer
}

export interface PickupCodeReport { scanned: number; found: number }

const MAX_HTML = 1_000_000

/**
 * Fills in Z-BOX opening codes by re-reading the parcel's own stored mail.
 *
 * This runs during a poll and touches no network: the code is already on disk, in mail ingested
 * whenever the carrier sent it. Reading it here rather than at ingest time is what makes historical
 * mail work - a parcel whose pickup email arrived days before this feature existed gets its code on
 * the next poll, with no backfill command to remember to run.
 */
export async function runPickupCodes(deps: PickupCodeDeps): Promise<PickupCodeReport> {
  const { db, now } = deps
  const read = deps.readMail ?? readFileSync
  const report: PickupCodeReport = { scanned: 0, found: 0 }

  for (const parcel of listActive(db)) {
    if (parcel.status !== 'ready_for_pickup') continue
    const mails = db.prepare(
      'SELECT raw_path FROM messages WHERE parcel_id = ? AND raw_path IS NOT NULL ORDER BY received_at DESC, id DESC',
    ).all(parcel.id) as { raw_path: string }[]
    if (!needsPickupCodeCheck(db, parcel.id, mails.length)) continue

    report.scanned++
    let code: string | undefined
    for (const m of mails) {
      let text: string
      try {
        const mail = await simpleParser(read(m.raw_path))
        text = mail.text || (typeof mail.html === 'string' ? htmlToText(mail.html.slice(0, MAX_HTML)) : '')
      } catch {
        continue   // an unreadable file must not stop the parcel's other mail being tried
      }
      code = extractPickupCode(text)
      if (code) break
    }
    if (code) report.found++
    recordPickupCode(db, parcel.id, code, mails.length, now)
  }
  return report
}
