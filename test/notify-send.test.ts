import { test, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppNotifier, createNotifier, defaultSpawn, notifierFor, type SpawnFn } from '../src/notify/send.js'
import { postToMain, setMainChannel, type ToMain } from '../src/core/app-ipc.js'
import { validateConfig } from '../src/core/config.js'
import type { Notification } from '../src/notify/types.js'

const TN = '/opt/homebrew/bin/terminal-notifier'

interface Call { command: string; args: readonly string[] }

/** A spawn that records every call and behaves as `behave` says (default: exits 0). */
function recorder(behave: (c: Call) => Promise<{ code: number | null }> = async () => ({ code: 0 })) {
  const calls: Call[] = []
  const spawn: SpawnFn = (command, args) => {
    const call = { command, args }
    calls.push(call)
    return behave(call)
  }
  return { calls, spawn }
}

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
const base: Notification = { groupKey: 'parcel-42', title: 'Ready for pickup - Alza', message: 'Z-BOX Hlavna 12', url: 'http://127.0.0.1:8787/parcel/42' }

test('terminal-notifier receives title, message, group and open as separate argv entries', async () => {
  const { calls, spawn } = recorder()
  await createNotifier('terminal-notifier', spawn).send(base)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.command).toBe(TN)
  expect(calls[0]!.args).toEqual([
    '-title', 'Ready for pickup - Alza',
    '-message', 'Z-BOX Hlavna 12',
    '-group', 'parcel-42',
    '-open', 'http://127.0.0.1:8787/parcel/42',
    '-sound', 'Ping',
  ])
})

test('-open is omitted when the notification has no url', async () => {
  const { calls, spawn } = recorder()
  await createNotifier('terminal-notifier', spawn).send({ groupKey: 'g', title: 't', message: 'm' })
  expect(calls[0]!.args).not.toContain('-open')
})

test('a message containing double quotes, backslashes and newlines is passed through unmodified in argv', async () => {
  const n = { title: 'A "quoted" \\ parcel', message: 'line1\nline2 $(whoami) `id`', groupKey: 'p1' }
  const { calls, spawn } = recorder()
  await createNotifier('terminal-notifier', spawn).send(n)
  // The exact original strings are single argv entries: nothing was quoted, escaped or joined.
  expect(calls[0]!.args[calls[0]!.args.indexOf('-title') + 1]).toBe(n.title)
  expect(calls[0]!.args[calls[0]!.args.indexOf('-message') + 1]).toBe(n.message)
  expect(calls[0]!.args).toHaveLength(8)   // -title T -message M -group G -sound Ping
})

