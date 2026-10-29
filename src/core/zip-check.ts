import {
  closeSync, createReadStream, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync,
} from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib'

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
 * Three layers, because no check of an archive can prove what a particular unpacker will do with it:
 *
 * 1. `readZipEntries` - the archive is self-consistent. Read with plain file reads rather than a
 *    library, so the checks are about the bytes an unpacker sees. Every local header agrees with its
 *    central-directory entry on name, method, flags, CRC and both sizes; the local entries tile the
 *    file exactly, from offset 0 up to the directory; data descriptors (flag bit 3) are refused; a
 *    directory entry carries no data; and every deflated entry's stream ends exactly at its stated
 *    compressed size and inflates to its stated size and CRC. These close the differentials known
 *    between a reader of the directory and `ditto`, which walks the local headers and finds the end of
 *    deflated data from the deflate stream itself. They do not prove that no other differential exists.
 * 2. `unsafeZipEntry` - what the archive lists is safe: printable ASCII names and link targets only
 *    (APFS folds case and Unicode in ways a check would otherwise have to reproduce exactly - `ſ` is
 *    `s`), no `.`, `..`, empty, absolute or backslashed components, nothing written through a link,
 *    and every link resolving, through the archive's other links, to a listed path inside the folder.
 * 3. `unsafeUnpackedTree` - the ground truth, after `ditto` has run. The staging tree is walked
 *    without following links; anything the archive did not list (as that kind of thing) is refused,
 *    and so is any link that does not resolve on the real file system, or resolves - lexically or
 *    there - outside the folder. This is the layer that holds even if 1 and 2 missed a trick: what is
 *    left in the folder is exactly what was listed, and every link in it lands inside it. It cannot
 *    see a write that `ditto` made outside the folder through a link it then replaced; layers 1 and
 *    2 are what stand in the way of that.
 *
 * electron-builder's archiver (7za, `-mm=Deflate -mcu -snl`) writes exactly what these allow: no data
 * descriptors, matching local and central fields, ASCII names, in-tree links. So a real release passes.
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
const S_IFDIR = 0o040000
/** The MS-DOS directory attribute, in the low byte of the external attributes. */
const DOS_DIR = 0x10
/** How many links may be followed while resolving one target; more is a loop. */
const MAX_LINK_DEPTH = 40

const bad = (message: string): never => { throw new ZipFormatError(message) }

const safeNumber = (n: bigint, what: string): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) bad(`${what} is too large`)
  return Number(n)
}

/**
 * A name or link target must be printable ASCII. There is then exactly one way to read it, and the
 * file system's case folding is plain ASCII case folding, which `keyOf` reproduces.
 */
function decodeName(raw: Buffer, what: string): string {
  for (const b of raw) if (b < 0x20 || b > 0x7e) bad(`${what} has a byte that is not printable ASCII`)
  return raw.toString('latin1')
}

/**
 * Checks that a deflated entry's stream ends exactly at its stated compressed size and inflates to its
 * stated size and CRC. Streamed, because `app.asar` is tens of megabytes. `ditto` finds the end of
 * deflated data from the stream itself, so a stream that ends early would leave bytes - possibly a
 * hidden local header - that it reads as the next entry. zlib's `bytesWritten` is the input consumed
 * up to the end of the stream, whatever follows it.
 */
async function checkDeflate(path: string, start: number, comp: number, uncomp: number, crc: number, name: string): Promise<void> {
  if (comp === 0) bad(`${name} is deflated but has no data`)
  const inflater = createInflateRaw()
  let out = 0
  let sum = 0
  inflater.on('data', (chunk: Buffer) => {
    out += chunk.length
    sum = crc32(chunk, sum)
    // Bounded by the stated size, so a small entry cannot inflate into gigabytes while being checked.
    if (out > uncomp) inflater.destroy(new ZipFormatError(`${name} inflates to more than its stated size`))
  })
  try {
    await pipeline(createReadStream(path, { start, end: start + comp - 1 }), inflater)
  } catch (err) {
    if (err instanceof ZipFormatError) throw err
    bad(`${name} does not inflate`)
  }
  if (inflater.bytesWritten !== comp) bad(`${name}'s deflate stream ends before its stated size`)
  if (out !== uncomp) bad(`${name} inflates to a different size than stated`)
  if ((sum >>> 0) !== crc) bad(`${name} does not match its CRC`)
}

