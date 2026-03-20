import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { ResourcePipelineService } from '@kukan/pipeline'
import { InProcessQueueAdapter } from '@kukan/queue-adapter'
import { getTestDb, cleanDatabase, closeTestDb, ensureTestUser } from '../test-helpers/test-db'

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

describe('ResourcePipelineService', () => {
  describe('enqueue', () => {
    it('should create pipeline record and enqueue job', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      const jobId = await service.enqueue(testResId)

      expect(jobId).toBeDefined()

      const status = await service.getStatus(testResId)
      expect(status).not.toBeNull()
      expect(status!.status).toBe('queued')

      await queue.stop()
    })

    it('should reset pipeline on re-enqueue', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)
      await service.startStep(pipeline!.id, 'fetch')

      // Re-enqueue should reset
      await service.enqueue(testResId)

      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('queued')
      expect(status!.steps).toHaveLength(0)

      await queue.stop()
    })

    it('should throw when queue is not provided', async () => {
      const service = new ResourcePipelineService(db)

      await expect(service.enqueue(testResId)).rejects.toThrow('Queue adapter is required')
    })
  })

  describe('step management', () => {
    it('should track step lifecycle: start → complete', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)

      const stepId = await service.startStep(pipeline!.id, 'fetch')
      await service.completeStep(stepId)

      const status = await service.getStatus(testResId)
      expect(status!.steps).toHaveLength(1)
      expect(status!.steps[0].stepName).toBe('fetch')
      expect(status!.steps[0].status).toBe('complete')
      expect(status!.steps[0].completedAt).not.toBeNull()

      await queue.stop()
    })

    it('should track failed steps with error message', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)

      const stepId = await service.startStep(pipeline!.id, 'fetch')
      await service.failStep(stepId, 'Download timeout')

      const status = await service.getStatus(testResId)
      expect(status!.steps[0].status).toBe('error')
      expect(status!.steps[0].error).toBe('Download timeout')

      await queue.stop()
    })

    it('should track skipped steps', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)

      const stepId = await service.startStep(pipeline!.id, 'extract')
      await service.skipStep(stepId)

      const status = await service.getStatus(testResId)
      expect(status!.steps[0].status).toBe('skipped')

      await queue.stop()
    })
  })

  describe('pipeline status', () => {
    it('should return null for resource with no pipeline', async () => {
      const service = new ResourcePipelineService(db)
      const status = await service.getStatus(testResId)
      expect(status).toBeNull()
    })

    it('should update pipeline status to complete', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)
      await service.updateStatus(pipeline!.id, 'complete')

      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('complete')

      await queue.stop()
    })

    it('should update pipeline status to error with message', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)
      await service.updateStatus(pipeline!.id, 'error', 'Something failed')

      const status = await service.getStatus(testResId)
      expect(status!.status).toBe('error')
      expect(status!.error).toBe('Something failed')

      await queue.stop()
    })

    it('should update preview key', async () => {
      const queue = new InProcessQueueAdapter()
      const service = new ResourcePipelineService(db, queue)

      await service.enqueue(testResId)
      const pipeline = await service.startPipeline(testResId)
      await service.updateExtractResult(pipeline!.id, 'previews/pkg-1/res-1.parquet')

      const status = await service.getStatus(testResId)
      expect(status!.previewKey).toBe('previews/pkg-1/res-1.parquet')

      await queue.stop()
    })
  })
})
