/**
 * The per-resource execution claim (ADR-044).
 *
 * One resource, one writer. SQS delivers at least once and redelivers to a
 * second worker while the first is still going, so two runs do reach the same
 * resource — and a purge reaches it while a run is midway through writing the
 * derivatives the purge is there to destroy. The claim is what stops the second
 * from starting, rather than each write along the way having to notice it lost.
 *
 * Here rather than in the worker because it is a database invariant, like the
 * storage pointer and the advisory locks: the row is the claim, and the rules
 * for taking it have to hold whoever asks — the pipeline in the worker, the
 * purge in either process, the one-time backfill.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { ConflictError } from '@kukan/shared'

/**
 * How long a resource's claim survives without progress before another run can
 * take it (15 min, ADR-044).
 *
 * Sized against the longest single step rather than a whole run: Fetch is
 * capped at 30 s by its abort signal, Extract's input at 50MB of CSV, Version
 * is a server-side copy, and Index chunks and indexes — all expected in the
 * order of minutes. Several times over that, so a run that is merely slow is
 * never taken from. Derived from those caps, not measured in production.
 *
 * One value for every claimer: were the purge to judge staleness differently
 * from the pipeline, each would think the other's claim was still alive — or
 * both would take the same resource.
 */
export const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * SQL condition: nothing has progressed on this row for `staleAfterMs`, so
 * whoever holds it can be taken from.
 *
 * Progress is when the claim was taken or a step last started — never
 * `updated`. That column is written by `PipelineService.enqueue` and by the
 * purge's preview invalidation, neither of which holds the claim, so judging by
 * it would let a user re-uploading keep a dead run's window open indefinitely.
 * Step starts are needed alongside the claim time because a long run must not
 * be taken from: between the end of Extract and the final write, nothing else
 * moves.
 *
 * One expression for everyone who asks, for the same reason there is one
 * constant: two answers to "is this claim alive" is two writers.
 */
function staleClaim(staleAfterMs: number) {
  return sql`GREATEST(
    p.claim_owner_at,
    (SELECT MAX(s.started_at) FROM resource_pipeline_step s WHERE s.pipeline_id = p.id)
  ) < NOW() - ${`${Math.trunc(staleAfterMs)} milliseconds`}::interval`
}

/** A resource's claim: the pipeline row that holds it. */
export interface ResourceClaim {
  id: string
  resourceId: string
  /**
   * The run this claim was taken for. Carried so the holder can condition its
   * own writes on still being it — which is what makes a run killable
   * (ADR-044 §4): released, the claim stops matching and the run's next write
   * lands on nothing.
   */
  owner: string
}

/**
 * What is holding a resource.
 *
 * A run is the processing of the resource's content, and stopping it is
 * something a user can ask for (ADR-044 §4). A job — a purge, the backfill, a
 * lake retry — merely needs runs kept away while it works, and releasing its
 * claim would not stop it: it has no per-write ownership check to fail, so it
 * would carry on believing it still had the resource.
 *
 * Recorded on the row because that is where the kill has to make the
 * distinction, and by then the claimer is long out of the picture.
 */
export type ClaimKind = 'run' | 'job'

/**
 * Take every one of these resources for `owner`.
 *
 * One statement for the whole set, which is what makes a job that touches
 * hundreds of resources safe: there is no acquisition order to agree on and
 * nothing to deadlock against, because nothing here waits (ADR-044 open
 * question 2). A resource is either taken or reported held.
 *
 * Resources with no pipeline row appear in neither list. That is not a gap:
 * a run cannot start without that row either, so there is nothing to exclude.
 *
 * Takeable again once nothing has progressed for `staleAfterMs`, which is what
 * lets a worker that died mid-run (OOM, task replacement, deploy) be recovered
 * from without anyone intervening.
 *
 * Conditioned on the rows' own columns rather than on values read first, so the
 * check and the take cannot come apart without a lock to hold them together.
 *
 * @param kind - what is taking them. `'run'` is a promise that the holder
 *   conditions every write on still owning the claim, since that is what makes
 *   releasing it a kill; a caller that claims as a run without doing so gets a
 *   kill that drops the exclusion and stops nothing. Use the wrappers below
 *   rather than answering this by hand.
 */
