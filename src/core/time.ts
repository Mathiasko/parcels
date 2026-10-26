import { DateTime } from 'luxon'

const WALL_CLOCK = 'yyyy-MM-dd HH:mm:ss.SSS'

/**
 * Parses a zone-less carrier timestamp as wall-clock time in `zone` (an IANA name), never UTC.
 * Without `format`, accepts ISO-8601 ("2026-07-13T15:08:08") and the space-separated SQL form
 * ("2026-04-29 13:12:42"). A local time in the spring-forward gap resolves forward (Luxon's
 * default); a local time in the autumn fold resolves to the EARLIER of its two offsets,
 * independent of when the code runs (see `earlierOffsetInFold`).
 * Throws on anything unparseable or an unknown zone.
 */
export function parseNaive(raw: string, zone: string, format?: string): { at: Date; tz: string } {
  const parsed = format
    ? DateTime.fromFormat(raw, format, { zone })
    : firstValid(DateTime.fromISO(raw, { zone }), () => DateTime.fromSQL(raw, { zone }))
  if (!parsed.isValid) {
    throw new Error(`cannot parse timestamp ${JSON.stringify(raw)} in zone ${zone}: ${parsed.invalidExplanation}`)
  }
  return { at: earlierOffsetInFold(parsed).toJSDate(), tz: zone }
}

function firstValid(first: DateTime, second: () => DateTime): DateTime {
  return first.isValid ? first : second()
}

/**
 * Luxon does not resolve an ambiguous wall-clock time (autumn fold) deterministically: it keeps
 * whichever of the two offsets is in force "now", so the same input parses to different instants
 * depending on when the code runs. This pins it to the EARLIER occurrence (the larger, summer
 * offset): if the same wall-clock time exists one offset-step earlier, return that instant.
 */
function earlierOffsetInFold(dt: DateTime): DateTime {
  const stepMinutes = dt.minus({ hours: 3 }).offset - dt.offset
  if (stepMinutes <= 0) return dt
  const earlier = DateTime.fromMillis(dt.toMillis() - stepMinutes * 60_000, { zone: dt.zone })
  return earlier.toFormat(WALL_CLOCK) === dt.toFormat(WALL_CLOCK) ? earlier : dt
}
