/**
 * KUKAN Storage Adapter Interface
 * S3-compatible object storage abstraction
 */

import { Readable } from 'stream'

export interface ObjectMeta {
  contentType?: string
  contentLength?: number
  originalFilename?: string
  [key: string]: unknown
}

export interface SignedUrlOptions {
  expiresIn?: number
  /** When true, sets Content-Disposition: inline so the browser displays the file instead of downloading */
  inline?: boolean
  /** Override the Content-Type header in the response */
  contentType?: string
  /** When set, forces Content-Disposition: attachment with the given filename */
  filename?: string
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
   * Download a byte range of an object from storage.
   * Used for Range request proxying (e.g., Parquet pagination via hyparquet).
   */
  downloadRange(
    key: string,
    start: number,
    end: number
  ): Promise<{ stream: Readable; totalSize: number; start: number; end: number }>

  /**
   * Get a presigned URL for uploading an object
   */
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn?: number,
    meta?: ObjectMeta
  ): Promise<string>

  /**
   * Delete all objects matching a key prefix.
   * Returns the number of deleted objects.
   */
  deleteByPrefix(prefix: string): Promise<number>
}
