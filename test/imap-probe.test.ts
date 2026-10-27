import { describe, expect, test } from 'vitest'
import { probeImap, type ImapProbeLike, type ImapProbeResult } from '../src/ingest/imap-probe.js'
import { fakeImap, type FakeMessage } from './imap-fake.js'

const PASS = 'abcdefghijklmnop'
const imap = { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: PASS, mailbox: 'parcels' }

const msg = (uid: number): FakeMessage => ({ uid, messageId: `<m${uid}@x>`, source: Buffer.from('x') })

/** An ImapFlow-shaped error: the library sets these properties, and the probe reads them, not the text. */
function imapError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props)
}

const probe = (over: Parameters<typeof probeImap>[0] = {}) => probeImap({ config: imap, ...over })

describe('probeImap: the five answers', () => {
  test('no imap block at all is not an error, it is "not configured"', async () => {
    expect(await probeImap({ config: undefined })).toEqual({ kind: 'not_configured' })
  })

  test('success reports the account and how many messages the label holds', async () => {
    const fake = fakeImap([msg(1), msg(2), msg(3)])
    expect(await probe({ client: fake.client })).toEqual({
      kind: 'ok', user: 'you@gmail.com', mailbox: 'parcels', messages: 3,
    })
  })

  test('an empty label is a success with a count of zero, not a failure', async () => {
    const fake = fakeImap([])
    expect(await probe({ client: fake.client })).toEqual({
      kind: 'ok', user: 'you@gmail.com', mailbox: 'parcels', messages: 0,
    })
  })

  test('the count comes from the mailbox the server reported, not from reading messages', async () => {
    const fake = fakeImap([], { exists: 79 })
    const result = await probe({ client: fake.client })
    expect(result).toMatchObject({ kind: 'ok', messages: 79 })
    expect(fake.downloaded).toEqual([])
    expect(fake.calls).not.toContain('fetch')
    expect(fake.calls).not.toContain('fetchOne')
  })

  test('a revoked or wrong App Password is reported as an authentication failure', async () => {
    const fake = fakeImap([], {
      connectError: imapError('Invalid credentials (Failure)', {
        authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED', responseStatus: 'NO',
      }),
    })
    expect(await probe({ client: fake.client })).toMatchObject({ kind: 'auth', user: 'you@gmail.com' })
  })

  test('the auth case is taken from the server response code when the library sets no flag', async () => {
    const fake = fakeImap([], { connectError: imapError('command failed', { serverResponseCode: 'AUTHENTICATIONFAILED' }) })
    expect((await probe({ client: fake.client })).kind).toBe('auth')
  })

  test('a label that is not shown in IMAP is reported as a missing mailbox, naming it', async () => {
    const fake = fakeImap([], {
      lockError: imapError('Unknown Mailbox: parcels (Failure)', {
        mailboxMissing: true, serverResponseCode: 'NONEXISTENT', responseStatus: 'NO', path: 'parcels',
      }),
    })
    expect(await probe({ client: fake.client })).toMatchObject({ kind: 'mailbox', mailbox: 'parcels' })
  })

  test('a server that reports NONEXISTENT without the flag is still a missing mailbox', async () => {
    const fake = fakeImap([], { lockError: imapError('select failed', { serverResponseCode: 'NONEXISTENT' }) })
    expect((await probe({ client: fake.client })).kind).toBe('mailbox')
  })

  test('with no structured hint at all, the wording of a select failure is the last resort', async () => {
    const fake = fakeImap([], { lockError: imapError('Unknown Mailbox: parcels (Failure)', { responseStatus: 'NO' }) })
    expect((await probe({ client: fake.client })).kind).toBe('mailbox')
  })

  test('DNS, TCP and TLS failures are one answer, and it names the host and port', async () => {
    for (const props of [
      { code: 'ENOTFOUND' },
      { code: 'ECONNREFUSED' },
      { code: 'CONNECT_TIMEOUT' },
      { code: 'GREETING_TIMEOUT' },
      { code: 'NoConnection' },
      { code: 'EConnectionClosed' },
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID', tlsFailed: true },
      { tlsFailed: true },
    ]) {
      const fake = fakeImap([], { connectError: imapError('connection problem', props) })
      expect(await probe({ client: fake.client }), JSON.stringify(props)).toMatchObject({
        kind: 'network', host: 'imap.gmail.com', port: 993,
      })
    }
  })

  test('anything else is reported as itself rather than guessed at', async () => {
    const fake = fakeImap([], { lockError: imapError('server said something odd', {}) })
    const result = await probe({ client: fake.client })
    expect(result.kind).toBe('unknown')
    expect((result as { detail?: string }).detail).toContain('something odd')
  })

  test('a mailbox the server selects without reporting a count is not called a success', async () => {
    const fake = fakeImap([], { noMailboxObject: true })
    expect((await probe({ client: fake.client })).kind).toBe('unknown')
  })
})

describe('probeImap: the properties that matter', () => {
  test('nothing is written: the mailbox is opened read-only and no forbidden call is made', async () => {
    const fake = fakeImap([msg(1)])
    await probe({ client: fake.client })
    expect(fake.forbidden).toEqual([])
    expect(fake.locks).toEqual([{ path: 'parcels', readOnly: true, released: true }])
    expect(fake.loggedOut()).toBe(true)
  })

  test('the connection is closed even when the mailbox could not be opened', async () => {
    const fake = fakeImap([], { lockError: imapError('nope', { mailboxMissing: true }) })
    await probe({ client: fake.client })
    expect(fake.loggedOut()).toBe(true)
    expect(fake.forbidden).toEqual([])
  })

  test('the password never reaches the result, however the server echoes it back', async () => {
    const leaky = imapError(`LOGIN "you@gmail.com" "${PASS}" failed`, {
      responseText: `bad password ${PASS}`,
      executedCommand: `A1 LOGIN "you@gmail.com" "${PASS}"`,
    })
    for (const result of [
      await probe({ client: fakeImap([], { connectError: leaky }).client }),
      await probe({ client: fakeImap([], { lockError: leaky }).client }),
    ]) {
      expect(JSON.stringify(result)).not.toContain(PASS)
    }
  })

  test('a password typed with spaces is redacted in both spellings', async () => {
    const spaced = { ...imap, pass: 'abcd efgh ijkl mnop' }
    const result = await probeImap({
      config: spaced,
      client: fakeImap([], { connectError: new Error('rejected abcdefghijklmnop / abcd efgh ijkl mnop') }).client,
    })
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop')
    expect(JSON.stringify(result)).not.toContain('abcd efgh ijkl mnop')
  })

  test('a server that never answers cannot hang the page: the probe times out and closes the socket', async () => {
    let closed = false
    const hanging = {
      on: () => undefined,
      connect: () => new Promise<void>(() => {}),
      getMailboxLock: () => new Promise<never>(() => {}),
      logout: async () => undefined,
      close: () => { closed = true },
      mailbox: false as const,
    } as unknown as ImapProbeLike
    const result: ImapProbeResult = await probeImap({ config: imap, client: hanging, timeoutMs: 25 })
    expect(result).toMatchObject({ kind: 'network', host: 'imap.gmail.com', port: 993 })
    expect((result as { detail?: string }).detail).toMatch(/answer|timed out/i)
    expect(closed).toBe(true)
  })
})
