/**
 * KUKAN Pipeline — Fetch Step
 * Downloads resource data and streams it directly to Storage (from external URL)
 * or verifies it exists (for uploads already in Storage).
 */

import { createHash } from 'crypto'
import { Transform, Readable } from 'stream'
import { KukanError, NotFoundError, ValidationError, getStorageKey } from '@kukan/shared'
import type { PipelineContext } from '../types'

const MAX_EXTERNAL_DOWNLOAD_SIZE = 10 * 1024 * 1024 // 10MB
const FETCH_TIMEOUT_MS = 30_000

export interface FetchResult {
  storageKey: string
  format: string | null
  packageId: string
}

/**
 * Fetch resource data into Storage.
 * - Upload resources: already in Storage, nothing to do.
 * - External URL resources: stream to Storage, compute hash/size on the fly.
 */
export async function fetchStep(resourceId: string, ctx: PipelineContext): Promise<FetchResult> {
  const res = await ctx.getResource(resourceId)

  if (!res) {
    throw new NotFoundError('Resource', resourceId)
  }

  const storageKey = getStorageKey(res.packageId, res.id)

  if (res.urlType === 'upload') {
    // Already in Storage — compute hash if missing
    if (!res.hash) {
      const { hash, size } = await computeHash(storageKey, ctx)
      await ctx.updateResourceHashAndSize(resourceId, { hash, size })
    }
  } else if (res.url) {
    const { hash, size } = await downloadToStorage(res.url, storageKey, ctx)

    if (hash !== res.hash) {
      await ctx.updateResourceHashAndSize(resourceId, { hash, size })
    }
  } else {
    throw new ValidationError('Resource has no file or URL')
  }

  return { storageKey, format: res.format, packageId: res.packageId }
}

/** Compute SHA-256 hash and size from an existing Storage object */
async function computeHash(
  storageKey: string,
  ctx: PipelineContext
): Promise<{ hash: string; size: number }> {
  const stream = await ctx.storage.download(storageKey)
  const hashDigest = createHash('sha256')
  let totalSize = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hashDigest.update(buf)
    totalSize += buf.length
  }
  return { hash: `sha256:${hashDigest.digest('hex')}`, size: totalSize }
}

async function downloadToStorage(
  url: string,
  storageKey: string,
  ctx: PipelineContext
): Promise<{ hash: string; size: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok || !response.body) {
    throw new KukanError(`Failed to fetch ${url}: ${response.status}`, 'BAD_GATEWAY', 502)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_EXTERNAL_DOWNLOAD_SIZE) {
    throw new KukanError(
      `Resource exceeds ${MAX_EXTERNAL_DOWNLOAD_SIZE / 1024 / 1024}MB limit`,
      'PAYLOAD_TOO_LARGE',
      413
    )
  }

  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  const hashDigest = createHash('sha256')
  let totalSize = 0

  // Transform that computes hash and checks size limit while passing data through
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalSize += buf.length
      if (totalSize > MAX_EXTERNAL_DOWNLOAD_SIZE) {
        callback(
          new KukanError(
            `Resource exceeds ${MAX_EXTERNAL_DOWNLOAD_SIZE / 1024 / 1024}MB limit`,
            'PAYLOAD_TOO_LARGE',
            413
          )
        )
        return
      }
      hashDigest.update(buf)
      callback(null, buf)
    },
  })

  const stream = readable.pipe(meter)
  await ctx.storage.upload(storageKey, stream)

  return {
    hash: `sha256:${hashDigest.digest('hex')}`,
    size: totalSize,
  }
}