/**
 * Reads every entry of the zip at `path`. Rejects with `ZipFormatError` for anything it cannot vouch
 * for. Asynchronous only because deflated data is streamed through zlib.
 */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
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
    interface Raw {
      entry: ZipEntry; rawName: Buffer; method: number; flags: number; crc: number; comp: number; uncomp: number; local: number
    }
    const raws: Raw[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) bad('a broken central directory')
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
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
      // Bit 3 leaves the sizes out of the local header, so a streaming unpacker finds the end of the data
      // by itself - which is exactly where a hidden entry could start. The release archiver never sets it.
      if (flags & 0x8) bad('an entry with a data descriptor')
      if (method !== 0 && method !== 8) bad('an entry with an unknown compression method')
      if (method === 0 && comp !== uncomp) bad('a stored entry whose sizes disagree')
      if (comp === 0xffffffff || uncomp === 0xffffffff || local === 0xffffffff) bad('zip64 values without a zip64 extra field')
      const name = decodeName(rawName, 'an entry name')
      const mode = external >>> 16
      // `ditto` skips a directory entry's data; anything there would be read as further entries. A
      // directory by any of its three signs must be named as one and carry nothing.
      const dirLike = name.endsWith('/') || (mode & S_IFMT) === S_IFDIR || (external & DOS_DIR) !== 0
      if (dirLike && !name.endsWith('/')) bad(`${name} is a directory not named like one`)
      if (dirLike && (comp !== 0 || uncomp !== 0)) bad(`the directory ${name} carries data`)
      raws.push({ entry: { name, isSymlink: (mode & S_IFMT) === S_IFLNK }, rawName, method, flags, crc, comp, uncomp, local })
      p = end
    }
    if (p !== cd.length) bad('the central directory has more in it than its entries')

    // Every local header where the directory says, agreeing with it on everything a streaming unpacker
    // uses, packed end to end from offset 0 up to the directory: no entry an unpacker could find that
    // this list does not have, and no entry it would size differently.
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
      let lcomp = head.readUInt32LE(18)
      let luncomp = head.readUInt32LE(22)
      // A zip64 local header saturates both sizes and carries them, uncompressed first, in its 0x0001 field.
      if (lcomp === 0xffffffff || luncomp === 0xffffffff) {
        const extra = read(r.local + 30 + nameLen, extraLen)
        let found = false
        for (let q = 0; q + 4 <= extra.length;) {
          const id = extra.readUInt16LE(q)
          const len = extra.readUInt16LE(q + 2)
          if (q + 4 + len > extra.length) bad('a broken local extra field')
          if (id === 0x0001) {
            let at = q + 4
            const next = (): number => {
              if (at + 8 > q + 4 + len) bad('a short zip64 local extra field')
              const v = safeNumber(extra.readBigUInt64LE(at), 'a local size')
              at += 8
              return v
            }
            if (luncomp === 0xffffffff) luncomp = next()
            if (lcomp === 0xffffffff) lcomp = next()
            found = true
          }
          q += 4 + len
        }
        if (!found) bad('zip64 local sizes without a zip64 extra field')
      }
      if (head.readUInt16LE(6) !== r.flags || head.readUInt16LE(8) !== r.method || head.readUInt32LE(14) !== r.crc
        || lcomp !== r.comp || luncomp !== r.uncomp) {
        bad(`the local header of ${r.entry.name} disagrees with the directory`)
      }
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
        r.entry.target = decodeName(target, 'a symlink target')
      }
      if (r.method === 8) await checkDeflate(path, dataStart, r.comp, r.uncomp, r.crc, r.entry.name)
      const next = i + 1 < byOffset.length ? byOffset[i + 1]!.local : cdOffset
      if (next !== dataEnd) bad('there is data between entries')
      expected = next
    }
    if (byOffset.length === 0 && cdOffset !== 0) bad('there is data before the central directory')
    return raws.map(r => r.entry)
  } finally {
    closeSync(fd)
  }
}

/**
 * APFS is case-insensitive by default, so two spellings of one path are one path. Names are ASCII by
 * the time they get here (`decodeName`), so ASCII lowercasing is the file system's own folding.
 */
const keyOf = (parts: readonly string[]): string => parts.join('/').toLowerCase()

