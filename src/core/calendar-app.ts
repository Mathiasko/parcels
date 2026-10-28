import { execFile } from 'node:child_process'

/**
 * Putting a pickup into Calendar.app, by AppleScript through `osascript`, the way notifications are
 * posted (notify/send.ts): every value travels as an argv item read by `on run argv`, and none is ever
 * written into the script's text, so nothing a carrier or a mail puts in a parcel's name or address can
 * become AppleScript. There is no option for a shell either.
 *
 * Behind `CalendarClient` so the server can be tested without it: no test runs osascript against
 * Calendar, and `defaultRunner` refuses to run at all under the test runner (see there).
 *
 * The first call from the web server makes macOS ask whether "node" may control Calendar (System
 * Settings → Privacy & Security → Automation). That prompt waits for a person, which is why adding has
 * a generous timeout, and why a denial is a failure of its own with its own instructions.
 */

/** A local wall-clock moment, the shape an AppleScript date is built from. */
export interface WallClock { year: number; month: number; day: number; hour: number; minute: number }

/** What goes into Calendar. Plain strings; `description` may hold newlines. */
export interface CalendarEventSpec {
  summary: string
  location?: string
  description: string
  url?: string
  /** The start, as the wall clock in the display zone reads it. */
  start: WallClock
  minutes: number
}

export interface CalendarAdded {
  /** Calendar's own id for the event, kept so that adding again can replace it. */
  uid: string
  /** The calendar it actually went into: the chosen one, or the first writable one when none is chosen. */
  calendar: string
}

/** The event added before for the same parcel, to be removed once the new one exists. */
export interface CalendarReplace { uid: string; calendar: string }

export type CalendarFailureKind =
  | 'denied'        // macOS refused the Apple events (-1743): the Automation permission is off
  | 'timeout'       // nothing answered in time; often the permission prompt is still waiting
  | 'no_calendar'   // no writable calendar exists at all
  | 'not_found'     // no calendar has the chosen name
  | 'ambiguous'     // more than one writable calendar has the chosen name
  | 'read_only'     // the chosen calendar exists but cannot be written to
  | 'other'

export class CalendarFailure extends Error {
  constructor(readonly kind: CalendarFailureKind, readonly detail?: string, readonly calendar?: string) {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'CalendarFailure'
  }
}

