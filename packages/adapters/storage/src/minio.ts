/**
 * KUKAN MinIO Storage Adapter
 * Development/on-premise storage implementation
 */

import { Client } from 'minio'
import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'
import { StorageAdapter } from './adapter'

export interface MinIOConfig {
  endpoint: string
  port?: number
  useSSL?: boolean
  accessKey: string
  secretKey: string
  bucket: string
}

export class MinIOStorageAdapter implements StorageAdapter {
  private client: Client
  private bucket: string

  constructor(config: MinIOConfig) {
    const url = new URL(config.endpoint)
    this.client = new Client({
      endPoint: url.hostname,
      port: config.port || (url.protocol === 'https:' ? 443 : 9000),
      useSSL: config.useSSL ?? url.protocol === 'https:',
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    })
    this.bucket = config.bucket
  }

  async upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void> {
    const metadata = meta ? this.convertMeta(meta) : {}

    if (Buffer.isBuffer(body)) {
      await this.client.putObject(this.bucket, key, body, body.length, metadata)
    } else {
      // Stream upload - size unknown, use -1
      await this.client.putObject(this.bucket, key, body, -1, metadata)
    }
  }

  async download(key: string): Promise<Readable> {
    return await this.client.getObject(this.bucket, key)
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key)
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    return await this.client.presignedGetObject(this.bucket, key, expiresIn)
  }

  private convertMeta(meta: ObjectMeta): Record<string, string> {
    const result: Record<string, string> = {}
    if (meta.contentType) {
      result['Content-Type'] = meta.contentType
    }
    return result
  }
}
