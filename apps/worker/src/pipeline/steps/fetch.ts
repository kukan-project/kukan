/**
 * KUKAN Pipeline — Fetch Step
 * Downloads resource data and streams it directly to Storage (from external URL)
 * or verifies it exists (for uploads already in Storage).
 */

import { createHash } from 'crypto'
import { Transform, Readable } from 'stream'
import { KukanError, NotFoundError, ValidationError, getStorageKey } from '@kukan/shared'
import { safeFetch } from '@/safe-fetch'
import { HASH_PREFIX, digestStream } from '@kukan/shared/hash-node'
import type { PipelineContext } from '../types'
import { MAX_FETCH_SIZE, FETCH_TIMEOUT_MS } from '@/config'

const SIZE_LIMIT_MSG = `Resource exceeds ${MAX_FETCH_SIZE / 1024 / 1024}MB limit`

interface FetchResultData {
  storageKey: string
  format: string | null
  packageId: string
}

export type FetchResult = (FetchResultData & { status: 'fetched' }) | { status: 'deferred' }

/**
 * Fetch resource data into Storage.
 * - Upload resources: already in Storage, nothing to do.
 * - External URL resources: stream to Storage, compute hash/size on the fly.
 */
export async function executeFetch(resourceId: string, ctx: PipelineContext): Promise<FetchResult> {
  const res = await ctx.getResource(resourceId)

  if (!res) {
    throw new NotFoundError('Resource', resourceId)
  }

  const storageKey = getStorageKey(res.packageId, res.id)

  if (res.urlType === 'upload') {
    // Already in Storage — hash it here rather than trusting the value the
    // upload-complete call carried. Version capture gates on this hash and
    // records it against the bytes it copies (ADR-043), so a client-supplied
    // one would let a caller decide whether new versions are ever captured.
    const { hash, size } = await digestStream(await ctx.storage.download(storageKey))
    await ctx.recordContent(resourceId, { hash, size, previousHash: res.hash })
    return { storageKey, format: res.format, packageId: res.packageId, status: 'fetched' }
  }

  if (!res.url) {
    throw new ValidationError('Resource has no file or URL')
  }

  // Rate limit: max 1 request per interval per FQDN
  const fqdn = new URL(res.url).hostname
  const acquired = await ctx.acquireFetchSlot(fqdn)
  if (!acquired) {
    return { status: 'deferred' }
  }

  // The hash is cleared only once bytes are about to land, not before the
  // request: a DNS failure, an HTTP error or an oversize response leaves the
  // previous object in place, so the row must keep describing it. Once the
  // upload starts, the object is indeterminate and null is the honest value.
  const { hash, size } = await downloadToStorage(res.url, storageKey, ctx, () =>
    ctx.beginContentReplacement(resourceId)
  )
  await ctx.recordContent(resourceId, { hash, size, previousHash: res.hash })

  return { storageKey, format: res.format, packageId: res.packageId, status: 'fetched' }
}

async function downloadToStorage(
  url: string,
  storageKey: string,
  ctx: PipelineContext,
  /** Called once the response is validated and the write is about to begin. */
  beforeWrite: () => Promise<void>
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
  await beforeWrite()
  await ctx.storage.upload(storageKey, stream)

  return {
    hash: `${HASH_PREFIX}${hashDigest.digest('hex')}`,
    size: totalSize,
  }
}
