import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import type { Config } from '../core/config.js'

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
 * The part of an IMAP client this module is allowed to use. It deliberately has NO way to write
 * anything: no flag, move, copy, delete, append or expunge. The ingest reads the user's personal
 * mailbox, so a write method on this interface would be a defect by construction.
 */
export interface ImapLike {
  on(event: 'error', listener: (err: Error) => void): unknown
  connect(): Promise<unknown>
  getMailboxLock(path: string, options: { readOnly: boolean }): Promise<{ release(): void }>
  fetch(range: string, query: { uid: true; envelope: true; internalDate: true; size: true }): AsyncIterable<EnvelopeMessage>
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

/** A message with no Message-ID still needs a stable key, or it would be stored again every run. */
function syntheticId(m: EnvelopeMessage, from: string, mailbox: string): string {
  const basis = [m.uid, from, m.envelope?.subject ?? '', asDate(m.envelope?.date)?.toISOString() ?? ''].join('\n')
  return `<no-id-${createHash('sha256').update(basis).digest('hex').slice(0, 24)}@${mailbox}>`
}

/**
 * Reads every message in the configured mailbox (a Gmail label) that is not already `known`.
 *
 * STRICTLY READ-ONLY. The mailbox is opened with EXAMINE (`readOnly: true`), bodies are fetched with
 * BODY.PEEK, and nothing is ever flagged, moved or deleted; the client type has no such methods.
 * There is no UNSEEN filter and no "mark seen" step: deduplication is the `messages.message_id`
 * UNIQUE constraint, so the user's read/unread state is never touched.
 *
 * Envelopes come first and the bodies of unknown messages after, because a client cannot issue a
 * second command while a fetch is still streaming. A failure at any point rejects, after releasing
 * the lock and closing the connection.
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
      const envelopes: EnvelopeMessage[] = []
      for await (const m of client.fetch('1:*', { uid: true, envelope: true, internalDate: true, size: true })) {
        envelopes.push(m)
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
      return out
    } finally {
      lock.release()
    }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
