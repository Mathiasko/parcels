import { spawn as nodeSpawn } from 'node:child_process'
import { postToMain, type ToMain } from '../core/app-ipc.js'
import type { Config } from '../core/config.js'
import { host } from '../core/host.js'
import type { Notification, Notifier } from './types.js'

/**
 * Runs `command` with `args` as a real argv. Resolves with the exit code once the process ends and
 * rejects only if it could not be started at all (`error.code === 'ENOENT'` for a missing binary).
 * The seam deliberately has no options parameter: there is no way to ask for a shell.
 */
export type SpawnFn = (command: string, args: readonly string[]) => Promise<{ code: number | null }>

/** What one delivery attempt did. `started` says a process ran, never that a banner appeared. */
export interface Delivery {
  mechanism: 'terminal-notifier' | 'osascript' | 'app'
  started: boolean
  exitCode: number | null
  note?: string
}

export interface ReportingNotifier extends Notifier {
  /** Like `send`, but says which mechanism was used and how it went. Also never rejects. */
  deliver(n: Notification): Promise<Delivery>
}

const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', 'terminal-notifier']
/** terminal-notifier's exit code when macOS has not authorised it to post notifications. */
const NOT_AUTHORISED = 3
const SPAWN_TIMEOUT_MS = 10_000
const MAX_CHARS = 200

export const defaultSpawn: SpawnFn = (command, args) =>
  new Promise((resolve, reject) => {
    // No `shell`: `args` reach the process exactly as given, whatever they contain.
    const child = nodeSpawn(command, [...args], { stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill(); resolve({ code: null }) }, SPAWN_TIMEOUT_MS)
    child.once('error', err => { clearTimeout(timer); reject(err) })
    child.once('close', code => { clearTimeout(timer); resolve({ code }) })
  })

/**
 * Carrier text and merchant names come from untrusted email and carrier responses. Drop control
 * characters (keeping tab and newline) and cap the length, counting characters rather than UTF-16
 * units so an emoji is never cut in half.
 */
function clean(text: string): string {
  const stripped = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  const chars = Array.from(stripped)
  return chars.length <= MAX_CHARS ? stripped : chars.slice(0, MAX_CHARS - 1).join('') + '…'
}

/**
 * terminal-notifier reads option values through NSUserDefaults, which parses a value as a property
 * list: one that starts with `[`, `(`, `{`, `"`, `<` or `-` is rejected (exit 2 or 4, nothing posted),
 * and so is one where such a character follows leading whitespace or zero-width characters (checked
 * against the real binary). Its README prescribes a leading backslash. Leading blanks are dropped
 * first, so the backslash lands on the character that matters; text that needs neither is untouched.
 */
const LEADING_BLANKS = '\\s\\u00AD\\u200B-\\u200F\\u2060\\uFEFF'
const RISKY_START = new RegExp(`^[${LEADING_BLANKS}]*[[({"<-]`)
const forTerminalNotifier = (text: string): string =>
  RISKY_START.test(text) ? `\\${text.replace(new RegExp(`^[${LEADING_BLANKS}]+`), '')}` : text

const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT'

type Attempt = { kind: 'missing' } | { kind: 'failed' } | { kind: 'ran'; code: number | null }

/**
 * `auto` prefers terminal-notifier (it can coalesce by group and open a URL) and uses osascript when
 * the binary is absent or macOS has not authorised it (exit 3); the decision is remembered for the
 * life of the notifier so the doomed spawn is not repeated. An explicit `terminal-notifier` mode never
 * degrades: it reports the problem on stderr. Both tools exit 0 whether or not a banner appeared, so
 * apart from that one code the exit status is not read as a delivery result, and nothing is retried.
 */
