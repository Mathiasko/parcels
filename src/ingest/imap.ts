import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import type { Config } from '../core/config.js'
import type { ImapState } from '../db/imap-state.js'

export type ImapConfig = NonNullable<Config['imap']>

export interface RawMessage {
  messageId: string
  from: string
  subject: string
  /** The message's own Date header (falling back to the server's arrival time). */
  receivedAt: Date
  raw: Buffer
  /** Over the size cap: the body was never downloaded and `raw` is empty. */
  oversize?: boolean
}

/**
 * What the server said about the mailbox when it selected it, read as a property rather than fetched:
 * every field of it comes from the SELECT/EXAMINE response, so it costs nothing and reads no message.
 *
 * `uidValidity` and `uidNext` are optional because a server is not obliged to volunteer them (and
 * imapflow reports UIDVALIDITY as a BigInt), and the ingest must work without them.
 */
export interface MailboxInfo {
  path: string
  exists: number
  uidValidity?: number | bigint | string
  uidNext?: number
}

/**
 * The part of an IMAP client this module is allowed to use. It deliberately has NO way to write
 * anything: no flag, move, copy, delete, append or expunge. The ingest reads the user's personal
 * mailbox, so a write method on this interface would be a defect by construction.
 */
export interface ImapLike {
  readonly mailbox: MailboxInfo | false
  on(event: 'error', listener: (err: Error) => void): unknown
  connect(): Promise<unknown>
  getMailboxLock(path: string, options: { readOnly: boolean }): Promise<{ release(): void }>
  fetch(
    range: string,
    query: { uid: true; envelope: true; internalDate: true; size: true },
    options: { uid: true },
  ): AsyncIterable<EnvelopeMessage>
  fetchOne(uid: number, query: { source: true }, options: { uid: true }): Promise<{ source?: Buffer } | false>
  logout(): Promise<unknown>
  close(): void
}

interface EnvelopeMessage {
  uid: number
  size?: number
  internalDate?: Date | string
  envelope?: {
    messageId?: string
    subject?: string
    date?: Date | string
    from?: Array<{ address?: string }>
  }
}

export interface FetchDeps {
  config: ImapConfig
  /** Injected in tests; production builds an `ImapFlow`. */
  client?: ImapLike
  /** Message-IDs already stored: their bodies are not downloaded again. */
  known?: (messageId: string) => boolean
  /** Messages larger than this are reported as `oversize` and not downloaded. */
  maxBytes?: number
  /**
   * Where the previous completed run got to in this mailbox. Absent (or stale: a different
   * UIDVALIDITY) means the mailbox is read in full, exactly as it was before any state was kept.
   */
  state?: ImapState
  /**
   * Called ONCE, with the point a later run may resume from, and only after this pass has read every
   * envelope and every body it wanted without throwing. Not called at all when the server did not say
   * what its UIDVALIDITY is, because then there is no promise to resume against.
   *
   * It reports rather than persists, because a caller knows something this function cannot: whether
   * the messages were actually stored. A message that failed to store has no row, is not `known`, and
   * must stay inside the next run's range - see `ingestMessages`.
   */
  onScanned?: (state: ImapState) => void
}

export const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024

function createClient(c: ImapConfig): ImapLike {
  return new ImapFlow({
    host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false,
  }) as unknown as ImapLike
}

const asDate = (v: Date | string | undefined): Date | undefined => {
  const d = v === undefined ? undefined : new Date(v)
  return d && !Number.isNaN(d.getTime()) ? d : undefined
}

/**
 * The later of the Date header (set by the sender, so arbitrary) and INTERNALDATE (set by the server on
 * arrival). A bogus-old Date header must not make a fresh parcel look three years old and archive it
 * unseen; a bogus-future one only makes a parcel look newer, which is the safe direction.
 */
export function receivedAt(header: Date | undefined, arrival: Date | undefined): Date {
  if (header && arrival) return header > arrival ? header : arrival
  return header ?? arrival ?? new Date()
}

/**
 * The server's UIDVALIDITY as comparable text, or `undefined` when there is nothing to compare.
 *
 * Zero is treated as absent on purpose: RFC 9051 requires UIDVALIDITY to be non-zero, so a 0 is a
 * server that is not making the promise, and resuming against it would be resuming against nothing.
 */
function uidValidityOf(box: MailboxInfo | false): string | undefined {
  if (box === false || box.uidValidity === undefined || box.uidValidity === null) return undefined
  const text = String(box.uidValidity)
  return /^[1-9][0-9]*$/.test(text) ? text : undefined
}

/**
 * Whether the server has already told us there is nothing to fetch, so the FETCH is not issued at all.
 *
 * This is the only answer that is the same on every server. A UID range matching nothing is legal and
 * should come back empty, but `<lastUid+1>:*` is the set between that UID and the mailbox's highest,
 * so some servers answer it with their highest message, and others refuse the range outright. Not
 * asking avoids both. EXISTS and UIDNEXT both come from the EXAMINE response, so this costs nothing.
 */
function nothingToFetch(box: MailboxInfo | false, from: number): boolean {
  if (box === false) return false                                  // a server that said nothing: ask.
  if (box.exists === 0) return true                                // an empty mailbox, on any server.
  if (from <= 1) return false                                      // a full scan is never "nothing".
  const next = Number(box.uidNext)
  return Number.isFinite(next) && next > 0 && from >= next
}

/** The properties imapflow attaches to a tagged NO/BAD, which is how a refused range arrives. */
interface RefusalShape { message?: unknown; responseText?: unknown; responseStatus?: unknown }

