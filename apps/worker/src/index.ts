/**
 * KUKAN Worker — Job Queue Consumer
 * Processes resource pipeline jobs from the job table (ADR-058).
 */

import { serve } from '@hono/node-server'
import { config } from 'dotenv'
import { Hono } from 'hono'
import {
  loadEnv,
  createLogger,
  PIPELINE_JOB_TYPE,
  REINDEX_JOB_TYPE,
  PURGE_ORG_JOB_TYPE,
  PURGE_VERSION_JOB_TYPE,
  BACKFILL_VERSIONS_JOB_TYPE,
  RECORD_ROW_GROUPS_JOB_TYPE,
  CONVERT_SET_ASIDE_JOB_TYPE,
  LAKE_INGEST_JOB_TYPE,
  EMBED_JOB_TYPE,
  SUMMARIZE_ALL_JOB_TYPE,
  SUMMARIZE_PACKAGE_JOB_TYPE,
  SYNC_RESOURCE_DOC_JOB_TYPE,
  pipelineJobSchema,
  reindexJobSchema,
  purgeOrgJobSchema,
  purgeVersionJobSchema,
  backfillVersionsJobSchema,
  recordRowGroupsJobSchema,
  convertSetAsideJobSchema,
  lakeIngestJobSchema,
  embedJobSchema,
  summarizeAllJobSchema,
  summarizePackageJobSchema,
  syncResourceDocJobSchema,
  REANALYSE_INDEX_JOB_TYPE,
  reanalyseIndexJobSchema,
} from '@kukan/shared'
import { eq } from 'drizzle-orm'
import { packageTable } from '@kukan/db'
import type { Job } from '@kukan/queue-adapter'
import {
  enqueueResourceDocSyncIfDue,
  rebuildMetadataIndex,
  syncDueResourceDocs,
} from '@kukan/api/services/search-index'
import {
  enqueueResourceEmbedsIfDue,
  requestResourceEmbeds,
} from '@kukan/api/services/resource-embedding'
import { markContentUnindexed } from '@kukan/api/services/content-index-record'
import { PipelineService } from '@kukan/api/services/pipeline-service'
import { recordMissingRowGroups } from '@kukan/api/services/odata/row-group-backfill'
import { OrganizationService } from '@kukan/api/services/organization-service'
import { ResourceVersionService } from '@kukan/api/services/resource-version-service'
import { createAIAdapter } from '@kukan/api/adapters'
import { AI_SUMMARY_LOCALE_KEY, SystemSettingService } from '@kukan/api/services/system-setting'
import { reanalyseSearchIndex } from './search/reanalyse-index'
import type { SummaryDeps } from './pipeline/steps/summarize'
import { enqueueSummarizePackages, summarizeNextInPackage } from './summary/backfill'
import { createDb, runMigrations } from '@kukan/db'
import { closeLakeInstances, lakeConfigFromEnv } from '@kukan/lake'
import { PostgresQueueAdapter, httpWake, isWakeAuthorized } from '@kukan/queue-adapter'
import { S3StorageAdapter } from '@kukan/storage-adapter'
import { OpenSearchAdapter, PostgresSearchAdapter } from '@kukan/search-adapter'
import { processResource } from './pipeline/process-resource'
import { buildPipelineContext } from './pipeline/build-context'
import { retryLakeIngest } from './pipeline/retry-lake-ingest'
import { startCronJob } from './cron/start-cron-job'
import { sweepOrphanedObjects } from './cron/orphan-cleanup/sweep-orphans'
import { sweepLakeOrphans } from './cron/orphan-cleanup/sweep-lake-orphans'
import { sweepResourceDocs, sweepResourceEmbeds } from './cron/sweep-resource-marks'
import {
  expirePendingUploads,
  markUploadsThatNeverArrived,
} from '@kukan/api/services/storage-pointer'
import {
  DEAD_JOB_RETENTION_MS,
  LAKE_INGEST_SWEEP_CRON,
  ORPHAN_CLEANUP_CRON,
  PENDING_UPLOAD_TTL_MS,
  RESOURCE_DOC_SWEEP_CRON,
  RESOURCE_EMBED_SWEEP_CRON,
  START_SWEEP_DELAY_MS,
} from '@/config'
import { checkBatch } from './cron/health-check/check-batch'
import { embedDueResources } from './embed/embed-resources'
import { setUserAgent } from './safe-fetch'
import { buildUserAgent } from './user-agent'
import { WAITING_METRIC_INTERVAL_MS, waitingMetricLine } from './queue/waiting-metric'