export async function claimResources(
  db: Pick<Database, 'execute'>,
  resourceIds: string[],
  owner: string,
  staleAfterMs: number,
  kind: ClaimKind
): Promise<{ claimed: ResourceClaim[]; held: HeldResource[] }> {
  if (resourceIds.length === 0) return { claimed: [], held: [] }

  const result = await db.execute(sql`
    WITH claimed AS (
      UPDATE resource_pipeline p
      SET claim_owner = ${owner}::uuid, claim_owner_at = NOW(), claim_kind = ${kind}
      WHERE p.resource_id = ANY(${sql.param(resourceIds)}::uuid[])
        AND (p.claim_owner IS NULL OR ${staleClaim(staleAfterMs)})
      RETURNING p.id
    )
    SELECT p.id, p.resource_id AS "resourceId", (c.id IS NOT NULL) AS taken
    FROM resource_pipeline p
    LEFT JOIN claimed c ON c.id = p.id
    WHERE p.resource_id = ANY(${sql.param(resourceIds)}::uuid[])
  `)

  const rows = result.rows as unknown as (HeldResource & { taken: boolean })[]
  return {
    claimed: rows.filter((r) => r.taken).map(({ id, resourceId }) => ({ id, resourceId, owner })),
    held: rows.filter((r) => !r.taken).map(({ id, resourceId }) => ({ id, resourceId })),
  }
}

/**
 * Give the claims up, so the next run does not have to wait out the staleness
 * window.
 *
 * Conditioned on still holding them: a run that was taken over must not release
 * the claim of whoever took it, which is the whole reason the owner is recorded
 * rather than inferred from `status`.
 *
 * Returns how many were actually released, so a caller that cares can tell it
 * was displaced.
 */
export async function releaseResourceClaims(
  db: Pick<Database, 'execute'>,
  pipelineIds: string[],
  owner: string
): Promise<number> {
  if (pipelineIds.length === 0) return 0

  const result = await db.execute(sql`
    UPDATE resource_pipeline
    SET claim_owner = NULL, claim_owner_at = NULL, claim_kind = NULL
    WHERE id = ANY(${sql.param(pipelineIds)}::uuid[]) AND claim_owner = ${owner}::uuid
    RETURNING id
  `)
  return result.rows.length
}

/** A pipeline row someone else holds. Which run holds it is deliberately not
 *  reported: only the holder itself can act on that, and it already knows. */
export type HeldResource = Omit<ResourceClaim, 'owner'>

/** Refused: these resources are held by someone else, and nothing was run. */
export interface ClaimHeld {
  status: 'held'
  held: HeldResource[]
}

/** What became of a claimed section of work. */
export type ClaimOutcome<T> =
  | { status: 'ran'; result: T }
  | ClaimHeld
  /** No pipeline row, so the resource cannot be run at all. */
  | { status: 'absent' }

/**
 * Hold one resource for the duration of `fn` — the shape a pipeline run needs.
 *
 * A missing pipeline row is refused rather than waved through: this is for work
 * that *is* the run, and the run has nowhere to record itself without one. Jobs
 * that merely have to keep runs away from a resource want
 * {@link withResourceClaims}, which treats the same case as nothing to exclude.
 */
export async function withResourceClaim<T>(
  db: Database,
  resourceId: string,
  fn: (claim: ResourceClaim) => Promise<T>
): Promise<ClaimOutcome<T>> {
  const owner = randomUUID()
  const { claimed, held } = await claimResources(
    db,
    [resourceId],
    owner,
    CLAIM_STALE_AFTER_MS,
    'run'
  )
  if (claimed.length === 0) return held.length > 0 ? { status: 'held', held } : { status: 'absent' }

  try {
    return { status: 'ran', result: await fn(claimed[0]) }
  } finally {
    await releaseResourceClaims(db, [claimed[0].id], owner)
  }
}

