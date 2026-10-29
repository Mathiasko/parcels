import { repoRoot } from './version.js'

/**
 * What is running this process: a `git` checkout run by launchd (today's install), or the packaged
 * Mac `app`. The two differ in wording ("update" means a `git pull` in one and a download in the
 * other) and in where files live, so everything that must tell them apart asks here rather than
 * sniffing the environment on its own.
 */
export type Host = 'git' | 'app'

/**
 * The app's main process sets `PARCELS_HOST=app` for the server and poller it starts. Only that
 * exact word counts: a stray or differently-cased value must leave the git install behaving as it
 * always has. The environment is a parameter so a test can ask without touching `process.env`.
 */
export const host = (env: NodeJS.ProcessEnv = process.env): Host => (env.PARCELS_HOST === 'app' ? 'app' : 'git')

/**
 * Where read-only files that ship with the program live (`gmail-filter.xml`, `signing-cert.sha256`).
 * In the app they sit in the bundle's Resources folder, which the main process passes as
 * `PARCELS_RESOURCES`; in the git install they sit in the checkout. An app without the variable
 * falls back to the checkout rather than to an empty path, which would resolve against the working
 * directory and quietly read the wrong file.
 *
 * `version.ts` imports this module too. The cycle is harmless because each only calls the other
 * inside a function, never while loading.
 */
export const resourceRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  host(env) === 'app' && env.PARCELS_RESOURCES ? env.PARCELS_RESOURCES : repoRoot()
