import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * `gmail-filter.xml` is the importable Gmail filter that fills the `parcels` label. It is not code,
 * but it has exactly one way of being catastrophically wrong, and it fails silently: Gmail's filter
 * form ANDs its From / Subject / Has-the-words boxes together, so a filter split across them matches
 * no message at all and looks identical to "no parcels have arrived". These tests pin the shape that
 * cannot do that - one field, one OR-expression, no field-restricting operator inside it.
 */
const FILE = fileURLToPath(new URL('../gmail-filter.xml', import.meta.url))
const xml = readFileSync(FILE, 'utf8')

/** Every `<apps:property name='..' value='..'/>`, in order. Gmail's export quotes attributes with '. */
const properties = (): Array<[string, string]> =>
  [...xml.matchAll(/<apps:property\s+name='([^']*)'\s+value='([^']*)'\s*\/>/g)].map(m => [m[1]!, m[2]!])

const prop = (name: string): string | undefined => properties().find(([n]) => n === name)?.[1]

describe('gmail-filter.xml', () => {
  test('is well-formed XML', () => {
    const r = spawnSync('/usr/bin/xmllint', ['--noout', FILE], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  test('is one Atom filter entry in Gmail\'s own export format', () => {
    expect(xml).toContain("xmlns:apps='http://schemas.google.com/apps/2006'")
    expect(xml.match(/<entry>/g)).toHaveLength(1)
    expect(xml).toContain("<category term='filter'>")
  })

  test('applies the parcels label', () => {
    expect(prop('label')).toBe('parcels')
  })

  // The one that matters: the whole query in `hasTheWord`, and no second field to be ANDed with it.
  test('the query lives in a single field', () => {
    const names = properties().map(([n]) => n)
    expect(names).toContain('hasTheWord')
    for (const field of ['from', 'to', 'subject', 'doesNotHaveTheWord']) {
      expect(names).not.toContain(field)
    }
    // No other property carries search terms either - exactly one field holds an OR-expression.
    expect(properties().filter(([, v]) => / OR /.test(v))).toHaveLength(1)
  })

  test('the query contains no from: or subject: restriction to AND with the rest', () => {
    const q = prop('hasTheWord')!
    expect(q).not.toMatch(/\bfrom:/)
    expect(q).not.toMatch(/\bsubject:/)
    expect(q).not.toMatch(/\bto:/)
    expect(q).not.toMatch(/\blabel:/)
    expect(q).not.toMatch(/\bAND\b/)
    expect(q).not.toMatch(/\s-\w/)                     // no negated term either
  })

  test('the query is a single OR-expression with balanced quoting', () => {
    const q = prop('hasTheWord')!
    const terms = q.split(' OR ')
    expect(terms.length).toBeGreaterThan(20)
    expect(terms.every(t => t.trim() !== '')).toBe(true)
    expect((q.match(/"/g) ?? []).length % 2).toBe(0)   // every phrase is closed
    expect(q).not.toContain('(')                       // nothing to group: it is one flat OR
    expect(q).not.toContain(')')
  })

  test('covers all five carriers', () => {
    const q = prop('hasTheWord')!
    for (const domain of ['packeta.sk', 'packeta.com', 'posta.sk', 'gls-group.eu', 'sps-sro.sk', 'dpd.sk']) {
      expect(q).toContain(domain)
    }
  })

  /**
   * The shop's own dispatch mail is often the first notice of a parcel and sometimes the only one,
   * so carrier domains alone are not enough. Gmail does not stem, hence the word forms.
   */
  test('covers e-shop dispatch wording, in several word forms', () => {
    const q = prop('hasTheWord')!
    for (const word of ['odoslana', 'odoslane', 'odoslany', 'expedovana', 'expedovane', 'shipped', 'dispatched']) {
      expect(q.split(/[ "]+/)).toContain(word)
    }
    expect(q).toContain('"tracking number"')
    expect(q).toContain('"cislo zasielky"')
  })

  // Gmail ignores diacritics, so the file can stay plain ASCII - which also keeps it safe to paste
  // through anything with an opinion about encodings.
  test('the query is plain ASCII, since Gmail ignores diacritics', () => {
    expect(prop('hasTheWord')!).toMatch(/^[\x20-\x7e]+$/)
  })
})