/**
 * Keep every run away from these resources for the duration of `fn` — the shape
 * a purge, a backfill or a retry needs.
 *
 * All or nothing: one resource held by a run means `fn` never starts and the
 * claims already taken are rolled back, because doing half of a purge would
 * leave exactly the objects the claim exists to prevent. The caller retries.
 *
 * Resources with no pipeline row are simply not claimed — nothing can run
 * against them — so `fn` still runs for a set that has none.
 */
export async function withResourceClaims<T>(
  db: Database,
  resourceIds: string[],
  fn: (claims: ResourceClaim[]) => Promise<T>
): Promise<{ status: 'ran'; result: T } | ClaimHeld> {
  const owner = randomUUID()
  let claimed: ResourceClaim[]

  // A transaction so that a refusal leaves nothing behind. Giving the taken
  // ones back by hand, a process dying between the take and that release would
  // hold resources it never worked on until they went stale — a quarter hour in
  // which nothing runs against them and nothing is running.
  try {
    claimed = await db.transaction(async (tx) => {
      const outcome = await claimResources(tx, resourceIds, owner, CLAIM_STALE_AFTER_MS, 'job')
      if (outcome.held.length > 0) throw new SomeHeld(outcome.held)
      return outcome.claimed
    })
  } catch (err) {
    if (err instanceof SomeHeld) return { status: 'held', held: err.held }
    throw err
  }

  try {
    return { status: 'ran', result: await fn(claimed) }
  } finally {
    await releaseResourceClaims(
      db,
      claimed.map((c) => c.id),
      owner
    )
  }
}

/** Rolls the claiming transaction back, carrying the resources that refused. */
class SomeHeld extends Error {
  constructor(readonly held: HeldResource[]) {
    super('Some resources are held')
  }
}

/**
 * {@link withResourceClaims} for the callers that cannot proceed without the
 * resources: every purge.
 *
 * A refusal is a conflict, not a failure — the work is still outstanding and
 * the caller is expected back. Both kinds of caller already do the right thing
 * with it: an HTTP purge answers 409, and a worker job's throw returns the
 * message to the queue, leaving the durable 'purging' state for the retry.
 *
 * The blocking resource is named, because with hundreds of them in a set,
 * "something is busy" is nowhere to start for anyone looking into a purge that
 * will not finish.
 */
export async function withResourceClaimsOrConflict<T>(
  db: Database,
  resourceIds: string[],
  fn: () => Promise<T>
): Promise<T> {
  const outcome = await withResourceClaims(db, resourceIds, fn)
  if (outcome.status === 'held') throw heldConflict(outcome.held, 'purge')
  return outcome.result
}

/**
 * The refusal every claiming caller gives back.
 *
 * The blocking resource is named, because with hundreds of them in a set,
 * "something is busy" is nowhere to start for anyone looking into work that
 * will not finish.
 */
function heldConflict(held: HeldResource[], action: string): ConflictError {
  return new ConflictError(`Resource ${held[0].resourceId} is being processed; retry the ${action}`)
}

/**
 * SQL condition: this pipeline row, and `claim.owner` still holds it.
 *
 * Every write a run makes to its own record carries this, which is what turns
 * releasing the claim into a kill — the run's next statement matches nothing
 * and it leaves. Here rather than in the worker for the same reason the rest of
 * this file is: it is the claim's rule, and it has to read the same everywhere
 * it is applied.
 */
export function heldBy(claim: ResourceClaim, table?: 'p') {
  const col = (name: string) => sql.raw(table ? `${table}.${name}` : name)
  return sql`${col('id')} = ${claim.id}::uuid AND ${col('claim_owner')} = ${claim.owner}::uuid`
}

/**
 * Stop whatever run holds this resource (ADR-044 §4).
 *
 * Releasing the claim is the kill: every write a run makes to its own record is
 * conditioned on still holding it, so from here the run lands on nothing and
 * leaves. It is not asked to stop — there is no channel to ask over, and a run
 * wedged in a slow read would not hear it anyway.
 *
 * The row is marked `cancelled` rather than left as it was, because otherwise
 * nothing distinguishes a run that was stopped from one still going: the
 * resource keeps content that no version, preview or index describes, and
 * `processing` would go on claiming otherwise.
 *
 * The content is not touched. Reverting it is a separate decision (§4), and one
 * a caller stopping a stuck run does not want made for them.
 *
 * Only a run is stopped, for the reason {@link ClaimKind} gives. Rows claimed
 * before that column existed read as runs, which is how they were treated.
 *
 * @returns whether a run was actually stopped.
 */
