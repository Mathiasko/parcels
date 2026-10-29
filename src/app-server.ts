import { setMainChannel, isToServer, type ToMain } from './core/app-ipc.js'
import { startAppHost } from './core/app-host.js'
import { BIND_HOST } from './web/server.js'

/**
 * The part of Electron's `process.parentPort` this entry uses. Typed here rather than imported, so
 * `src/` builds and type-checks without Electron's types: this file runs in a utility process, which
 * is plain Node with that one object added.
 */
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
}

/** The exit status the main process reads as "the port is taken": it names the port instead of restarting. */
const EXIT_PORT_IN_USE = 3

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The Mac app's server process, started by the main process as an Electron utility process. All the
 * behaviour is in core/app-host.ts, where it can be tested; this is only the wiring to the one channel
 * the process has. The git install never runs this file: it runs `src/server.ts` and `src/poll.ts`.
 */
async function main(): Promise<void> {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!parentPort) {
    // Under plain node there is nobody to post to, and every notification and count would vanish.
    throw new Error('this runs only inside the Mac app, as its server process; the git install runs dist/server.js')
  }
  const configPath = process.env.PARCELS_CONFIG
  // No fallback to the repository's config.json: inside the bundle that path is wrong, and silently
  // reading it would hide a main process that forgot to pass the support folder's config.
  if (!configPath) throw new Error('PARCELS_CONFIG is not set; the main process passes the config file path')

  const post = (m: ToMain) => parentPort.postMessage(m)
  // Everything that reaches for the main process without being handed `post` (the notifier
  // `notifierFor` builds, for one) goes through this channel.
  setMainChannel(post)
  const host = await startAppHost({ configPath, post })
  console.log(`${new Date().toISOString()} listening on http://${BIND_HOST}:${host.port}`)

  parentPort.on('message', e => {
    if (!isToServer(e.data)) return
    const m = e.data
    host.handle(m).then(
      () => { if (m.type === 'shutdown') process.exit(0) },
      err => {
        console.error(`${new Date().toISOString()} app-server: ${m.type} failed: ${message(err)}`)
        // A shutdown that failed halfway still has to end the process: the main process is waiting.
        if (m.type === 'shutdown') process.exit(1)
      },
    )
  })
}

main().catch(err => {
  if ((err as { code?: unknown } | null)?.code === 'EADDRINUSE') {
    console.error(`app-server: the port is already in use: ${message(err)}`)
    process.exit(EXIT_PORT_IN_USE)
  }
  console.error(`app-server: fatal: ${message(err)}`)
  process.exit(1)
})
