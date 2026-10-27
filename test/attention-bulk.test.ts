import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildServer } from '../src/web/server.js'
import { dismissMessages } from '../src/db/messages.js'
import { listUnparsedMessages } from '../src/web/queries.js'
import { insertParcel } from '../src/db/parcels.js'
import type { Database } from '../src/db/index.js'
import { config, memDb, NOW } from './poll-helpers.js'

const server = (db: Database) => buildServer({ db, config, now: () => NOW, notifier: { send: async () => {} } })
const get = (db: Database, url: string) => server(db).inject({ method: 'GET', url })
const post = (db: Database, url: string, fields: Record<string, string>) => server(db).inject({
  method: 'POST', url,
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

const dir = mkdtempSync(join(tmpdir(), 'parcels-bulk-'))
let seq = 0

/** A stored message the ingest could not place, with its .eml really on disk. */
function junk(db: Database, from: string, subject = 'Newsletter'): { id: number; path: string } {
  const path = join(dir, `m${++seq}.eml`)
  writeFileSync(path, `From: ${from}\r\nSubject: ${subject}\r\n\r\nbody\r\n`)
  const id = Number(db.prepare(`
    INSERT INTO messages (message_id, received_at, from_addr, subject, raw_path, parsed_ok, parse_note)
    VALUES (?, ?, ?, ?, ?, 0, 'no tracking number found in this message')
  `).run(`<m${seq}@x>`, new Date(NOW.getTime() - seq * 1000).toISOString(), from, subject, path).lastInsertRowid)
  return { id, path }
}

const pending = (db: Database) => listUnparsedMessages(db).map(m => m.id)
const noteOf = (db: Database, id: number) =>
  (db.prepare('SELECT parse_note FROM messages WHERE id = ?').get(id) as { parse_note: string | null }).parse_note

describe('dismissMessages (bulk)', () => {
  test('dismisses every pending message up to the given row, and nothing else', () => {
    const db = memDb()
    // Already assigned to a parcel, and INSIDE the range the bulk action covers: not on the list, and
    // not to be touched - its .eml is still the parcel's, and the pickup-code scanner reads it.
    const assigned = junk(db, 'noreply@packeta.sk', 'Shipped')
    const parcel = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR1', source: 'email' })
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ? WHERE id = ?').run(parcel, assigned.id)
    const a = junk(db, 'news@info.billa.sk')
    const b = junk(db, 'sluzobnicek@alza.sk')

    expect(dismissMessages(db, { upTo: b.id })).toBe(2)
    expect(pending(db)).toEqual([])
    expect(noteOf(db, a.id)).toBe('Dismissed')
    expect(db.prepare('SELECT parsed_ok, parcel_id, raw_path FROM messages WHERE id = ?').get(assigned.id))
      .toEqual({ parsed_ok: 1, parcel_id: parcel, raw_path: assigned.path })
    expect(existsSync(assigned.path)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 3 })   // no row is ever deleted
  })

  test('mail that arrived after the page was rendered is left alone', () => {
    const db = memDb()
    const listed = [junk(db, 'news@info.billa.sk'), junk(db, 'news@info.billa.sk')]
    const later = junk(db, 'noreply@steampowered.com')     // ingested between the render and the click
    expect(dismissMessages(db, { upTo: listed[1]!.id })).toBe(2)
    expect(pending(db)).toEqual([later.id])
    expect(existsSync(later.path)).toBe(true)
  })

  test('by sender: only that sender, and only up to the listed row', () => {
    const db = memDb()
    const alza = [junk(db, 'sluzobnicek@alza.sk'), junk(db, 'sluzobnicek@alza.sk')]
    const billa = junk(db, 'news@info.billa.sk')
    const steam = junk(db, 'noreply@steampowered.com')
    expect(dismissMessages(db, { upTo: steam.id, from: 'sluzobnicek@alza.sk' })).toBe(2)
    expect(pending(db).sort()).toEqual([billa.id, steam.id].sort())
    expect(alza.every(m => !existsSync(m.path))).toBe(true)
    expect(existsSync(billa.path)).toBe(true)
  })

  test('a sender nobody on the list has dismisses nothing', () => {
    const db = memDb()
    const a = junk(db, 'news@info.billa.sk')
    expect(dismissMessages(db, { upTo: a.id, from: 'someone@else.example' })).toBe(0)
    expect(pending(db)).toEqual([a.id])
  })

  test('every dismissed message loses its .eml and its path, in bulk as singly', () => {
    const db = memDb()
    const all = [junk(db, 'a@x.example'), junk(db, 'b@x.example'), junk(db, 'c@x.example')]
    dismissMessages(db, { upTo: all[2]!.id })
    expect(all.filter(m => existsSync(m.path))).toEqual([])
    expect(db.prepare('SELECT COUNT(*) n FROM messages WHERE raw_path IS NOT NULL').get()).toEqual({ n: 0 })
  })

  test('a second bulk dismiss over the same range changes nothing', () => {
    const db = memDb()
    const a = junk(db, 'a@x.example')
    expect(dismissMessages(db, { upTo: a.id })).toBe(1)
    expect(dismissMessages(db, { upTo: a.id })).toBe(0)
  })
})

describe('GET /attention: clearing the queue', () => {
  test('the bulk action is behind a disclosure that names the exact number', async () => {
    const db = memDb()
    for (let i = 0; i < 5; i++) junk(db, 'news@info.billa.sk')
    const body = (await get(db, '/attention')).body
    const open = body.indexOf('<details class="bulk"')
    expect(open).toBeGreaterThan(-1)
    expect(body.slice(open, body.indexOf('</details>', open))).toContain('5 emails')
    expect(body).toContain('Dismiss all 5 emails')
    // Collapsed: opening it IS the confirm step, as on the parcel page.
    expect(/<details class="bulk"\s*>/.test(body)).toBe(true)
  })

  test('the count is the real one, not a page size: it counts what the list holds', async () => {
    const db = memDb()
    for (let i = 0; i < 3; i++) junk(db, 'news@info.billa.sk')
    const assigned = junk(db, 'noreply@packeta.sk')
    const parcel = insertParcel(db, { carrier: 'posta', trackingNumber: 'RR2', source: 'email' })
    db.prepare('UPDATE messages SET parsed_ok = 1, parcel_id = ? WHERE id = ?').run(parcel, assigned.id)
    const body = (await get(db, '/attention')).body
    expect(body).toContain('Dismiss all 3 emails')
    expect(body).not.toContain('Dismiss all 4 emails')
  })

  test('senders with more than one waiting message get a dismissal of their own, with their count', async () => {
    const db = memDb()
    for (let i = 0; i < 4; i++) junk(db, 'sluzobnicek@alza.sk')
    for (let i = 0; i < 2; i++) junk(db, 'news@info.billa.sk')
    junk(db, 'lonely@example.com')
    const body = (await get(db, '/attention')).body
    const section = body.slice(body.indexOf('<details class="bulk"'), body.indexOf('</details>'))
    expect(section).toContain('Dismiss 4')
    expect(section).toContain('sluzobnicek@alza.sk')
    expect(section).toContain('Dismiss 2')
    // One message is not a bulk action: it already has its own Dismiss button.
    expect(section).not.toContain('lonely@example.com')
    // Busiest sender first: that is the one a person actually wants gone.
    expect(body.indexOf('sluzobnicek@alza.sk')).toBeLessThan(body.indexOf('news@info.billa.sk'))
  })

  test('the bulk forms are forms of their own and carry no assign field', async () => {
    const db = memDb()
    for (let i = 0; i < 2; i++) junk(db, 'news@info.billa.sk')
    const body = (await get(db, '/attention')).body
    const section = body.slice(body.indexOf('<details class="bulk"'), body.indexOf('</details>'))
    expect(section).not.toContain('name="number"')
    expect(section).not.toContain('name="carrier"')
    expect(section).not.toContain('class="pri"')        // --signal means "this needs you", never a bulk delete
    // Each bulk form closes before the next opens: no nesting, so no form submits another's fields.
    const forms = section.split('<form').length - 1
    expect(section.split('</form>').length - 1).toBe(forms)
    expect(forms).toBe(2)                               // dismiss-all, plus the one sender with 2
  })

  test('nothing to clear, or a single item, shows no bulk section at all', async () => {
    const db = memDb()
    expect((await get(db, '/attention')).body).not.toContain('class="bulk"')
    junk(db, 'news@info.billa.sk')
    expect((await get(db, '/attention')).body).not.toContain('class="bulk"')
  })
})

describe('POST /attention/dismiss', () => {
  test('clears the whole listed queue and comes back to the page', async () => {
    const db = memDb()
    const ids = [junk(db, 'a@x.example'), junk(db, 'b@x.example'), junk(db, 'c@x.example')]
    const res = await post(db, '/attention/dismiss', { up_to: String(ids[2]!.id) })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/attention')
    expect(pending(db)).toEqual([])
    expect(ids.filter(m => existsSync(m.path))).toEqual([])
  })

  test('clears one sender, through the form the page renders', async () => {
    const db = memDb()
    const alza = junk(db, 'sluzobnicek@alza.sk')
    const billa = junk(db, 'news@info.billa.sk')
    const res = await post(db, '/attention/dismiss', { up_to: String(billa.id), from: 'sluzobnicek@alza.sk' })
    expect(res.statusCode).toBe(303)
    expect(pending(db)).toEqual([billa.id])
    expect(existsSync(alza.path)).toBe(false)
    expect(existsSync(billa.path)).toBe(true)
  })

  test('a missing or nonsense up_to dismisses NOTHING: a bulk delete needs the page it came from', async () => {
    const db = memDb()
    const a = junk(db, 'a@x.example')
    for (const fields of [{}, { up_to: '' }, { up_to: 'all' }, { up_to: '-1' }, { up_to: '0' }, { up_to: '1e9' }]) {
      const res = await post(db, '/attention/dismiss', fields as Record<string, string>)
      expect(res.statusCode).toBe(404)
    }
    expect(pending(db)).toEqual([a.id])
    expect(existsSync(a.path)).toBe(true)
  })

  test('a second submit of the same form is harmless', async () => {
    const db = memDb()
    const a = junk(db, 'a@x.example')
    expect((await post(db, '/attention/dismiss', { up_to: String(a.id) })).statusCode).toBe(303)
    expect((await post(db, '/attention/dismiss', { up_to: String(a.id) })).statusCode).toBe(303)
    expect(pending(db)).toEqual([])
  })

  test('the per-item dismiss route still works: the bulk route has not shadowed it', async () => {
    const db = memDb()
    const a = junk(db, 'a@x.example')
    const res = await post(db, `/attention/${a.id}/dismiss`, {})
    expect(res.statusCode).toBe(303)
    expect(pending(db)).toEqual([])
  })
})