// Skip dotenv in production (env vars injected by container/ECS)
if (process.env.NODE_ENV !== 'production') {
  config({ path: '../../.env' })
}

const env = loadEnv()
const log = createLogger({ name: 'worker', level: env.LOG_LEVEL })
setUserAgent(buildUserAgent(env))

// Initialize database (worker processes jobs sequentially, so fewer connections needed)
const db = createDb(env.DATABASE_URL, {
  max: env.WORKER_DB_POOL_MAX,
  idleTimeoutMillis: env.WORKER_DB_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.WORKER_DB_POOL_CONNECTION_TIMEOUT_MS,
})

// Initialize storage adapter (S3: AWS S3 or MinIO)
const storage = new S3StorageAdapter({
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
})

// Job queue (ADR-058): woken by the web's POST below and by its own enqueues,
// which it also tells the other tasks about.
// Where the service scales, the waiting jobs are reported as a metric: counted
// while a job runs, 0 once idle, and written every minute either way, so the
// scaling policy sees a series without the database being asked.
const metricSite = env.WORKER_METRIC_SITE
// Unknown until the first count: a fresh task must not report 0 over a backlog
let waitingJobs: number | undefined
const queue = new PostgresQueueAdapter({
  db,
  logger: log.child({ component: 'job-queue' }),
  // The other tasks, told when a job this one runs writes another
  ...(env.WORKER_WAKE_URL && {
    notify: httpWake(env.WORKER_WAKE_URL, env.BETTER_AUTH_SECRET),
  }),
  ...(metricSite && { onWaiting: (count: number) => (waitingJobs = count) }),
})
const waitingMetricTimer = metricSite
  ? setInterval(() => {
      if (waitingJobs !== undefined) {
        process.stdout.write(waitingMetricLine(metricSite, waitingJobs) + '\n')
      }
    }, WAITING_METRIC_INTERVAL_MS)
  : undefined

// --- Health check + wake HTTP server ---
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080', 10)
let ready = false

const health = new Hono()
health.get('/health', (c) => {
  // During migration/startup, return 200 to keep ECS happy
  if (!ready) {
    return c.json({ status: 'starting' })
  }

  // Answering is the check: an event loop that has stopped cannot. Never a
  // database query — every check would wake the database — and never how long
  // the job in hand has run, which would stop a long job partway through and
  // again on each retry (ADR-058 §5). A job that hangs lets its lease go after
  // the hold limit, and another worker takes it.
  return c.json({ status: 'ok' })
})
health.post('/wake', (c) => {
  if (!isWakeAuthorized(c.req.header('authorization'), env.BETTER_AUTH_SECRET)) {
    return c.body(null, 401)
  }
  // Here only: forwarded, the tasks would signal each other without end
  queue.wakeHere()
  return c.body(null, 202)
})

serve({ fetch: health.fetch, port: HEALTH_PORT })

// --- Run DB migrations before starting ---
await runMigrations(env.DATABASE_URL)
ready = true

// --- Health check scheduler ---
let healthCheckJob: { stop: () => void } | null = null

