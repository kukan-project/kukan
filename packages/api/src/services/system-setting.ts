/**
 * System Setting Service — DB-backed runtime settings (ADR-036).
 * Generic key/value rows with a short-TTL read cache. Every setting is declared
 * in SETTING_DEFINITIONS; invalid or missing values degrade to the default.
 */

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '@kukan/db'
import { systemSetting } from '@kukan/db'
import { createCache } from '@kukan/shared'
import { SYSTEM_SETTING_CACHE_TTL_MS, VECTOR_SIMILARITY_MAX_NOTCHES } from '../config'

export const VECTOR_SIMILARITY_NOTCHES_KEY = 'vector-similarity-notches'
export const SEMANTIC_SEARCH_ENABLED_KEY = 'semantic-search-enabled'
export const SEARCH_EXAMPLE_QUERIES_KEY = 'search-example-queries'
export const REGISTRATION_ENABLED_KEY = 'registration-enabled'
export const AI_SUGGEST_MODEL_KEY = 'ai-suggest-model'
export const AI_SUGGEST_ENABLED_KEY = 'ai-suggest-enabled'

/** Registry of runtime settings — adding a setting means adding an entry here */
const SETTING_DEFINITIONS = {
  // Similarity-floor adjustment in notches — integers keep the offset exact
  // and audit entries readable
  [VECTOR_SIMILARITY_NOTCHES_KEY]: {
    schema: z.number().int().min(-VECTOR_SIMILARITY_MAX_NOTCHES).max(VECTOR_SIMILARITY_MAX_NOTCHES),
    default: 0,
  },
  // Global kill switch for the vector leg of hybrid search
  [SEMANTIC_SEARCH_ENABLED_KEY]: {
    schema: z.boolean(),
    default: true,
  },
  // Example-query chips under the search box; empty = hidden
  [SEARCH_EXAMPLE_QUERIES_KEY]: {
    schema: z.array(z.string().trim().min(1).max(100)).max(10),
    default: [] as string[],
  },
  // Self-registration; overridden to allowed while the user table is empty (ADR-038)
  [REGISTRATION_ENABLED_KEY]: {
    schema: z.boolean(),
    default: false,
  },
  // Generation model for AI metadata suggestions; '' = provider default (ADR-040).
  // Runtime-switchable because suggestions are never persisted, unlike the
  // embedding model which is pinned to stored vectors.
  [AI_SUGGEST_MODEL_KEY]: {
    schema: z.string().trim().max(200),
    default: '',
  },
  // Kill switch for AI metadata suggestions
  [AI_SUGGEST_ENABLED_KEY]: {
    schema: z.boolean(),
    default: true,
  },
} as const

export type SettingKey = keyof typeof SETTING_DEFINITIONS
type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[]

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_DEFINITIONS
}

/** Validate a candidate value against the key's registry schema (generic admin API) */
export function parseSettingValue(key: SettingKey, value: unknown) {
  return SETTING_DEFINITIONS[key].schema.safeParse(value)
}

export class SystemSettingService {
  private db: Database
  /** Caches { value } wrappers so a missing row is negatively cached too */
  private cache = createCache({ max: 100, ttlMs: SYSTEM_SETTING_CACHE_TTL_MS })

  constructor(db: Database) {
    this.db = db
  }

  /** Narrow the union so schema.parse/safeParse type-check per key */
  private def<K extends SettingKey>(key: K) {
    return SETTING_DEFINITIONS[key] as unknown as {
      schema: z.ZodType<SettingValue<K>>
      default: SettingValue<K>
    }
  }

  /** Raw read; undefined when the key has no row */
  private async read(key: string): Promise<unknown> {
    const cached = this.cache.get(key) as { value: unknown } | undefined
    if (cached) return cached.value

    const [row] = await this.db
      .select({ value: systemSetting.value })
      .from(systemSetting)
      .where(eq(systemSetting.key, key))
      .limit(1)

    const value = row?.value
    this.cache.set(key, { value })
    return value
  }

  /** Read a setting; invalid or missing values degrade to the definition's default. */
  async getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const def = this.def(key)
    const parsed = def.schema.safeParse(await this.read(key))
    return parsed.success ? parsed.data : def.default
  }

  /** Validated upsert. Returns the row id (for audit logs) and the previous raw value. */
  async setSetting<K extends SettingKey>(
    key: K,
    value: SettingValue<K>
  ): Promise<{ id: string; previous: unknown }> {
    const validated = this.def(key).schema.parse(value)
    const previous = await this.read(key)
    const [row] = await this.db
      .insert(systemSetting)
      .values({ key, value: validated })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: validated, updated: new Date() },
      })
      .returning({ id: systemSetting.id })

    this.cache.set(key, { value: validated })
    return { id: row.id, previous }
  }

  /** Drop cached reads (tests). */
  clearCache(): void {
    this.cache.clear()
  }
}
