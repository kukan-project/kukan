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
   * Server-side copy within the same bucket (no data streamed through the app).
   * Used to capture immutable per-version snapshots (ADR-043).
   */
  copy(sourceKey: string, destKey: string): Promise<void>

  /**
   * Get object metadata (byte size) without downloading the body.
   * Returns null if the object does not exist.
   */
  head(key: string): Promise<{ size: number } | null>

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

  /**
   * Delete the given keys, returning the ones that are gone. A key the backend
   * reports an error for is left out rather than failing the batch, so a caller
   * tracking objects for deletion can keep the rest (ADR-043).
   */
  deleteMany(keys: string[]): Promise<string[]>
}
