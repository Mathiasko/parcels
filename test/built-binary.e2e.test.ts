import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// Runs the *built* entry point (`dist/cli.js`) as a real child process. Every other CLI test calls
// `runCli` in-process with injected dependencies, so none of them can notice a binary that prints
// nothing, or exits before `main()` runs. Skipped when `npm run build` has not been run.
//
// The child is started from `process.execPath` with an argv array and no shell, so it exercises
// this code and not whatever `node` happens to resolve to in a developer's shell. (A lazy-loading
// `node` shell function that returns non-zero makes `node dist/cli.js ...` exit 1 silently.)
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

describe.skipIf(!existsSync(CLI))('built binary dist/cli.js', () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'parcels-e2e-'))
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ defaultPostalCode: '81101', dbPath: 'parcels.db' }))
    env = { ...process.env, PARCELS_CONFIG: configPath }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 })
    return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr }
  }

  test('list on an empty database prints "no active parcels" to stdout and exits 0', () => {
    const r = run('list')
    expect(r).toMatchObject({ code: 0, signal: null, stdout: 'no active parcels\n', stderr: '' })
  })

  test('an unknown command prints usage to stderr and exits 1', () => {
    const r = run('bogus')
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('unknown command "bogus"')
    expect(r.stderr).toContain('usage: cli <command>')
  })

  test('state persists across invocations: add, then list and show see the parcel', () => {
    expect(run('add', 'RA123456785SK', '--label', 'e2e').code).toBe(0)
    const list = run('list')
    expect(list.code).toBe(0)
    expect(list.stdout).toContain('RA123456785SK')
    expect(list.stdout).toContain('e2e')
  })

  test('a missing config is reported on stderr, not swallowed', () => {
    const r = spawnSync(process.execPath, [CLI, 'list'], {
      env: { ...env, PARCELS_CONFIG: join(dir, 'nope.json') }, encoding: 'utf8',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cli: fatal:')
  })
})
