/**
 * Copy an object and confirm what landed (ADR-043 layer 1).
 *
 * The source is the resource's shared live key, which Fetch rewrites outside
 * any lock a capture can hold, so the copy may have taken a different run's
 * bytes than the caller expects. The copy is immutable once made, so measuring
 * it settles the question — and a version is never recorded against content it
 * does not hold. On a mismatch the stray copy is removed and the caller decides
 * whether to abandon or, where the expectation itself was untrustworthy, adopt
 * the measurement.
 */
import { digestStream } from '@kukan/shared/hash-node'
import type { StorageAdapter } from '@kukan/storage-adapter'

export interface CopiedObject {
  hash: string
  size: number
}

/** @returns what the destination actually holds, measured rather than assumed. */
export async function copyAndMeasure(
  storage: StorageAdapter,
  from: string,
  to: string
): Promise<CopiedObject> {
  await storage.copy(from, to)
  return digestStream(await storage.download(to))
}

/** Remove a copy the caller decided not to keep. Best-effort. */
export async function discardCopy(storage: StorageAdapter, key: string): Promise<void> {
  await storage.delete(key).catch(() => {})
}
