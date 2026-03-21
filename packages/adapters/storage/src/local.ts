/**
 * KUKAN Local Storage Adapter
 * Filesystem-based storage for development/testing
 */

import { mkdir, writeFile, unlink, stat as fsStat } from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import { join, dirname } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'
import { StorageAdapter, type SignedUrlOptions } from './adapter'

export interface LocalStorageConfig {
  basePath: string
}

export class LocalStorageAdapter implements StorageAdapter {
  private basePath: string

  constructor(config: LocalStorageConfig) {
    this.basePath = config.basePath
  }

  async upload(key: string, body: Buffer | Readable, _meta?: ObjectMeta): Promise<void> {
    const filePath = join(this.basePath, key)
    const dir = dirname(filePath)

    await mkdir(dir, { recursive: true })

    if (Buffer.isBuffer(body)) {
      await writeFile(filePath, body)
    } else {
      await pipeline(body, createWriteStream(filePath))
    }
  }

  async download(key: string): Promise<Readable> {
    const filePath = join(this.basePath, key)
    return createReadStream(filePath)
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.basePath, key)
    await unlink(filePath)
  }

  async downloadRange(
    key: string,
    start: number,
    end: number
  ): Promise<{ stream: Readable; totalSize: number; start: number; end: number }> {
    const filePath = join(this.basePath, key)
    const stats = await fsStat(filePath)
    const totalSize = stats.size
    const actualEnd = Math.min(end, totalSize - 1)
    const stream = createReadStream(filePath, { start, end: actualEnd })
    return { stream, totalSize, start, end: actualEnd }
  }

  async getSignedUrl(key: string, _options?: SignedUrlOptions): Promise<string> {
    // Local filesystem doesn't support signed URLs
    // Return a file:// URL for local access
    const filePath = join(this.basePath, key)
    return `file://${filePath}`
  }

  async getSignedUploadUrl(
    key: string,
    _contentType: string,
    _expiresIn: number = 3600,
    _meta?: ObjectMeta
  ): Promise<string> {
    // Local filesystem doesn't support presigned upload URLs
    // Return a sentinel URL — the server-side upload endpoint handles the actual file write
    return `local://${key}`
  }
}
