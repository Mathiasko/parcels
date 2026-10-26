import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotifier, defaultSpawn, type SpawnFn } from '../src/notify/send.js'
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
  // The spawn seam takes (command, args) only, so there is nowhere to ask for a shell.
  expect(spawn.length).toBe(2)
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

test('the osascript fallback escapes quotes and backslashes in the AppleScript string literal', async () => {
  const { calls, spawn } = recorder()
  await createNotifier('osascript', spawn).send({
    groupKey: 'g', title: 'say "hi" \\ bye', message: '" & (do shell script "id") & "\\',
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.command).toBe('osascript')
  expect(calls[0]!.args).toEqual([
    '-e',
    'display notification "\\" & (do shell script \\"id\\") & \\"\\\\" with title "say \\"hi\\" \\\\ bye" sound name "Ping"',
  ])
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
