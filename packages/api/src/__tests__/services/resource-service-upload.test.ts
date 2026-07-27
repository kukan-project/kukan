import { describe, it, expect, beforeEach } from 'vitest'
import { ResourceService } from '../../services/resource-service'
import { createMockDb } from '../test-helpers/mock-db'
import { createResourceFixture } from '../test-helpers/fixtures'

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

  describe('promoteUpload', () => {
    it('returns the key it promoted', async () => {
      mock.addResult([{ new_key: 'resources/pkg-1/res-1.tok' }])

      expect(await service.promoteUpload('res-1', { size: 2048 })).toBe('resources/pkg-1/res-1.tok')
    })

    it('returns null when nothing was pending', async () => {
      // A duplicate upload-complete: promoting again would park the live object.
      mock.addResult([])

      expect(await service.promoteUpload('res-1', { size: 2048 })).toBeNull()
    })
  })
})
