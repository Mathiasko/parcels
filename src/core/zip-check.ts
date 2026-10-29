import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/**
 * Reading an update zip's table of contents before anything unpacks it.
 *
 * `ditto -x -k` runs before the certificate check can (the check needs the unpacked app), so the zip
 * is still untrusted when it is unpacked: its checksum only proves it matches its own release. An
 * archive whose entries are named `../x` or `/x`, or which plants a symlink and then writes through it,
 * could otherwise put files outside the staging folder - over the running app's `app.asar`, say, or
 * into ~/Library/LaunchAgents. So the archive is read here first and refused if any entry could land
 * outside the folder it is unpacked into. Symlinks that stay inside it are allowed: Electron's
 * frameworks are full of them (`Versions/Current -> A`).
 *
 * Read with plain file reads rather than a library, because what matters is exactly what an unpacker
 * could see: every entry in the central directory, and nothing hidden between them. Each local header
 * must sit where the central directory says, carry the same name, and be followed directly by the next,
 * so an unpacker that streams the local headers instead of reading the directory sees the same list.
 */

/** Something that is not a zip this module can vouch for: truncated, multi-disk, encrypted, odd. */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

export interface ZipEntry {
  /** The name as stored, `/`-separated, with a directory's trailing slash. */
  name: string
  isSymlink: boolean
  /** The link's target, for a symlink. */
  target?: string
}

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
/** A symlink's target is a path; anything longer than this is not one. */
const MAX_LINK = 4096
/** The table of contents of a 130 MB app is well under a megabyte; this bounds what is read into memory. */
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
/** How many links may be followed while resolving one target; more is a loop. */
const MAX_LINK_DEPTH = 40

const bad = (message: string): never => { throw new ZipFormatError(message) }

const safeNumber = (n: bigint, what: string): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) bad(`${what} is too large`)
  return Number(n)
}

/**
 * A name must be valid UTF-8 (whatever the flag says: macOS reads names as UTF-8), so that what is
 * checked here is what the unpacker will create. Overlong encodings of `/` and `.` are the classic way
 * around a check that decodes leniently.
 */
function decodeName(raw: Buffer): string {
  const name = raw.toString('utf8')
  if (!Buffer.from(name, 'utf8').equals(raw)) bad('an entry name is not valid UTF-8')
  return name
}

