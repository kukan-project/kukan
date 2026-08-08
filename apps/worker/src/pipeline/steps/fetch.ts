/**
 * KUKAN Pipeline — Fetch Step
 * Downloads resource data and streams it directly to Storage (from external URL)
 * or verifies it exists (for uploads already in Storage).
 */

import { createHash, randomUUID } from 'crypto'
import { Transform, Readable } from 'stream'
import {
  KukanError,
  NotFoundError,
  ValidationError,
  getStorageKey,
  normalizeHostname,
} from '@kukan/shared'
import { HopRefusedError, discardBody, safeFetch } from '@/safe-fetch'
import { HASH_PREFIX, digestStream } from '@kukan/shared/hash-node'
import type { PipelineContext } from '../types'
import { MAX_FETCH_SIZE, FETCH_TIMEOUT_MS } from '@/config'

const SIZE_LIMIT_MSG = `Resource exceeds ${MAX_FETCH_SIZE / 1024 / 1024}MB limit`

interface FetchResultData {
  /** The object this run holds; nothing else writes it (ADR-043). */
  storageKey: string
  format: string | null
  packageId: string
  hash: string
  size: number
}

export type FetchResult =
  | (FetchResultData & { status: 'fetched' })
  | { status: 'deferred' }
  /** Another run replaced the content while this one was fetching. */
  | { status: 'superseded' }

/**
 * Fetch resource data into Storage.
 * - Upload resources: already in Storage, measure what landed there.
 * - External URL resources: stream to a key of this run's own, compute hash/size
 *   on the fly, then publish it as the resource's content.
 */
export async function executeFetch(
  resourceId: string,
  ctx: PipelineContext,
  rebuildOnly = false
): Promise<FetchResult> {
  const res = await ctx.getResource(resourceId)

  if (!res) {
    throw new NotFoundError('Resource', resourceId)
  }

  let key: string
  let measured: { hash: string; size: number }

  // A rebuild reads the object the resource already holds, whatever its type.
  // Re-fetching an external URL would publish whatever it serves now — and a
  // resource reverted *because* that URL served the wrong thing would have the
  // retraction undone by the run queued to finish it (ADR-044 §4).
  if (res.urlType === 'upload' || rebuildOnly) {
    // `upload-complete` moved the pointer; this measures what actually landed
    // rather than trusting the value the call carried. Version create records
    // this hash against the bytes it copies (ADR-043), so a client-supplied one
    // would decide what a version claims to hold.
    if (!res.storageKey) {
      throw new ValidationError(
        rebuildOnly ? 'Resource has no content to rebuild from' : 'Resource has no uploaded file'
      )
    }
    key = res.storageKey
    measured = await digestStream(await ctx.storage.download(key))
  } else {
    if (!res.url) {
      throw new ValidationError('Resource has no file or URL')
    }

    // Rate limit: max 1 request per interval per FQDN. Normalized, so that the
    // slot this takes is the one the chain's own hops compare against.
    const fqdn = normalizeHostname(new URL(res.url).hostname)
    if (!(await ctx.acquireFetchSlot(fqdn))) {
      return { status: 'deferred' }
    }

    // A key of this run's own, so the resource keeps serving the object it has
    // until these bytes are complete: a DNS failure, an HTTP error, an oversize
    // response or a half-written stream leaves the previous content untouched
    // because it was never the target.
    key = getStorageKey(res.packageId, res.id, randomUUID())
    try {
      measured = await downloadToStorage(res.url, key, ctx)
    } catch (err) {
      // A host the chain redirected to was over its own limit. The same answer
      // as the registered host being over its limit: nothing is wrong with the
      // resource, so come back rather than record a failure against it.
      if (err instanceof HopRefusedError) return { status: 'deferred' }
      throw err
    }
  }

  const published = await ctx.publishContent(resourceId, {
    key,
    // For an upload the pointer is already this key, so the move is a no-op and
    // only its guard matters: a newer upload having moved it means these bytes
    // are no longer the content.
    previousKey: res.urlType === 'upload' ? key : res.storageKey,
    ...measured,
    previousHash: res.hash,
  })
  if (!published) return { status: 'superseded' }

  return {
    storageKey: key,
    format: res.format,
    packageId: res.packageId,
    ...measured,
    status: 'fetched',
  }
}

async function downloadToStorage(
  url: string,
  storageKey: string,
  ctx: PipelineContext
): Promise<{ hash: string; size: number }> {
  const response = await safeFetch(
    url,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    // The slot taken above covers the host the user registered. Every host the
    // chain reaches after it takes one of its own, or the limit is watching the
    // only host an attacker does not need it to watch.
    { onHost: (hostname) => ctx.acquireFetchSlot(hostname) }
  )

  // Both refusals below leave without reading the body, so both have to let go
  // of it. A 404 pins a pooled connection exactly as a hostile redirect does,
  // and the oversize branch is the one an attacker reaches on purpose: declare
  // a length nobody will accept, and the body goes on arriving on a socket the
  // shared Agent cannot hand to anyone else.
  if (!response.ok || !response.body) {
    await discardBody(response)
    throw new KukanError(`Failed to fetch ${url}: ${response.status}`, 'BAD_GATEWAY', 502)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_SIZE) {
    await discardBody(response)
    throw new KukanError(SIZE_LIMIT_MSG, 'PAYLOAD_TOO_LARGE', 413)
  }

  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  const hashDigest = createHash('sha256')
  let totalSize = 0

  // Transform that computes hash and checks size limit while passing data through
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalSize += buf.length
      if (totalSize > MAX_FETCH_SIZE) {
        callback(new KukanError(SIZE_LIMIT_MSG, 'PAYLOAD_TOO_LARGE', 413))
        return
      }
      hashDigest.update(buf)
      callback(null, buf)
    },
  })

  const stream = readable.pipe(meter)
  await ctx.putObject(storageKey, stream)

  return {
    hash: `${HASH_PREFIX}${hashDigest.digest('hex')}`,
    size: totalSize,
  }
}
