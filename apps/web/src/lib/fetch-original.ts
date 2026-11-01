import { clientFetch } from '@/lib/client-api'
import { readUpTo } from '@/lib/read-up-to'

/** The largest original fetched to draw in the browser (ADR-065 decision 3) */
const ORIGINAL_LIMIT = 64 * 1024 * 1024

/** Whether a file's recorded size already rules out fetching it. */
export function overOriginalLimit(size?: number | null): boolean {
  return !!size && size > ORIGINAL_LIMIT
}

/** The resource's file, read up to the limit; throws `TooLarge` past it. */
export async function fetchOriginal(resourceId: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await clientFetch(`/api/v1/resources/${encodeURIComponent(resourceId)}/preview`, {
    signal,
  })
  if (!res.ok) throw new Error(`preview ${res.status}`)
  return readUpTo(res, ORIGINAL_LIMIT)
}
