/**
 * KUKAN Storage Adapter Interface
 * S3-compatible object storage abstraction
 */

import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'

export interface StorageAdapter {
  /**
   * Upload an object to storage
   */
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>

  /**
   * Download an object from storage
   */
  download(key: string): Promise<Readable>

  /**
   * Delete an object from storage
   */
  delete(key: string): Promise<void>

  /**
   * Get a presigned URL for temporary access
   */
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
}