if (env.HEALTH_CHECK_ENABLED) {
  const hcLog = log.child({ component: 'health-check' })
  const stalenessHours = env.HEALTH_CHECK_STALENESS_HOURS
  const fullFetchIntervalHours = env.HEALTH_CHECK_FULL_FETCH_INTERVAL_HOURS
  healthCheckJob = startCronJob({
    name: 'Health check',
    cronExpression: env.HEALTH_CHECK_CRON,
    log: hcLog,
    meta: { stalenessHours, fullFetchIntervalHours },
    run: async () => {
      await checkBatch(db, queue, stalenessHours, fullFetchIntervalHours, hcLog)
    },
  })
}

// --- DuckLake (ADR-043 layer 2): catalog + bucket derived from the same env ---
const lake = lakeConfigFromEnv(env)

// --- Orphaned object sweeper (ADR-043) ---
const orphanSweepLog = log.child({ component: 'orphan-cleanup' })
const orphanCleanupJob = startCronJob({
  name: 'Orphaned object cleanup',
  cronExpression: ORPHAN_CLEANUP_CRON,
  log: orphanSweepLog,
  run: async () => {
    // A pass over the job table while the database is awake for this anyway:
    // a signal that never arrived, or a lease whose worker died, waits no
    // longer than this (ADR-058 §2). First, so a failing sweep cannot skip it.
    queue.wakeHere()
    const pruned = await queue.pruneDead(DEAD_JOB_RETENTION_MS)
    if (pruned > 0) orphanSweepLog.info({ pruned }, 'Deleted dead jobs past their retention')
    // After the prune, which is one way a purge loses its job
    const versions = await new ResourceVersionService(db).queueStrandedPurges(queue)
    const orgs = await new OrganizationService(db).queueStrandedPurges(queue)
    if (versions.queued + orgs.queued > 0) {
      orphanSweepLog.info(
        { versions: versions.queued, organizations: orgs.queued },
        'Queued purges left with no job'
      )
    }
    // Expire first: a key parked now still waits out the orphan retention
    // before it is deleted.
    const expired = await expirePendingUploads(db, PENDING_UPLOAD_TTL_MS)
    if (expired > 0) orphanSweepLog.info({ expired }, 'Expired abandoned upload URLs')
    // After the expiry, so a key cleared just now is one of the resources this
    // asks about rather than waiting an hour to be seen.
    const marked = await markUploadsThatNeverArrived(db, PENDING_UPLOAD_TTL_MS)
    if (marked > 0) orphanSweepLog.info({ marked }, 'Marked uploads that never arrived')
    await sweepOrphanedObjects(db, storage, orphanSweepLog)
    // Layer 2's orphans are the ones no writer could park: a Parquet written
    // but never committed to the catalog (ADR-043).
    await sweepLakeOrphans(lake, orphanSweepLog)
  },
})

// --- Pending DuckLake ingest sweeper (ADR-043 layer 2) ---
//
// The retry job covers a Lake step that failed; nothing covers that job failing
// to be written, and the pipeline moves on to 'complete' either way. The intent
// survives in the database — an active version with no snapshot id — so this
// pass picks up what was never queued, or was queued and gave up. Cheap when
// there is nothing to do: the scan finds no rows and nothing is enqueued.
const lakeIngestSweepLog = log.child({ component: 'lake-ingest-sweep' })
const lakeIngestSweepJob = startCronJob({
  name: 'Pending lake ingest',
  cronExpression: LAKE_INGEST_SWEEP_CRON,
  log: lakeIngestSweepLog,
  run: async () => {
    const result = await new ResourceVersionService(db).queuePendingLakeIngests(queue)
    if (result.queued > 0) {
      lakeIngestSweepLog.info(result, 'Queued versions layer 2 has not loaded')
    }
  },
})

// --- Stale search documents (ADR-053 §9.3) ---
//
// The queue owns the retry for a sync that failed; this owns the one it never
// heard about. Started below, beside the search adapter the handler uses.
const resourceDocSweepLog = log.child({ component: 'resource-doc-sweep' })

