import { describe, it, expect, beforeEach } from 'vitest'
import { TagService } from '../../services/tag-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createTagFixture } from '../test-helpers/fixtures'

describe('TagService', () => {
  let service: TagService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new TagService(mock.db)
  })

  describe('list', () => {
    it('should return paginated tags', async () => {
      const tag = { ...createTagFixture(), packageCount: 3, total: 1 }
      mock.addResult([tag])

      const result = await service.list({ offset: 0, limit: 100 })
      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
    })

    it('should return empty list', async () => {
      mock.addResult([])

      const result = await service.list({})
      expect(result.total).toBe(0)
      expect(result.items).toEqual([])
    })
  })

  describe('getById', () => {
    it('should return null when tag not found', async () => {
      mock.addResult([]) // empty result

      const result = await service.getById('nonexistent')
      expect(result).toBeNull()
    })

    it('should return tag with packageCount', async () => {
      const tag = { ...createTagFixture(), packageCount: 5 }
      mock.addResult([tag])

      const result = await service.getById(tag.id as string)
      expect(result).not.toBeNull()
      expect(result!.packageCount).toBe(5)
    })
  })
})
