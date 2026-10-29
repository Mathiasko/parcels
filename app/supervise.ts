import { isToMain, type ToMain, type ToServer } from '../src/core/app-ipc.js'

/** The longest wait between restarts: a server that keeps dying is retried once a minute, not given up on. */
const MAX_DELAY_MS = 60_000
/** A server that stayed up this long is healthy again: its next crash is treated as the first. */
const HEALTHY_AFTER_MS = 10 * 60_000
/** The server's exit status for "the port is taken" (src/app-server.ts). Restarting cannot fix that. */
const EXIT_PORT_IN_USE = 3

/**
 * How long to wait before restart number `consecutive` (1 for the first crash in a row): 1 s, 2 s,
 * 4 s and so on, up to a minute. Zero or nonsense counts as the first, so a bad count never means
 * restarting in a tight loop.
 */
export function restartDelay(consecutive: number): number {
  const n = Number.isFinite(consecutive) && consecutive >= 1 ? Math.floor(consecutive) : 1
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** (n - 1))
}

/** The part of Electron's `UtilityProcess` the supervisor uses, so tests can hand it a fake. */
export interface Child {
  on(e: 'exit', f: (code: number) => void): void
  on(e: 'message', f: (m: unknown) => void): void
  postMessage(m: unknown): void
  kill(): void
}

export type SupervisorState = 'running' | 'restarting' | 'port-busy' | 'stopped'

export interface SupervisorDeps {
  /** Starts one server process with this environment. Allowed to throw; that counts as a crash. */
  fork: (env: Record<string, string>) => Child
  env: Record<string, string>
  /** A message from the server that passed `isToMain`. */
  onMessage: (m: ToMain) => void
  onState: (s: SupervisorState) => void
  /** A message that did not pass `isToMain`; the main process logs it and does nothing else. */
  onInvalid?: (m: unknown) => void
  setTimer?: (fn: () => void, ms: number) => { clear(): void }
  now?: () => number
}

const defaultSetTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms)
  return { clear: () => clearTimeout(handle) }
}

/**
 * Keeps the server process (src/app-server.ts) running: starts it, restarts it with a growing delay
 * when it exits unexpectedly, gives up on "port in use" (another copy is running; restarting would only
 * fail again), and shuts it down cleanly on quit. Electron is reached only through `fork`, so every
 * rule here is tested with a fake child and a fake clock.
 */
export class Supervisor {
  /** Every restart since launch. The dashboard's /health shows it, through PARCELS_RESTARTS. */
  restarts = 0
  private child: Child | undefined
  private startedAt = 0
  private consecutive = 0
  private restartTimer: { clear(): void } | undefined
  private stopping: Promise<void> | undefined
  private portBusy = false
  private readonly setTimer: NonNullable<SupervisorDeps['setTimer']>
  private readonly now: () => number

  constructor(private readonly d: SupervisorDeps) {
    this.setTimer = d.setTimer ?? defaultSetTimer
    this.now = d.now ?? Date.now
  }

  /** Starts the server unless it is already running, waiting to restart, given up on, or stopped. */
  start(): void {
    if (this.child || this.restartTimer || this.stopping || this.portBusy) return
    this.spawn()
  }

  /** Sends a message to the running server. While none runs (a restart is pending) it is dropped. */
  send(m: ToServer): void {
    try { this.child?.postMessage(m) } catch { /* The child is going away; its exit handler takes over. */ }
  }

  /**
   * Asks the server to shut down and resolves when it has exited, or once it has been killed after
   * `timeoutMs`. Nothing is restarted afterwards, whatever status the exit reports. Calling it again
   * returns the same promise.
   */
  stop(timeoutMs = 5000): Promise<void> {
    if (this.stopping) return this.stopping
    this.restartTimer?.clear()
    this.restartTimer = undefined
    const child = this.child
    if (!child) {
      this.stopping = Promise.resolve()
      this.d.onState('stopped')
      return this.stopping
    }
    this.stopping = new Promise<void>(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        killTimer.clear()
        this.child = undefined
        this.d.onState('stopped')
        resolve()
      }
      // A child that ignores shutdown is killed, and quitting goes on without waiting for its exit
      // event: a hung server must not keep the app from quitting.
      const killTimer = this.setTimer(() => {
        try { child.kill() } catch { /* Already gone. */ }
        finish()
      }, timeoutMs)
      child.on('exit', finish)
      try { child.postMessage({ type: 'shutdown' } satisfies ToServer) } catch { finish() }
    })
    return this.stopping
  }

  private spawn(): void {
    const env = { ...this.d.env, PARCELS_RESTARTS: String(this.restarts) }
    let child: Child
    try {
      child = this.d.fork(env)
    } catch {
      this.scheduleRestart()
      return
    }
    this.child = child
    this.startedAt = this.now()
    child.on('message', m => {
      if (this.child !== child) return
      if (isToMain(m)) this.d.onMessage(m)
      else this.d.onInvalid?.(m)
    })
    child.on('exit', code => this.exited(child, code))
    this.d.onState('running')
  }

  private exited(child: Child, code: number): void {
    // An exit from a child already replaced, or one `stop` is waiting for, is not a crash.
    if (this.child !== child || this.stopping) return
    this.child = undefined
    if (code === EXIT_PORT_IN_USE) {
      this.portBusy = true
      this.d.onState('port-busy')
      return
    }
    if (this.now() - this.startedAt >= HEALTHY_AFTER_MS) this.consecutive = 0
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    this.consecutive++
    this.d.onState('restarting')
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined
      if (this.stopping) return
      this.restarts++
      this.spawn()
    }, restartDelay(this.consecutive))
  }
}
