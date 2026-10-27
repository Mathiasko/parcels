import type { Database } from './index.js'

/**
 * How far a mailbox has been read, and the server's promise that saying so means anything.
 *
 * `uidValidity` is carried as a string: UIDVALIDITY is an unsigned 32-bit number that imapflow hands
 * over as a BigInt, and comparing the decimal text of it cannot lose a digit, round one, or depend on
 * whether the value arrived as a number, a BigInt or a string.
 */
export interface ImapState {
  uidValidity: string
  /** The highest UID a completed run has read AND stored. Messages above it have never been seen. */
  lastUid: number
}

/**
 * Whose UIDs these are. UIDs are only meaningful inside one mailbox on one account, so the same label
 * name reached through a different login is a different mailbox: resuming one from the other's
 * watermark would silently skip everything in it. The password is deliberately not part of the key -
 * rotating an App Password does not renumber anything.
 */
export const accountKey = (c: { host: string; port: number; user: string }): string =>
  `${c.user} ${c.host}:${c.port}`

interface Row { uid_validity: string; last_uid: number }

export function getImapState(db: Database, account: string, mailbox: string): ImapState | undefined {
  const r = db.prepare(
    'SELECT uid_validity, last_uid FROM imap_state WHERE account = ? AND mailbox = ?',
  ).get(account, mailbox) as Row | undefined
  return r && { uidValidity: r.uid_validity, lastUid: r.last_uid }
}

/**
 * Records where a SUCCESSFUL pass got to. Called only by a run that read its whole range and stored
 * every message in it, because a message with no row is not `known` and must stay inside the next
 * run's range or it is lost; `ingestMessages` is where that is decided.
 *
 * A new UIDVALIDITY replaces the row outright: the old UID is not comparable to the new one, so
 * keeping the higher of the two would be meaningless arithmetic over two different numberings.
 */
export function saveImapState(db: Database, account: string, mailbox: string, state: ImapState, now: Date): void {
  db.prepare(`
    INSERT INTO imap_state (account, mailbox, uid_validity, last_uid, updated_at)
    VALUES (@account, @mailbox, @uidValidity, @lastUid, @now)
    ON CONFLICT (account, mailbox) DO UPDATE SET
      uid_validity = @uidValidity, last_uid = @lastUid, updated_at = @now
  `).run({ account, mailbox, uidValidity: state.uidValidity, lastUid: state.lastUid, now: now.toISOString() })
}
