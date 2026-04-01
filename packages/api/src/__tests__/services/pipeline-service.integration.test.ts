import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { PipelineService } from '../../services/pipeline-service'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

function createMockQueue(): QueueAdapter {
  return {
    enqueue: vi.fn().mockResolvedValue('mock-job-id'),
    getStats: vi.fn().mockResolvedValue({ pending: 0, inFlight: 0, delayed: 0 }),
    process: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }
}

const db = getTestDb()

let testOrgId: string
let testPkgId: string
let testResId: string

beforeEach(async () => {
  await cleanDatabase()
  await ensureTestUser()

  // Create org → package → resource for pipeline tests
  const orgResult = await db.execute(sql`
    INSERT INTO organization (name, state) VALUES ('test-org-pipeline', 'active') RETURNING id
  `)
  testOrgId = (orgResult.rows[0] as { id: string }).id

  const pkgResult = await db.execute(sql`
    INSERT INTO package (name, owner_org, creator_user_id, state)
    VALUES ('test-pkg', ${testOrgId}, '00000000-0000-0000-0000-000000000001', 'active')
    RETURNING id
  `)
  testPkgId = (pkgResult.rows[0] as { id: string }).id

  const resResult = await db.execute(sql`
    INSERT INTO resource (package_id, name, format, state)
    VALUES (${testPkgId}, 'test-resource', 'CSV', 'active')
    RETURNING id
  `)
  testResId = (resResult.rows[0] as { id: string }).id
})

afterAll(async () => {
  await closeTestDb()
})

describe('PipelineService', () => {
  describe('enqueue', () => {
    it('should create pipeline record and enqueue job', async () => {
      const queue = createMockQueue()
      const service = new PipelineService(db, queue)

      const jobId = await service.enqueue(testResId)

      expect(jobId).toBeDefined()

      const status = await service.getStatus(testResId)
      expect(status).not.toBeNull()
      expect(status!.status).toBe('queued')
    })

    it('should preserve previewKey and metadata on re-enqueue', async () => {
      const queue = createMockQueue()
      const service = new PipelineService(db, queue)

      await service.enqueue(testResId)

      // Simulate completed pipeline with preview data (as Worker would do)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET status = 'complete',
            preview_key = 'previews/pkg-1/res-1.parquet',
            metadata = '{"encoding":"UTF-8"}'::jsonb
        WHERE resource_id = ${testResId}
      `)

      // Re-enqueue should reset status but keep preview data
      await service.enqueue(testResId)

      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('queued')
      expect(status!.previewKey).toBe('previews/pkg-1/res-1.parquet')
      expect(status!.metadata).toEqual({ encoding: 'UTF-8' })
    })

    it('should throw when queue is not provided', async () => {
      const service = new PipelineService(db)

      await expect(service.enqueue(testResId)).rejects.toThrow('Queue adapter is required')
    })

    it('should rollback DB status to error when queue.enqueue fails', async () => {
      const queue = createMockQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SQS send failed'))
      const service = new PipelineService(db, queue)

      await expect(service.enqueue(testResId)).rejects.toThrow('SQS send failed')

      const status = await service.getStatus(testResId)
      expect(status).not.toBeNull()
      expect(status!.status).toBe('error')
      expect(status!.error).toContain('Queue enqueue failed')
    })

    it('should preserve previewKey when queue.enqueue fails on re-enqueue', async () => {
      const queue = createMockQueue()
      const service = new PipelineService(db, queue)

      // First enqueue succeeds and pipeline completes with preview data
      await service.enqueue(testResId)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET status = 'complete',
            preview_key = 'previews/pkg-1/res-1.parquet',
            metadata = '{"encoding":"Shift_JIS"}'::jsonb
        WHERE resource_id = ${testResId}
      `)

      // Second enqueue fails at SQS
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SQS send failed'))
      await expect(service.enqueue(testResId)).rejects.toThrow('SQS send failed')

      // previewKey and metadata should still be intact
      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('error')
      expect(status!.previewKey).toBe('previews/pkg-1/res-1.parquet')
      expect(status!.metadata).toEqual({ encoding: 'Shift_JIS' })
    })
  })

  describe('getStatus', () => {
    it('should return null for resource with no pipeline', async () => {
      const service = new PipelineService(db)
      const status = await service.getStatus(testResId)
      expect(status).toBeNull()
    })

    it('should return pipeline with steps', async () => {
      const queue = createMockQueue()
      const service = new PipelineService(db, queue)

      await service.enqueue(testResId)

      // Insert steps via raw SQL (simulating Worker StepTracker)
      const pipelineResult = await db.execute(sql`
        SELECT id FROM resource_pipeline WHERE resource_id = ${testResId}
      `)
      const pipelineId = (pipelineResult.rows[0] as { id: string }).id
      await db.execute(sql`
        INSERT INTO resource_pipeline_step (pipeline_id, step_name, status, started_at, completed_at)
        VALUES (${pipelineId}, 'fetch', 'complete', NOW(), NOW())
      `)

      const status = await service.getStatus(testResId)
      expect(status!.steps).toHaveLength(1)
      expect(status!.steps[0].stepName).toBe('fetch')
      expect(status!.steps[0].status).toBe('complete')
    })

    it('should return preview key after extract', async () => {
      const queue = createMockQueue()
      const service = new PipelineService(db, queue)

      await service.enqueue(testResId)

      // Update preview key via raw SQL (simulating Worker StepTracker)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET preview_key = 'previews/pkg-1/res-1.parquet'
        WHERE resource_id = ${testResId}
      `)

      const status = await service.getStatus(testResId)
      expect(status!.previewKey).toBe('previews/pkg-1/res-1.parquet')
    })
  })
})
