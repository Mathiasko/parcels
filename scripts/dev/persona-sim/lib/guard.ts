// The simulator's guards. Network: every way Node could reach the network throws and is recorded;
// loopback only (the same guard as scripts/dev/fake-mail/harness.run.ts). Processes: every child_process
// entry point throws and is recorded, so no osascript, launchctl, terminal-notifier, git or open can run.
// `syncBuiltinESMExports` makes the patches reach `import { spawn } from 'node:child_process'` as well.
// The simulator's own Chrome and ImageMagick calls go through `realExecFile`, captured before patching.
import cp from 'node:child_process'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

export const blocked: { network: string[]; processes: string[] } = { network: [], processes: [] }
export const realExecFile = cp.execFile

const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i

export function installGuards(): () => void {
  const childProc = cp as unknown as Record<string, unknown>
  const saved = {
    fetch: globalThis.fetch, connect: net.Socket.prototype.connect, lookup: dns.lookup,
    httpReq: http.request, httpGet: http.get, httpsReq: https.request, httpsGet: https.get, tls: tls.connect,
    cp: Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(k => [k, childProc[k]])),
  }
  const deny = (what: string) => (...args: unknown[]): never => {
    blocked.network.push(`${what} ${JSON.stringify(args[0])?.slice(0, 200)}`)
    throw new Error(`persona-sim: network disabled (${what})`)
  }
  globalThis.fetch = deny('fetch') as typeof fetch
  http.request = deny('http.request') as typeof http.request
  http.get = deny('http.get') as typeof http.get
  https.request = deny('https.request') as typeof https.request
  https.get = deny('https.get') as typeof https.get
  ;(tls as { connect: unknown }).connect = deny('tls.connect')
  ;(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
    if (LOOPBACK.test(host)) return (saved.lookup as (...a: unknown[]) => unknown)(host, ...rest)
    return deny('dns.lookup')(host)
  }
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const a = args[0] as { host?: string; path?: string } | number | string
    const host = typeof a === 'object' && a !== null ? (a.path ? 'localhost' : a.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost'
    if (!LOOPBACK.test(host)) return deny('net.connect')(a)
    return (saved.connect as (...x: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect
  for (const k of Object.keys(saved.cp)) {
    childProc[k] = (...args: unknown[]) => {
      blocked.processes.push(`${k} ${JSON.stringify(args.slice(0, 2)).slice(0, 200)}`)
      throw new Error(`persona-sim: starting processes is disabled (${k} ${String(args[0])})`)
    }
  }
  syncBuiltinESMExports()
  return () => {
    globalThis.fetch = saved.fetch
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    http.request = saved.httpReq; http.get = saved.httpGet; https.request = saved.httpsReq; https.get = saved.httpsGet
    ;(tls as { connect: unknown }).connect = saved.tls
    for (const [k, v] of Object.entries(saved.cp)) childProc[k] = v
    syncBuiltinESMExports()
  }
}
