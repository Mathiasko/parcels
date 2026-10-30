// Decides which mails the repo's gmail-filter.xml would label `parcels`, so the simulated mailbox has
// what a real one has: an inbox with everything, and a label holding only what the filter matched.
// The app reads only the label. This evaluates the filter's one `hasTheWord` query with Gmail's rules
// as far as they matter here: case and diacritics ignored, whole words (no stemming), quoted phrases
// as consecutive words, `from:` matching the sender's address or domain, implicit AND, OR, parentheses.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const words = s => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

function tokenize(q) {
  const out = []
  const re = /\s*(\(|\)|"[^"]*"|[^\s()"]+)/y
  let m
  while ((m = re.exec(q))) out.push(m[1])
  return out
}

// Grammar: or := and (OR and)* ; and := unary (AND? unary)* ; unary := field:(or) | field:term | (or) | term
function parse(tokens) {
  let i = 0
  const peek = () => tokens[i]
  function or(field) {
    const parts = [and(field)]
    while (peek() === 'OR') { i++; parts.push(and(field)) }
    return parts.length === 1 ? parts[0] : { op: 'or', parts }
  }
  function and(field) {
    const parts = [unary(field)]
    for (;;) {
      if (peek() === 'AND') { i++; parts.push(unary(field)); continue }
      if (peek() === undefined || peek() === ')' || peek() === 'OR') break
      parts.push(unary(field))
    }
    return parts.length === 1 ? parts[0] : { op: 'and', parts }
  }
  function unary(field) {
    const t = tokens[i++]
    if (t === '(') { const e = or(field); i++; return e }
    const f = /^(from|subject):(.*)$/.exec(t)
    if (f) {
      if (f[2] === '') { i++; const e = or(f[1]); i++; return e }   // from:( ... )
      return { op: 'term', field: f[1], value: f[2] }
    }
    return { op: 'term', field: field ?? 'any', value: t.replace(/^"|"$/g, '') }
  }
  return or(undefined)
}

function evaluate(node, mail) {
  if (node.op === 'or') return node.parts.some(p => evaluate(p, mail))
  if (node.op === 'and') return node.parts.every(p => evaluate(p, mail))
  const v = fold(node.value)
  if (node.field === 'from') {
    const addr = fold(mail.fromAddress)
    const domain = addr.split('@')[1] ?? ''
    return addr === v || domain === v || domain.endsWith(`.${v}`)
  }
  const hay = node.field === 'subject' ? words(mail.subject) : words(`${mail.subject} ${mail.body ?? ''}`)
  const want = words(v)
  if (want.length === 0) return false
  for (let k = 0; k + want.length <= hay.length; k++) if (want.every((w, j) => hay[k + j] === w)) return true
  return false
}

let compiled
/** The filter's query, parsed once from the repo's gmail-filter.xml (read only). */
export function filterQuery(root) {
  if (!compiled) {
    const xml = readFileSync(join(root, 'gmail-filter.xml'), 'utf8')
    const m = /name='hasTheWord' value='([^']*)'/.exec(xml)
    if (!m) throw new Error('gmail-filter.xml: no hasTheWord property')
    const q = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    compiled = parse(tokenize(q))
  }
  return compiled
}

/** `from` is a header value ('Name <a@b>' or 'a@b'). True when the filter would label this mail. */
export function labelled(root, { from, subject }) {
  const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from.trim()
  return evaluate(filterQuery(root), { fromAddress, subject: subject ?? '' })
}
