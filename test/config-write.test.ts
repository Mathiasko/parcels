import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  loadConfig, readConfigDocument, validateConfig, writeConfigDocument, type ConfigDocument,
} from '../src/core/config.js'
import { applySettings, settingsValues, submittedSettings } from '../src/web/settings.js'

const PASS = 'abcdefghijklmnop'

/** A config file in a directory of its own, as the real one is: every key the app knows, plus a stranger. */
function configFile(over: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'parcels-cfg-')), 'config.json')
  writeFileSync(path, JSON.stringify({
    defaultPostalCode: '81101',
    dbPath: 'data/parcels.db',
    port: 8787,
    notifier: 'auto',
    mapPreview: true,
    imap: { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: PASS, mailbox: 'parcels' },
    ...over,
  }, null, 2) + '\n', { mode: 0o600 })
  return path
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const imapOf = (path: string) => read(path).imap as Record<string, unknown>
const mode = (path: string) => statSync(path).mode & 0o777

/** The form as the browser sends it: every field present, the password box empty. */
const formOf = (over: Record<string, string> = {}) => ({
  defaultPostalCode: '81101', notifier: 'auto', mapPreview: 'true',
  imapHost: 'imap.gmail.com', imapPort: '993', imapUser: 'you@gmail.com', imapMailbox: 'parcels', imapPass: '',
  ...over,
})

/** applySettings + writeConfigDocument, the way the route does it. Throws if the form was rejected. */
function save(path: string, over: Record<string, string> = {}): void {
  const result = applySettings(readConfigDocument(path), formOf(over))
  if (!result.ok) throw new Error(`rejected: ${result.message}`)
  writeConfigDocument(path, result.doc)
}

