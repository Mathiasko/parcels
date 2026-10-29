import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Appends to a log file that never grows much past `maxBytes`: when a chunk would take it over, the
 * current file becomes `<path>.1` (replacing an older one) and the chunk starts a new file. So at most
 * two files exist, and the newest lines are always in `<path>`.
 *
 * Synchronous on purpose: the main process writes here from stream and crash handlers, and a write
 * that is still queued when the process exits is a lost line about why it exited. The file is created
 * 0600 because a log can quote a mail subject or a tracking number.
 */
export function appendRotating(path: string, chunk: string, maxBytes = 1_000_000): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let size = 0
  try { size = statSync(path).size } catch { /* No file yet: nothing to rotate. */ }
  // An empty file is never rotated, so one chunk larger than the limit is written whole rather than
  // leaving an empty `.1` behind.
  if (size > 0 && size + Buffer.byteLength(chunk) > maxBytes) renameSync(path, `${path}.1`)
  appendFileSync(path, chunk, { mode: 0o600 })
}