/** Reads every entry of the zip at `path`. Throws `ZipFormatError` for anything it cannot vouch for. */
export function readZipEntries(path: string): ZipEntry[] {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const read = (offset: number, length: number): Buffer => {
      if (offset < 0 || length < 0 || offset + length > size) bad('an offset points outside the file')
      const buf = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        const n = readSync(fd, buf, done, length - done, offset + done)
        if (n === 0) bad('the file ended early')
        done += n
      }
      return buf
    }

    // The end-of-central-directory record: the last one whose comment runs exactly to the end of file.
    if (size < EOCD_SIZE) bad('too short to be a zip')
    const tailLen = Math.min(size, EOCD_SIZE + MAX_COMMENT)
    const tailStart = size - tailLen
    const tail = read(tailStart, tailLen)
    let eocd = -1
    for (let i = tailLen - EOCD_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tailLen) { eocd = i; break }
    }
    if (eocd < 0) bad('no end-of-central-directory record')
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) bad('a multi-disk zip')
    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    const eocdPos = tailStart + eocd
    let cdEnd = eocdPos

    // Zip64: a locator 20 bytes before the record points at a larger record with the real numbers.
    if (eocdPos >= 20 && read(eocdPos - 20, 4).readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
      const loc = read(eocdPos - 20, 20)
      if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) !== 1) bad('a multi-disk zip64')
      const at = safeNumber(loc.readBigUInt64LE(8), 'the zip64 record offset')
      const rec = read(at, 56)
      if (rec.readUInt32LE(0) !== SIG_EOCD64) bad('the zip64 locator points at nothing')
      if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) bad('a multi-disk zip64')
      count = safeNumber(rec.readBigUInt64LE(32), 'the entry count')
      cdSize = safeNumber(rec.readBigUInt64LE(40), 'the directory size')
      cdOffset = safeNumber(rec.readBigUInt64LE(48), 'the directory offset')
      cdEnd = at
    } else if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      bad('zip64 values without a zip64 record')
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY) bad('the central directory is implausibly large')
    // Nothing may hide between the directory and its end record.
    if (cdOffset + cdSize !== cdEnd) bad('the central directory is not where the end record says')

    const cd = read(cdOffset, cdSize)
    interface Raw { entry: ZipEntry; rawName: Buffer; method: number; flags: number; comp: number; local: number }
    const raws: Raw[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) bad('a broken central directory')
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      let comp = cd.readUInt32LE(p + 20)
      let uncomp = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let disk = cd.readUInt16LE(p + 34)
      const external = cd.readUInt32LE(p + 38)
      let local = cd.readUInt32LE(p + 42)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > cd.length) bad('a broken central directory')
      const rawName = cd.subarray(p + 46, p + 46 + nameLen)
      // Zip64 extra field: 8-byte values for exactly those fields saturated above, in this order.
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      for (let q = 0; q + 4 <= extra.length;) {
        const id = extra.readUInt16LE(q)
        const len = extra.readUInt16LE(q + 2)
        if (q + 4 + len > extra.length) bad('a broken extra field')
        if (id === 0x0001) {
          let r = q + 4
          const next = (what: string): number => {
            if (r + 8 > q + 4 + len) bad('a short zip64 extra field')
            const v = safeNumber(extra.readBigUInt64LE(r), what)
            r += 8
            return v
          }
          if (uncomp === 0xffffffff) uncomp = next('a size')
          if (comp === 0xffffffff) comp = next('a size')
          if (local === 0xffffffff) local = next('an offset')
          if (disk === 0xffff) { if (r + 4 > q + 4 + len) bad('a short zip64 extra field'); disk = extra.readUInt32LE(r) }
        }
        q += 4 + len
      }
      if (disk !== 0) bad('a multi-disk zip')
      if (flags & 0x1) bad('an encrypted entry')
      if (comp === 0xffffffff || local === 0xffffffff) bad('zip64 values without a zip64 extra field')
      const name = decodeName(rawName)
      const mode = external >>> 16
      raws.push({ entry: { name, isSymlink: (mode & S_IFMT) === S_IFLNK }, rawName, method, flags, comp, local })
      p = end
    }
    if (p !== cd.length) bad('the central directory has more in it than its entries')

    // Every local header where the directory says, with the same name, packed end to end from offset 0
    // up to the directory: no entry an unpacker could find that this list does not have.
    const byOffset = [...raws].sort((a, b) => a.local - b.local)
    let expected = 0
    for (let i = 0; i < byOffset.length; i++) {
      const r = byOffset[i]!
      if (r.local !== expected) bad('there is data between entries')
      const head = read(r.local, 30)
      if (head.readUInt32LE(0) !== SIG_LOCAL) bad('a missing local header')
      const nameLen = head.readUInt16LE(26)
      const extraLen = head.readUInt16LE(28)
      if (!read(r.local + 30, nameLen).equals(r.rawName)) bad('a local header names a different file than the directory')
      const dataStart = r.local + 30 + nameLen + extraLen
      const dataEnd = dataStart + r.comp
      if (r.entry.isSymlink) {
        if (r.comp > MAX_LINK) bad('a symlink target is implausibly long')
        const data = read(dataStart, r.comp)
        const target = r.method === 0 ? data
          : r.method === 8 ? (() => {
            try { return inflateRawSync(data, { maxOutputLength: MAX_LINK }) } catch { return bad('a symlink target does not inflate') }
          })()
          : bad('a symlink stored with an unknown compression method')
        r.entry.target = decodeName(target)
      }
      const next = i + 1 < byOffset.length ? byOffset[i + 1]!.local : cdOffset
      // A data descriptor (flag bit 3) may follow the data: 12 or 20 bytes, plus an optional signature.
      const allowed = r.flags & 0x8 ? [dataEnd + 12, dataEnd + 16, dataEnd + 20, dataEnd + 24] : [dataEnd]
      if (!allowed.includes(next)) bad('there is data between entries')
      expected = next
    }
    if (byOffset.length === 0 && cdOffset !== 0) bad('there is data before the central directory')
    return raws.map(r => r.entry)
  } finally {
    closeSync(fd)
  }
}

