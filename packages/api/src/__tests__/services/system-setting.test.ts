import { describe, it, expect } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import {
  SystemSettingService,
  VECTOR_SIMILARITY_NOTCHES_KEY,
  SEMANTIC_SEARCH_ENABLED_KEY,
  AI_SUGGEST_MODEL_KEY,
  AI_SUGGEST_ENABLED_KEY,
} from '../../services/system-setting'

describe('SystemSettingService', () => {
  it('degrades to the default when the row is missing and caches the miss', async () => {
    const { db, addResult } = createMockDb()
    addResult([]) // first read hits the DB
    const service = new SystemSettingService(db)

    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(0)
    // A cached miss must not consume the queued row — only the uncached key does
    addResult([{ value: false }])
    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(0)
    expect(await service.getSetting(SEMANTIC_SEARCH_ENABLED_KEY)).toBe(false)
  })

  it('returns stored values', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: -2 }])
    const service = new SystemSettingService(db)

    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(-2)
  })

  it('degrades out-of-range or malformed stored values to the default', async () => {
    for (const bad of [5, -5, 1.5, 'x', { notches: 1 }]) {
      const { db, addResult } = createMockDb()
      addResult([{ value: bad }])
      const service = new SystemSettingService(db)

      expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(0)
    }

    const { db, addResult } = createMockDb()
    addResult([{ value: 'yes' }])
    const service = new SystemSettingService(db)
    expect(await service.getSetting(SEMANTIC_SEARCH_ENABLED_KEY)).toBe(true)
  })

  it('setSetting upserts, reports the previous value, and refreshes the cache', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 1 }]) // read inside setSetting → previous
    addResult([{ id: 'row-id' }]) // insert ... returning
    const service = new SystemSettingService(db)

    const result = await service.setSetting(VECTOR_SIMILARITY_NOTCHES_KEY, 2)
    expect(result).toEqual({ id: 'row-id', previous: 1 })
    // Cache holds the new value — no queued result needed
    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(2)
  })

  it('rejects writes that fail the setting schema', async () => {
    const { db } = createMockDb()
    const service = new SystemSettingService(db)

    await expect(service.setSetting(VECTOR_SIMILARITY_NOTCHES_KEY, 5)).rejects.toThrow()
    await expect(service.setSetting(VECTOR_SIMILARITY_NOTCHES_KEY, 0.5)).rejects.toThrow()
  })

  it('ai-suggest settings default to empty model + enabled', async () => {
    const { db, addResult } = createMockDb()
    addResult([]) // ai-suggest-model miss
    addResult([]) // ai-suggest-enabled miss
    const service = new SystemSettingService(db)

    expect(await service.getSetting(AI_SUGGEST_MODEL_KEY)).toBe('')
    expect(await service.getSetting(AI_SUGGEST_ENABLED_KEY)).toBe(true)
  })

  it('ai-suggest-model trims whitespace and rejects over-long values', async () => {
    const { db, addResult } = createMockDb()
    addResult([]) // previous read inside setSetting
    addResult([{ id: 'row-id' }])
    const service = new SystemSettingService(db)

    await service.setSetting(AI_SUGGEST_MODEL_KEY, '  gemma4:e4b  ')
    expect(await service.getSetting(AI_SUGGEST_MODEL_KEY)).toBe('gemma4:e4b')

    await expect(service.setSetting(AI_SUGGEST_MODEL_KEY, 'x'.repeat(201))).rejects.toThrow()
  })

  it('clearCache() forces the next read back to the DB', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 1 }])
    const service = new SystemSettingService(db)

    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(1)
    service.clearCache()
    addResult([{ value: 2 }])
    expect(await service.getSetting(VECTOR_SIMILARITY_NOTCHES_KEY)).toBe(2)
  })
})
