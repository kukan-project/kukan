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
| ストレージ | S3         | MinIO / Local   | ✅ Yes                   |
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
// packages/storage/src/adapter.ts
interface StorageAdapter {
  upload(key: string, body: Buffer | Readable, meta?: ObjectMeta): Promise<void>
  download(key: string): Promise<Readable>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
}

// packages/search/src/adapter.ts
interface SearchAdapter {
  indexDataset(dataset: DatasetDoc): Promise<void>
  search(query: SearchQuery): Promise<SearchResult>
  deleteDataset(id: string): Promise<void>
  reindexAll(): Promise<void>
}

// packages/ai/src/adapter.ts
interface AIAdapter {
  generateDescription(resource: ResourceMeta): Promise<string>
  suggestTags(content: string): Promise<string[]>
  detectLanguage(text: string): Promise<string>
  embedText(text: string): Promise<number[]>
}

// packages/queue/src/adapter.ts
interface QueueAdapter {
  enqueue<T>(job: Job<T>): Promise<string>
  process<T>(handler: (job: Job<T>) => Promise<void>): void
  getStatus(jobId: string): Promise<JobStatus>
}
```

## 影響

- 実装するアダプタークラスは最大8つ（4インターフェース × AWS/ローカル各1）
- BullMQQueueAdapter は将来オプション（3つ目のQueue実装）
- 新しいアダプターを追加する場合はADRで議論してから
