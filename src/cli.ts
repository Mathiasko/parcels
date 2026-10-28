import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadRuntimeConfig, type Config } from './core/config.js'
import { captureBodies, createHttpClient } from './core/http.js'
import { recordPollRun, runPoll, summarize } from './core/poll.js'
import { claimRun } from './db/poll-runs.js'
import type { Carrier, CarrierAdapter, CarrierId, HttpClient } from './core/types.js'
import { isPollable } from './core/types.js'
import { buildPollDeps, initRuntime } from './core/runtime.js'
import { allAdapters, getAdapter, normalizeNumber } from './carriers/registry.js'
import { openDb, type Database } from './db/index.js'
import { createNotifier, type SpawnFn } from './notify/send.js'
import type { Notifier } from './notify/types.js'
import { listEvents } from './db/events.js'
import { reprocessMessages } from './ingest/ingest.js'
import { getParcel, listActive, listDelivered, type Parcel } from './db/parcels.js'
import { addParcel } from './web/actions.js'

export interface CliContext {
  db: Database
  config: Config
  out: (line: string) => void
  err: (line: string) => void
  /** Injectable for tests; `poll` and `probe` default to the real client / registered adapters. */
  http?: HttpClient
  adapters?: Carrier[]
  /** Injectable for tests; `poll` defaults to the configured notifier. */
  notifier?: Notifier
  /** Injectable for tests; `notify-test` defaults to really launching the notifier. */
  spawn?: SpawnFn
}

/** Every carrier the registry knows, so a carrier added there is accepted here without a second list. */
const carrierIds = (): CarrierId[] => allAdapters().map(a => a.id)

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
  return (carrierIds() as string[]).includes(s)
}

function requireCarrier(s: string): CarrierId {
  if (!isCarrierId(s)) throw new CliError(`unknown carrier "${s}"; expected one of ${carrierIds().join(', ')}`)
  return s
}

function add(argv: string[], ctx: CliContext): void {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { carrier: { type: 'string' }, label: { type: 'string' }, zip: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length !== 1) throw new CliError('usage: add <number> [--carrier <id>] [--label <text>] [--zip <postcode>]')
  const typed = positionals[0]!
  // The same `addParcel` the web form calls, so normalising, carrier detection and the field limits are
  // one decision; only the wording of a refusal is the terminal's own.
  const r = addParcel(ctx.db, ctx.config, {
    number: typed,
    carrier: values.carrier === undefined ? undefined : requireCarrier(values.carrier),
    label: values.label,
    postcode: values.zip,
    source: 'manual',
  })
  if (!r.ok) {
    if (r.status === 409) {
      const existing = getParcel(ctx.db, r.existingId)!
      throw new CliError(`already tracking ${existing.trackingNumber} (${existing.carrier}) as #${existing.id}`)
    }
    const p = r.problem
    if (p.kind === 'no_number') throw new CliError(`"${typed}" is not a tracking number`)
    if (p.kind === 'too_long') throw new CliError(`"${typed}" is too long to be a tracking number`)
    if (p.kind === 'carrier_unclear') {
      if (p.candidates.length === 0) {
        throw new CliError(`could not tell which carrier ${p.number} belongs to; pass --carrier <${carrierIds().join('|')}>`)
      }
      throw new CliError(`${p.number} could be ${p.candidates.join(' or ')}; pass --carrier to choose`)
    }
    throw new CliError(r.message)
  }
  const added = getParcel(ctx.db, r.id)!
  ctx.out(`added #${added.id} ${added.carrier} ${added.trackingNumber}`)
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
  // Recorded in `poll_runs` like every other poll: the activity log on the Health page is of the app's
  // activity, so a run started by hand belongs in it exactly as the hourly one does.
  // Claimed, not just started: the hourly poller or a "Refresh now" may be mid-run in another process.
  const startedAt = new Date()
  const claim = claimRun(ctx.db, 'cli', startedAt)
  if (!claim.claimed) {
    throw new CliError(`a poll is already running (run ${claim.live.id}, ${claim.live.trigger}, started ${claim.live.startedAt.toISOString()}); not starting another`)
  }
  const runId = claim.id
  const report = await recordPollRun(ctx.db, runId, runPoll(buildPollDeps(ctx.db, ctx.config, {
    // A poll run by hand is the command line acting, not the poller; the activity log says which.
    cause: { actor: 'cli', runId, at: startedAt },
    ...(ctx.http && { http: ctx.http }),
    ...(ctx.adapters && { adapters: ctx.adapters }),
    ...(ctx.notifier && { notifier: ctx.notifier }),
  })))
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
    + `${r.ignored ? `, ${r.ignored} ignored (no sign of a parcel)` : ''}`
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
  let registered: Carrier
  try {
    registered = getAdapter(carrier)
  } catch {
    throw new CliError(`no adapter for ${carrier} is available yet`)
  }
  // An email-only carrier is never asked anything (§6.7), so there is no request to show and no
  // response to print. Said plainly rather than faked with an empty result.
  if (!isPollable(registered)) {
    throw new CliError(`${carrier} is an email-only carrier: it is never polled, so there is nothing to probe. Its updates come from its own mail, which \`cli poll\` ingests.`)
  }
  const adapter: CarrierAdapter = registered

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
