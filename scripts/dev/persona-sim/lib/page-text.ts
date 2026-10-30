// Turns a served page into what a person sees: its visible text (no head, style, hidden or screen-reader-only
// text), then its links and its forms (action, method, every field with its current value, every button),
// each form with a ready-to-run `sim post` line. Pages have no JavaScript, so this is the whole UI.
import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element } from 'domhandler'

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'form', 'fieldset', 'details', 'summary', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'blockquote', 'pre', 'address', 'legend', 'label'])
const SKIP = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link'])
const HIDDEN_CLASSES = new Set(['vh', 'pick-t'])

const isEl = (n: ChildNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style'
const attr = (e: Element, k: string) => e.attribs?.[k]
const classes = (e: Element) => (attr(e, 'class') ?? '').split(/\s+/)

function hidden(e: Element): boolean {
  if (SKIP.has(e.name)) return true
  if (attr(e, 'hidden') !== undefined || attr(e, 'aria-hidden') === 'true') return true
  if (/display\s*:\s*none/i.test(attr(e, 'style') ?? '')) return true
  if (e.name === 'input' && attr(e, 'type') === 'hidden') return true
  return classes(e).some(c => HIDDEN_CLASSES.has(c))
}

function textOf(n: ChildNode): string {
  if (n.type === 'text') return (n as unknown as { data: string }).data
  if (!isEl(n) || hidden(n)) return ''
  return n.children.map(textOf).join('')
}

const decode = (s: string) => s.replace(/\s+/g, ' ')

interface Field { name: string; type: string; value: string; label?: string; options?: string[]; checked?: boolean; required?: boolean }
interface Button { name?: string; value?: string; label: string }
interface Form { action: string; method: string; fields: Field[]; buttons: Button[]; heading?: string }

export function pageText(html: string, path: string): { text: string; links: Array<[string, string]>; forms: Form[] } {
  const doc = parseDocument(html, { decodeEntities: true })
  const lines: string[] = []
  let cur = ''
  const flush = () => { const t = cur.replace(/[ \t]+/g, ' ').trim(); if (t) lines.push(t); cur = '' }
  const links: Array<[string, string]> = []
  const forms: Form[] = []
  let lastHeading = ''
  const labelFor = new Map<string, string>()
  // Forms by id, made on first mention: a button outside a form names it with form="id", maybe before it.
  const formsById = new Map<string, Form>()
  let formSeq = 0
  const byId = (id: string): Form => {
    let f = formsById.get(id)
    if (!f) { f = { action: path, method: 'GET', fields: [], buttons: [] }; formsById.set(id, f) }
    return f
  }

  // label[for] texts first
  const collectLabels = (n: ChildNode) => {
    if (!isEl(n)) return
    if (n.name === 'label' && attr(n, 'for')) labelFor.set(attr(n, 'for')!, decode(textOf(n)).trim())
    n.children.forEach(collectLabels)
  }
  doc.children.forEach(collectLabels)

  const walk = (n: ChildNode, form?: Form, label?: string, depth = 0) => {
    if (n.type === 'text') { cur += decode((n as unknown as { data: string }).data); return }
    if (!isEl(n)) return
    const e = n
    if (e.name === 'input' && attr(e, 'type') === 'hidden' && form) {
      form.fields.push({ name: attr(e, 'name') ?? '', type: 'hidden', value: attr(e, 'value') ?? '' })
      return
    }
    if (hidden(e)) return
    const block = BLOCK.has(e.name)
    if (block) flush()
    switch (e.name) {
      case 'br': flush(); return
      case 'hr': flush(); lines.push('────────'); return
      case 'img': { const alt = attr(e, 'alt'); if (alt) cur += ` [image: ${alt}] `; return }
      case 'a': {
        const href = attr(e, 'href') ?? ''
        const t = decode(textOf(e)).trim()
        cur += ` [${t || href} → ${href}] `
        if (href) links.push([t || href, href])
        return
      }
      case 'button': {
        const t = decode(textOf(e)).trim()
        cur += ` [button: ${t}] `
        const owner = attr(e, 'form') ? byId(attr(e, 'form')!) : form
        owner?.buttons.push({ ...(attr(e, 'name') && { name: attr(e, 'name') }), ...(attr(e, 'value') !== undefined && { value: attr(e, 'value') }), label: t })
        return
      }
      case 'input': {
        const type = attr(e, 'type') ?? 'text'
        const name = attr(e, 'name') ?? ''
        const value = attr(e, 'value') ?? ''
        const lab = label ?? labelFor.get(attr(e, 'id') ?? '') ?? attr(e, 'aria-label') ?? attr(e, 'placeholder')
        if (type === 'submit' || type === 'button') {
          cur += ` [button: ${value || 'Submit'}] `
          form?.buttons.push({ ...(name && { name }), value, label: value || 'Submit' })
          return
        }
        const checked = attr(e, 'checked') !== undefined
        if (type === 'checkbox' || type === 'radio') cur += ` [${checked ? 'x' : ' '}] `
        else cur += ` [${type} field${value ? `: "${value}"` : ''}${attr(e, 'placeholder') ? ` (placeholder "${attr(e, 'placeholder')}")` : ''}] `
        form?.fields.push({ name, type, value: type === 'checkbox' && !value ? 'on' : value, ...(lab && { label: lab }), ...((type === 'checkbox' || type === 'radio') && { checked }), ...(attr(e, 'required') !== undefined && { required: true }) })
        return
      }
      case 'textarea': {
        const v = textOf(e)
        cur += ` [text area${v ? `: "${v.trim()}"` : ''}] `
        form?.fields.push({ name: attr(e, 'name') ?? '', type: 'textarea', value: v, ...(label && { label }) })
        return
      }
      case 'select': {
        const opts = e.children.filter(isEl).flatMap(o => o.name === 'optgroup' ? o.children.filter(isEl) : [o]).filter(o => o.name === 'option')
        const sel = opts.find(o => attr(o, 'selected') !== undefined) ?? opts[0]
        const val = (o: Element) => attr(o, 'value') ?? decode(textOf(o)).trim()
        cur += ` [choice: ${sel ? decode(textOf(sel)).trim() : ''} ▾] `
        form?.fields.push({ name: attr(e, 'name') ?? '', type: 'select', value: sel ? val(sel) : '', options: opts.map(o => `${val(o)}${decode(textOf(o)).trim() !== val(o) ? ` (${decode(textOf(o)).trim()})` : ''}`), ...(label && { label }) })
        return
      }
      case 'form': {
        const f = byId(attr(e, 'id') ?? `#${formSeq++}`)
        Object.assign(f, { action: attr(e, 'action') ?? path, method: (attr(e, 'method') ?? 'get').toUpperCase(), ...(lastHeading && { heading: lastHeading }) })
        forms.push(f)
        cur += ` {form ${forms.length}} `
        e.children.forEach(c => walk(c, f, undefined, depth + 1))
        flush()
        return
      }
      case 'label': {
        // The label's own words: what comes before its control (the hint after it is not part of the name).
        const ctl = e.children.findIndex(c => isEl(c) && ['input', 'select', 'textarea'].includes(c.name))
        const before = decode((ctl >= 0 ? e.children.slice(0, ctl) : e.children).map(textOf).join(' ')).trim()
        const own = before || (ctl >= 0 ? decode(e.children.slice(ctl + 1).map(textOf).join(' ')).trim() : '')
        e.children.forEach(c => walk(c, form, own || label, depth + 1))
        flush()
        return
      }
      case 'li': cur += '• '; break
      case 'td': case 'th': cur += ' | '; break
      case 'details': {
        const summary = e.children.find(c => isEl(c) && c.name === 'summary') as Element | undefined
        const open = attr(e, 'open') !== undefined
        lines.push(`▸ ${summary ? decode(textOf(summary)).trim() : 'Details'}${open ? '' : '   (collapsed; a click on it shows:)'}`)
        const before = lines.length
        e.children.filter(c => c !== summary).forEach(c => walk(c, form, label, depth + 1))
        flush()
        for (let i = before; i < lines.length; i++) lines[i] = `    ${lines[i]}`
        return
      }
    }
    if (/^h[1-6]$/.test(e.name)) {
      lastHeading = decode(textOf(e)).trim()
      // Walked, not flattened: a heading can hold a link (a parcel's name links to its page).
      cur = `${'#'.repeat(Number(e.name[1]))} `
      e.children.forEach(c => walk(c, form, label, depth + 1))
      flush()
      return
    }
    e.children.forEach(c => walk(c, form, label, depth + 1))
    if (block) flush()
  }
  doc.children.forEach(c => walk(c))
  flush()
  const text = lines.map(l => l.replace(/\s+\|/g, ' |').replace(/^\|\s*/, '')).filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
  return { text, links, forms }
}

const q = (s: string) => (/^[\w./:@,+-]*$/.test(s) && s !== '' ? s : `'${s.replace(/'/g, `'\\''`)}'`)

export function formatPage(html: string, path: string, status: number): string {
  const { text, links, forms } = pageText(html, path)
  const out = [`PAGE ${path}  (HTTP ${status})`, '', text, '']
  if (links.length) {
    out.push('LINKS (open with: sim text <path>)')
    const seen = new Set<string>()
    for (const [t, h] of links) { const k = `${t}|${h}`; if (seen.has(k)) continue; seen.add(k); out.push(`  ${t} → ${h}`) }
    out.push('')
  }
  if (forms.length) {
    out.push('FORMS (submit with: sim post <action> name=value ...)')
    forms.forEach((f, i) => {
      out.push(`  [form ${i + 1}] ${f.method} ${f.action}${f.heading ? `   (under "${f.heading}")` : ''}`)
      for (const fl of f.fields) {
        const extra = fl.type === 'select' ? ` options: ${fl.options!.join(' | ')}` : fl.type === 'checkbox' || fl.type === 'radio' ? ` (${fl.checked ? 'checked' : 'unchecked'})` : ''
        out.push(`     field ${fl.name || '(unnamed)'} [${fl.type}${fl.required ? ', required' : ''}] = "${fl.value}"${fl.label ? `  label "${fl.label}"` : ''}${extra}`)
      }
      for (const b of f.buttons) out.push(`     button "${b.label}"${b.name ? ` sends ${b.name}=${b.value ?? ''}` : ''}`)
      if (f.method === 'POST') {
        const sent = new Map<string, string>()
        for (const fl of f.fields) {
          if (!fl.name) continue
          if ((fl.type === 'checkbox' || fl.type === 'radio') && !fl.checked) continue
          if (fl.type === 'radio' && sent.has(fl.name)) continue
          sent.set(fl.name, fl.value)
        }
        const btns = f.buttons.length ? f.buttons : [{ label: 'Submit' } as Button]
        for (const b of btns) {
          const parts = [...sent].map(([k, v]) => `${k}=${q(v)}`)
          if (b.name) parts.push(`${b.name}=${q(b.value ?? '')}`)
          out.push(`     → as is, "${b.label}": sim post ${f.action.replace(/#.*$/, '')} ${parts.join(' ')}`.trimEnd())
        }
      }
    })
  }
  return out.join('\n')
}
