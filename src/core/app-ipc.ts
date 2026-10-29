/**
 * The messages the server (a utility process) and the Electron main process send each other. They
 * are plain data so they survive `postMessage`, and they live in one file so both ends are checked
 * against the same shapes.
 */
export type ToMain =
  | { type: 'notify'; groupKey: string; title: string; message: string; url?: string }
  | { type: 'ready-count'; n: number }
  | { type: 'install'; staged: string; version: string }
  | { type: 'reveal'; path: string }
  | { type: 'listening'; port: number }

export type ToServer = { type: 'refresh' } | { type: 'wake' } | { type: 'shutdown' }

let channel: ((m: ToMain) => void) | undefined

/**
 * Sets how this process reaches the main process. The app's server entry sets it once at startup;
 * the git install never does, which is how `postToMain` can tell the two apart. Passing `undefined`
 * clears it, which tests use to start from a clean slate.
 */
export function setMainChannel(post: ((m: ToMain) => void) | undefined): void {
  channel = post
}

/** Posts to the main process. Returns false when there is no channel (the git host): callers fall back. */
export function postToMain(m: ToMain): boolean {
  if (!channel) return false
  channel(m)
  return true
}

const SERVER_MESSAGES: ReadonlySet<unknown> = new Set(['refresh', 'wake', 'shutdown'])

/**
 * Messages arrive over a process boundary, so the type is checked at runtime rather than trusted.
 * Anything that is not one of the three known messages (including a message meant for the main
 * process) is rejected.
 */
export function isToServer(v: unknown): v is ToServer {
  return typeof v === 'object' && v !== null && SERVER_MESSAGES.has((v as { type?: unknown }).type)
}
