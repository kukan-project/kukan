/**
 * KUKAN Pipeline — Fetch Step
 * Downloads resource data and streams it directly to Storage (from external URL)
 * or verifies it exists (for uploads already in Storage).
 */

import { createHash, randomUUID } from 'crypto'
import { Transform, Readable } from 'stream'
import { KukanError, NotFoundError, ValidationError, getStorageKey } from '@kukan/shared'
import { safeFetch } from '@/safe-fetch'
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
export async function executeFetch(resourceId: string, ctx: PipelineContext): Promise<FetchResult> {
  const res = await ctx.getResource(resourceId)

  if (!res) {
    throw new NotFoundError('Resource', resourceId)
  }

  let key: string
  let measured: { hash: string; size: number }

  if (res.urlType === 'upload') {
    // `upload-complete` moved the pointer; this measures what actually landed
    // rather than trusting the value the call carried. Version capture records
    // this hash against the bytes it copies (ADR-043), so a client-supplied one
    // would decide what a version claims to hold.
    if (!res.storageKey) {
      throw new ValidationError('Resource has no uploaded file')
    }
    key = res.storageKey
    measured = await digestStream(await ctx.storage.download(key))
  } else {
    if (!res.url) {
      throw new ValidationError('Resource has no file or URL')
    }

    // Rate limit: max 1 request per interval per FQDN
    const fqdn = new URL(res.url).hostname
    if (!(await ctx.acquireFetchSlot(fqdn))) {
      return { status: 'deferred' }
    }

    // A key of this run's own, so the resource keeps serving the object it has
    // until these bytes are complete: a DNS failure, an HTTP error, an oversize
    // response or a half-written stream leaves the previous content untouched
    // because it was never the target.
    key = getStorageKey(res.packageId, res.id, randomUUID())
    measured = await downloadToStorage(res.url, key, ctx)
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
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok || !response.body) {
    throw new KukanError(`Failed to fetch ${url}: ${response.status}`, 'BAD_GATEWAY', 502)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_SIZE) {
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
