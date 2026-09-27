import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { job, resourcePipeline } from '@kukan/db'
import { PipelineService } from '../../services/pipeline-service'
import { PostgresQueueAdapter, type QueueAdapter } from '@kukan/queue-adapter'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'
import { mockTransaction } from '../test-helpers/test-app'

function createMockQueue(): QueueAdapter {
  return {
    enqueue: vi.fn().mockResolvedValue('mock-job-id'),
    enqueueMany: vi.fn().mockResolvedValue([]),
    transaction: mockTransaction(),
    countJobs: vi.fn(),
    listJobs: vi.fn(),
    retryDead: vi.fn(),
    deleteDead: vi.fn(),
    pruneDead: vi.fn(),
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

    it('writes the job in the same transaction as the row, and wakes the worker after', async () => {
      const queue = new PostgresQueueAdapter({ db })
      const wake = vi.spyOn(queue, 'wake').mockImplementation(() => {})
      const service = new PipelineService(db, queue)

      const jobId = await service.enqueue(testResId, { rebuildOnly: true })

      const [row] = await db.select().from(job).where(eq(job.id, jobId))
      expect(row).toMatchObject({
        type: 'resource-pipeline',
        payload: { resourceId: testResId, rebuildOnly: true },
      })
      expect(wake).toHaveBeenCalledOnce()
    })

    it('refuses a resource that does not exist', async () => {
      const service = new PipelineService(db, new PostgresQueueAdapter({ db }))

      await expect(service.enqueue(randomUUID())).rejects.toThrow('not found')
      expect(await db.$count(job)).toBe(0)
    })

    it('leaves no row behind when the job cannot be written', async () => {
      const queue = createMockQueue()
      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('insert failed'))
      const service = new PipelineService(db, queue)

      await expect(service.enqueue(testResId)).rejects.toThrow('insert failed')

      expect(await service.getStatus(testResId)).toBeNull()
    })

    it('leaves a finished run as it was when the job cannot be written', async () => {
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

      ;(queue.enqueue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('insert failed'))
      await expect(service.enqueue(testResId)).rejects.toThrow('insert failed')

      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('complete')
      expect(status!.previewKey).toBe('previews/pkg-1/res-1.parquet')
      expect(status!.metadata).toEqual({ encoding: 'Shift_JIS' })
    })
  })

  describe('enqueueAll', () => {
    it('should enqueue all active resources', async () => {
      const service = new PipelineService(db, new PostgresQueueAdapter({ db }))

      const result = await service.enqueueAll()

      expect(result).toEqual({ enqueued: 1, failed: 0 })
      expect(await db.select({ payload: job.payload }).from(job)).toEqual([
        { payload: { resourceId: testResId } },
      ])
      expect((await service.getStatus(testResId))!.status).toBe('queued')
    })

    it('should include resources under draft packages (ADR-040 addendum)', async () => {
      // Draft documents carry the text-head artifact a bulk reprocess must
      // regenerate; the worker still keeps draft content out of the search index
      const draftPkg = await db.execute(sql`
        INSERT INTO package (name, owner_org, creator_user_id, state)
        VALUES ('draft-pkg', ${testOrgId}, '00000000-0000-0000-0000-000000000001', 'draft')
        RETURNING id
      `)
      const draftPkgId = (draftPkg.rows[0] as { id: string }).id
      await db.execute(sql`
        INSERT INTO resource (package_id, name, format, state)
        VALUES (${draftPkgId}, 'draft-resource', 'CSV', 'active')
      `)

      const service = new PipelineService(db, new PostgresQueueAdapter({ db }))

      const result = await service.enqueueAll()
      expect(result).toEqual({ enqueued: 2, failed: 0 })
      expect(await db.$count(job)).toBe(2)
    })

    it('should return 0 when no active resources exist', async () => {
      await db.execute(sql`UPDATE resource SET state = 'deleted'`)

      const service = new PipelineService(db, new PostgresQueueAdapter({ db }))

      const result = await service.enqueueAll()
      expect(result).toEqual({ enqueued: 0, failed: 0 })
      expect(await db.$count(job)).toBe(0)
    })

    it('skips a resource deleted since it was listed, and queues the rest', async () => {
      // Listed, then gone before its batch is written: its foreign key must not
      // refuse the whole batch.
      const service = new PipelineService(db, new PostgresQueueAdapter({ db }))

      const result = await service.enqueueMany([{ id: randomUUID() }, { id: testResId }])

      expect(result).toEqual({ enqueued: 1, failed: [] })
      expect(await db.select({ payload: job.payload }).from(job)).toEqual([
        { payload: { resourceId: testResId } },
      ])
    })

    it('counts a refused batch as failed, and leaves none of its runs half-written', async () => {
      await db.execute(sql`
        INSERT INTO resource (package_id, url, url_type, name, state, position)
        VALUES (${testPkgId}, 'http://example.com/data2.csv', 'url', 'data2', 'active', 1)
      `)

      const queue = createMockQueue()
      vi.mocked(queue.enqueueMany).mockRejectedValueOnce(new Error('connection lost'))
      const service = new PipelineService(db, queue)

      const result = await service.enqueueAll()
      expect(result).toEqual({ enqueued: 0, failed: 2 })
      expect(await db.$count(resourcePipeline)).toBe(0)
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

  describe('getQueryTarget (ADR-032)', () => {
    const validSchema = {
      rowCount: 2,
      columns: [
        { name: 'id', type: 'integer', nullable: false, nullCount: 0 },
        { name: 'name', type: 'string', nullable: true, nullCount: 1 },
      ],
    }

    it('returns null when no pipeline exists', async () => {
      const service = new PipelineService(db)
      expect(await service.getQueryTarget(testResId)).toBeNull()
    })

    it('returns a null schema when metadata has none', async () => {
      const service = new PipelineService(db, createMockQueue())
      await service.enqueue(testResId)
      await db.execute(sql`
        UPDATE resource_pipeline SET metadata = '{"encoding":"UTF-8"}'::jsonb
        WHERE resource_id = ${testResId}
      `)
      expect(await service.getQueryTarget(testResId)).toEqual({
        previewKey: null,
        schema: null,
        encoding: 'UTF-8',
        rowGroupRows: null,
        primaryKey: null,
        describesLiveContent: false,
      })
    })

    it('returns the preview key and parsed schema when present and live', async () => {
      const service = new PipelineService(db, createMockQueue())
      await service.enqueue(testResId)
      await db.execute(sql`UPDATE resource SET hash = 'sha256:live' WHERE id = ${testResId}`)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET preview_key = 'previews/test.parquet',
            metadata = ${JSON.stringify({ encoding: 'UTF-8', schema: validSchema, sourceHash: 'sha256:live' })}::jsonb
        WHERE resource_id = ${testResId}
      `)
      expect(await service.getQueryTarget(testResId)).toEqual({
        previewKey: 'previews/test.parquet',
        schema: validSchema,
        encoding: 'UTF-8',
        rowGroupRows: null,
        primaryKey: null,
        describesLiveContent: true,
      })
    })

    it('reports stale when the sourceHash no longer matches the resource hash', async () => {
      const service = new PipelineService(db, createMockQueue())
      await service.enqueue(testResId)
      await db.execute(sql`UPDATE resource SET hash = 'sha256:replaced' WHERE id = ${testResId}`)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET preview_key = 'previews/test.parquet',
            metadata = ${JSON.stringify({ encoding: 'UTF-8', schema: validSchema, sourceHash: 'sha256:old' })}::jsonb
        WHERE resource_id = ${testResId}
      `)
      expect(await service.getQueryTarget(testResId)).toEqual({
        previewKey: 'previews/test.parquet',
        schema: validSchema,
        encoding: 'UTF-8',
        rowGroupRows: null,
        primaryKey: null,
        describesLiveContent: false,
      })
    })

    it('returns a null schema when the stored schema is malformed', async () => {
      const service = new PipelineService(db, createMockQueue())
      await service.enqueue(testResId)
      await db.execute(sql`
        UPDATE resource_pipeline
        SET metadata = '{"schema":{"columns":"not-an-array"}}'::jsonb
        WHERE resource_id = ${testResId}
      `)
      expect(await service.getQueryTarget(testResId)).toEqual({
        previewKey: null,
        schema: null,
        encoding: null,
        rowGroupRows: null,
        primaryKey: null,
        describesLiveContent: false,
      })
    })
  })
})
