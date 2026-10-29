import { dirname, join } from 'node:path'

/**
 * Where the app keeps its files under a home folder (spec §3). The home is a parameter, so a test, or
 * a hand run with a temporary HOME, never reaches the real ~/Library.
 */
export function appPaths(home: string): { support: string; config: string; logs: string; launchAgents: string } {
  const support = join(home, 'Library', 'Application Support', 'Parcels')
  return {
    support,
    config: join(support, 'config.json'),
    logs: join(home, 'Library', 'Logs', 'Parcels'),
    launchAgents: join(home, 'Library', 'LaunchAgents'),
  }
}

/**
 * The .app folder that holds an executable at `<bundle>/Contents/MacOS/<name>`, which is where macOS
 * runs an app's binary from. The server shows it on /health and the updater swaps it, so it is derived
 * from where the binary really is rather than assumed to be /Applications. An executable outside a
 * bundle gives an empty string, which the server already treats as "not known".
 */
export function bundlePath(execPath: string): string {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  const ok = macos.endsWith('/MacOS') && contents.endsWith('/Contents') && bundle.endsWith('.app')
  return ok ? bundle : ''
}