export interface CalendarClient {
  /** The names of the calendars an event can be added to, in Calendar's order. Rejects with a `CalendarFailure`. */
  listWritable(): Promise<string[]>
  /**
   * Adds the event with one alert at its start and returns its uid. `calendar` undefined means the first
   * writable calendar. With `replace`, the earlier event is deleted AFTER the new one exists, and a
   * replace that finds nothing (it was deleted by hand) is not an error. Rejects with a `CalendarFailure`.
   */
  add(event: CalendarEventSpec, calendar: string | undefined, replace?: CalendarReplace): Promise<CalendarAdded>
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
/** Runs `osascript` with exactly these argv items. No shell, no options beyond the timeout. */
export type OsascriptRunner = (args: readonly string[], timeoutMs: number) => Promise<RunResult>

/** Adding: long enough for a person to read and answer the Automation prompt the first time. */
export const ADD_TIMEOUT_MS = 60_000
/** Listing, for the settings page: short, so a page render never hangs on it. Calendar may need launching. */
export const LIST_TIMEOUT_MS = 8_000

/**
 * The add script. Its outcomes are returned as text on stdout (`ok`, `not_found`, ...) rather than as
 * AppleScript errors, so this app's own conditions can never be confused with Calendar's or macOS's,
 * which arrive on stderr with osascript's exit status 1.
 *
 * The date is built from numbers, never parsed from a string: AppleScript reads date strings in the
 * Mac's own locale and date format, so the same string means different days on different Macs. Day 1
 * is set BEFORE the year and the month, or setting October on 31 January would land in a month that
 * has no 31st and roll over. Seconds are zeroed through `time of`. The components are the wall clock in
 * Europe/Bratislava, computed in Node; an AppleScript date is the Mac's own local wall clock, so this
 * assumes the Mac is in that zone - the same assumption every page of this app makes when it prints a time.
 *
 * Replacing: the new event is made first, then the old one is deleted in the calendar it was stored in,
 * inside `try` - the person may have deleted or moved it by hand, which is fine. Made first, so a
 * failure part-way through leaves the old event rather than nothing.
 */
export const ADD_SCRIPT = [
  'on run argv',
  '  set calName to item 1 of argv',
  '  set y to (item 2 of argv) as integer',
  '  set mo to (item 3 of argv) as integer',
  '  set d to (item 4 of argv) as integer',
  '  set h to (item 5 of argv) as integer',
  '  set mi to (item 6 of argv) as integer',
  '  set durationMinutes to (item 7 of argv) as integer',
  '  set theSummary to item 8 of argv',
  '  set theLocation to item 9 of argv',
  '  set theDescription to item 10 of argv',
  '  set theUrl to item 11 of argv',
  '  set oldCalendar to item 12 of argv',
  '  set oldUid to item 13 of argv',
  '  set startDate to current date',
  '  set day of startDate to 1',
  '  set year of startDate to y',
  '  set month of startDate to mo',
  '  set day of startDate to d',
  '  set time of startDate to (h * hours) + (mi * minutes)',
  '  set endDate to startDate + (durationMinutes * minutes)',
  '  tell application "Calendar"',
  '    if calName is "" then',
  '      set candidates to every calendar whose writable is true',
  '      if (count of candidates) is 0 then return "no_calendar"',
  '    else',
  '      set sameName to every calendar whose name is calName',
  '      if (count of sameName) is 0 then return "not_found"',
  '      set candidates to every calendar whose name is calName and writable is true',
  '      if (count of candidates) is 0 then return "read_only"',
  '      if (count of candidates) > 1 then return "ambiguous"',
  '    end if',
  '    set targetCalendar to item 1 of candidates',
  '    set props to {summary:theSummary, start date:startDate, end date:endDate, description:theDescription}',
  '    if theLocation is not "" then set props to props & {location:theLocation}',
  '    if theUrl is not "" then set props to props & {url:theUrl}',
  '    set newEvent to make new event at end of events of targetCalendar with properties props',
  '    make new display alarm at end of display alarms of newEvent with properties {trigger interval:0}',
  '    set newUid to uid of newEvent',
  '    set targetName to name of targetCalendar',
  '    if oldUid is not "" then',
  '      repeat with c in (every calendar whose name is oldCalendar)',
  '        try',
  '          delete (every event of c whose uid is oldUid)',
  '        end try',
  '      end repeat',
  '    end if',
  '  end tell',
  '  return "ok" & tab & newUid & tab & targetName',
  'end run',
] as const

/** The names of the writable calendars, one per line. Takes no argv. */
export const LIST_SCRIPT = [
  'on run argv',
  '  tell application "Calendar"',
  '    set names to name of every calendar whose writable is true',
  '  end tell',
  '  set AppleScript\'s text item delimiters to linefeed',
  '  return names as text',
  'end run',
] as const

const MAX_TEXT = 2000

/** Control characters out (tab and newline kept), length capped by character. Values are argv, so this is tidiness, not safety. */
function clean(s: string | undefined, max = MAX_TEXT): string {
  const chars = Array.from((s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

const scriptArgs = (lines: readonly string[]): string[] => lines.flatMap(l => ['-e', l])

/**
 * The full argv for adding one event. The `--` is load-bearing, as in notify/send.ts: without it
 * osascript would read a value that begins with `-` as one of its own options.
 */
export function addArgs(event: CalendarEventSpec, calendar: string | undefined, replace?: CalendarReplace): string[] {
  const { year, month, day, hour, minute } = event.start
  return [
    ...scriptArgs(ADD_SCRIPT),
    '--',
    clean(calendar, 255),
    String(year), String(month), String(day), String(hour), String(minute), String(event.minutes),
    clean(event.summary, 255),
    clean(event.location, 500),
    clean(event.description),
    clean(event.url, 1000),
    clean(replace?.calendar, 255),
    clean(replace?.uid, 255),
  ]
}

export const listArgs = (): string[] => scriptArgs(LIST_SCRIPT)

/** osascript's own wrapping (`0:123: execution error: … (-1743)`) trimmed down to the sentence, one line, bounded. */
export function stderrMessage(stderr: string): string {
  const line = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
  const msg = line.replace(/^.*?execution error:\s*/, '').replace(/^\d+:\d+:\s*/, '').trim()
  return clean(msg, 300)
}

/**
 * Why osascript did not produce an answer. `-1743` is errAEEventNotPermitted: the user said no to the
 * Automation prompt, or turned it off later. `-1712` is errAETimeout: Calendar itself did not answer an
 * Apple event in time, which is the same thing to the person as our own timeout.
 */
export function classifyFailure(r: Pick<RunResult, 'stderr' | 'timedOut'>): CalendarFailure {
  if (r.timedOut) return new CalendarFailure('timeout')
  if (/\(-1743\)|not authori[sz]ed to send apple events/i.test(r.stderr)) return new CalendarFailure('denied', stderrMessage(r.stderr))
  if (/\(-1712\)/.test(r.stderr)) return new CalendarFailure('timeout', stderrMessage(r.stderr))
  return new CalendarFailure('other', stderrMessage(r.stderr) || 'osascript failed without saying why')
}

/** The add script's stdout, as a result or as this app's own failure. */
export function parseAddOutput(stdout: string, calendar: string | undefined): CalendarAdded | CalendarFailure {
  const [word, uid, name] = stdout.replace(/\r?\n$/, '').split('\t')
  switch (word) {
    case 'ok':
      return uid ? { uid, calendar: name ?? calendar ?? '' } : new CalendarFailure('other', 'Calendar did not return the new event')
    case 'no_calendar':
    case 'not_found':
    case 'ambiguous':
    case 'read_only':
      return new CalendarFailure(word, undefined, calendar)
    default:
      return new CalendarFailure('other', clean(stdout.trim(), 300) || 'Calendar gave no answer')
  }
}

/**
 * The real runner: `execFile`, never a shell, with a timeout that kills osascript.
 *
 * It refuses to run under the test runner. This is a safety net, not the mechanism: every test injects
 * a fake client, but a server built without one would fall back to this - and a GET /settings in any
 * test would then raise the Automation prompt on whoever runs the suite, or touch their real calendars.
 */
export const defaultRunner: OsascriptRunner = (args, timeoutMs) => {
  if (process.env.VITEST) return Promise.reject(new Error('Calendar is never driven by the test suite'))
  return new Promise(resolve => {
    execFile('osascript', [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (e && !e.killed && typeof e.code === 'string' ? `${e.code}: ${e.message}` : ''),
        timedOut: e?.killed === true,
      })
    })
  })
}

async function run(runner: OsascriptRunner, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    return await runner(args, timeoutMs)
  } catch (err) {
    throw new CalendarFailure('other', err instanceof Error ? err.message : String(err))
  }
}

export function osascriptCalendar(runner: OsascriptRunner = defaultRunner): CalendarClient {
  return {
    async listWritable() {
      const r = await run(runner, listArgs(), LIST_TIMEOUT_MS)
      if (r.timedOut || r.code !== 0) throw classifyFailure(r)
      return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    },
    async add(event, calendar, replace) {
      const r = await run(runner, addArgs(event, calendar, replace), ADD_TIMEOUT_MS)
      if (r.timedOut || r.code !== 0) throw classifyFailure(r)
      const out = parseAddOutput(r.stdout, calendar)
      if (out instanceof CalendarFailure) throw out
      return out
    },
  }
}
