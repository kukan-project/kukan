/**
 * KUKAN S3 Storage Adapter
 * AWS S3 storage implementation (Phase 2)
 */

import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'
import { StorageAdapter } from './adapter'

export interface S3Config {
  region: string
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
}

export class S3StorageAdapter implements StorageAdapter {
  constructor(_config: S3Config) {
    // Stub implementation
  }

  async upload(_key: string, _body: Buffer | Readable, _meta?: ObjectMeta): Promise<void> {
    throw new Error('S3StorageAdapter not implemented yet (Phase 2)')
  }

  async download(_key: string): Promise<Readable> {
    throw new Error('S3StorageAdapter not implemented yet (Phase 2)')
  }

  async delete(_key: string): Promise<void> {
    throw new Error('S3StorageAdapter not implemented yet (Phase 2)')
  }

  async getSignedUrl(_key: string, _expiresIn?: number): Promise<string> {
    throw new Error('S3StorageAdapter not implemented yet (Phase 2)')
  }
}