/** APFS is case- and normalization-insensitive by default, so two spellings of one path are one path. */
const keyOf = (parts: readonly string[]): string => parts.join('/').normalize('NFD').toLowerCase()

/**
 * The first reason an entry could land outside the folder the zip is unpacked into, or `undefined`
 * when none can.
 *
 * Refused: an empty, absolute or backslashed name, a control character, any `.` or `..` or empty
 * component, two entries for one path, any entry whose path passes through a symlink entry, and a
 * symlink whose target - resolved through the archive's other links, as the file system would - is
 * absolute or leaves the folder. A link may point at another link; a chain that loops is refused.
 */
export function unsafeZipEntry(entries: readonly ZipEntry[]): string | undefined {
  const seen = new Set<string>()
  const links = new Map<string, { dir: string[]; target: string }>()
  const paths: Array<{ name: string; parts: string[] }> = []
  for (const e of entries) {
    const name = e.name
    if (name === '' || name.startsWith('/')) return `${JSON.stringify(name)} is absolute or empty`
    if (name.includes('\\')) return `${JSON.stringify(name)} contains a backslash`
    if (/[\u0000-\u001F\u007F]/.test(name)) return `${JSON.stringify(name)} contains a control character`
    const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/')
    if (parts.some(c => c === '' || c === '.' || c === '..')) return `${JSON.stringify(name)} has an empty, . or .. component`
    const key = keyOf(parts)
    if (seen.has(key)) return `${JSON.stringify(name)} appears twice`
    seen.add(key)
    paths.push({ name, parts })
    if (e.isSymlink) {
      if (name.endsWith('/')) return `${JSON.stringify(name)} is a symlink named like a directory`
      links.set(key, { dir: parts.slice(0, -1), target: e.target ?? '' })
    }
  }

  // Order does not matter here: a link created after a directory of the same name would fail, and one
  // created before it would be written through, so any overlap at all is refused.
  for (const { name, parts } of paths) {
    for (let i = 1; i < parts.length; i++) {
      if (links.has(keyOf(parts.slice(0, i)))) return `${JSON.stringify(name)} passes through a symlink`
    }
  }

  /** Walks `target` from `from` like the kernel would; `undefined` means it left the folder or looped. */
  const resolve = (from: string[], target: string, depth: number): string[] | undefined => {
    if (target === '' || target.startsWith('/') || depth > MAX_LINK_DEPTH) return undefined
    let stack = [...from]
    for (const c of target.split('/')) {
      if (c === '' || c === '.') continue
      if (c === '..') {
        if (stack.length === 0) return undefined
        stack.pop()
        continue
      }
      stack.push(c)
      const link = links.get(keyOf(stack))
      if (link) {
        const r = resolve(stack.slice(0, -1), link.target, depth + 1)
        if (!r) return undefined
        stack = r
      }
    }
    return stack
  }

  for (const [key, link] of links) {
    if (/[\u0000-\u001F\u007F]/.test(link.target)) return `the symlink ${key} has a control character in its target`
    if (!resolve(link.dir, link.target, 0)) return `the symlink ${key} -> ${link.target} points outside the folder`
  }
  return undefined
}
