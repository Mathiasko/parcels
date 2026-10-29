import { crc32, deflateRawSync } from 'node:zlib'

/**
 * A minimal zip writer for tests, so crafted archives (`../evil`, a symlink out of the folder, a name
 * that differs between the local header and the directory) can be built without any external tool.
 * Unix "version made by", modes in the external attributes, optional deflate, optional zip64 records.
 */
export interface WriteEntry {
  name: string
  /** File contents; a directory is a name ending in `/`. */
  data?: string | Buffer
  /** Makes this a symlink with this target (stored as the entry's data). */
  link?: string
  deflate?: boolean
  /** Written as a local entry but left out of the central directory. */
  hidden?: boolean
  /** A different name in the local header than in the central directory. */
  localName?: string
  /** Values the local header claims instead of the true ones (the central directory keeps the truth). */
  local?: { comp?: number; flags?: number; crc?: number; method?: number }
  /** General-purpose flags for both headers (default 0x0800, UTF-8 names). */
  flags?: number
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }

export function makeZip(entries: WriteEntry[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let count = 0
  for (const e of entries) {
    const isDir = e.name.endsWith('/')
    const raw = Buffer.from(e.link ?? e.data ?? '')
    const body = e.deflate ? deflateRawSync(raw) : raw
    const method = e.deflate ? 8 : 0
    const mode = e.link !== undefined ? 0o120755 : isDir ? 0o040755 : 0o100644
    const external = ((mode << 16) | (isDir ? 0x10 : 0)) >>> 0
    const name = Buffer.from(e.name)
    const localName = Buffer.from(e.localName ?? e.name)
    const crc = crc32(raw)
    const z = opts.zip64
    const flags = e.flags ?? 0x0800
    const lc = e.local?.comp
    const local = Buffer.concat([
      u32(0x04034b50), u16(45), u16(e.local?.flags ?? flags), u16(e.local?.method ?? method), u16(0), u16(0),
      u32(e.local?.crc ?? crc),
      u32(z ? 0xffffffff : lc ?? body.length), u32(z ? 0xffffffff : lc ?? raw.length),
      u16(localName.length), u16(z ? 20 : 0), localName,
      ...(z ? [u16(0x0001), u16(16), u64(raw.length), u64(body.length)] : []),
      body,
    ])
    if (!e.hidden) {
      centrals.push(Buffer.concat([
        u32(0x02014b50), u16((3 << 8) | 45), u16(45), u16(flags), u16(method), u16(0), u16(0), u32(crc),
        u32(z ? 0xffffffff : body.length), u32(z ? 0xffffffff : raw.length),
        u16(name.length), u16(z ? 28 : 0), u16(0), u16(0), u16(0), u32(external), u32(z ? 0xffffffff : offset),
        name,
        ...(z ? [u16(0x0001), u16(24), u64(raw.length), u64(body.length), u64(offset)] : []),
      ]))
      count++
    }
    locals.push(local)
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const cdOffset = offset
  const tail: Buffer[] = []
  if (opts.zip64) {
    const recAt = cdOffset + cd.length
    tail.push(
      u32(0x06064b50), u64(44), u16((3 << 8) | 45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(cd.length), u64(cdOffset),
      u32(0x07064b50), u32(0), u64(recAt), u32(1),
    )
  }
  tail.push(
    u32(0x06054b50), u16(0), u16(0),
    u16(opts.zip64 ? 0xffff : count), u16(opts.zip64 ? 0xffff : count),
    u32(opts.zip64 ? 0xffffffff : cd.length), u32(opts.zip64 ? 0xffffffff : cdOffset), u16(0),
  )
  return Buffer.concat([...locals, cd, ...tail])
}

/**
 * A bare local header and its stored data, for smuggling an entry inside another entry's data: what a
 * streaming unpacker that trusts the local sizes would find, and the central directory never lists.
 */
export function localHeader(name: string, data: string): Buffer {
  const n = Buffer.from(name)
  const d = Buffer.from(data)
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc32(d)), u32(d.length), u32(d.length),
    u16(n.length), u16(0), n, d,
  ])
}

/** A zip shaped like the real app: a framework with its in-tree symlinks, which must be accepted. */
export const LEGIT_APP: WriteEntry[] = [
  { name: 'Parcels.app/' },
  { name: 'Parcels.app/Contents/' },
  { name: 'Parcels.app/Contents/Info.plist', data: '<plist/>' },
  { name: 'Parcels.app/Contents/Frameworks/' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/A/' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/A/X', data: 'binary', deflate: true },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/A/Resources/' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/A/Resources/Info.plist', data: '<plist/>' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Versions/Current', link: 'A' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/X', link: 'Versions/Current/X' },
  { name: 'Parcels.app/Contents/Frameworks/X.framework/Resources', link: 'Versions/Current/Resources', deflate: true },
]
