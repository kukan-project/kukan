import { describe, it, expect, beforeEach } from 'vitest'
import { AnnouncementService } from '../../services/announcement-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createAnnouncementFixture } from '../test-helpers/fixtures'

describe('AnnouncementService', () => {
  let service: AnnouncementService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new AnnouncementService(mock.db)
  })

  describe('list', () => {
    it('should return empty paginated result', async () => {
      mock.addResult([])

      const result = await service.list({ offset: 0, limit: 20 })
      expect(result.total).toBe(0)
      expect(result.items).toEqual([])
    })

    it('should return items with total from window function', async () => {
      const item = createAnnouncementFixture({ total: 1 })
      mock.addResult([item])

      const result = await service.list({ offset: 0, limit: 20, publishedOnly: false })
      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].title).toBe('Test Announcement')
    })
  })

  describe('getById', () => {
    it('should return announcement when found', async () => {
      const item = createAnnouncementFixture({ title: 'Found' })
      mock.addResult([item])

      const result = await service.getById(item.id as string)
      expect(result.title).toBe('Found')
    })

    it('should throw NotFoundError when not found', async () => {
      mock.addResult([])
      await expect(service.getById('nonexistent')).rejects.toThrow(
        'Announcement not found: nonexistent'
      )
    })
  })

  describe('create', () => {
    it('should create announcement', async () => {
      const created = createAnnouncementFixture({ title: 'New' })
      mock.addResult([created])

      const result = await service.create({ title: 'New', category: 'info' })
      expect(result.title).toBe('New')
    })

    it('should create with publishedAt', async () => {
      const publishedAt = new Date('2026-06-05T10:00:00Z')
      const created = createAnnouncementFixture({ title: 'Scheduled', publishedAt })
      mock.addResult([created])

      const result = await service.create({
        title: 'Scheduled',
        category: 'release',
        publishedAt,
      })
      expect(result.publishedAt).toEqual(publishedAt)
    })
  })

  describe('update', () => {
    it('should update and return the announcement', async () => {
      const existing = createAnnouncementFixture()
      mock.addResult([existing]) // getById
      mock.addResult([{ ...existing, title: 'Updated' }]) // update returning

      const result = await service.update(existing.id as string, {
        title: 'Updated',
        category: 'important',
      })
      expect(result.title).toBe('Updated')
    })

    it('should throw NotFoundError if not found', async () => {
      mock.addResult([]) // getById returns nothing
      await expect(service.update('nonexistent', { title: 'X', category: 'info' })).rejects.toThrow(
        'Announcement not found: nonexistent'
      )
    })
  })

  describe('delete', () => {
    it('should hard delete and return success', async () => {
      const existing = createAnnouncementFixture()
      mock.addResult([existing]) // delete returning

      const result = await service.delete(existing.id as string)
      expect(result).toEqual({ success: true })
    })

    it('should throw NotFoundError if not found', async () => {
      mock.addResult([]) // delete returns nothing
      await expect(service.delete('nonexistent')).rejects.toThrow(
        'Announcement not found: nonexistent'
      )
    })
  })
})
