import { ImapFlow } from 'imapflow'
import type { ImapConfig, ImapLike } from './imap.js'

/**
 * What the probe needs on top of {@link ImapLike}: the mailbox the server reported when it selected
 * it. `exists` is the EXISTS line of the SELECT/EXAMINE response, so the message count costs nothing
 * and reads no message. Like `ImapLike` this has no way to write anything.
 */
export interface ImapProbeLike extends ImapLike {
  readonly mailbox: { path: string; exists: number } | false
}

/**
 * The answer the settings page shows. Each case is a different thing for the user to do, which is the
 * whole reason the probe exists: every one of these failures is silent in normal operation.
 */
export type ImapProbeResult =
  /** There is no `imap` block. Not an error: mail ingest is optional. */
  | { kind: 'not_configured' }
  /** Connected, authenticated, mailbox selected. `messages` may be 0, which is a useful answer. */
  | { kind: 'ok'; user: string; mailbox: string; messages: number }
  /** The App Password is wrong or has been revoked. */
  | { kind: 'auth'; user: string; detail?: string }
  /** The mailbox does not exist on the server - on Gmail, almost always a label not shown in IMAP. */
  | { kind: 'mailbox'; mailbox: string; detail?: string }
  /** DNS, TCP or TLS: the server was never reached, or the connection died. */
  | { kind: 'network'; host: string; port: number; detail?: string }
  /** Reached, authenticated, and then something the probe will not guess at. */
  | { kind: 'unknown'; detail?: string }

export interface ProbeDeps {
  /** Absent means `not_configured`; the page says so rather than inventing a failure. */
  config?: ImapConfig
  /** Injected in tests; production builds an `ImapFlow`. Never touches the network in tests. */
  client?: ImapProbeLike
  timeoutMs?: number
}

/** Long enough for a slow TLS handshake, short enough that a click never hangs the page. */
export const PROBE_TIMEOUT_MS = 15_000

/** imapflow's own codes for "the connection is the problem"; Node's socket/DNS/TLS codes are matched by shape. */
const CONNECTION_CODES = new Set([
  'NoConnection', 'EConnectionClosed', 'StateLogout', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS',
  'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT', 'ETHROTTLE', 'ProxyError', 'EPROXY',
  'STARTTLS_INJECTION', 'UnsupportedProxyAddress', 'UnsupportedTransportOption', 'ERR_INVALID_URL',
])

