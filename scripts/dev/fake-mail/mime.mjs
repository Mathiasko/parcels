// Minimal RFC 822 / MIME writer for the fake-mail corpus. Dev tool only (see README.md here).
// Builds messages byte-for-byte so the encodings real carriers use (quoted-printable, base64,
// ISO-8859-2, windows-1250, mis-declared charsets) can be reproduced on purpose.
import iconv from 'iconv-lite'
import libqp from 'libqp'

const CRLF = '\r\n'

/** S10 (UPU) check digit, as Slovenská pošta numbers carry it. */
export function s10(prefix, eight, suffix = 'SK') {
  const w = [8, 6, 4, 2, 3, 5, 9, 7]
  const sum = [...eight].reduce((a, d, i) => a + w[i] * Number(d), 0)
  const raw = 11 - (sum % 11)
  const cd = raw === 10 ? 0 : raw === 11 ? 5 : raw
  return `${prefix}${eight}${cd}${suffix}`
}

/** Europe/Bratislava wall time -> RFC 2822 date with the right offset (DST ends 2026-10-25 03:00). */
export function rfcDate(local) {
  // local: 'YYYY-MM-DD HH:MM'
  const [d, t] = local.split(' ')
  const naive = new Date(`${d}T${t}:00Z`)
  const summer = naive < new Date('2026-10-25T03:00:00Z') && naive > new Date('2026-03-29T02:00:00Z')
  const off = summer ? 2 : 1
  const utc = new Date(naive.getTime() - off * 3600_000)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = n => String(n).padStart(2, '0')
  const wd = days[naive.getUTCDay()]
  return { header: `${wd}, ${naive.getUTCDate()} ${months[naive.getUTCMonth()]} ${naive.getUTCFullYear()} ${p(naive.getUTCHours())}:${p(naive.getUTCMinutes())}:${p(Number(d.slice(8)) % 60)} +0${off}00`, utc }
}

/** One RFC 2047 encoded-word run for a header, in the given charset and encoding. */
export function encodeWords(text, charset = 'utf-8', enc = 'Q') {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const bytes = iconv.encode(text, charset)
  // Split into chunks so no encoded word exceeds ~75 chars; never split a UTF-8 sequence.
  const words = []
  let chunk = []
  const flush = () => {
    if (!chunk.length) return
    const b = Buffer.from(chunk)
    const body = enc === 'B'
      ? b.toString('base64')
      : [...b].map(c => (c === 0x20 ? '_' : (c >= 0x21 && c <= 0x7e && !'=?_'.includes(String.fromCharCode(c))) ? String.fromCharCode(c) : `=${c.toString(16).toUpperCase().padStart(2, '0')}`)).join('')
    words.push(`=?${charset}?${enc}?${body}?=`)
    chunk = []
  }
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    const isStart = charset.toLowerCase() !== 'utf-8' || (c & 0xc0) !== 0x80
    if (isStart && chunk.length >= (enc === 'B' ? 36 : 18)) flush()
    chunk.push(c)
  }
  flush()
  return words.join(`${CRLF} `)
}

const wrap76 = s => s.replace(/(.{76})/g, `$1${CRLF}`)

/** A leaf part: headers + encoded body. `bytesCharset` lets a mail lie about its charset. */
function leaf({ type, body, charset = 'utf-8', encoding = 'quoted-printable', bytesCharset, filename, disposition }) {
  const buf = Buffer.isBuffer(body) ? body : iconv.encode(body.replace(/\r?\n/g, CRLF), bytesCharset ?? charset)
  let encoded
  if (encoding === 'base64') encoded = wrap76(buf.toString('base64'))
  else if (encoding === 'quoted-printable') encoded = libqp.wrap(libqp.encode(buf), 76)
  else encoded = buf.toString('latin1')     // 8bit / 7bit: raw bytes
  const ct = filename
    ? `Content-Type: ${type}; name="${filename}"`
    : `Content-Type: ${type}${type.startsWith('text/') ? `; charset=${charset}` : ''}`
  const lines = [ct, `Content-Transfer-Encoding: ${encoding}`]
  if (filename) lines.push(`Content-Disposition: ${disposition ?? 'attachment'}; filename="${filename}"`)
  return { head: lines.join(CRLF), body: encoded }
}

let boundarySeq = 0
const boundary = tag => `----=_Part_${tag}_${(++boundarySeq).toString(36)}${'x'.repeat(4)}.fake`

function multipart(subtype, parts, tag) {
  const b = boundary(tag)
  const body = parts.map(p => `--${b}${CRLF}${p.head}${CRLF}${CRLF}${p.body}${CRLF}`).join('') + `--${b}--${CRLF}`
  return { head: `Content-Type: multipart/${subtype};${CRLF} boundary="${b}"`, body }
}

/**
 * spec: { from, to, date (local 'YYYY-MM-DD HH:MM'), subject, messageId, text?, html?, charset?,
 *   encoding?, bytesCharset?, subjectCharset?, subjectEnc?, rawSubject?, attachments?, extraHeaders? }
 * Returns the .eml as a Buffer (latin1 transport of 7bit-safe content, raw bytes for 8bit parts).
 */
export function buildEml(spec) {
  const { header: date } = rfcDate(spec.date)
  const charset = spec.charset ?? 'utf-8'
  const encoding = spec.encoding ?? 'quoted-printable'
  const parts = []
  if (spec.text !== undefined) parts.push(leaf({ type: 'text/plain', body: spec.text, charset, encoding, bytesCharset: spec.bytesCharset }))
  if (spec.html !== undefined) parts.push(leaf({ type: 'text/html', body: spec.html, charset, encoding: spec.htmlEncoding ?? encoding, bytesCharset: spec.bytesCharset }))
  let root = parts.length === 1 ? parts[0] : parts.length > 1 ? multipart('alternative', parts, 'alt') : undefined
  if (spec.attachments?.length) {
    const atts = spec.attachments.map(a => leaf({ type: a.type, body: a.body, encoding: 'base64', filename: a.filename }))
    root = multipart('mixed', root ? [root, ...atts] : atts, 'mix')
  }
  const subject = spec.rawSubject ?? encodeWords(spec.subject, spec.subjectCharset ?? 'utf-8', spec.subjectEnc ?? 'Q')
  // Display names with non-ASCII must be encoded words (RFC 2047), never raw bytes.
  const fromHeader = spec.from.replace(/^"?([^"<]*?)"?\s*<([^>]+)>$/, (all, name, addr) =>
    /^[\x20-\x7e]*$/.test(name) ? all : `${encodeWords(name, spec.fromCharset ?? 'utf-8', 'Q')} <${addr}>`)
  const headers = [
    `Delivered-To: ${spec.deliveredTo ?? 'jana.testova@example.com'}`,
    `Received: by 2002:a05:fake:0:0:0:0 with SMTP id fake${(++boundarySeq).toString(36)};${CRLF}        ${date}`,
    `Return-Path: <${spec.returnPath ?? (/<([^>]+)>/.exec(fromHeader)?.[1] ?? fromHeader)}>`,
    `Date: ${date}`,
    `From: ${fromHeader}`,
    `To: ${spec.to ?? 'Jana =?utf-8?Q?Testov=C3=A1?= <jana.testova@example.com>'}`,
    `Subject: ${subject}`,
    `Message-ID: ${spec.messageId}`,
    'MIME-Version: 1.0',
    ...(spec.extraHeaders ?? []),
    root.head,
  ]
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${root.body}`, 'latin1')
}
