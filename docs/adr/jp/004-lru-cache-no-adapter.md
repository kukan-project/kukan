# ADR-004: lru-cache ユーティリティを採用し、CacheAdapter を作らない

## ステータス

承認済み（2026-03-01）

## コンテキスト

v3設計ではCacheAdapterを用意し、AWS環境ではElastiCache(Redis)、開発環境ではインメモリの切り替えを想定していた。しかしキャッシュの用途を分析すると、APIレスポンスキャッシュとメタデータのショートTTLキャッシュのみであり、プロセス間共有は不要と判断。

## 設計原則

> **「環境差があるものだけ抽象化する」**

キャッシュはすべての環境でインメモリで十分 → 環境差がない → アダプター不要。

## 決定

- `lru-cache` 11.x をユーティリティとして `packages/shared` に配置
- CacheAdapter インターフェースは作らない
- Redis / ElastiCache は構成要素から完全削除

## 実装

```typescript
// packages/shared/src/cache.ts
import { LRUCache } from 'lru-cache'

export function createCache<V>(options?: { max?: number; ttlMs?: number }) {
  return new LRUCache<string, V>({
    max: options?.max ?? 500,
    ttl: options?.ttlMs ?? 5 * 60 * 1000, // 5分デフォルト
  })
}
```

## 影響

- ElastiCache 完全削除（月額 ~$13〜 削減）
- Docker Compose からRedisコンテナ削除
- アダプター数を4つに限定（Storage, Search, AI, Queue）