export async function cancelResourceRun(
  db: Pick<Database, 'execute'>,
  resourceId: string
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE resource_pipeline
    SET claim_owner = NULL, claim_owner_at = NULL, claim_kind = NULL,
        status = 'cancelled', updated = NOW()
    WHERE resource_id = ${resourceId}::uuid
      AND claim_owner IS NOT NULL
      AND claim_kind IS DISTINCT FROM 'job'
    RETURNING id
  `)
  return result.rows.length > 0
}

/**
 * Stop the run and take the resource for this piece of work, in one statement
 * (ADR-044 §4).
 *
 * For the callers that stop a run in order to do something to the content it
 * was writing. Cancelling and then claiming leaves a gap in which a waiting job
 * takes the resource and starts writing over exactly what is being retracted;
 * here the resource is never free.
 *
 * A resource nothing is running against is claimed just the same, so the caller
 * has one path rather than two. A job holding it is refused, for the reason
 * {@link ClaimKind} gives.
 */
export async function claimFromRun(
  db: Pick<Database, 'execute'>,
  resourceId: string
): Promise<ClaimTakeover> {
  const owner = randomUUID()
  const result = await db.execute(sql`
    WITH before AS (
      SELECT id, claim_owner, claim_kind FROM resource_pipeline
      WHERE resource_id = ${resourceId}::uuid
      FOR UPDATE
    ),
    taken AS (
      UPDATE resource_pipeline p
      SET claim_owner = ${owner}::uuid, claim_owner_at = NOW(), claim_kind = 'job',
          -- Only a run that was actually stopped is recorded as cancelled; an
          -- idle resource keeps whatever its last run left.
          status = CASE WHEN b.claim_owner IS NULL THEN p.status ELSE 'cancelled' END,
          updated = NOW()
      FROM before b
      WHERE p.id = b.id
        AND (b.claim_kind IS DISTINCT FROM 'job' OR ${staleClaim(CLAIM_STALE_AFTER_MS)})
      RETURNING p.id
    )
    SELECT b.id, (b.claim_owner IS NOT NULL) AS cancelled, (t.id IS NOT NULL) AS taken
    FROM before b LEFT JOIN taken t ON t.id = b.id
  `)
  const row = result.rows[0] as { id: string; cancelled: boolean; taken: boolean } | undefined
  if (!row) return { status: 'claimed', claim: null, cancelled: false }
  if (!row.taken) return { status: 'held', held: [{ id: row.id, resourceId }] }
  return { status: 'claimed', claim: { id: row.id, resourceId, owner }, cancelled: row.cancelled }
}

/**
 * What became of a takeover. `cancelled` reports whether a run was stopped, and
 * a null claim means the resource has no pipeline row — nothing could have been
 * running, and there is nothing to hold.
 */
export type ClaimTakeover =
  { status: 'claimed'; claim: ResourceClaim | null; cancelled: boolean } | ClaimHeld

/**
 * Stop the run and hold the resource for the duration of `fn` — the shape a
 * revert needs (ADR-044 §4).
 *
 * The scoped form of {@link claimFromRun}, here beside the other two
 * acquisitions so that no caller holds a raw claim: the rule for giving one
 * back is the claim's, not the caller's, and a caller that forgets holds the
 * resource against every run and every other revert for the staleness window.
 *
 * A refusal is a conflict — only a job can refuse, and its work is not
 * something to proceed alongside.
 */
export async function withClaimFromRun<T>(
  db: Database,
  resourceId: string,
  action: string,
  fn: (claim: ResourceClaim | null, cancelled: boolean) => Promise<T>
): Promise<T> {
  const outcome = await claimFromRun(db, resourceId)
  if (outcome.status === 'held') throw heldConflict(outcome.held, action)

  const { claim, cancelled } = outcome
  try {
    return await fn(claim, cancelled)
  } finally {
    if (claim) await releaseResourceClaims(db, [claim.id], claim.owner)
  }
}
