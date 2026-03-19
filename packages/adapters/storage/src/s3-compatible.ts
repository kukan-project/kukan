/**
 * KUKAN S3-Compatible Storage Adapter
 * Works with both AWS S3 and MinIO via @aws-sdk/client-s3
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'
import { ObjectMeta } from '@kukan/shared'
import { StorageAdapter } from './adapter'

export interface S3CompatibleConfig {
  bucket: string
  region?: string
  endpoint?: string // MinIO: 'http://localhost:9000', AWS S3: omit
  accessKeyId?: string // MinIO: required, AWS S3: use IAM role
  secretAccessKey?: string
  forcePathStyle?: boolean // auto-detected from endpoint presence if not set
}

export class S3CompatibleStorageAdapter implements StorageAdapter {
  private client: S3Client
  private bucket: string

  constructor(config: S3CompatibleConfig) {
    this.bucket = config.bucket
    this.client = new S3Client({
      region: config.region ?? 'ap-northeast-1',
      ...(config.endpoint && { endpoint: config.endpoint }),
      ...(config.accessKeyId &&
        config.secretAccessKey && {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }),
      forcePathStyle: config.forcePathStyle ?? !!config.endpoint,
    })
  }

  private buildMetadata(meta?: ObjectMeta): Record<string, string> {
    const metadata: Record<string, string> = {}
    if (meta?.originalFilename) metadata['original-filename'] = meta.originalFilename
    return metadata
  }

  async upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void> {
    const metadata = this.buildMetadata(meta)

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: meta?.contentType,
        ...(Buffer.isBuffer(body) && { ContentLength: body.length }),
        ...(Object.keys(metadata).length > 0 && { Metadata: metadata }),
      })
    )
  }

  async download(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    )
    return response.Body as Readable
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    )
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn }
    )
  }

  async getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = 3600,
    meta?: ObjectMeta
  ): Promise<string> {
    const metadata = this.buildMetadata(meta)

    return await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ...(Object.keys(metadata).length > 0 && { Metadata: metadata }),
      }),
      { expiresIn }
    )
  }
}