/**
 * A server refusing the SHAPE of the range, rather than failing to answer it. Some IMAP servers answer
 * a UID set that matches nothing with `BAD Invalid messageset` instead of an empty result.
 *
 * Deliberately narrow, and only ever consulted for an incremental range that yielded nothing: a
 * broader rule would let a dead connection read as "no new mail" for ever, which is exactly the silent
 * failure keeping IMAP state is supposed to avoid. Anything else still rejects.
 */
function isEmptySetRefusal(err: unknown): boolean {
  const e = (err ?? {}) as RefusalShape
  const text = [e.responseText, e.message].filter(v => typeof v === 'string').join(' ')
  return /invalid (?:message ?set|uid ?set|uid range|sequence|set)|bad message ?set|no matching messages/i.test(text)
}

/** A message with no Message-ID still needs a stable key, or it would be stored again every run. */
function syntheticId(m: EnvelopeMessage, from: string, mailbox: string): string {
  const basis = [m.uid, from, m.envelope?.subject ?? '', asDate(m.envelope?.date)?.toISOString() ?? ''].join('\n')
  return `<no-id-${createHash('sha256').update(basis).digest('hex').slice(0, 24)}@${mailbox}>`
}

/**
 * Reads the messages in the configured mailbox (a Gmail label) that this run has not seen, and that
 * are not already `known`.
 *
 * INCREMENTAL. Given the `state` a previous run reported, only UIDs above its watermark are enveloped:
 * `<lastUid+1>:*` rather than `1:*`, so the run costs what arrived rather than what the label holds.
 * Three things make that safe:
 *
 *   - **UIDVALIDITY.** A stored UID only means anything while the server reports the same UIDVALIDITY.
 *     If it changed (or the server will not say), the watermark is ignored and the mailbox is read in
 *     full, which is also what the very first run does.
 *   - **Message-ID dedupe is untouched.** The range is an optimisation; `known` still decides what is
 *     downloaded, and `messages.message_id` is still UNIQUE. A message inside the range that is
 *     already stored costs an envelope and no body.
 *   - **Retroactive labels still arrive.** Gmail gives a message a new, higher UID when a label is
 *     applied to it, so old mail that has just been labelled appears ABOVE the watermark, not below.
 *
 * STRICTLY READ-ONLY. The mailbox is opened with EXAMINE (`readOnly: true`), bodies are fetched with
 * BODY.PEEK, and nothing is ever flagged, moved or deleted; the client type has no such methods.
 * There is no UNSEEN filter and no "mark seen" step: deduplication is the `messages.message_id`
 * UNIQUE constraint, so the user's read/unread state is never touched.
 *
 * Envelopes come first and the bodies of unknown messages after, because a client cannot issue a
 * second command while a fetch is still streaming. A failure at any point rejects, after releasing
 * the lock and closing the connection - and without reporting a resume point, so a run that died
 * half way cannot make the next one skip the mail it never read.
 */
export async function fetchMessages(deps: FetchDeps): Promise<RawMessage[]> {
  const { config } = deps
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const client = deps.client ?? createClient(config)
  // An unhandled 'error' event would crash the process; the rejection from the pending call carries it.
  client.on('error', () => undefined)

  await client.connect()
  try {
    const lock = await client.getMailboxLock(config.mailbox, { readOnly: true })
    try {
      const uidValidity = uidValidityOf(client.mailbox)
      // The watermark counts for nothing unless the server still vouches for the numbering it was
      // taken from. Same promise -> resume; changed, or never made -> read the mailbox in full.
      const resume = uidValidity !== undefined && deps.state?.uidValidity === uidValidity ? deps.state : undefined
      const fromUid = resume ? resume.lastUid + 1 : 1

      const envelopes: EnvelopeMessage[] = []
      if (!nothingToFetch(client.mailbox, fromUid)) {
        try {
          for await (const m of client.fetch(
            fromUid <= 1 ? '1:*' : `${fromUid}:*`,
            { uid: true, envelope: true, internalDate: true, size: true },
            { uid: true },
          )) {
            // Belt and braces for the server that answers a range matching nothing with its highest
            // message anyway: below the watermark is, by definition, already seen.
            if (m.uid >= fromUid) envelopes.push(m)
          }
        } catch (err) {
          // Nothing came back and the server objected to the range itself: there is no new mail, which
          // is not a failure. Any other error, or any error after a message HAS arrived, still rejects.
          if (!(fromUid > 1 && envelopes.length === 0 && isEmptySetRefusal(err))) throw err
        }
      }

      const out: RawMessage[] = []
      for (const m of envelopes) {
        const from = m.envelope?.from?.[0]?.address ?? ''
        const messageId = m.envelope?.messageId || syntheticId(m, from, config.mailbox)
        if (deps.known?.(messageId)) continue
        const base = {
          messageId, from, subject: m.envelope?.subject ?? '',
          receivedAt: receivedAt(asDate(m.envelope?.date), asDate(m.internalDate)),
        }
        if ((m.size ?? 0) > maxBytes) {
          out.push({ ...base, raw: Buffer.alloc(0), oversize: true })
          continue
        }
        const full = await client.fetchOne(m.uid, { source: true }, { uid: true })
        if (full && full.source) out.push({ ...base, raw: full.source })
      }

      // Reached only by a pass that read everything it meant to. The watermark never goes backwards:
      // a run that found nothing new keeps the one it resumed from.
      if (uidValidity !== undefined) {
        deps.onScanned?.({
          uidValidity,
          lastUid: envelopes.reduce((hi, m) => Math.max(hi, m.uid), resume?.lastUid ?? 0),
        })
      }
      return out
    } finally {
      lock.release()
    }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
