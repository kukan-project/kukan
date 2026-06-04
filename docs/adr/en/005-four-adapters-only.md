> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/005-four-adapters-only.md`](../jp/005-four-adapters-only.md).

# ADR-005: Only Four Adapters (Storage / Search / AI / Queue)

## Status

Accepted (2026-03-01)

## Context

The v3 design envisioned six or more adapters (Storage, Search, Cache, Queue, AI, Metrics, etc.).
We re-evaluated the cost of abstraction (interface definitions, doubled testing, configuration management) against the actual environment differences.

## Design Principle

> **"Only abstract what changes between environments." (YAGNI)**

## Analysis

| Feature | AWS             | Development/On-prem   | Environment difference?                      |
| ------- | --------------- | --------------------- | -------------------------------------------- |
| Storage | S3-compatible   | S3-compatible (MinIO) | ✅ Yes                                       |
| Search  | OpenSearch      | PG full-text search   | ✅ Yes                                       |
| AI      | Bedrock         | Ollama / OpenAI       | ✅ Yes                                       |
| Queue   | SQS             | ElasticMQ             | ✅ Yes                                       |
| Cache   | lru-cache       | lru-cache             | ❌ No → utility                              |
| DB      | PostgreSQL      | PostgreSQL            | ❌ No → use directly                         |
| Logging | CloudWatch Logs | pino (JSON)           | ❌ No → pino is sufficient for all (ADR-019) |

## Decision

Define adapter interfaces only for the four areas where environment differences exist.

## Adapter List

```typescript
// packages/adapters/storage/src/adapter.ts (@kukan/storage-adapter)
interface StorageAdapter {
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
  download(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn?: number,
    meta?: ObjectMeta
  ): Promise<string>
}

// packages/adapters/search/src/adapter.ts (@kukan/search-adapter)
interface SearchAdapter {
  index(doc: DatasetDoc): Promise<void>
  search(query: SearchQuery): Promise<SearchResult>
  delete(id: string): Promise<void>
  bulkIndex(docs: DatasetDoc[]): Promise<void>
}

// packages/adapters/ai/src/adapter.ts (@kukan/ai-adapter)
interface AIAdapter {
  complete(prompt: string, options?: CompleteOptions): Promise<string>
  embed(text: string): Promise<number[]>
}

// packages/adapters/queue/src/adapter.ts (@kukan/queue-adapter)
interface QueueAdapter {
  enqueue<T>(type: string, data: T): Promise<string>
  getStatus(jobId: string): Promise<JobStatus | null>
  process<T>(type: string, handler: (job: Job<T>) => Promise<void>): Promise<void>
  stop(): Promise<void>
}
```

## Consequences

- Maximum of 8 adapter classes to implement (4 interfaces × 1 AWS + 1 local each)
- BullMQQueueAdapter remains as a future option (a third Queue implementation)
- Adding new adapters requires discussion via an ADR first

## Addendum: StorageAdapter Unification (2026-03-19)

The former `MinIOStorageAdapter` (`minio` package) and `S3StorageAdapter` have been
unified into `S3StorageAdapter` (based on `@aws-sdk/client-s3`).
Since MinIO uses the S3-compatible protocol, the presence of `S3_ENDPOINT` determines the mode automatically:

- `S3_ENDPOINT` present → MinIO mode (`forcePathStyle: true`)
- `S3_ENDPOINT` absent → AWS S3 mode (IAM role authentication)

`STORAGE_TYPE` is unnecessary (S3-compatible only). The presence of `S3_ENDPOINT` automatically determines MinIO vs. AWS S3.