// --- Search adapter (optional, for content indexing) ---
const osLogger = log.child({ component: 'opensearch' })
const search =
  env.SEARCH_TYPE === 'opensearch'
    ? new OpenSearchAdapter({
        endpoint: env.OPENSEARCH_URL,
        indexPrefix: env.OPENSEARCH_INDEX_PREFIX,
        replicas: env.OPENSEARCH_REPLICAS,
        logger: osLogger,
      })
    : undefined
// What the document sync writes to. Without an index the marks are cleared all
// the same, through an adapter that writes nothing: a mark nobody clears is
// asked for again by every run of the resource.
const docSearch = search ?? new PostgresSearchAdapter(db)

// With or without an index: the marks are cleared either way
const resourceDocSweepJob = startCronJob({
  name: 'Stale search documents',
  cronExpression: RESOURCE_DOC_SWEEP_CRON,
  log: resourceDocSweepLog,
  run: async () => {
    await sweepResourceDocs(db, queue, resourceDocSweepLog)
  },
})

// --- AI adapter (embedding; NoOp when AI_TYPE=none) ---
const ai = createAIAdapter(env)

// --- Stale vectors (ADR-054) ---
// As for the documents above: the queue owns the retry, this the job it never
// heard about. Nothing is asked for where embedding is unavailable.
const resourceEmbedSweepLog = log.child({ component: 'resource-embed-sweep' })
const resourceEmbedSweepJob = startCronJob({
  name: 'Stale vectors',
  cronExpression: RESOURCE_EMBED_SWEEP_CRON,
  log: resourceEmbedSweepLog,
  run: async () => {
    await sweepResourceEmbeds(db, queue, ai, resourceEmbedSweepLog)
  },
})

// Both sweeps once after start, without the grace period: a job queued for
// marks can be lost across a deploy — taken by a worker of the previous
// version, which has no handler for it and deletes it — and a migration that
// leaves marks leaves them to this. After the rollout rather than at once:
// a job queued at start is one the previous version is still there to take.
const startSweep = setTimeout(() => {
  void Promise.all([
    sweepResourceDocs(db, queue, resourceDocSweepLog, 0),
    sweepResourceEmbeds(db, queue, ai, resourceEmbedSweepLog, 0),
  ]).catch((err) => log.warn({ err }, 'Post-start sweep failed; the hourly one will retry'))
}, START_SWEEP_DELAY_MS)
startSweep.unref()

// --- Resource abstracts (ADR-053) ---
// The named model is the switch: unset writes nothing, so a site that sets it
// later has nothing to clear. Null all the way down — the Summarize step is
// then never started.
const summaryDeps: SummaryDeps | null = resolveSummaryDeps()
function resolveSummaryDeps(): SummaryDeps | null {
  const model = env.AI_SUMMARY_MODEL
  if (!model) return null
  const completion = ai.getCompletionInfo()
  if (!completion) {
    log.warn({ model }, 'Resource abstracts are configured but no provider can generate them')
    return null
  }
  // Refused rather than quietly replaced by the provider default. The default
  // is whatever is first in the allow-list, and the measurements say the wrong
  // model there does not produce worse abstracts — it produces invented ones.
  if (!completion.allowlist.includes(model)) {
    log.error(
      { model, allowlist: completion.allowlist },
      'AI_SUMMARY_MODEL is not in AI_COMPLETION_MODELS — abstracts are off'
    )
    return null
  }
  return {
    db,
    storage,
    ai,
    model,
    log: log.child({ component: 'summarize' }),
    // Read per call rather than captured: the setting is runtime, and the
    // service caches it for its own short TTL.
    locale: () => new SystemSettingService(db).getSetting(AI_SUMMARY_LOCALE_KEY),
  }
}

// Validate a job payload against its schema; logs and returns null on mismatch so
// the handler can bail without ever trusting an unvalidated payload.
function parseJobPayload<T>(
  job: Job,
  schema: {
    safeParse(
      data: unknown
    ): { success: true; data: T } | { success: false; error: { message: string } }
  }
): T | null {
  const parsed = schema.safeParse(job.data ?? {})
  if (parsed.success) return parsed.data
  log.error({ jobId: job.id, type: job.type, err: parsed.error.message }, 'Invalid job payload')
  return null
}

