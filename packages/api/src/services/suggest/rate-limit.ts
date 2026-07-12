/**
 * Per-user rate limit for AI metadata suggestions (ADR-040).
 * Fixed window: the TTL starts at a user's first request and the counter is
 * dropped when it expires.
 */

import { createCache, TooManyRequestsError } from '@kukan/shared'
import { SUGGEST_RATE_LIMIT, SUGGEST_RATE_WINDOW_MS } from '../../config'

export interface SuggestRateLimiter {
  /** Count one suggestion request; throws 429 when the window budget is spent. */
  check(userId: string): void
  /** Drop all counters (tests). */
  reset(): void
}

export function createSuggestRateLimiter(
  limit = SUGGEST_RATE_LIMIT,
  windowMs = SUGGEST_RATE_WINDOW_MS
): SuggestRateLimiter {
  const counters = createCache({ max: 10_000, ttlMs: windowMs })
  return {
    check(userId) {
      const count = (counters.get(userId) as number | undefined) ?? 0
      if (count >= limit) {
        throw new TooManyRequestsError('AI suggestion rate limit reached; please try again later')
      }
      // First set starts the TTL; increments preserve it so the window stays
      // anchored at the user's first request
      counters.set(userId, count + 1, count === 0 ? undefined : { noUpdateTTL: true })
    },
    reset() {
      counters.clear()
    },
  }
}

// Module-level singleton shared across requests (same pattern as the query
// semaphore). In-memory keeps the DB unchanged (ADR-040); a multi-instance
// deployment enforces ~instances × limit, acceptable for LLM cost capping.
export const suggestRateLimiter = createSuggestRateLimiter()