describe('the config writer', () => {
  test('writes a file loadConfig accepts, and re-applies mode 600', () => {
    const path = configFile()
    save(path, { defaultPostalCode: '81101' })
    expect(loadConfig(path).defaultPostalCode).toBe('81101')
    expect(mode(path)).toBe(0o600)
  })

  test('a file that was left world-readable comes back 600 after a save', () => {
    const path = configFile()
    writeFileSync(path, readFileSync(path), { mode: 0o644 })
    save(path)
    expect(mode(path)).toBe(0o600)
  })

  test('keys the app does not know about survive a save, top level and inside imap', () => {
    const path = configFile({
      futureFeature: { nested: [1, 2, 3] },
      imap: { host: 'imap.gmail.com', port: 993, user: 'you@gmail.com', pass: PASS, mailbox: 'parcels', tlsFingerprint: 'ab:cd' },
    })
    save(path, { defaultPostalCode: '81101' })
    expect(read(path).futureFeature).toEqual({ nested: [1, 2, 3] })
    expect(imapOf(path).tlsFingerprint).toBe('ab:cd')
  })

  test('refuses to write a document loadConfig would reject, and leaves the file exactly as it was', () => {
    const path = configFile()
    const before = readFileSync(path, 'utf8')
    const doc = readConfigDocument(path)
    expect(() => writeConfigDocument(path, { ...doc, notifier: 'carrier-pigeon' })).toThrow(/notifier/)
    expect(() => writeConfigDocument(path, { ...doc, defaultPostalCode: '' })).toThrow(/defaultPostalCode/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('an invalid imap block is refused too: the poller would fail on it', () => {
    const path = configFile()
    const doc = readConfigDocument(path)
    expect(() => writeConfigDocument(path, { ...doc, imap: { ...(doc.imap as object), port: 'ninety-three' } })).toThrow(/imap/)
    expect(() => writeConfigDocument(path, { ...doc, imap: { ...(doc.imap as object), host: '' } })).toThrow(/imap/)
  })

  test('the write leaves no temp file behind, and the file stays parseable JSON', () => {
    const path = configFile()
    save(path)
    expect(readdirSync(join(path, '..'))).toEqual(['config.json'])
    expect(() => read(path)).not.toThrow()
  })

  test('validateConfig is the rule loadConfig itself uses, so a written file always loads', () => {
    const path = configFile()
    const doc = readConfigDocument(path)
    expect(validateConfig(doc, path)).toEqual(loadConfig(path))
  })
})

describe('applySettings', () => {
  test('an empty password box keeps the stored password; the rest of the form still saves', () => {
    const path = configFile()
    save(path, { imapUser: 'someone.else@gmail.com', imapPass: '' })
    expect(imapOf(path).user).toBe('someone.else@gmail.com')
    expect(imapOf(path).pass).toBe(PASS)
  })

  test('a non-empty password box replaces the stored password, with its whitespace removed', () => {
    const path = configFile()
    save(path, { imapPass: 'qrst uvwx yzab cdef' })
    expect(imapOf(path).pass).toBe('qrstuvwxyzabcdef')
  })

  test('port and dbPath are not editable: a crafted form cannot touch them', () => {
    const path = configFile()
    const result = applySettings(readConfigDocument(path), { ...formOf(), port: '9999', dbPath: '/tmp/evil.db' } as Record<string, string>)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.port).toBe(8787)
    expect(result.doc.dbPath).toBe('data/parcels.db')
  })

  test('clearing every mail field turns ingest off by removing the imap block', () => {
    const path = configFile()
    save(path, { imapHost: '', imapPort: '', imapUser: '', imapMailbox: '', imapPass: '' })
    expect('imap' in read(path)).toBe(false)
    expect(loadConfig(path).imap).toBeUndefined()
  })

  test('each invalid field is rejected with its own message, and nothing is returned to write', () => {
    const doc = readConfigDocument(configFile())
    const bad = (over: Record<string, string>) => applySettings(doc, formOf(over))
    for (const [over, pattern] of [
      [{ defaultPostalCode: '' }, /postcode/i],
      [{ defaultPostalCode: 'SW1A 1AA' }, /postcode/i],
      [{ notifier: 'carrier-pigeon' }, /notifier/i],
      [{ mapPreview: 'maybe' }, /map preview/i],
      [{ imapPort: 'ninety-three' }, /port/i],
      [{ imapPort: '99999' }, /port/i],
      [{ imapHost: '' }, /host/i],
      [{ imapHost: 'h'.repeat(300) }, /longer than/i],
      [{ imapPass: 'p'.repeat(300) }, /longer than/i],
    ] as Array<[Record<string, string>, RegExp]>) {
      const result = bad(over)
      expect(result.ok, JSON.stringify(over)).toBe(false)
      if (result.ok) continue
      expect(result.message).toMatch(pattern)
      expect(result).not.toHaveProperty('doc')
    }
  })

  test('mail fields filled in but no password anywhere is rejected, not written as a half account', () => {
    const doc = readConfigDocument(configFile({ imap: undefined }))
    const result = applySettings(doc, formOf())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/password/i)
  })

  test('the stored password is never part of the values the page is given', () => {
    const doc = readConfigDocument(configFile())
    for (const values of [settingsValues(doc), submittedSettings(formOf({ imapPass: PASS }), doc)]) {
      expect(JSON.stringify(values)).not.toContain(PASS)
      expect(values.passSet).toBe(true)
      expect(values.imapUser).toBe('you@gmail.com')
    }
    expect(settingsValues({ defaultPostalCode: '81101' } as ConfigDocument).passSet).toBe(false)
  })

  test('settingsValues shows the effective defaults for fields the file omits', () => {
    const values = settingsValues({ defaultPostalCode: '81101' } as ConfigDocument)
    // The mail fields default to Gmail's, so a first-time reader fills in two boxes rather than five;
    // `imapConfigured` is what still says no account is actually set up. Only the account itself is
    // left blank, because it is the one thing nobody can guess.
    expect(values).toMatchObject({
      notifier: 'auto', mapPreview: true, imapConfigured: false,
      imapHost: 'imap.gmail.com', imapPort: '993', imapMailbox: 'parcels', imapUser: '',
    })
  })
})