test('shell metacharacters reach a real process as inert argv entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-argv-'))
  const marker = join(dir, 'pwned')
  const out = join(dir, 'argv.json')
  const payloads = [`$(touch ${marker})`, `\`touch ${marker}\``, `"; touch ${marker}; "`, `a\nb\\c "d"`, '-e']
  // Stand in for the notifier binary: node dumps the argv it was really given.
  const dump = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`
  await defaultSpawn(process.execPath, ['-e', dump, '--', ...payloads])
  expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(payloads)
  expect(existsSync(marker)).toBe(false)
})

test('a leading character terminal-notifier would parse as a property list is backslash-escaped, nothing else is touched', async () => {
  const { calls, spawn } = recorder()
  const notifier = createNotifier('terminal-notifier', spawn)
  for (const lead of ['[', '(', '{', '"', '<', '-']) {
    await notifier.send({ groupKey: 'g', title: `${lead}t`, message: `${lead}m ${lead}` })
  }
  await notifier.send({ groupKey: 'g', title: "'t", message: 'm [x] -y' })
  const value = (i: number, flag: string) => calls[i]!.args[calls[i]!.args.indexOf(flag) + 1]
  expect(calls.slice(0, 6).map(c => c.args[c.args.indexOf('-message') + 1])).toEqual(
    ['[', '(', '{', '"', '<', '-'].map(l => `\\${l}m ${l}`))
  expect(calls.slice(0, 6).map(c => c.args[1])).toEqual(['[', '(', '{', '"', '<', '-'].map(l => `\\${l}t`))
  expect(value(6, '-title')).toBe("'t")
  expect(value(6, '-message')).toBe('m [x] -y')
})

test('leading whitespace or zero-width characters before a risky character do not defeat the escape', async () => {
  const { calls, spawn } = recorder()
  const notifier = createNotifier('terminal-notifier', spawn)
  const leads = [' ', '\t', '\n', '\u00a0', '\u200b', '\u3000', '\ufeff', '\u200b\u200b ']
  for (const lead of leads) await notifier.send({ groupKey: 'g', title: `${lead}(Redirected)`, message: `${lead}[x] y` })
  await notifier.send({ groupKey: 'g', title: '  plain title', message: '   ' })
  const arg = (i: number, flag: string) => calls[i]!.args[calls[i]!.args.indexOf(flag) + 1]
  for (let i = 0; i < leads.length; i++) {
    expect(arg(i, '-title')).toBe('\\(Redirected)')
    expect(arg(i, '-message')).toBe('\\[x] y')
  }
  // Text that does not need the escape is not touched, and an all-blank message falls back to the title.
  expect(arg(leads.length, '-title')).toBe('  plain title')
  expect(arg(leads.length, '-message')).toBe('  plain title')
})

test('an emoji in the label survives intact', async () => {
  const { calls, spawn } = recorder()
  await createNotifier('terminal-notifier', spawn).send({ groupKey: 'g', title: '\u{1F4E6} Alza \u{1F1F8}\u{1F1F0}', message: 'ok \u{1F44D}' })
  const a = calls[0]!.args
  expect(a[a.indexOf('-title') + 1]).toBe('\u{1F4E6} Alza \u{1F1F8}\u{1F1F0}')
  expect(a[a.indexOf('-message') + 1]).toBe('ok \u{1F44D}')
})

test('control characters are stripped and the message is truncated to the cap', async () => {
  const { calls, spawn } = recorder()
  const notifier = createNotifier('terminal-notifier', spawn)
  await notifier.send({ groupKey: 'g', title: 'a\x00b\x07c\x1Bd', message: 'x\x0By\x1Fz\tkeep\nkeep' })
  const a = calls[0]!.args
  expect(a[a.indexOf('-title') + 1]).toBe('abcd')
  expect(a[a.indexOf('-message') + 1]).toBe('xyz\tkeep\nkeep')

  // 300 emoji: the cap counts characters, so a surrogate pair is never cut in half.
  await notifier.send({ groupKey: 'g', title: 't', message: '\u{1F4E6}'.repeat(300) })
  const long = calls[1]!.args[calls[1]!.args.indexOf('-message') + 1]!
  expect(Array.from(long)).toHaveLength(200)
  expect(long.endsWith('…')).toBe(true)
  expect(long).toBe('\u{1F4E6}'.repeat(199) + '…')
})

test('auto mode selects terminal-notifier when it is on the path', async () => {
  const { calls, spawn } = recorder()
  await createNotifier('auto', spawn).send(base)
  expect(calls.map(c => c.command)).toEqual([TN])
})

test('auto mode falls back to osascript when terminal-notifier is absent', async () => {
  const { calls, spawn } = recorder(async c => {
    if (c.command.endsWith('terminal-notifier')) throw enoent()
    return { code: 0 }
  })
  const notifier = createNotifier('auto', spawn)
  await notifier.send(base)
  // Absolute path first, then a PATH lookup, then the fallback.
  expect(calls.map(c => c.command)).toEqual([TN, 'terminal-notifier', 'osascript'])
  await notifier.send(base)
  // The answer is remembered: no further probing for the missing binary.
  expect(calls.slice(3).map(c => c.command)).toEqual(['osascript'])
})

test('the osascript fallback passes text as argv items, never inside the script source', async () => {
  const n = { groupKey: 'g', title: 'say "hi" \\ bye', message: '-x " & (do shell script "id") & "\\\n$(whoami) `id`' }
  const { calls, spawn } = recorder()
  await createNotifier('osascript', spawn).send(n)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.command).toBe('osascript')
  expect(calls[0]!.args).toEqual([
    '-e', 'on run argv',
    '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Ping"',
    '-e', 'end run',
    '--', n.message, n.title,   // after `--`, so a leading "-x" is a value and not an osascript option
  ])
  // No text of ours appears in any script fragment.
  const scripts = calls[0]!.args.filter((_, i) => calls[0]!.args[i - 1] === '-e').join('\n')
  expect(scripts).not.toContain('shell script')
  expect(scripts).not.toContain('bye')
})

test('send resolves even when the notifier process exits non-zero', async () => {
  const failing = recorder(async () => ({ code: 1 }))
  await expect(createNotifier('terminal-notifier', failing.spawn).send(base)).resolves.toBeUndefined()
  expect(failing.calls).toHaveLength(1)   // and is not retried

  const crashing = recorder(async () => { throw new Error('boom') })
  await expect(createNotifier('osascript', crashing.spawn).send(base)).resolves.toBeUndefined()
  expect(crashing.calls).toHaveLength(1)

  const missing = recorder(async () => { throw enoent() })
  await expect(createNotifier('auto', missing.spawn).send(base)).resolves.toBeUndefined()
})

const NOT_AUTHORISED = (c: Call) => c.command.endsWith('terminal-notifier') ? { code: 3 } : { code: 0 }

test('auto mode falls back to osascript when terminal-notifier is not authorised (exit 3), and remembers it', async () => {
  const { calls, spawn } = recorder(async c => NOT_AUTHORISED(c))
  const notifier = createNotifier('auto', spawn)

  const first = await notifier.deliver(base)
  expect(calls.map(c => c.command)).toEqual([TN, 'osascript'])
  expect(first).toMatchObject({ mechanism: 'osascript', started: true, exitCode: 0 })
  expect(first.note).toMatch(/not authorised/)

  await notifier.send(base)
  expect(calls.map(c => c.command)).toEqual([TN, 'osascript', 'osascript'])   // no second doomed spawn
})

test('an explicit terminal-notifier mode does not degrade when unauthorised: it reports loudly and uses no osascript', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const { calls, spawn } = recorder(async c => NOT_AUTHORISED(c))
    const d = await createNotifier('terminal-notifier', spawn).deliver(base)
    expect(calls.map(c => c.command)).toEqual([TN])
    expect(d).toMatchObject({ mechanism: 'terminal-notifier', started: true, exitCode: 3 })
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/not authorised/))
  } finally { err.mockRestore() }
})

test('other non-zero exits from terminal-notifier in auto mode neither fall back nor retry', async () => {
  const { calls, spawn } = recorder(async () => ({ code: 1 }))
  const d = await createNotifier('auto', spawn).deliver(base)
  expect(calls.map(c => c.command)).toEqual([TN])
  expect(d).toMatchObject({ mechanism: 'terminal-notifier', exitCode: 1 })
})

// --- the app notifier -------------------------------------------------------------------------

test('the app notifier posts the notification to the main process and spawns nothing', async () => {
  // createAppNotifier takes no spawn function at all, so it has no way to start a process.
  const post = vi.fn<(m: ToMain) => void>()
  const d = await createAppNotifier(post).deliver({ groupKey: 'g', title: 'T', message: 'M', url: '/parcel/3' })
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'notify', groupKey: 'g', title: 'T', message: 'M', url: '/parcel/3' })
  expect(d).toEqual({ mechanism: 'app', started: true, exitCode: 0 })
})

test('the app notifier leaves url out of the message when there is none', async () => {
  const post = vi.fn<(m: ToMain) => void>()
  await createAppNotifier(post).send({ groupKey: 'g', title: 'T', message: 'M' })
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'notify', groupKey: 'g', title: 'T', message: 'M' })
})

test('the app notifier never rejects, even when the channel throws', async () => {
  const post = () => { throw new Error('channel closed') }
  await expect(createAppNotifier(post).send(base)).resolves.toBeUndefined()
  await expect(createAppNotifier(post).deliver(base)).resolves.toMatchObject({ mechanism: 'app', started: false })
})

test('notifierFor gives the app notifier under PARCELS_HOST=app whatever the config says', async () => {
  const post = vi.fn<(m: ToMain) => void>()
  setMainChannel(post)
  try {
    const config = validateConfig({ defaultPostalCode: '81101', notifier: 'terminal-notifier' })
    const d = await notifierFor(config, { PARCELS_HOST: 'app' }).deliver(base)
    expect(d.mechanism).toBe('app')
    expect(post).toHaveBeenCalledTimes(1)
  } finally {
    setMainChannel(undefined)
  }
})

test('notifierFor gives the configured notifier on the git host', async () => {
  const config = validateConfig({ defaultPostalCode: '81101', notifier: 'osascript' })
  expect(notifierFor(config, {})).toHaveProperty('deliver')
  // The app notifier would have posted; with no channel set, a real one must not have.
  expect(postToMain({ type: 'ready-count', n: 0 })).toBe(false)
})

test('"app" is not something a user can put in config.json', () => {
  expect(() => validateConfig({ defaultPostalCode: '81101', notifier: 'app' })).toThrow()
})
