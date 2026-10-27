import type { ImapProbeLike } from '../src/ingest/imap-probe.js'

export interface FakeMessage {
  uid: number
  messageId?: string
  subject?: string
  from?: string
  date?: Date
  /** The server's arrival time (INTERNALDATE); defaults to `date`. */
  internalDate?: Date
  source?: Buffer
  /** Reported size; defaults to the source length. */
  size?: number
}

/** Everything the production code is allowed to ask of a mailbox. Anything else is a write. */
const READ_ONLY_CALLS = new Set(['on', 'connect', 'getMailboxLock', 'fetch', 'fetchOne', 'logout', 'close'])

/**
 * State the code reads as a property rather than calling: the selected mailbox, as the server
 * reported it on SELECT/EXAMINE. Reading it cannot change anything, so it belongs on the allowed
 * side of the line - but it is listed separately so the set above keeps meaning "calls".
 */
const READ_ONLY_PROPS = new Set(['mailbox'])

export interface FakeImap {
  client: ImapProbeLike
  /** Every method the code touched, in order, including forbidden ones. */
  calls: string[]
  locks: Array<{ path: string; readOnly: boolean; released: boolean }>
  /** Forbidden calls (flag writes, moves, deletes, searches that imply UNSEEN, ...). */
  forbidden: string[]
  /** Every envelope FETCH the code issued: the range it asked for, and whether it was a UID range. */
  fetches: Array<{ range: string; uid: boolean }>
  /** UIDs whose full source was downloaded. */
  downloaded: number[]
  loggedOut: () => boolean
}

/** The default UIDVALIDITY: a distinctive value, so a test that asserts on it cannot be reading a 1. */
export const UID_VALIDITY = 9001

/**
 * Which messages a UID range selects. Only the `a:*` form the ingest uses is implemented; anything
 * else (and a sequence-number fetch, which is what no `{ uid: true }` means) selects everything, as
 * `1:*` does.
 */
function selectRange(messages: FakeMessage[], range: string, uidMode: boolean): FakeMessage[] {
  const m = uidMode ? /^(\d+):\*$/.exec(range) : null
  if (!m) return messages
  return messages.filter(x => x.uid >= Number(m[1]))
}

/**
 * A mailbox that records every call and THROWS on anything outside the read-only set, so an
 * implementation that stores a flag, moves or deletes fails the test at the call site (and again at
 * the `forbidden` assertion if the implementation swallows the throw).
 */
export function fakeImap(
  messages: FakeMessage[],
  opts: {
    connectError?: Error
    fetchError?: Error
    /** Thrown by `getMailboxLock`: a mailbox that cannot be selected (missing, or no permission). */
    lockError?: Error
    /** EXISTS as the server would report it; defaults to the number of messages given. */
    exists?: number
    /** A server that selects the mailbox but reports nothing about it. */
    noMailboxObject?: boolean
    /**
     * UIDVALIDITY as the server reports it (imapflow hands it over as a BigInt, hence the type).
     * `null` is a server that selects the mailbox and says nothing about UIDVALIDITY.
     */
    uidValidity?: number | bigint | string | null
    /** UIDNEXT; defaults to one above the highest UID given. `null` is a server that omits it. */
    uidNext?: number | null
    /**
     * A server that answers a UID range matching nothing with its highest message anyway: `12:*` is
     * the set {12..highest}, which several servers read as containing the highest message.
     */
    emptyRangeYieldsHighest?: boolean
    /** A server that refuses a UID range matching nothing instead of answering it with nothing. */
    emptyRangeError?: Error
    /** A server that ignores the range it was given and answers with the whole mailbox. */
    ignoresRange?: boolean
    /** Thrown mid-stream, AFTER this many envelopes have been handed over. */
    fetchErrorAfter?: { count: number; error: Error }
    /** Thrown when a body is downloaded: the connection dying between envelopes and sources. */
    fetchOneError?: Error
  } = {},
): FakeImap {
  const calls: string[] = []
  const forbidden: string[] = []
  const locks: FakeImap['locks'] = []
  const fetches: FakeImap['fetches'] = []
  const downloaded: number[] = []
  let out = false

  const highest = messages.reduce((hi, m) => Math.max(hi, m.uid), 0)
  const validity = opts.uidValidity === undefined ? UID_VALIDITY : opts.uidValidity
  const uidNext = opts.uidNext === undefined ? highest + 1 : opts.uidNext

  const impl = {
    mailbox: false as { path: string; exists: number; uidValidity?: number | bigint | string; uidNext?: number } | false,
    on: () => impl,
    async connect() {
      if (opts.connectError) throw opts.connectError
    },
    async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
      if (opts.lockError) throw opts.lockError
      const lock = { path, readOnly: options?.readOnly === true, released: false }
      locks.push(lock)
      if (!opts.noMailboxObject) {
        impl.mailbox = {
          path, exists: opts.exists ?? messages.length,
          ...(validity !== null && { uidValidity: validity }),
          ...(uidNext !== null && { uidNext }),
        }
      }
      return { release: () => { lock.released = true; impl.mailbox = false } }
    },
    fetch(range: string, _query: object, options?: { uid?: boolean }) {
      const uidMode = options?.uid === true
      fetches.push({ range, uid: uidMode })
      const selected = opts.ignoresRange ? [...messages] : selectRange(messages, range, uidMode)
      return (async function* () {
        if (opts.fetchError) throw opts.fetchError
        if (selected.length === 0 && messages.length > 0) {
          if (opts.emptyRangeError) throw opts.emptyRangeError
          if (opts.emptyRangeYieldsHighest) selected.push(messages.find(m => m.uid === highest)!)
        }
        let handed = 0
        for (const m of selected) {
          if (opts.fetchErrorAfter && handed++ === opts.fetchErrorAfter.count) throw opts.fetchErrorAfter.error
          yield {
            uid: m.uid,
            size: m.size ?? m.source?.length ?? 0,
            internalDate: m.internalDate ?? m.date,
            envelope: {
              messageId: m.messageId,
              subject: m.subject,
              date: m.date,
              from: m.from ? [{ address: m.from }] : [],
            },
          }
        }
      })()
    },
    async fetchOne(uid: string | number, _query: object, _options?: object) {
      downloaded.push(Number(uid))
      if (opts.fetchOneError) throw opts.fetchOneError
      const m = messages.find(x => x.uid === Number(uid))
      return m ? { uid: m.uid, source: m.source } : false
    },
    async logout() { out = true },
    close() { out = true },
  }

  const client = new Proxy(impl, {
    get(target, prop) {
      const name = String(prop)
      if (name === 'then') return undefined   // never look like a thenable
      calls.push(name)
      if (READ_ONLY_CALLS.has(name) || READ_ONLY_PROPS.has(name)) return (target as Record<string, unknown>)[name]
      forbidden.push(name)
      return () => { throw new Error(`forbidden IMAP call: ${name}`) }
    },
  }) as unknown as ImapProbeLike

  return { client, calls, locks, forbidden, fetches, downloaded, loggedOut: () => out }
}