export function createNotifier(mode: Config['notifier'], spawn: SpawnFn = defaultSpawn): ReportingNotifier {
  let tnProblem: string | undefined   // why terminal-notifier is not being used (auto mode only)
  let preferred = 0                   // index into TERMINAL_NOTIFIER of the candidate that last launched

  async function runTerminalNotifier(n: Notification): Promise<Attempt> {
    const title = clean(n.title)
    const message = clean(n.message)
    const args = [
      '-title', forTerminalNotifier(title),
      // terminal-notifier prints usage and posts nothing for an empty (or all-blank) message.
      '-message', forTerminalNotifier(new RegExp(`^[${LEADING_BLANKS}]*$`).test(message) ? title : message),
      '-group', forTerminalNotifier(clean(n.groupKey)),
      ...(n.url ? ['-open', clean(n.url)] : []),
      '-sound', 'Ping',
    ]
    for (const i of [preferred, 1 - preferred]) {
      try {
        const { code } = await spawn(TERMINAL_NOTIFIER[i]!, args)
        preferred = i
        return { kind: 'ran', code }
      } catch (err) {
        if (!isMissing(err)) return { kind: 'failed' }   // it could not run: do not try again
      }
    }
    return { kind: 'missing' }
  }

  async function runOsascript(n: Notification, note?: string): Promise<Delivery> {
    const message = clean(n.message) || clean(n.title)
    // The text travels as argv items read by `on run argv`, never inside the script source. The
    // `--` is load-bearing: without it osascript would read a value like `-x` as one of its options.
    const args = [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Ping"',
      '-e', 'end run',
      '--', message, clean(n.title),
    ]
    try {
      const { code } = await spawn('osascript', args)
      return { mechanism: 'osascript', started: true, exitCode: code, note }
    } catch {
      return { mechanism: 'osascript', started: false, exitCode: null, note }
    }
  }

  const loud = (msg: string) => console.error(`notify: ${msg}`)

  async function deliver(n: Notification): Promise<Delivery> {
    if (mode !== 'osascript' && tnProblem === undefined) {
      const r = await runTerminalNotifier(n)
      if (r.kind === 'ran' && r.code !== NOT_AUTHORISED) {
        return { mechanism: 'terminal-notifier', started: true, exitCode: r.code }
      }
      const problem = r.kind === 'missing' ? 'terminal-notifier is not installed'
        : r.kind === 'failed' ? 'terminal-notifier could not be launched'
        : 'terminal-notifier is not authorised to post notifications (exit 3); run it once from Terminal and approve the prompt'
      if (mode === 'terminal-notifier') {
        loud(problem)
        return { mechanism: 'terminal-notifier', started: r.kind === 'ran', exitCode: r.kind === 'ran' ? r.code : null, note: problem }
      }
      tnProblem = problem
    }
    return runOsascript(n, tnProblem)   // osascript mode, or auto after terminal-notifier proved unusable
  }

  return { deliver, send: async n => { await deliver(n) } }
}

/**
 * In the Mac app the server runs in a utility process that has no notification permission of its
 * own, so it hands the banner to the main process, which posts it under the app's identity. Nothing
 * is spawned. Like the other notifier it never rejects: a channel that throws (the main process went
 * away mid-shutdown) is reported as not started rather than raised into the poll.
 */
export function createAppNotifier(post: (m: ToMain) => void): ReportingNotifier {
  async function deliver(n: Notification): Promise<Delivery> {
    try {
      post({ type: 'notify', groupKey: n.groupKey, title: n.title, message: n.message, ...(n.url ? { url: n.url } : {}) })
      return { mechanism: 'app', started: true, exitCode: 0 }
    } catch {
      return { mechanism: 'app', started: false, exitCode: null }
    }
  }
  return { deliver, send: async n => { await deliver(n) } }
}

/**
 * The notifier the server and poller use. Under the app the configured `notifier` is ignored, since
 * terminal-notifier and osascript would post under the wrong identity (or not at all) from inside
 * the bundle; the git install keeps honouring it. The environment is a parameter so a test can ask
 * without touching `process.env`.
 */
export function notifierFor(config: Config, env: NodeJS.ProcessEnv = process.env): ReportingNotifier {
  return host(env) === 'app' ? createAppNotifier(postToMain) : createNotifier(config.notifier)
}
