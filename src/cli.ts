import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadRuntimeConfig, type Config } from './core/config.js'
import { captureBodies, createHttpClient } from './core/http.js'
import { runPoll, summarize } from './core/poll.js'
import type { CarrierAdapter, CarrierId, HttpClient } from './core/types.js'
import { buildPollDeps, initRuntime } from './core/runtime.js'
import { allAdapters, getAdapter, normalizeNumber, resolveCarrier } from './carriers/registry.js'
import { openDb, type Database } from './db/index.js'
import { createNotifier, type SpawnFn } from './notify/send.js'
import type { Notifier } from './notify/types.js'
import { listEvents } from './db/events.js'
import { reprocessMessages } from './ingest/ingest.js'
import { findParcel, getParcel, insertParcel, listActive, listDelivered, type Parcel } from './db/parcels.js'

export interface CliContext {
  db: Database
  config: Config
  out: (line: string) => void
  err: (line: string) => void
  /** Injectable for tests; `poll` and `probe` default to the real client / registered adapters. */
  http?: HttpClient
  adapters?: CarrierAdapter[]
  /** Injectable for tests; `poll` defaults to the configured notifier. */
  notifier?: Notifier
  /** Injectable for tests; `notify-test` defaults to really launching the notifier. */
  spawn?: SpawnFn
}

const CARRIER_IDS: readonly CarrierId[] = ['posta', 'packeta', 'gls', 'sps', 'dpd']

const USAGE = `usage: cli <command>
  add <number> [--carrier <id>] [--label <text>] [--zip <postcode>]
  list
  show <id>
  poll
  reprocess
  probe <carrier> <number> [--zip <postcode>]
  notify-test`

/** A user-facing failure: its message is printed as-is, with no stack. */
class CliError extends Error {}

function isCarrierId(s: string): s is CarrierId {
  return (CARRIER_IDS as readonly string[]).includes(s)
}

function requireCarrier(s: string): CarrierId {
  if (!isCarrierId(s)) throw new CliError(`unknown carrier "${s}"; expected one of ${CARRIER_IDS.join(', ')}`)
  return s
}

function add(argv: string[], ctx: CliContext): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { carrier: { type: 'string' }, label: { type: 'string' }, zip: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length !== 1) throw new CliError('usage: add <number> [--carrier <id>] [--label <text>] [--zip <postcode>]')
  const number = normalizeNumber(positionals[0]!)
  if (number === '') throw new CliError(`"${positionals[0]}" is not a tracking number`)

  const resolved = resolveCarrier(number, values.carrier === undefined ? undefined : requireCarrier(values.carrier))
  if (!resolved.ok) {
    if (resolved.candidates.length === 0) {
      throw new CliError(`could not tell which carrier ${number} belongs to; pass --carrier <${CARRIER_IDS.join('|')}>`)
    }
    throw new CliError(`${number} could be ${resolved.candidates.join(' or ')}; pass --carrier to choose`)
  }
  const carrier = resolved.carrier

  const existing = findParcel(ctx.db, carrier, number)
  if (existing) throw new CliError(`already tracking ${number} (${carrier}) as #${existing.id}`)

  const id = insertParcel(ctx.db, {
    carrier,
    trackingNumber: number,
    label: values.label,
    postalCode: values.zip ?? ctx.config.defaultPostalCode,
    source: 'manual',
  })
  ctx.out(`added #${id} ${carrier} ${number}`)
}

function list(ctx: CliContext): void {
  const line = (p: Parcel) => `#${p.id}  ${p.label ?? '-'}  ${p.carrier}  ${p.status}  ${p.trackingNumber}`
  const parcels = listActive(ctx.db)
  // Returned parcels are outside "active" but need the owner's attention (the parcel is coming back).
  const returned = listDelivered(ctx.db).filter(p => p.status === 'returned')
  if (parcels.length === 0 && returned.length === 0) return ctx.out('no active parcels')
  for (const p of parcels) ctx.out(line(p))
  if (returned.length > 0) {
    ctx.out('returned to sender:')
    for (const p of returned) ctx.out(line(p))
  }
}

function show(argv: string[], ctx: CliContext): void {
  const id = Number(argv[0])
  if (argv.length !== 1 || !Number.isInteger(id)) throw new CliError('usage: show <id>')
  const p = getParcel(ctx.db, id)
  if (!p) throw new CliError(`no parcel #${id}`)

  ctx.out(`#${p.id}  ${p.label ?? '-'}  ${p.carrier}  ${p.trackingNumber}`)
  ctx.out(`status: ${p.status}${p.statusRaw ? ` (${p.statusRaw})` : ''}`)
  if (p.pickup) {
    ctx.out(`pickup: ${[p.pickup.name, p.pickup.street, p.pickup.city].filter(Boolean).join(', ')}`)
  }
  if (p.retainedTill) ctx.out(`collect by: ${p.retainedTill.toISOString()}`)
  for (const e of listEvents(ctx.db, id)) {
    ctx.out(`${e.occurredAtRaw} (${e.occurredAtTz})  ${e.status}  ${e.description}${e.location ? ` @ ${e.location}` : ''}`)
  }
}