/** `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, `ERR_TLS_*`, `CERT_HAS_EXPIRED`, `SELF_SIGNED_CERT_IN_CHAIN`, ... */
const NODE_CONNECTION_CODE = /^(E[A-Z_]+|ERR_TLS[A-Z_]*|[A-Z_]*CERT[A-Z_]*|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/

/** The properties imapflow attaches to the errors it raises; see its `ImapFlowError`. */
interface ImapErrorShape {
  message?: unknown
  code?: unknown
  authenticationFailed?: unknown
  mailboxMissing?: unknown
  tlsFailed?: unknown
  serverResponseCode?: unknown
  responseStatus?: unknown
  responseText?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The password out of any text that is about to be shown. The server echoes the failed command back
 * on some IMAP servers, and imapflow puts that text on the error, so this is not theoretical. Both
 * spellings are removed: an App Password is displayed by Google in four space-separated groups and
 * stored here without them, so either form can turn up in a message.
 */
function redact(text: string, pass: string): string {
  const spellings = [pass, pass.replace(/\s+/g, '')].filter(p => p.length >= 4)
  let out = text
  for (const p of new Set(spellings)) out = out.split(p).join('[password]')
  return out
}

/** A single line of context, redacted and bounded: enough to recognise the failure, never a dump. */
function detailOf(err: unknown, pass: string): string | undefined {
  const e = (err ?? {}) as ImapErrorShape
  const text = str(e.responseText) ?? str(e.message) ?? (typeof err === 'string' ? err : undefined)
  if (text === undefined) return undefined
  return redact(text, pass).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Which of the answers an error is. Structured first and string matching last: imapflow sets
 * `authenticationFailed` and `mailboxMissing` itself (the latter by running LIST after a SELECT that
 * failed with NO, which is exactly the Gmail "label not shown in IMAP" case) and passes
 * `serverResponseCode` through from the server, so the text is only consulted when a server reports
 * neither - and then only for a tagged NO/BAD, where the text is the server's own explanation.
 */
export function classifyImapError(err: unknown, config: ImapConfig): ImapProbeResult {
  const e = (err ?? {}) as ImapErrorShape
  const code = str(e.serverResponseCode)?.toUpperCase()
  const detail = detailOf(err, config.pass)

  if (e.authenticationFailed === true || code === 'AUTHENTICATIONFAILED' || code === 'AUTHORIZATIONFAILED') {
    return { kind: 'auth', user: config.user, detail }
  }
  if (e.mailboxMissing === true || code === 'NONEXISTENT' || code === 'TRYCREATE') {
    return { kind: 'mailbox', mailbox: config.mailbox, detail }
  }
  if (e.tlsFailed === true) return { kind: 'network', host: config.host, port: config.port, detail }
  const errCode = str(e.code)
  if (errCode !== undefined && (CONNECTION_CODES.has(errCode) || NODE_CONNECTION_CODE.test(errCode))) {
    return { kind: 'network', host: config.host, port: config.port, detail }
  }

  // Last resort, and only for a command the server refused in words: some servers answer
  // `NO Unknown Mailbox: parcels` with no response code at all.
  const text = detail ?? ''
  if (/no such|unknown mailbox|mailbox doesn't exist|does not exist|nonexistent/i.test(text)) {
    return { kind: 'mailbox', mailbox: config.mailbox, detail }
  }
  if (/invalid credentials|authentication fail|login fail|bad credentials/i.test(text)) {
    return { kind: 'auth', user: config.user, detail }
  }
  return { kind: 'unknown', detail }
}

function createClient(c: ImapConfig): ImapProbeLike {
  return new ImapFlow({
    host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false,
  }) as unknown as ImapProbeLike
}

/**
 * Connects with the saved settings and says what happened, in the terms the user can act on.
 *
 * STRICTLY READ-ONLY, for the same reason the ingest is (`imap.ts`): the mailbox is opened with
 * EXAMINE (`readOnly: true`) and the message count is read off the server's own SELECT response, so
 * no message is fetched and no flag can be touched. The client type has no write method to call.
 *
 * Never rejects and never throws: every failure is one of the result kinds, so a click on the test
 * button cannot 500 the page, and the App Password cannot escape into a stack trace or a log line.
 */
export async function probeImap(deps: ProbeDeps): Promise<ImapProbeResult> {
  const config = deps.config
  if (config === undefined) return { kind: 'not_configured' }
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const client = deps.client ?? createClient(config)
  // An unhandled 'error' event would crash the process; the rejection from the pending call carries it.
  client.on('error', () => undefined)

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ImapProbeResult>(resolve => {
    timer = setTimeout(() => {
      // Abandon the connection rather than leave the request hanging on a server that never answers.
      try { client.close() } catch { /* already gone */ }
      resolve({
        kind: 'network', host: config.host, port: config.port,
        detail: `no answer within ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)
  })

  const run = (async (): Promise<ImapProbeResult> => {
    try {
      await client.connect()
      try {
        const lock = await client.getMailboxLock(config.mailbox, { readOnly: true })
        try {
          const box = client.mailbox
          if (box === false || typeof box.exists !== 'number') {
            return { kind: 'unknown', detail: 'the server selected the mailbox but reported no message count' }
          }
          return { kind: 'ok', user: config.user, mailbox: config.mailbox, messages: box.exists }
        } finally {
          lock.release()
        }
      } finally {
        try { await client.logout() } catch { client.close() }
      }
    } catch (err) {
      return classifyImapError(err, config)
    }
  })()

  try {
    return await Promise.race([run, timeout])
  } finally {
    clearTimeout(timer)
    // The loser of the race must not surface later as an unhandled rejection; it cannot reject, but
    // this makes that independent of the body above.
    void run.catch(() => undefined)
  }
}
