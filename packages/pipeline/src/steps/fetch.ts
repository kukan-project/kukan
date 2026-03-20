/**
 * KUKAN Pipeline — Fetch Step
 * Downloads resource file to a temporary file (from Storage or external URL)
 */

import { createWriteStream } from 'fs'
import { unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { pipeline, finished } from 'stream/promises'
import { Readable } from 'stream'
import { KukanError, NotFoundError, ValidationError } from '@kukan/shared'
import type { PipelineContext } from '../types'

const MAX_EXTERNAL_DOWNLOAD_SIZE = 10 * 1024 * 1024 // 10MB
const FETCH_TIMEOUT_MS = 30_000

export interface FetchResult {
  tmpFile: string
  format: string | null
  packageId: string
}

/**
 * Fetch resource file to a temporary file.
 * For external URLs, also computes SHA-256 hash and updates resource.hash + lastModified if changed.
 */
export async function fetchStep(
  resourceId: string,
  ctx: PipelineContext,
  tmpFile: string
): Promise<FetchResult> {
  const res = await ctx.getResource(resourceId)

  if (!res) {
    throw new NotFoundError('Resource', resourceId)
  }

  if (res.urlType === 'upload') {
    const storageKey = `resources/${res.packageId}/${res.id}`
    const stream = await ctx.storage.download(storageKey)
    await pipeline(stream, createWriteStream(tmpFile))
  } else if (res.url) {
    const hash = await downloadWithLimit(res.url, tmpFile, MAX_EXTERNAL_DOWNLOAD_SIZE)

    // Update hash + lastModified if changed
    if (hash !== res.hash) {
      await ctx.updateResourceHash(resourceId, hash)
    }
  } else {
    throw new ValidationError('Resource has no file or URL')
  }

  return { tmpFile, format: res.format, packageId: res.packageId }
}

/**
 * Download a URL to a file with size limit. Returns SHA-256 hash.
 */
async function downloadWithLimit(url: string, destPath: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok || !response.body) {
    throw new KukanError(`Failed to fetch ${url}: ${response.status}`, 'BAD_GATEWAY', 502)
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new KukanError(
      `Resource exceeds ${maxBytes / 1024 / 1024}MB limit`,
      'PAYLOAD_TOO_LARGE',
      413
    )
  }

  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  const hash = createHash('sha256')
  const writeStream = createWriteStream(destPath)

  let totalSize = 0

  try {
    for await (const chunk of readable) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalSize += buf.length
      if (totalSize > maxBytes) {
        throw new KukanError(
          `Resource exceeds ${maxBytes / 1024 / 1024}MB limit`,
          'PAYLOAD_TOO_LARGE',
          413
        )
      }
      hash.update(buf)
      writeStream.write(buf)
    }
    writeStream.end()
    await finished(writeStream)
  } catch (err) {
    writeStream.destroy()
    await unlink(destPath).catch(() => {})
    throw err
  }

  return `sha256:${hash.digest('hex')}`
}
