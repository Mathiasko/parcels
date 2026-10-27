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
  /** UIDs whose full source was downloaded. */
  downloaded: number[]
  loggedOut: () => boolean
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
  } = {},
): FakeImap {
  const calls: string[] = []
  const forbidden: string[] = []
  const locks: FakeImap['locks'] = []
  const downloaded: number[] = []
  let out = false

  const impl = {
    mailbox: false as { path: string; exists: number } | false,
    on: () => impl,
    async connect() {
      if (opts.connectError) throw opts.connectError
    },
    async getMailboxLock(path: string, options?: { readOnly?: boolean }) {
      if (opts.lockError) throw opts.lockError
      const lock = { path, readOnly: options?.readOnly === true, released: false }
      locks.push(lock)
      if (!opts.noMailboxObject) impl.mailbox = { path, exists: opts.exists ?? messages.length }
      return { release: () => { lock.released = true; impl.mailbox = false } }
    },
    fetch(_range: string, _query: object, _options?: object) {
      return (async function* () {
        if (opts.fetchError) throw opts.fetchError
        for (const m of messages) {
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

  return { client, calls, locks, forbidden, downloaded, loggedOut: () => out }
}
