/**
 * KUKAN S3 Storage Adapter
 * Works with both AWS S3 and MinIO via @aws-sdk/client-s3
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'stream'
import {
  type ObjectMeta,
  type ObjectPage,
  type SignedUrlOptions,
  type StorageAdapter,
} from './adapter'

/** S3's per-request cap for DeleteObjects. */
const DELETE_BATCH_SIZE = 1000

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

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        // CopySource must be URL-encoded so keys with spaces/special chars resolve.
        CopySource: encodeURI(`${this.bucket}/${sourceKey}`),
        Key: destKey,
      })
    )
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      )
      return { size: response.ContentLength ?? 0 }
    } catch (err) {
      // S3 sets name 'NotFound', GetObject-style backends 'NoSuchKey'; some
      // S3-compatible servers (MinIO) only set the 404 status — treat all as
      // "object missing" rather than a hard error.
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
      if (
        status === 404 ||
        (err instanceof Error && (err.name === 'NotFound' || err.name === 'NoSuchKey'))
      ) {
        return null
      }
      throw err
    }
  }

  async downloadRange(
    key: string,
    start: number,
    end?: number
  ): Promise<{
    stream: Readable
    totalSize: number
    start: number
    end: number
    partial: boolean
  }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${start}-${end ?? ''}`,
      })
    )

    // "bytes 100-199/1234" — the backend's own account of what it served,
    // which is authoritative when the request was open-ended or clamped.
    const served = response.ContentRange?.match(/bytes (\d+)-(\d+)\/(\d+)/)
    if (served) {
      return {
        stream: response.Body as Readable,
        totalSize: parseInt(served[3], 10),
        start: parseInt(served[1], 10),
        end: parseInt(served[2], 10),
        partial: true,
      }
    }

    // No Content-Range means the backend ignored the Range and sent the full
    // body; report the offsets of what is actually in the stream rather than
    // echoing the request, or the caller would label a 200 body as a 206.
    const totalSize = response.ContentLength ?? 0
    return {
      stream: response.Body as Readable,
      totalSize,
      start: 0,
      end: totalSize - 1,
      partial: false,
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

  async list(prefix: string, continuationToken?: string): Promise<ObjectPage> {
    const page = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )

    return {
      // A listing entry without a key or a timestamp is not something to guess
      // at: the caller decides what to delete from this, and an object it
      // cannot date is one it cannot tell from a write still in flight.
      objects: (page.Contents ?? []).flatMap((o) =>
        o.Key && o.LastModified ? [{ key: o.Key, lastModified: o.LastModified }] : []
      ),
      nextToken: page.IsTruncated ? page.NextContinuationToken : undefined,
    }
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

  async deleteMany(keys: string[]): Promise<string[]> {
    const gone: string[] = []
    // DeleteObjects takes 1000 keys per request; the alternative is one request
    // per key, which for the hourly orphan sweep is three orders of magnitude
    // more round trips for the same work.
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE)
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        })
      )
      const failed = new Set((result.Errors ?? []).map((e) => e.Key))
      gone.push(...batch.filter((key) => !failed.has(key)))
    }
    return gone
  }
}
