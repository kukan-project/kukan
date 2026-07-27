/**
 * Content hashes recorded on resources and versions (ADR-043).
 * Node-only (streams + crypto), so it lives outside the browser-safe index —
 * import from '@kukan/shared/hash-node'.
 */
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

export const HASH_PREFIX = 'sha256:'

export function hashBuffer(buf: Buffer): string {
  return `${HASH_PREFIX}${createHash('sha256').update(buf).digest('hex')}`
}

/**
 * Hash a stream without buffering it — objects run to the fetch size cap.
 * Returns the byte count too: a caller verifying content usually has to record
 * the size as well, and reading twice for it would be wasteful.
 */
export async function digestStream(stream: Readable): Promise<{ hash: string; size: number }> {
  const digest = createHash('sha256')
  let size = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    size += buf.length
    digest.update(buf)
  }
  return { hash: `${HASH_PREFIX}${digest.digest('hex')}`, size }
}
