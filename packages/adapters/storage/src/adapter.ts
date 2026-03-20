/**
 * KUKAN Storage Adapter Interface
 * S3-compatible object storage abstraction
 */

import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'

export interface SignedUrlOptions {
  expiresIn?: number
  /** When true, sets Content-Disposition: inline so the browser displays the file instead of downloading */
  inline?: boolean
  /** Override the Content-Type header in the response */
  contentType?: string
}

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
   * Get a presigned URL for temporary read access
   */
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>

  /**
   * Get a presigned URL for uploading an object
   */
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn?: number,
    meta?: ObjectMeta
  ): Promise<string>
}
