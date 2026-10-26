import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
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
