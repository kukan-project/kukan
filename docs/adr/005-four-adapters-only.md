# ADR-005: アダプターは4つだけ（Storage / Search / AI / Queue）

## ステータス

承認済み（2026-03-01）

## コンテキスト

v3設計では6つ以上のアダプター（Storage, Search, Cache, Queue, AI, Metrics等）を想定していた。
抽象化のコスト（インターフェース定義、テスト倍増、設定管理）と実際の環境差を再評価した。

## 設計原則

> **「環境によって実装が変わるものだけ抽象化する」（YAGNI）**

## 分析

| 機能       | AWS        | 開発/オンプレ   | 環境差あり？             |
| ---------- | ---------- | --------------- | ------------------------ |
| ストレージ | S3互換     | S3互換 / Local  | ✅ Yes                   |
| 全文検索   | OpenSearch | PG全文検索      | ✅ Yes                   |
| AI推論     | Bedrock    | Ollama / OpenAI | ✅ Yes                   |
| キュー     | SQS        | InProcess       | ✅ Yes                   |
| キャッシュ | lru-cache  | lru-cache       | ❌ No → ユーティリティ   |
| DB         | PostgreSQL | PostgreSQL      | ❌ No → 直接使用         |
| メトリクス | CloudWatch | console.log     | ❌ No → ロガー設定で十分 |

## 決定

環境差がある4つだけアダプターインターフェースを定義する。

## アダプター一覧

```typescript
// packages/adapters/storage/src/adapter.ts (@kukan/storage-adapter)
interface StorageAdapter {
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
  download(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
  getSignedUploadUrl(key: string, contentType: string, expiresIn?: number, meta?: ObjectMeta): Promise<string>
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

## 影響

- 実装するアダプタークラスは最大8つ（4インターフェース × AWS/ローカル各1）
- BullMQQueueAdapter は将来オプション（3つ目のQueue実装）
- 新しいアダプターを追加する場合はADRで議論してから

## 補足: StorageAdapter 統合（2026-03-19）

旧 `MinIOStorageAdapter`（`minio` パッケージ）と `S3StorageAdapter` を
`S3CompatibleStorageAdapter`（`@aws-sdk/client-s3` ベース）に統合。
MinIO は S3 互換プロトコルのため、`S3_ENDPOINT` の有無で自動判別する:

- `S3_ENDPOINT` あり → MinIO モード（`forcePathStyle: true`）
- `S3_ENDPOINT` なし → AWS S3 モード（IAM ロール認証）

`STORAGE_TYPE` は `'s3' | 'local'` の 2 値に簡素化。
