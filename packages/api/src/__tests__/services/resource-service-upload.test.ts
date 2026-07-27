import { describe, it, expect, beforeEach } from 'vitest'
import { NotFoundError } from '@kukan/shared'
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
    it('returns the key the caller must upload to', async () => {
      const existing = createResourceFixture()
      mock.addResult([{ updated: 1 }])

      const pendingKey = await service.prepareForUpload(
        existing.id as string,
        { filename: 'data.csv', contentType: 'text/csv' },
        existing as Awaited<ReturnType<ResourceService['getById']>>
      )

      // A key of this call's own, under the resource's prefix — never the live
      // one, which keeps serving until the upload is promoted.
      expect(pendingKey).toMatch(
        new RegExp(`^resources/${existing.packageId}/${existing.id}\\..+$`)
      )
    })

    it('reads the resource when the caller did not', async () => {
      const existing = createResourceFixture()
      mock.addResult([existing]) // getById
      mock.addResult([{ updated: 1 }])

      await expect(
        service.prepareForUpload(existing.id as string, {
          filename: 'data.csv',
          contentType: 'text/csv',
        })
      ).resolves.toBeTruthy()
    })

    it('throws when the row went away before the update landed', async () => {
      const existing = createResourceFixture()
      mock.addResult([{ updated: 0 }])

      await expect(
        service.prepareForUpload(
          existing.id as string,
          { filename: 'data.csv', contentType: 'text/csv' },
          existing as Awaited<ReturnType<ResourceService['getById']>>
        )
      ).rejects.toThrow(NotFoundError)
    })
  })

  describe('promoteUpload', () => {
    it('returns the key it promoted', async () => {
      mock.addResult([{ new_key: 'resources/pkg-1/res-1.tok' }])

      expect(
        await service.promoteUpload('res-1', 'resources/pkg-1/res-1.tok', { size: 2048 })
      ).toBe('resources/pkg-1/res-1.tok')
    })

    it('returns null when that key is no longer the pending one', async () => {
      // A duplicate upload-complete, or an upload a newer one replaced.
      // Promoting anyway would park the live object.
      mock.addResult([])

      expect(
        await service.promoteUpload('res-1', 'resources/pkg-1/res-1.tok', { size: 2048 })
      ).toBeNull()
    })
  })
})
