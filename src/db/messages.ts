import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './index.js'
import type { RawMessage } from '../ingest/imap.js'

/**
 * Stores one message and returns its row id; storing the same Message-ID again returns the same
 * row and changes nothing (a re-sent or re-forwarded mail is one message).
 *
 * The raw `.eml` goes to `<dir>/<id>.eml`, written to a temp name and renamed so a crash never
 * leaves a truncated file. The insert and the write are one unit: if the write throws, the row is
 * rolled back, so the message is simply fetched again on the next run. A message over the size
 * cap has no body to write: it is recorded as unparsed with a note, and shows up in needs-attention.
 */
export function storeMessage(db: Database, m: RawMessage, dir: string): number {
  return db.transaction((): number => {
    const info = db.prepare(`
      INSERT INTO messages (message_id, received_at, from_addr, subject, parsed_ok, parse_note)
      VALUES (@messageId, @receivedAt, @from, @subject, 0, @note)
      ON CONFLICT (message_id) DO NOTHING
    `).run({
      messageId: m.messageId,
      receivedAt: m.receivedAt.toISOString(),
      from: m.from,
      subject: m.subject,
      note: m.oversize ? 'message exceeds the size cap and was not downloaded' : null,
    })
    if (info.changes === 0) {
      return (db.prepare('SELECT id FROM messages WHERE message_id = ?').get(m.messageId) as { id: number }).id
    }
    const id = Number(info.lastInsertRowid)
    if (!m.oversize) {
      // Full personal mail (pickup PINs included): owner-only, like config.json.
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${id}.eml`)
      writeFileSync(`${path}.tmp`, m.raw, { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
      db.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(path, id)
    }
    return id
  })()
}

/**
 * What "still waiting on /attention" means, in SQL. The attention list and `reprocess` both select on
 * it, so a message that no longer matches it is off the page and out of every future reprocess run.
 */
const PENDING = 'parsed_ok = 0 AND parcel_id IS NULL'

/**
 * Throws away the stored copy of a message that will never be read again.
 *
 * A dismissed message is never reprocessed (`reprocessMessages` selects `parsed_ok = 0 AND parcel_id
 * IS NULL`) and never scanned for a pickup code (that reads only mail linked to a parcel), so its
 * `.eml` is dead weight - and it is the bulk of it: on the author's machine 132 MB of the 139 MB in
 * `data/mail` belonged to mail waiting on /attention, almost all newsletters.
 *
 * Deleted AFTER the row has been committed with `raw_path = NULL`, so nothing can ever hold a path to
 * a file that is not there; the reverse order would risk the opposite. A failure to unlink therefore
 * leaks an unreferenced file rather than breaking anything, and is reported but not raised: a
 * permissions problem in the mail directory must not turn a dismissal into a 500.
 */
function discard(path: string): void {
  try {
    rmSync(path, { force: true })   // force: already gone is the expected case, not an error
  } catch (err) {
    console.error(`messages: could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Throws away stored `.eml` files whose rows no longer point at them. See `discard`. */
export function discardRaw(paths: string[]): void {
  for (const path of paths) discard(path)
}

/**
 * Unlinks a deleted parcel's mail from it, and returns the `.eml` paths that nothing references any
 * more, for the caller to hand to `discardRaw` once its transaction has committed.
 *
 * The rows are NOT deleted, and that is load-bearing twice over:
 *   - the ingest dedupes by Message-ID against this table, so deleting them would make the next poll
 *     re-ingest the same mail and RECREATE the parcel that was just deleted;
 *   - `parsed_ok = 1` (not 0) keeps the orphaned mail off /attention, because deleting a parcel must
 *     not dump its emails into the attention queue as fresh alerts.
 *
 * The stored files DO go, for the same reason a dismissal's do: this state - `parsed_ok = 1` with no
 * parcel - is matched by no reader. `reprocessMessages` selects on `PENDING` (`parsed_ok = 0 AND
 * parcel_id IS NULL`) and the pickup-code scan reads only mail still linked to a parcel, so the
 * bytes are dead weight, and mail is the bulk of what this app keeps on disk. Writing `raw_path =
 * NULL` in the same statement is what keeps a path from ever outliving its file.
 */
export function orphanParcelMessages(db: Database, parcelId: number): string[] {
  const rows = db.prepare('SELECT raw_path FROM messages WHERE parcel_id = ? AND raw_path IS NOT NULL')
    .all(parcelId) as Array<{ raw_path: string }>
  db.prepare(
    "UPDATE messages SET parcel_id = NULL, parsed_ok = 1, parse_note = 'Parcel deleted; email discarded', raw_path = NULL WHERE parcel_id = ?",
  ).run(parcelId)
  return rows.map(r => r.raw_path)
}

/**
 * Dismisses a message the ingest could not place: junk mail (a verification notice with no tracking
 * number) that would otherwise sit on /attention as a permanent false alert.
 *
 * Dismissing is `parsed_ok = 1` with `parcel_id` still NULL, so it leaves the page AND every future
 * reprocess run, with no schema change; the assign path already writes the same column the same way.
 * The row itself is never deleted - it is the Message-ID dedupe key, and deleting it would let the
 * next mail check ingest the same junk again - but its stored `.eml` is deleted and `raw_path`
 * cleared, because nothing will ever read it again (see `discard`).
 *
 * The predicate is repeated in the WHERE so a second dismiss, or one aimed at a message that has since
 * been assigned, changes nothing. Returns whether this call was the one that dismissed it.
 */
export function dismissMessage(db: Database, id: number): boolean {
  return dismissed(db, 'id = ?', [id]) > 0
}

/** Which messages a bulk dismissal covers. */
export interface BulkDismissal {
  /**
   * Only messages at or below this row id - the newest the page listed. Mail ingested between the
   * page being rendered and the button being pressed gets a higher id, so it survives: a bulk action
   * clears exactly the queue the person was looking at, never a message they have not seen.
   */
  upTo: number
  /**
   * Only this sender, matched exactly as stored. Absent clears everything listed.
   *
   * Exact address, not domain: the queue's biggest senders are single addresses (one newsletter each),
   * while a domain can hold unrelated people - `laco.matus@gmail.com` and `maruska.magalova@gmail.com`
   * are both "gmail.com", and lumping them together would make one button dismiss someone else's mail.
   */
  from?: string
}

/**
 * Dismisses a whole queue at once, and returns how many it dismissed.
 *
 * 662 items cannot be cleared one at a time, which is what this exists for. Every row is dismissed in
 * ONE transaction (so the page's count and what happened cannot disagree), and the `.eml` files go
 * afterwards, outside it, for the reason `discard` explains.
 */
export function dismissMessages(db: Database, sel: BulkDismissal): number {
  const where = sel.from === undefined ? 'id <= ?' : 'id <= ? AND from_addr = ?'
  const params = sel.from === undefined ? [sel.upTo] : [sel.upTo, sel.from]
  return dismissed(db, where, params)
}

/**
 * The one way a message is dismissed: mark the rows, then delete their files. `PENDING` is part of
 * the UPDATE as well as of the SELECT, so a row that stopped being pending in between is not touched
 * and its file is not deleted.
 */
function dismissed(db: Database, where: string, params: unknown[]): number {
  const rows = db.prepare(`SELECT id, raw_path FROM messages WHERE ${PENDING} AND ${where}`)
    .all(...params) as Array<{ id: number; raw_path: string | null }>
  if (rows.length === 0) return 0

  const update = db.prepare(
    `UPDATE messages SET parsed_ok = 1, parse_note = 'Dismissed', raw_path = NULL WHERE id = ? AND ${PENDING}`,
  )
  const done = db.transaction((): Array<{ id: number; raw_path: string | null }> =>
    rows.filter(r => update.run(r.id).changes > 0))()

  for (const r of done) if (r.raw_path !== null) discard(r.raw_path)
  return done.length
}
