/**
 * KUKAN S3 Storage Adapter
 * Works with both AWS S3 and MinIO via @aws-sdk/client-s3
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'
import { type ObjectMeta, type SignedUrlOptions, type StorageAdapter } from './adapter'

export interface S3Config {
  bucket: string
  region?: string
  endpoint?: string // MinIO: 'http://localhost:9000', AWS S3: omit
  accessKeyId?: string // MinIO: required, AWS S3: use IAM role
  secretAccessKey?: string
  forcePathStyle?: boolean // auto-detected from endpoint presence if not set
}

export class S3StorageAdapter implements StorageAdapter {
  private client: S3Client
  private bucket: string

  constructor(config: S3Config) {
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

    if (Buffer.isBuffer(body)) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: meta?.contentType,
          ContentLength: body.length,
          ...(Object.keys(metadata).length > 0 && { Metadata: metadata }),
        })
      )
    } else {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: meta?.contentType,
          ...(Object.keys(metadata).length > 0 && { Metadata: metadata }),
        },
      })
      await upload.done()
    }
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

  async downloadRange(
    key: string,
    start: number,
    end: number
  ): Promise<{ stream: Readable; totalSize: number; start: number; end: number }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      })
    )

    const totalSize = response.ContentRange
      ? parseInt(response.ContentRange.split('/')[1], 10)
      : (response.ContentLength ?? 0)

    return {
      stream: response.Body as Readable,
      totalSize,
      start,
      end: Math.min(end, totalSize - 1),
    }
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const expiresIn = options?.expiresIn ?? 3600

    let disposition: string | undefined
    if (options?.filename) {
      const encoded = encodeURIComponent(options.filename)
      disposition = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
    } else if (options?.inline) {
      disposition = 'inline'
    }

    return await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(disposition && { ResponseContentDisposition: disposition }),
        ...(options?.contentType && { ResponseContentType: options.contentType }),
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

  async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0
    let continuationToken: string | undefined

    for (;;) {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      )

      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }))
      if (keys.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys },
          })
        )
        if (result.Errors && result.Errors.length > 0) {
          throw new Error(`Failed to delete ${result.Errors.length} objects`)
        }
        deleted += keys.length
      }

      if (!list.IsTruncated) break
      continuationToken = list.NextContinuationToken
    }

    return deleted
  }
}
