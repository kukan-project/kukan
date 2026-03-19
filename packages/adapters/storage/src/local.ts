/**
 * KUKAN Local Storage Adapter
 * Filesystem-based storage for development/testing
 */

import { mkdir, writeFile, unlink } from 'fs/promises'
import { createReadStream } from 'fs'
import { join, dirname } from 'path'
import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'
import { StorageAdapter } from './adapter'

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
      const chunks: Buffer[] = []
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk))
      }
      await writeFile(filePath, Buffer.concat(chunks))
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

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
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
