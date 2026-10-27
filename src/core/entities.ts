const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Decodes the HTML entities that turn up in carrier and mail text: the few named ones, and numeric
 * ones in decimal (`&#268;`) or hex (`&#x10C;`). Anything unrecognised or out of range is left as it
 * was, so a stray `&` never corrupts a string.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string, hex: string, name: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole
    const code = dec ? Number(dec) : parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}