/**
 * The first reason an entry could land outside the folder the zip is unpacked into, or `undefined`
 * when none can.
 *
 * Refused: an empty, absolute or backslashed name, anything but printable ASCII, any `.` or `..` or empty
 * component, two entries for one path, any entry whose path passes through a symlink entry, and a
 * symlink whose target - resolved through the archive's other links, as the file system would - is
 * absolute, leaves the folder, or lands on nothing the archive lists. A link may point at another
 * link; a chain that loops is refused.
 */
export function unsafeZipEntry(entries: readonly ZipEntry[]): string | undefined {
  const seen = new Set<string>()
  const links = new Map<string, { dir: string[]; target: string }>()
  const paths: Array<{ name: string; parts: string[] }> = []
  for (const e of entries) {
    const name = e.name
    if (name === '' || name.startsWith('/')) return `${JSON.stringify(name)} is absolute or empty`
    if (name.includes('\\')) return `${JSON.stringify(name)} contains a backslash`
    if (/[^\x20-\x7e]/.test(name)) return `${JSON.stringify(name)} has a character that is not printable ASCII`
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

  // Every path the archive lists, and every folder above one: what a link may land on.
  const present = new Set<string>()
  for (const { parts } of paths) for (let i = 1; i <= parts.length; i++) present.add(keyOf(parts.slice(0, i)))

  for (const [key, link] of links) {
    if (/[^\x20-\x7e]/.test(link.target)) return `the symlink ${key} has a character in its target that is not printable ASCII`
    const landed = resolve(link.dir, link.target, 0)
    if (!landed) return `the symlink ${key} -> ${link.target} points outside the folder`
    // A genuine app has no dangling links; and a link to the folder itself is a step away from its parent.
    if (landed.length === 0 || !present.has(keyOf(landed))) return `the symlink ${key} -> ${link.target} points at nothing the archive lists`
  }
  return undefined
}

/**
 * The ground truth, after `ditto` has run: the first reason the unpacked tree at `root` is not what
 * the archive listed, or `undefined` when it is.
 *
 * Walked with `lstat`, never following a link. Every file, directory and link found must be one the
 * directory listed, as the same kind (a directory may also be implied by a listed path below it), and
 * nothing else may exist - which also refuses AppleDouble `._*` files `ditto` would make from
 * `__MACOSX` entries; the release archiver writes none. Every link's target is resolved twice: lexically
 * against its own directory, and through libc's `realpath`, so a chain of links that only escapes once
 * the file system follows it is still caught. Either leaving `root` is a refusal, and so is a link that
 * does not resolve at all: a genuine app has no dangling or looping links, and a dangling one cannot be
 * judged by where it would lead.
 */
export function unsafeUnpackedTree(root: string, entries: readonly ZipEntry[]): string | undefined {
  const listed = new Map<string, 'dir' | 'file' | 'link'>()
  const implied = new Set<string>()
  for (const e of entries) {
    const parts = (e.name.endsWith('/') ? e.name.slice(0, -1) : e.name).split('/')
    listed.set(keyOf(parts), e.isSymlink ? 'link' : e.name.endsWith('/') ? 'dir' : 'file')
    for (let i = 1; i < parts.length; i++) implied.add(keyOf(parts.slice(0, i)))
  }
  const absRoot = resolvePath(root)
  let realRoot: string
  try { realRoot = realpathSync.native(absRoot) } catch { return 'the unpacked folder is missing' }
  const inside = (base: string, p: string) => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep)

  const walk = (dir: string): string | undefined => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = relative(absRoot, abs)
      const key = keyOf(rel.split(sep))
      const st = lstatSync(abs)
      const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : undefined
      if (kind === undefined) return `${rel} is neither a file, a folder nor a link`
      const want = listed.get(key)
      const ok = want === kind || (kind === 'dir' && want === undefined && implied.has(key))
      if (!ok) return `${rel} is a ${kind} the archive did not list as one`
      if (kind === 'link') {
        const target = readlinkSync(abs)
        if (!inside(absRoot, resolvePath(dirname(abs), target))) return `${rel} -> ${target} points outside the folder`
        let real: string
        // `.native` is libc's realpath, which asks the kernel. Node's own JS `realpathSync` normalizes
        // each link's target lexically (`x/..` becomes `.`), which is exactly the chain this must catch.
        try { real = realpathSync.native(abs) } catch { return `${rel} -> ${target} does not resolve` }
        if (!inside(realRoot, real)) return `${rel} -> ${target} resolves outside the folder`
      } else if (kind === 'dir') {
        const why = walk(abs)
        if (why) return why
      }
    }
    return undefined
  }
  return walk(absRoot)
}
