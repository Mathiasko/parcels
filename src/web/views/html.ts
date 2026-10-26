/**
 * Every piece of text shown on a page - labels, merchants, carrier descriptions - originates in
 * untrusted email or carrier responses, so escaping is structural rather than a habit: the `html`
 * tag escapes every interpolated value, and the only way to emit markup is to nest another `Html`
 * (the result of `html`, or `raw` for a trusted constant).
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string { return this.value }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Safe for element content and for quoted attribute values alike. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ESCAPES[c]!)
}

/** Marks a trusted string (a static fragment, never data) as already-safe markup. */
export const raw = (value: string): Html => new Html(value)

type Interpolation = Html | string | number | boolean | null | undefined | readonly Interpolation[]

function render(v: Interpolation): string {
  if (v instanceof Html) return v.value
  if (Array.isArray(v)) return v.map(render).join('')
  if (v === null || v === undefined || v === false) return ''
  return escapeHtml(v)
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  return new Html(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]!) : ''), ''))
}
