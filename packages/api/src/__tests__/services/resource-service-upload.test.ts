import { describe, it, expect, beforeEach } from 'vitest'
import { ResourceService, getStorageKey } from '../../services/resource-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createResourceFixture } from '../test-helpers/fixtures'

describe('getStorageKey', () => {
  it('should return resources/{packageId}/{resourceId}', () => {
    expect(getStorageKey('pkg-1', 'res-1')).toBe('resources/pkg-1/res-1')
  })

  it('should handle UUID-style ids', () => {
    const key = getStorageKey(
      '550e8400-e29b-41d4-a716-446655440000',
      '660e8400-e29b-41d4-a716-446655440001'
    )
    expect(key).toBe(
      'resources/550e8400-e29b-41d4-a716-446655440000/660e8400-e29b-41d4-a716-446655440001'
    )
  })
})

describe('ResourceService upload methods', () => {
  let service: ResourceService
  let mock: ReturnType<typeof createMockDb>

  beforeEach(() => {
    mock = createMockDb()
    service = new ResourceService(mock.db)
  })

  describe('prepareForUpload', () => {
    it('should clear upload metadata and set urlType to upload', async () => {
      const existing = createResourceFixture({
        url: 'https://example.com/old.csv',
        urlType: null,
        size: 1024,
        hash: 'abc',
      })
      const updated = {
        ...existing,
        url: 'data.csv',
        urlType: 'upload',
        format: 'CSV',
        mimetype: 'text/csv',
        size: null,
        hash: null,
      }

      // No getById call since we pass existing
      mock.addResult([updated]) // update returning

      const result = await service.prepareForUpload(
        existing.id as string,
        { filename: 'data.csv', contentType: 'text/csv' },
        existing as Awaited<ReturnType<ResourceService['getById']>>
      )
      expect(result.urlType).toBe('upload')
      expect(result.size).toBeNull()
      expect(result.hash).toBeNull()
    })

    it('should derive format from filename extension', async () => {
      const existing = createResourceFixture({ format: null })
      const updated = { ...existing, format: 'JSON', urlType: 'upload' }

      mock.addResult([updated]) // update returning

      const result = await service.prepareForUpload(
        existing.id as string,
        { filename: 'data.json', contentType: 'application/json' },
        existing as Awaited<ReturnType<ResourceService['getById']>>
      )
      expect(result.format).toBe('JSON')
    })

    it('should use explicit format over derived format', async () => {
      const existing = createResourceFixture({ format: null })
      const updated = { ...existing, format: 'GeoJSON', urlType: 'upload' }

      mock.addResult([updated]) // update returning

      const result = await service.prepareForUpload(
        existing.id as string,
        { filename: 'data.json', contentType: 'application/json', format: 'GeoJSON' },
        existing as Awaited<ReturnType<ResourceService['getById']>>
      )
      expect(result.format).toBe('GeoJSON')
    })

    it('should call getById when existing is not provided', async () => {
      const existing = createResourceFixture()
      const updated = { ...existing, urlType: 'upload' }

      mock.addResult([existing]) // getById
      mock.addResult([updated]) // update returning

      const result = await service.prepareForUpload(existing.id as string, {
        filename: 'data.csv',
        contentType: 'text/csv',
      })
      expect(result.urlType).toBe('upload')
    })
  })

  describe('updateAfterUpload', () => {
    it('should update size and hash', async () => {
      const res = createResourceFixture()
      const updated = { ...res, size: 2048, hash: 'sha256:abc123' }
      mock.addResult([updated])

      const result = await service.updateAfterUpload(res.id as string, {
        size: 2048,
        hash: 'sha256:abc123',
      })
      expect(result.size).toBe(2048)
      expect(result.hash).toBe('sha256:abc123')
    })

    it('should update size only', async () => {
      const res = createResourceFixture()
      const updated = { ...res, size: 1024 }
      mock.addResult([updated])

      const result = await service.updateAfterUpload(res.id as string, { size: 1024 })
      expect(result.size).toBe(1024)
    })

    it('should throw NotFoundError for non-existent resource', async () => {
      mock.addResult([]) // empty result
      await expect(service.updateAfterUpload('nonexistent', { size: 100 })).rejects.toThrow(
        'Resource not found'
      )
    })
  })
})
