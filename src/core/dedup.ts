import { createHash } from 'node:crypto'
import type { ParcelEvent } from './types.js'

/** Identity of an event across polls: carriers resend full history, so this must be stable. */
export function dedupHash(e: Pick<ParcelEvent, 'occurredAtRaw' | 'code' | 'description'>): string {
  return createHash('sha256')
    .update(e.occurredAtRaw + '|' + (e.code ?? '') + '|' + e.description)
    .digest('hex')
}
