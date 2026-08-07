/**
 * Finds the objects that leaked before there was a ledger to catch them, and
 * hands them to the sweep (ADR-045 open issue 1).
 *
 * The write-ahead record protects writes made from now on. Anything stranded by
 * a crash before it — or by one of the races ADR-044 closed — is named by no
 * record and no pointer, so the only way to see it is to list the bucket. That
 * is the reconciliation ADR-045 weighed as approach B and declined as a standing
 * mechanism, for a reason that has not changed: it depends on the list of
 * pointer sources being exhaustive, and a column added later with only one of
 * the two copies updated deletes live data.
 *
 * So this does not carry its own copy. It asks {@link referenced}, the same
 * predicate the sweep asks, and it does not delete: it nominates. The keys it
 * finds go into `orphaned_object` with an expiry, and the sweep decides an hour
 * later — asking the question a second time, after the wait, against whatever
 * committed in between. An object whose pointer landed between the listing and
 * the sweep is therefore kept, not lost, and a run of this that turns out to
 * have been wrong costs a row rather than a file.
 *
 * Run by hand, not scheduled — but run until **`nominated` and `tooRecent` are
 * both zero**, which may take more than once. `tooRecent` holds the objects
 * this pass could not judge because they are young enough to still be a write
 * in progress, and nothing else is coming back to look at them.
 *
 * Keys the ledger already holds are counted apart from both, since ordinary
 * parked keys are unreferenced by construction and would otherwise keep the
 * count off zero for as long as the system is in use.
 */

import { inArray } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { orphanedObject } from '@kukan/db'
import { RESOURCE_PREFIX, PREVIEW_PREFIX, VERSION_PREFIX } from '@kukan/shared'
import type { Logger } from '@kukan/shared'
import { RESERVED_UNTIL } from '@kukan/api/services/storage-pointer'
import type { ListedObject, StorageAdapter } from '@kukan/storage-adapter'
import { referenced } from './sweep-orphans'

/**
 * Where a leaked object can be. `lake/` is not here: DuckLake knows its own
 * layout and reclaims its own files, and ADR-045 §5 declined to build a second
 * thing that thinks it does.
 */
const PREFIXES = [RESOURCE_PREFIX, PREVIEW_PREFIX, VERSION_PREFIX]

/**
 * How much of the bucket to hold before asking about it. The question is one
 * statement over an array, so this trades memory for round trips rather than
 * for correctness.
 */
const CHECK_BATCH_SIZE = 1000

export interface ReconcileOptions {
  /**
   * Do not act on an object younger than this. A write in flight has put its
   * object down and not yet committed the pointer, which from a listing is
   * indistinguishable from a leak — but unlike a leak it settles on its own, so
   * the answer is to look again rather than to decide now. Deferred, not
   * dropped: see {@link ReconcileResult.tooRecent}.
   */
  minAgeMs: number
  /** Report what would be nominated, without writing anything. */
  dryRun: boolean
}

export interface ReconcileResult {
  listed: number
  /**
   * Unreferenced and untracked, but younger than `minAgeMs` — so this run
   * cannot tell a leak from a write still going, and defers.
   *
   * Judged after the other two, not before them. Filtering by age first would
   * have folded these in with every ordinary recent object and left them out of
   * the report entirely: `nominated` could read zero with untracked leaks
   * sitting in the bucket, and nothing is scheduled to look again. **The run is
   * finished only when this and `nominated` are both zero.**
   */
  tooRecent: number
  /** Live, and left alone. */
  referenced: number
  /**
   * Unreferenced, but a writer had already parked or reserved it. Counted apart
   * from `nominated` so that number means what the completion signal needs it
   * to: normal parking churn is always in the ledger with an object old enough
   * to pass the age guard, and folding it in would keep the report from ever
   * reaching zero.
   */
  alreadyTracked: number
  /** Handed to the sweep — or, in a dry run, what would have been. */
  nominated: number
  /** The first few, so an operator can look before committing. */
  samples: string[]
}

const SAMPLE_LIMIT = 20

export async function reconcileOrphanedObjects(
  db: Database,
  storage: StorageAdapter,
  log: Logger,
  opts: ReconcileOptions
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    listed: 0,
    tooRecent: 0,
    referenced: 0,
    alreadyTracked: 0,
    nominated: 0,
    samples: [],
  }

  for (const prefix of PREFIXES) {
    let token: string | undefined
    // Per prefix, so a partial batch is settled before moving on rather than
    // carried across a boundary the report is grouped by.
    const pending: ListedObject[] = []

    do {
      const page = await storage.list(prefix, token)
      token = page.nextToken
      result.listed += page.objects.length
      pending.push(...page.objects)

      while (pending.length >= CHECK_BATCH_SIZE) {
        await settle(pending.splice(0, CHECK_BATCH_SIZE))
      }
    } while (token)

    if (pending.length > 0) await settle(pending.splice(0))
  }

  const { samples: _samples, ...counts } = result
  log.info(counts, opts.dryRun ? 'Reconciliation (dry run)' : 'Reconciliation complete')
  return result

  async function settle(batch: ListedObject[]): Promise<void> {
    const keys = batch.map((o) => o.key)
    const rows = await db.execute(referenced(keys))
    const live = new Set((rows.rows as unknown as { key: string }[]).map((r) => r.key))
    result.referenced += live.size

    const unreferenced = keys.filter((k) => !live.has(k))
    if (unreferenced.length === 0) return

    // Asked before inserting rather than inferred from what the insert skipped,
    // so a dry run reports the same split as a commit.
    const known = await db
      .select({ key: orphanedObject.key })
      .from(orphanedObject)
      .where(inArray(orphanedObject.key, unreferenced))
    const tracked = new Set(known.map((r) => r.key))
    result.alreadyTracked += tracked.size

    // Age last. Everything that reaches here is unreferenced and unrecorded —
    // a leak, or a write that has put its object down and not yet committed a
    // pointer. Only that second possibility is worth waiting on, so only these
    // are dated. One clock reading for the batch, so the boundary cannot move
    // while it is being split.
    const cutoff = Date.now() - opts.minAgeMs
    const candidates = batch.filter((o) => !live.has(o.key) && !tracked.has(o.key))
    const orphans: string[] = []
    for (const o of candidates) {
      if (o.lastModified.getTime() >= cutoff) result.tooRecent++
      else orphans.push(o.key)
    }
    if (orphans.length === 0) return

    result.nominated += orphans.length
    for (const k of orphans) {
      if (result.samples.length < SAMPLE_LIMIT) result.samples.push(k)
    }
    if (opts.dryRun) return

    // The reserved wait rather than the parked one: what this is waiting out is
    // a write that may still be running, which is the question that constant
    // answers. `DO NOTHING` is belt and braces — the keys are already filtered
    // — for a writer that parked one between the read above and this insert.
    await db
      .insert(orphanedObject)
      .values(orphans.map((key) => ({ key, expiresAt: RESERVED_UNTIL })))
      .onConflictDoNothing({ target: orphanedObject.key })
  }
}