// --- Job handlers ---
const ctx = buildPipelineContext(db, storage, search, lake, summaryDeps)
await queue.process({
  // Pipeline (data-plane): process one resource.
  [PIPELINE_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, pipelineJobSchema)
    if (!data) return
    const { resourceId, rebuildOnly } = data
    log.info({ jobId: job.id, type: job.type, resourceId }, 'Processing job')
    const start = performance.now()
    await processResource(resourceId, ctx, db, queue, { rebuildOnly })
    // Once, whatever in the run marked the document or the vector: an abstract
    // written, a format the version settled, a replacement upload's name
    await Promise.all([
      enqueueResourceDocSyncIfDue(db, queue, resourceId, log),
      enqueueResourceEmbedsIfDue(db, { queue, ai, logger: log }, { resourceIds: [resourceId] }),
    ])
    const elapsed = Math.round(performance.now() - start)
    log.info({ jobId: job.id, type: job.type, resourceId, elapsed }, 'Completed job')
  },

  // Maintenance (control-plane): re-analyse the index in place. The documents
  // ride along — `extractedText` is in `_source`, so nothing is fetched or
  // extracted again — which is why this is not the rebuild below.
  [REANALYSE_INDEX_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, reanalyseIndexJobSchema)) return
    await reanalyseSearchIndex(db, search, queue, log.child({ jobId: job.id, type: job.type }))
  },

  // One-time migration: give previews written before it the figure a feed pages
  // by (ADR-055 §6). Reads footers only; the few whose grouping is what stops
  // them being served are handed to the pipeline from stored content.
  [RECORD_ROW_GROUPS_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, recordRowGroupsJobSchema)) return
    log.info({ jobId: job.id, type: job.type }, 'Record row groups job started')
    const start = performance.now()
    const result = await recordMissingRowGroups(db, {
      storage,
      env,
      queue,
      log: log.child({ jobId: job.id, type: job.type }),
    })
    log.info(
      { jobId: job.id, type: job.type, ...result, elapsed: Math.round(performance.now() - start) },
      'Record row groups job completed'
    )
  },

  // Maintenance (control-plane): rebuild the search index.
  [REINDEX_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, reindexJobSchema)
    if (!data) return
    const { includeContent } = data
    log.info({ jobId: job.id, type: job.type, includeContent }, 'Reindex metadata job started')
    const start = performance.now()
    if (search) {
      const jobLogger = osLogger.child({ jobId: job.id, type: job.type })
      await rebuildMetadataIndex(db, search, jobLogger)
      if (includeContent) {
        // The rows have to stop saying their content is indexed, or the runs
        // enqueued below are the ones that skip and the index stays empty
        await search.deleteAllContents()
        await markContentUnindexed(db, 'all')
        // From the object each resource already holds: the content to index is
        // in storage, and fetching a whole catalog again asks every
        // publisher's server for what we have (ADR-044 §4).
        const pipelineService = new PipelineService(db, queue)
        const { enqueued, failed } = await pipelineService.enqueueAll({ rebuildOnly: true })
        log.info(
          { jobId: job.id, type: job.type, enqueued, failed },
          'Content pipeline jobs enqueued'
        )
      }
      const elapsed = Math.round(performance.now() - start)
      log.info({ jobId: job.id, type: job.type, elapsed }, 'Reindex metadata job completed')
    } else {
      log.warn({ jobId: job.id, type: job.type }, 'Reindex skipped — OpenSearch not configured')
    }
  },
  // Abstracts (ADR-053): fan out one walk per package.
  [SUMMARIZE_ALL_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, summarizeAllJobSchema)
    if (!data) return
    if (!summaryDeps) {
      log.warn({ jobId: job.id, type: job.type }, 'Summarize all skipped — abstracts are off')
      return
    }
    const { enqueued, failed } = await enqueueSummarizePackages(db, queue, log, data.refresh)
    log.info({ jobId: job.id, type: job.type, enqueued, failed }, 'Summarize jobs enqueued')
  },
  // Abstracts: one resource of one package, then hand on the rest.
  [SUMMARIZE_PACKAGE_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, summarizePackageJobSchema)
    if (!data) return
    if (!summaryDeps) return
    const start = performance.now()
    const result = await summarizeNextInPackage(
      data.packageId,
      data.after,
      summaryDeps,
      queue,
      data.refresh
    )
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, packageId: data.packageId, ...result, elapsed },
      'Summarize step finished'
    )
  },
  // The abstract reaches the keyword leg here (ADR-053 §9.3). Its own job so
  // the queue owns the retry: the step that makes the document stale runs
  // after Index and is best-effort, so a failure there would otherwise never
  // be asked again. Every marked resource, whatever the payload names.
  [SYNC_RESOURCE_DOC_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, syncResourceDocJobSchema)) return
    const { synced, refused } = await syncDueResourceDocs(db, docSearch)
    if (synced > 0) log.info({ jobId: job.id, type: job.type, synced }, 'Resource documents synced')
    // Not thrown: every other mark was cleared, and a retry would refuse the
    // same documents. Their marks stay, so the sweep keeps asking.
    if (refused.length > 0) {
      log.error({ jobId: job.id, type: job.type, refused }, 'The index refused resource documents')
    }
  },
  // Semantic search: build the vectors of every resource marked due (ADR-054).
  [EMBED_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, embedJobSchema)) return
    const start = performance.now()
    const { embedded, settled, rejected, more, busy } = await embedDueResources(db, ai)
    // More: at once, these marks have waited. Busy: after the delay, for marks
    // the run holding the lock may have read past. A provider failure was
    // thrown, for the queue's retry.
    if (more || busy) await requestResourceEmbeds(queue, ai, busy ? {} : { delaySeconds: 0 })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, embedded, settled, more, busy, elapsed },
      'Embed job finished'
    )
    // Recorded as refused, their marks cleared: the same text would be refused
    // again. A new text or a new model sends each again.
    if (rejected.length > 0) {
      log.warn(
        { jobId: job.id, type: job.type, rejected },
        'Texts too long for the embedding model'
      )
    }
  },
  // Maintenance (control-plane): erase a soft-deleted org. Runs the destructive
  // work in the worker (retried on failure) — see OrganizationService.purgeDeletedOrg.
  [PURGE_ORG_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, purgeOrgJobSchema)
    if (!data) return
    const { organizationId } = data
    log.info({ jobId: job.id, type: job.type, organizationId }, 'Purge organization job started')
    const start = performance.now()
    const orgService = new OrganizationService(db)
    const { purged, packageCount } = await orgService.purgeDeletedOrg(organizationId, {
      search,
      storage,
      lake,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, organizationId, purged, packageCount, elapsed },
      purged ? 'Purge organization job completed' : 'Purge organization job skipped (not deleted)'
    )
  },
  // Make one resource version unobtainable (ADR-043 §5): its file goes, and
  // layer 2 is put out of reach rather than erased. When the purged version is
  // the one being served, the preview and the search index go with it and the
  // live version rolls back to the previous one; for any other version they
  // describe content this purge does not touch and are left alone.
  [PURGE_VERSION_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, purgeVersionJobSchema)
    if (!data) return
    const { resourceId, version } = data
    log.info({ jobId: job.id, type: job.type, resourceId, version }, 'Purge version job started')
    const start = performance.now()
    const result = await new ResourceVersionService(db).executePurge(resourceId, version, {
      storage,
      search,
      queue,
      lake,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, resourceId, version, ...result, elapsed },
      result.purged ? 'Purge version job completed' : 'Purge version job skipped (not purging)'
    )
  },
  // Retry a DuckLake ingest the pipeline's advisory Lake step could not
  // complete (ADR-043). The fast path only: a version stays outstanding in the
  // database until layer 2 has it, so the hourly sweep finds it either way
  // (ADR-046).
  [LAKE_INGEST_JOB_TYPE]: async (job: Job) => {
    const data = parseJobPayload(job, lakeIngestJobSchema)
    if (!data) return
    await retryLakeIngest(data, {
      ctx,
      db,
      queue,
      log: log.child({ jobId: job.id, type: job.type }),
    })
  },
  // One-time migration: name every unversioned resource's live file as v1
  // (ADR-043). Nothing is fetched, re-indexed or copied — the object is
  // already there and nothing owns it yet.
  [BACKFILL_VERSIONS_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, backfillVersionsJobSchema)) return
    log.info({ jobId: job.id, type: job.type }, 'Backfill versions job started')
    const start = performance.now()
    const result = await new ResourceVersionService(db).createFirstVersions({
      storage,
      queue,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, ...result, elapsed },
      'Backfill versions job completed'
    )
  },
  // One-time migration: convert the versions the revert before ADR-044 §4 set
  // aside — issue what each resource serves as its newest version, then flip
  // the set-aside rows back to `active`.
  //
  // Its own job rather than another call inside the backfill above, though one
  // control enqueues both: each walks every resource it finds, so joined, one
  // job would run as long as both and a retry would repeat both. Separate, each
  // is retried on its own — and both are idempotent, so a retry costs a
  // re-scan.
  [CONVERT_SET_ASIDE_JOB_TYPE]: async (job: Job) => {
    if (!parseJobPayload(job, convertSetAsideJobSchema)) return
    log.info({ jobId: job.id, type: job.type }, 'Convert set-aside versions job started')
    const start = performance.now()
    const result = await new ResourceVersionService(db).convertSetAsideVersions({
      storage,
      queue,
    })
    const elapsed = Math.round(performance.now() - start)
    log.info(
      { jobId: job.id, type: job.type, ...result, elapsed },
      'Convert set-aside versions job completed'
    )
  },
})

