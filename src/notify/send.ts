import { spawn as nodeSpawn } from 'node:child_process'
import type { Config } from '../core/config.js'
import type { Notification, Notifier } from './types.js'

/**
 * Runs `command` with `args` as a real argv. Resolves with the exit code once the process ends and
 * rejects only if it could not be started at all (`error.code === 'ENOENT'` for a missing binary).
 * The seam deliberately has no options parameter: there is no way to ask for a shell.
 */
export type SpawnFn = (command: string, args: readonly string[]) => Promise<{ code: number | null }>

const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', 'terminal-notifier']
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
 * list: one whose FIRST character is `[`, `(`, `{`, `"`, `<` or `-` is rejected (exit 2, nothing
 * posted). Its README prescribes a leading backslash; only the first character ever needs it.
 */
const forTerminalNotifier = (text: string): string => (/^[[({"<-]/.test(text) ? `\\${text}` : text)

/** Escapes text for use inside an AppleScript double-quoted string literal. */
const appleScriptLiteral = (text: string): string => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT'

/**
 * `auto` prefers terminal-notifier (it can coalesce by group and open a URL) and falls back to
 * osascript when the binary cannot be launched. Both tools exit 0 whether or not a banner appeared,
 * so the exit code is never read as a delivery result and nothing is retried: delivery is best-effort.
 */
export function createNotifier(mode: Config['notifier'], spawn: SpawnFn = defaultSpawn): Notifier {
  let terminalNotifierMissing = false
  let preferred = 0   // index into TERMINAL_NOTIFIER of the candidate that last launched

  /** Whether terminal-notifier was launched at all (not whether it delivered anything). */
  async function viaTerminalNotifier(n: Notification): Promise<boolean> {
    const title = clean(n.title)
    const args = [
      '-title', forTerminalNotifier(title),
      // terminal-notifier prints usage and posts nothing for an empty message.
      '-message', forTerminalNotifier(clean(n.message) || title),
      '-group', forTerminalNotifier(clean(n.groupKey)),
      ...(n.url ? ['-open', clean(n.url)] : []),
      '-sound', 'Ping',
    ]
    for (const i of [preferred, 1 - preferred]) {
      try {
        await spawn(TERMINAL_NOTIFIER[i]!, args)
        preferred = i
        return true
      } catch (err) {
        if (!isMissing(err)) return true   // it started and then failed: do not retry or fall back
      }
    }
    terminalNotifierMissing = true
    return false
  }

  async function viaOsascript(n: Notification): Promise<void> {
    const script = `display notification "${appleScriptLiteral(clean(n.message))}"`
      + ` with title "${appleScriptLiteral(clean(n.title))}" sound name "Ping"`
    try { await spawn('osascript', ['-e', script]) } catch { /* best-effort */ }
  }

  return {
    async send(n) {
      if (mode !== 'osascript' && !terminalNotifierMissing) {
        if (await viaTerminalNotifier(n)) return
      }
      if (mode !== 'terminal-notifier') await viaOsascript(n)
    },
  }
}
