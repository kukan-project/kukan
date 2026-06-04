> **Note**: This is a machine-translated version of the original Japanese ADR for reference purposes. The authoritative version is [`jp/004-lru-cache-no-adapter.md`](../jp/004-lru-cache-no-adapter.md).

# ADR-004: Adopt lru-cache Utility Without Creating a CacheAdapter

## Status

Accepted (2026-03-01)

## Context

The v3 design envisioned a CacheAdapter that would switch between ElastiCache (Redis) in AWS environments and in-memory caching in development. However, upon analyzing cache usage, it was determined that only API response caching and short-TTL metadata caching are needed, and cross-process sharing is unnecessary.

## Design Principle

> **"Only abstract what differs between environments."**

Caching is sufficient with in-memory across all environments → no environment difference → no adapter needed.

## Decision

- Place `lru-cache` 11.x as a utility in `packages/shared`
- Do not create a CacheAdapter interface
- Fully remove Redis / ElastiCache from the architecture

## Implementation

```typescript
// packages/shared/src/cache.ts
import { LRUCache } from 'lru-cache'

export function createCache<V>(options?: { max?: number; ttlMs?: number }) {
  return new LRUCache<string, V>({
    max: options?.max ?? 500,
    ttl: options?.ttlMs ?? 5 * 60 * 1000, // 5 minutes default
  })
}
```

## Consequences

- ElastiCache fully removed (~$13+/month savings)
- Redis container removed from Docker Compose
- Number of adapters limited to four (Storage, Search, AI, Queue)