// --- Periodic index health check (detect data loss even when queue is idle) ---
const INDEX_CHECK_INTERVAL_MS = 60_000
const REBUILD_COOLDOWN_MS = 5 * 60 * 1000
let lastRebuildEnqueuedAt = 0
let indexCheckTimer: ReturnType<typeof setInterval> | undefined
if (search) {
  indexCheckTimer = setInterval(async () => {
    try {
      const osCount = await search.getPackagesDocCount()
      if (osCount !== 0) return // Non-empty or error — no action needed

      // OS index is empty — check DB to confirm data loss (avoid Aurora wake for normal state)
      const dbCount = await db.$count(packageTable, eq(packageTable.state, 'active'))

      if (dbCount > 0 && Date.now() - lastRebuildEnqueuedAt > REBUILD_COOLDOWN_MS) {
        osLogger.warn({ dbCount, osCount }, 'Index out of sync — enqueuing auto-recovery')
        lastRebuildEnqueuedAt = Date.now()
        await queue.enqueue(REINDEX_JOB_TYPE, { includeContent: true })
      }
    } catch (err) {
      osLogger.error({ err }, 'Periodic index check failed')
    }
  }, INDEX_CHECK_INTERVAL_MS)
}

log.info({ healthPort: HEALTH_PORT }, 'Worker started')

// Graceful shutdown
const shutdown = async () => {
  log.info('Shutting down...')
  healthCheckJob?.stop()
  orphanCleanupJob.stop()
  lakeIngestSweepJob.stop()
  resourceDocSweepJob.stop()
  resourceEmbedSweepJob.stop()
  clearTimeout(startSweep)
  if (indexCheckTimer) clearInterval(indexCheckTimer)
  if (waitingMetricTimer) clearInterval(waitingMetricTimer)
  await queue.stop()
  // Before the pool: each holds a libpq connection of its own, opened by the
  // catalog ATTACH and invisible to Drizzle's accounting (ADR-043).
  await closeLakeInstances()
  await db.$client.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