async function poll(ctx: CliContext): Promise<void> {
  // The same run the hourly agent does (including mail ingest), built by the same function. A manual poll
  // stores the very status changes the hourly run would have announced, so it announces them too.
  const report = await runPoll(buildPollDeps(ctx.db, ctx.config, {
    ...(ctx.http && { http: ctx.http }),
    ...(ctx.adapters && { adapters: ctx.adapters }),
    ...(ctx.notifier && { notifier: ctx.notifier }),
  }))
  ctx.out(summarize(report))
}

/**
 * Re-runs extraction over stored mail that no parcel was made from, using the .eml files on disk (no
 * mailbox access). Run it after improving the extractor; messages already assigned are left alone.
 */
async function reprocess(ctx: CliContext): Promise<void> {
  const r = await reprocessMessages(ctx.db, {
    now: new Date(), adapters: ctx.adapters ?? allAdapters(), defaultPostalCode: ctx.config.defaultPostalCode,
  })
  ctx.out(`reprocessed ${r.read} unassigned message(s): ${r.created} parcel(s) created`
    + `${r.archivedOld ? ` (${r.archivedOld} archived as old)` : ''}, ${r.linked} linked, ${r.needsAttention} still need attention`
    + `${r.failed ? `, ${r.failed} failed` : ''}`)
}

/**
 * Sends one fixed notification through the configured notifier and says how it went. This is the
 * command that triggers macOS's one-time authorisation prompt for terminal-notifier. The tools exit
 * 0 whether or not a banner appeared, so success here means "the process ran": look for the banner.
 */
async function notifyTest(ctx: CliContext): Promise<void> {
  const d = await createNotifier(ctx.config.notifier, ctx.spawn).deliver({
    groupKey: 'notify-test',
    title: 'Parcel tracker',
    message: 'Test notification. If you can read this, notifications work.',
  })
  ctx.out(`configured notifier: ${ctx.config.notifier}`)
  ctx.out(`mechanism used: ${d.mechanism}`)
  ctx.out(`process started: ${d.started ? 'yes' : 'no'}`)
  ctx.out(`exit code: ${d.exitCode ?? 'none'}`)
  if (d.note) ctx.out(`note: ${d.note}`)
  if (!d.started || (d.mechanism === 'terminal-notifier' && d.exitCode === 3)) {
    throw new CliError('no notification could be sent')
  }
  ctx.out('Check that a banner appeared: a zero exit code only means the tool ran.')
}

/** The only command that touches the live network. Prints each response body exactly as received. */
async function probe(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, options: { zip: { type: 'string' } }, allowPositionals: true,
  })
  if (positionals.length !== 2) throw new CliError('usage: probe <carrier> <number> [--zip <postcode>]')
  const carrier = requireCarrier(positionals[0]!)
  let adapter: CarrierAdapter
  try {
    adapter = getAdapter(carrier)
  } catch {
    throw new CliError(`no adapter for ${carrier} is available yet`)
  }

  const capture = captureBodies(ctx.http ?? createHttpClient())
  try {
    const [result] = await adapter.fetch(
      [{ number: normalizeNumber(positionals[1]!), postalCode: values.zip ?? ctx.config.defaultPostalCode }],
      capture.http,
    )
    // The parsed reading (minus the bulky raw) goes to stderr, apart from the verbatim bodies.
    ctx.err(`parsed: ${JSON.stringify(result, (key, value) => (key === 'raw' ? undefined : value))}`)
  } finally {
    // Printed even when the adapter throws: the body that broke the parser is the evidence probe is for.
    for (const body of capture.bodies) ctx.out(body)
  }
}

/** Runs one command and returns the process exit code. Never throws for user mistakes. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'add': add(rest, ctx); break
      case 'list': list(ctx); break
      case 'show': show(rest, ctx); break
      case 'poll': await poll(ctx); break
      case 'reprocess': await reprocess(ctx); break
      case 'probe': await probe(rest, ctx); break
      case 'notify-test': await notifyTest(ctx); break
      default:
        ctx.err(command === undefined ? USAGE : `unknown command "${command}"\n${USAGE}`)
        return 1
    }
    return 0
  } catch (err) {
    if (err instanceof CliError) {
      ctx.err(err.message)
    } else if (err instanceof TypeError && (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      ctx.err(`${err.message}\n${USAGE}`)   // bad flags are a usage error, not a crash
    } else {
      ctx.err(`${command} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return 1
  }
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig()
  initRuntime(config)
  const db = openDb(config.dbPath)
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      db, config, out: console.log, err: console.error,
    })
  } finally {
    db.close()
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`cli: fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
