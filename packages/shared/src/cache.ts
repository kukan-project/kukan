/**
 * KUKAN Cache Utility
 * LRU cache wrapper for consistent caching across all environments
 */

import { LRUCache } from 'lru-cache'

export interface CacheOptions {
  max?: number
  ttlMs?: number
}

/**
 * Create an LRU cache instance
 * @param options - Cache configuration
 * @returns LRU cache instance
 */
export function createCache(options?: CacheOptions) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new LRUCache<string, any>({
    max: options?.max ?? 500,
    ttl: options?.ttlMs ?? 5 * 60 * 1000, // 5 minutes default
  })
}
