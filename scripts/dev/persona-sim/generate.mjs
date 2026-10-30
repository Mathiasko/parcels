// Builds every persona scenario from scenarios/<persona>.mjs into scenarios/<persona>/:
//   scenario.json  what the simulator loads (meta, carrier timelines, every mail's rendered spec)
//   mails/*.eml    each mail as bytes (reactive mails get a nominal date), for inspection
//   OVERVIEW.md    OPERATOR ONLY: every mail with its purpose, label verdict and the parcels. Spoilers.
// Run from the repo root:  $N/node scripts/dev/persona-sim/generate.mjs [persona ...]
// Deterministic: re-running rewrites the same bytes.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildEml } from '../fake-mail/mime.mjs'
import { labelled } from './lib/gmail-filter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const SC = join(HERE, 'scenarios')
const want = process.argv.slice(2)
const ids = readdirSync(SC).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4)).filter(id => !want.length || want.includes(id))

for (const id of ids) {
  const build = (await import(pathToFileURL(join(SC, `${id}.mjs`)).href)).default
  const s = build()
  const j = s.toJSON()
  // Mail the lifecycles would send after day 14 never arrives inside the simulation.
  j.mails = j.mails.filter(m => !m.at || s.day(m.at) <= 14)
  // ---- checks: every mail is timed or triggered, every condition names a parcel, keys unique
  const keys = new Set(j.parcels.map(p => p.key))
  if (keys.size !== j.parcels.length) throw new Error(`${id}: duplicate parcel keys`)
  for (const m of j.mails) {
    if (!m.at && !m.trigger) throw new Error(`${id} ${m.id}: neither at nor trigger`)
    for (const k of [m.cond?.notCollected, m.trigger?.afterCollect].filter(Boolean)) if (!keys.has(k)) throw new Error(`${id} ${m.id}: unknown parcel ${k}`)
  }
  const out = join(SC, id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'mails'), { recursive: true })
  const rows = []
  for (const m of j.mails) {
    const at = m.at ?? 'D14 21:59'
    const eml = buildEml({ ...m.spec, date: s.local(at) })
    writeFileSync(join(out, 'mails', `${m.id}.eml`), eml)
    m.labelled = labelled(ROOT, m.spec)
    rows.push(m)
  }
  writeFileSync(join(out, 'scenario.json'), `${JSON.stringify(j, null, 1)}\n`)
  const key = m => m.at ? s.day(m.at) * 1440 + Number(s.hm(m.at).slice(0, 2)) * 60 + Number(s.hm(m.at).slice(3)) : 1e9
  const sorted = [...rows].sort((a, b) => key(a) - key(b))
  const md = [
    `# ${id}: operator overview (generated - SPOILERS, never show this to the persona agent)`, '',
    `${j.meta.fullName}, ${j.meta.town}. Day 0 = ${j.meta.day0}. ${j.parcels.length} carrier parcels in the world, ${j.mails.length} mails (${j.mails.filter(m => m.labelled).length} match gmail-filter.xml and reach the app's label, ${j.mails.filter(m => m.trigger).length} only appear after a \`sim collect\`, ${j.mails.filter(m => m.cond).length} are conditional).${j.meta.away.length ? ` Away days: ${j.meta.away.join(', ')}.` : ''}${j.meta.release ? ` A new app release (${j.meta.release.tag}) appears ${j.meta.release.at}.` : ''}`, '',
    '## Mails', '', '| id | when | from | subject | label | purpose |', '|---|---|---|---|---|---|',
    ...sorted.map(m => `| ${m.id} | ${m.at ?? `after collect ${m.trigger.afterCollect} +${m.trigger.min}m`}${m.cond ? ' (if not collected)' : ''} | ${m.spec.from.replace(/\|/g, '/')} | ${m.spec.subject.replace(/\|/g, '/')} | ${m.labelled ? 'yes' : '**no**'} | ${m.about.replace(/\|/g, '/')} |`),
    '', '## Parcels (carrier side)', '', '| key | carrier | number | what | ready | where | code | deadline |', '|---|---|---|---|---|---|---|---|',
    ...j.parcels.map(p => `| ${p.key} | ${p.carrier} | ${p.number} | ${p.label}${p.owner === 'flatmate' ? ' (flatmate)' : ''} | ${p.ready?.at ?? (p.events.at(-1)?.status ?? 'email only')} | ${p.ready?.where ?? ''} | ${p.ready?.code ?? ''} | ${p.ready?.till ?? ''} |`),
    '',
  ].join('\n')
  writeFileSync(join(out, 'OVERVIEW.md'), md)
  console.log(`${id}: ${j.parcels.length} parcels, ${j.mails.length} mails (${j.mails.filter(m => m.labelled).length} labelled)`)
}
