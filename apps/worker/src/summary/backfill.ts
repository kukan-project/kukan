/**
 * Writing the abstracts a catalog is missing (ADR-053 §11).
 *
 * Its own job rather than the pipeline's `rebuildOnly`, which bypasses the
 * reuse check and would regenerate every Parquet and re-ingest all of DuckLake
 * to arrive at a sentence. Everything an abstract is made from is already in
 * storage.
 *
 * **Per package, one resource at a time.** Three things follow from that shape,
 * and all three are the reason for it:
 *
 * - one job is one completion, so the visibility timeout covers it — a package
 *   of a hundred files in a single job would run for twenty minutes and be
 *   redelivered, billing every completion twice;
 * - the embedding is enqueued once, at the end, with every abstract written.
 *   The debounce is leading-edge, so fanning out per resource would settle a
 *   package's vector on the first abstract of a hundred;
 * - "nothing left" is the terminal condition, so no counter has to be kept
 *   anywhere, and a chain that dies is restarted by pressing the button again.
 *
 * A resource somebody else is processing is waited for rather than passed over.
 * The run holding it writes the abstract itself only if it reaches the step,
 * and a failed Fetch or a throttled provider means it does not.
 */

import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, resourceVersion } from '@kukan/db'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { enqueuePackageEmbed, enqueueResourceDocSync } from '@kukan/api/services/search-index'
import { withResourceClaim } from '@kukan/api/services/pipeline-claim'
import { SUMMARIZE_PACKAGE_JOB_TYPE, type Logger } from '@kukan/shared'
import { CLAIM_RETRY_DELAY_S } from '@/config'
import {
  executeSummarize,
  recordSkip,
  type SummaryDeps,
  type SummaryInput,
} from '../pipeline/steps/summarize'

/** Enqueue one walk per active package. */
export async function enqueueSummarizePackages(
  db: Database,
  queue: QueueAdapter,
  log: Logger,
  refresh = false
): Promise<{ enqueued: number; failed: number }> {
  const packages = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(and(eq(packageTable.state, 'active'), eq(packageTable.private, false)))
    .orderBy(asc(packageTable.id))

  let enqueued = 0
  let failed = 0
  for (const pkg of packages) {
    try {
      await queue.enqueue(SUMMARIZE_PACKAGE_JOB_TYPE, { packageId: pkg.id, refresh })
      enqueued++
    } catch (err) {
      failed++
      log.error({ err, packageId: pkg.id }, 'Failed to enqueue a summarize-package job')
    }
  }
  return { enqueued, failed }
}

/**
 * Write the abstract for one resource of a package, then hand the rest of the
 * package to the next job.
 *
 * The walk is ordered by id and carries where it got to, so nothing has to be
 * marked as done: a resource whose abstract already describes its material
 * costs the material read and no completion, which is also what makes the
 * whole chain safe to start again.
 */
export async function summarizeNextInPackage(
  packageId: string,
  after: string | undefined,
  deps: SummaryDeps,
  queue: QueueAdapter,
  refresh = false
): Promise<{ done: boolean; resourceId?: string; held?: boolean }> {
  const [next] = await deps.db
    .select({
      id: resource.id,
      // The version's format is the authoritative one (ADR-046 §6), but a null
      // there is "not recorded", not "no format": versions created by the
      // layer-1 backfill carry none, and 438 of the 507 in the catalogue this
      // was first run against were such rows. Reading them as formatless made
      // the walk record "no material" for six resources in seven.
      format: sql<string | null>`COALESCE(${resourceVersion.format}, ${resource.format})`,
      size: resourceVersion.size,
      storageKey: resourceVersion.storageKey,
      version: resourceVersion.version,
    })
    .from(resource)
    // The version holding the live content, which is what an abstract is made
    // from: settled bytes that cannot change under it (ADR-046).
    .innerJoin(
      resourceVersion,
      and(
        eq(resourceVersion.resourceId, resource.id),
        eq(resourceVersion.state, 'active'),
        eq(resourceVersion.hash, resource.hash)
      )
    )
    .where(
      and(
        eq(resource.packageId, packageId),
        eq(resource.state, 'active'),
        isNotNull(resource.hash),
        after ? gt(resource.id, after) : undefined
      )
    )
    .orderBy(asc(resource.id), sql`${resourceVersion.version} desc`)
    .limit(1)

  if (!next) {
    // Every abstract in the package is written, so the vector can be built from
    // all of them at once — the one enqueue this chain makes.
    await enqueuePackageEmbed(deps.db, queue, deps.ai, packageId, deps.log)
    return { done: true }
  }

  const held = await summarizeOne(packageId, next, deps, queue, refresh)
  // Held, the walk stays where it is and comes back. The run holding it writes
  // the abstract itself only if it gets that far: a failed Fetch never reaches
  // the step, and a throttled Summarize records the failure and lets the run
  // finish. Advancing past it would drop the resource out of the generation
  // somebody asked for, silently — the one kind of failure this chain did not
  // retry, while retrying its own.
  if (held) {
    await queue.enqueue(
      SUMMARIZE_PACKAGE_JOB_TYPE,
      { packageId, after, refresh },
      { delaySeconds: CLAIM_RETRY_DELAY_S }
    )
  } else {
    await queue.enqueue(SUMMARIZE_PACKAGE_JOB_TYPE, { packageId, after: next.id, refresh })
  }
  return { done: false, resourceId: next.id, held }
}

async function summarizeOne(
  packageId: string,
  next: {
    id: string
    version: number
    storageKey: string
    format: string | null
    size: number | null
  },
  deps: SummaryDeps,
  queue: QueueAdapter,
  refresh: boolean
): Promise<boolean> {
  const outcome = await withResourceClaim(deps.db, next.id, async (claim) => {
    const input: SummaryInput = {
      refresh,
      resourceId: next.id,
      packageId,
      version: next.version,
      storageKey: next.storageKey,
      format: next.format,
      size: next.size,
      claim,
    }
    const result = await executeSummarize(input, deps)
    // Everything about the file goes on the resource; a refusal of the moment
    // throws out of here and fails the job, which SQS retries.
    if (result.status === 'skipped') await recordSkip(input, deps, result.reason, result)
    // The abstract is in the keyword leg as well as the vector (ADR-053 §9.3),
    // and the walk is the only thing that will have written it here. The
    // package's vector is settled once, at the end of the chain; the document
    // is per resource, so it goes now.
    //
    // **Whatever the outcome, not only a write.** The document is a statement
    // about the row, so making it say what the row says is right either way —
    // and only that makes it recoverable: written and then failed to index,
    // the retry finds the abstract unchanged and would step past it for ever,
    // leaving the sentences out of the index with nothing left to notice. The
    // walk repairs the index for the same reason pressing it again is free.
    await enqueueResourceDocSync(queue, next.id, deps.log)
    return result.status
  })

  if (outcome.status === 'held') {
    deps.log.info({ resourceId: next.id }, 'Resource is being processed; the walk will come back')
    return true
  }
  return false
}
