import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * `gmail-filter.xml` is the importable Gmail filter that fills the `parcels` label. It is not code,
 * but it has exactly one way of being catastrophically wrong, and it fails silently: Gmail's filter
 * form ANDs its From / Subject / Has-the-words boxes together, so a filter split across them matches
 * no message at all and looks identical to "no parcels have arrived". These tests pin the shape that
 * cannot do that - one field, one OR-expression. Operators inside it are fine and necessary:
 * they still OR, and without them a bare term matches the whole message body.
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

  test('operators scope the terms, and they live inside the single field', () => {
    // A bare term is matched against the WHOLE MESSAGE, not just its headers. The first version of
    // this filter relied on that and labelled 95 unrelated mails in one import: "na ceste" is
    // everyday Slovak for "on the way", so a friend's email and an Airbnb receipt both matched.
    // Operators are therefore required - but INSIDE hasTheWord, where they still OR. The trap this
    // file exists to avoid is splitting them across Gmail's From and Subject boxes, which ANDs.
    const q = prop('hasTheWord')!
    expect(q).toMatch(/^from:\(/)
    expect(q).toMatch(/\bOR subject:\(/)
    // A shop's domain alone labels everything it sends - order confirmations, cancellations,
    // marketing. Shops are therefore ANDed with shipping wording; only carriers stand on their
    // sender alone. Measured on the real mailbox: 430 labelled without this, 220 with it, and no
    // real parcel lost either way.
    expect(q).toMatch(/\(from:\([^)]*\) AND subject:\([^)]*\)\)/)
    // Nothing is a bare term: strip every from:(...) and subject:(...) group and only the
    // operators are left. A bare term is matched against the whole message, which is how
    // "na ceste" - everyday Slovak for "on the way" - once labelled a friend's email.
    const skeleton = q.replace(/(from|subject):\([^)]*\)/g, 'X').replace(/[()]/g, ' ')
    expect(skeleton.split(/\s+/).filter(w => w && w !== 'X' && w !== 'OR' && w !== 'AND')).toEqual([])
    expect(q).not.toMatch(/\bto:/)
    expect(q).not.toMatch(/\blabel:/)
    // AND inside this one field is fine and now deliberate (shops must also say something about
    // shipping). The trap this file guards is AND across Gmail's separate From/Subject/Has-the-words
    // boxes, which the test above pins by asserting those fields are absent.
    expect(q.match(/\bAND\b/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(q).not.toMatch(/\s-\w/)                     // no negated term either
  })

  test('the query is a single OR-expression with balanced quoting', () => {
    const q = prop('hasTheWord')!
    const terms = q.split(' OR ')
    expect(terms.length).toBeGreaterThan(20)
    expect(terms.every(t => t.trim() !== '')).toBe(true)
    expect(q).not.toMatch(/OR\s*$/)                    // no dangling operator
    expect((q.match(/"/g) ?? []).length % 2).toBe(0)   // every phrase is closed
    // Parentheses are expected now: they group the terms under from:/subject:. What must not appear
    // is a second FIELD, which is what Gmail would AND - asserted in the test above.
    expect((q.match(/\(/g) ?? []).length).toBe((q.match(/\)/g) ?? []).length)
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
      expect(q.split(/[ "()]+/)).toContain(word)   // terms now sit inside subject:( ... )
    }
    expect(q).toContain('"tracking number"')
    // Slovak does not stem in Gmail search, so each noun form has to be listed. These are what
    // rescued 12 real parcels that the previous, phrase-only subject list missed: "Zasielka caka na
    // vyzdvihnutie", "Spracovanie zasielky", "Vas balik dorazi" - all genuine shipment mail from
    // shops not on the domain list.
    for (const form of ['zasielka', 'zasielku', 'zasielky', 'zasielke', 'balik', 'baliku', 'balika']) {
      expect(q.split(/[ "()]+/)).toContain(form)
    }
  })

  /**
   * Version 2 of the filter labels Czech mail too: Zásilkovna and PPL as senders, and the Czech
   * dispatch words in BOTH subject lists - the one inside the shop group and the trailing one for
   * any sender. Gmail does not stem, so every form is listed. The sellers' tip lives in the comment
   * (the query itself must stay free of negated terms, pinned above).
   */
  test('labels Czech mail: carriers, subject words in both lists, and the sellers\' tip', () => {
    const q = prop('hasTheWord')!
    const carriers = q.match(/^from:\(([^)]*)\)/)![1]!.split(' OR ')
    expect(carriers).toContain('zasilkovna.cz')
    expect(carriers).toContain('ppl.cz')

    const lists = [...q.matchAll(/subject:\(([^)]*)\)/g)].map(m => m[1]!.split(' OR '))
    expect(lists).toHaveLength(2)   // the shop group's list and the trailing one
    for (const list of lists) {
      for (const term of ['zasilka', 'zasilku', 'zasilky', 'pripravena', 'vyzvednuti', '"k vyzvednuti"',
        '"vydejni misto"', '"vydejnim miste"', 'dorucime']) {
        expect(list).toContain(term)
      }
    }

    expect(xml.match(/<!--[\s\S]*?-->/)![0]).toContain('-from:yourshop.sk')
    expect(xml).toContain('parcels-2')
    expect(xml).not.toContain('parcels-1')
    expect(xml.match(/<updated>2026-10-30T00:00:00Z<\/updated>/g)).toHaveLength(2)
  })

  // Gmail ignores diacritics, so the file can stay plain ASCII - which also keeps it safe to paste
  // through anything with an opinion about encodings.
  test('the query is plain ASCII, since Gmail ignores diacritics', () => {
    expect(prop('hasTheWord')!).toMatch(/^[\x20-\x7e]+$/)
  })
})
