/**
 * KUKAN Worker — Resource Embedding (ADR-034 / ADR-054)
 *
 * Generates one semantic-search vector per resource, from its package's title
 * and tags followed by the resource's own (section / name / description /
 * abstract). The job builds the resources marked due (`embedding_due_at`), a
 * batch to a provider call, whatever packages they belong to.
 *
 * **Why the resource and not the package (ADR-054).** A vector of a package's
 * resources concatenated is a centroid, and a centroid holds no per-resource
 * score: it cannot say which of nineteen sheets a query is about, and the
 * further apart the sheets are the less it resembles any of them. One vector
 * per resource lets a hit name the table, and puts the package at its closest
 * resource's position.
 */

import { createHash } from 'node:crypto'
import { asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, publicSummary, resource, packageTag, tag } from '@kukan/db'
import { type AIAdapter, AiInputRejectedError, embeddingKey } from '@kukan/ai-adapter'
import { RESOURCE_EMBED_LOCK, tryLockInTransaction } from '@kukan/api/services/advisory-lock'
import {
  EMBED_BATCH_SIZE,
  EMBED_JOB_MAX_BATCHES,
  EMBED_RESOURCE_RESERVE_CHARS,
  EMBED_TIMEOUT_MS,
  MAX_EMBED_TEXT_LENGTH,
} from '../config'

export interface ResourceEmbedSource {
  /**
   * The package's — the context a resource named「13_shisetsu.csv」lacks, and
   * the whole of a resource's meaning on a site without abstracts. Title and
   * tags only: `notes` measured to blur which of a package's resources is the
   * match, and the keyword leg reads it on the package document anyway
   * (ADR-054 decision 3).
   */
  title: string | null
  tags: string[]
  /** The resource's own */
  section: string | null
  name: string | null
  description: string | null
  /** The abstract, null when there is none or an editor hid it (ADR-053) */
  summary?: string | null
}

/**
 * Build one resource's embedding text (truncated to MAX_EMBED_TEXT_LENGTH).
 *
 * Package context first, so that a cut lands on the resource's own tail; the
 * abstract last because it is the longest part and whole sentences, so the cut
 * — which backs up to a sentence end — loses the least by falling there.
 */
export function buildResourceEmbeddingText(source: ResourceEmbedSource): string {
  // Title and tags first — the head of the text weighs most, and this is what
  // lands the query on the right package. The resource's own words are what
  // tell its vector from its siblings', so they hold a reserve the head cannot
  // take (EMBED_RESOURCE_RESERVE_CHARS): neither title nor tags is bounded, and
  // a head that ate the whole budget would give every resource of the package
  // the same vector. What the resource does not need, the head may have.
  const ownFull = [source.section, source.name, source.description, source.summary]
    .filter(Boolean)
    .join('\n')
  const reserved = Math.min(ownFull.length, EMBED_RESOURCE_RESERVE_CHARS)
  const head = truncateAtBoundary(
    [source.title, source.tags.join(' ')].filter(Boolean).join('\n'),
    MAX_EMBED_TEXT_LENGTH - reserved - (reserved ? 1 : 0)
  )
  const own = truncateAtBoundary(ownFull, MAX_EMBED_TEXT_LENGTH - head.length - (head ? 1 : 0))
  return [head, own].filter(Boolean).join('\n')
}

/**
 * Cut back to the last sentence or line that ended before the budget.
 *
 * Every abstract measured ended on a full stop, so dropping the trailing
 * sentence whole leaves text that still reads; cutting on the character count
 * is what produces the half-sentence. Falls back to the hard cut when nothing
 * ended in range — a single unbroken run of text has no better answer.
 */
function truncateAtBoundary(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const end = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('.'),
    head.lastIndexOf('!'),
    head.lastIndexOf('?'),
    head.lastIndexOf('\n')
  )
  return end > 0 ? head.slice(0, end + 1).trimEnd() : head
}

/** What one run did, for the log */
export interface EmbedDueResult {
  /** Vectors written */
  embedded: number
  /** Marks cleared without a provider call: text and model unchanged, nothing
   *  to embed, or a resource no longer searchable */
  settled: number
  /** Resources whose text the model refused as too long: recorded as refused, mark cleared */
  rejected: string[]
  /** Whether marks were left for another run */
  more: boolean
  /** Whether another run held the lock, so this one did nothing */
  busy: boolean
}

type Planned = { id: string; dueAt: string } & (
  { action: 'keep' } | { action: 'drop' } | { action: 'write'; text: string; hash: string }
)

/**
 * Build the vectors of the resources marked due, oldest mark first, a batch
 * of {@link EMBED_BATCH_SIZE} per provider call, and at most `maxBatches`
 * batches — the rest are left for the job this one asks for, so a catalog-wide
 * mark does not hold the worker from everything queued behind it.
 *
 * A resource whose text and model key are unchanged has its mark cleared and
 * nothing else (embedding_hash); one with nothing to embed has its vector
 * cleared; one no longer searchable — deleted, or of a draft or deleted
 * package — has only its mark cleared: publish and restore mark it again.
 *
 * **Compare-and-set on the mark**, as the document sync does: a vector is
 * written, and the mark cleared, only where the mark is still the one read.
 * An edit that lands while the provider is working leaves a newer mark, and
 * the vector of the text before it is dropped rather than written over the
 * newer one's turn. The row is read again by the next batch.
 *
 * **One run at a time** ({@link RESOURCE_EMBED_LOCK}): another reads the same
 * oldest marks and sends the same texts. A run that finds the lock held
 * returns `busy` at once, for the caller to ask again later.
 *
 * **Failures are of two kinds, told apart by the adapter.** A text the model
 * refuses as too long ({@link AiInputRejectedError}) is refused again whenever
 * it is sent: a batch that meets one is sent again a text at a time to find
 * it, and it is recorded as refused (see `settle`) — the next edit of it, or
 * a change of model, sends it again. Everything else — the
 * provider down, throttled, credentials expired, a request built wrong — is
 * thrown: the batch keeps its marks, the queue retries, and the sweep asks
 * again after that.
 */
export async function embedDueResources(
  db: Database,
  ai: AIAdapter,
  { maxBatches = EMBED_JOB_MAX_BATCHES }: { maxBatches?: number } = {}
): Promise<EmbedDueResult> {
  const result: EmbedDueResult = { embedded: 0, settled: 0, rejected: [], more: false, busy: false }
  const info = ai.getEmbeddingInfo()
  if (!info) return result
  const key = embeddingKey(info)

  const ran = await whenNoOtherRun(db, async () => {
    for (let n = 0; n < maxBatches; n++) {
      const rows = await readMarked(db)
      if (rows.length === 0) return
      const planned = await plan(db, rows, key)

      const writes = planned.filter((p) => p.action === 'write')
      const { vectors, rejected } = await embedAll(ai, writes)
      const done = await settle(
        db,
        planned.map((p): Settled => {
          if (p.action !== 'write') return p
          if (rejected.includes(p.id))
            return { id: p.id, dueAt: p.dueAt, action: 'reject', hash: p.hash }
          return { ...p, vector: vectors.get(p.id)! }
        }),
        key
      )
      result.embedded += done.filter((a) => a === 'write').length
      result.settled += done.filter((a) => a === 'keep' || a === 'drop').length
      result.rejected.push(...rejected)
      if (rows.length < EMBED_BATCH_SIZE) return
    }
    const [left] = await db
      .select({ id: resource.id })
      .from(resource)
      .where(isNotNull(resource.embeddingDueAt))
      .limit(1)
    result.more = left !== undefined
  })
  result.busy = !ran
  return result
}

/**
 * Run `fn` if no other run holds {@link RESOURCE_EMBED_LOCK}; false at once if
 * one does. The lock is held by a transaction that does nothing else, and `fn`
 * writes through the pool as usual: idle, with no writes, a read-committed
 * transaction pins no snapshot, so holding it costs one pooled connection.
 *
 * The lock goes when the connection does. A killed process closes it at once;
 * a host that vanishes does not, and the server's default keepalive would keep
 * every other run out for two hours — so the holder's is a minute.
 */
function whenNoOtherRun(db: Database, fn: () => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('tcp_keepalives_idle', '30', true),
      set_config('tcp_keepalives_interval', '10', true), set_config('tcp_keepalives_count', '3', true)`)
    if (!(await tryLockInTransaction(tx, RESOURCE_EMBED_LOCK, ''))) return false
    await fn()
    return true
  })
}

/** The oldest marks, with what their text is built from */
function readMarked(db: Database) {
  return db
    .select({
      id: resource.id,
      packageId: resource.packageId,
      searchable: sql<boolean>`${resource.state} = 'active' AND ${packageTable.state} = 'active'`,
      title: packageTable.title,
      name: resource.name,
      description: resource.description,
      section: resource.section,
      // An editor who hid an abstract hid it from the search too: it is off
      // the page, and a vector still pulled toward it is the version of
      // "hidden" nobody can see or check (ADR-053 §4.1)
      summary: publicSummary,
      embeddingModel: resource.embeddingModel,
      embeddingHash: resource.embeddingHash,
      // As text: a Date keeps milliseconds where the column keeps
      // microseconds, so the mark would never match itself
      dueAt: sql<string>`${resource.embeddingDueAt}::text`,
    })
    .from(resource)
    .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
    .where(isNotNull(resource.embeddingDueAt))
    .orderBy(asc(resource.embeddingDueAt))
    .limit(EMBED_BATCH_SIZE)
}

/** What each marked row needs: a vector written, dropped, or only its mark cleared */
async function plan(
  db: Database,
  rows: Awaited<ReturnType<typeof readMarked>>,
  key: string
): Promise<Planned[]> {
  const tags = await tagsOf(db, [
    ...new Set(rows.filter((r) => r.searchable).map((r) => r.packageId)),
  ])
  return rows.map((r) => {
    if (!r.searchable) return { id: r.id, dueAt: r.dueAt, action: 'keep' }
    const text = buildResourceEmbeddingText({
      title: r.title,
      tags: tags.get(r.packageId) ?? [],
      section: r.section,
      name: r.name,
      description: r.description,
      summary: r.summary,
    })
    if (!text) {
      return { id: r.id, dueAt: r.dueAt, action: r.embeddingModel === null ? 'keep' : 'drop' }
    }
    const hash = createHash('sha256').update(text).digest('hex')
    if (r.embeddingHash === hash && r.embeddingModel === key) {
      return { id: r.id, dueAt: r.dueAt, action: 'keep' }
    }
    return { id: r.id, dueAt: r.dueAt, action: 'write', text, hash }
  })
}

/**
 * The vectors of `writes`, in one call. When that call meets a text the model
 * refuses as too long, one call each, to find which: the refused are
 * returned, the rest embedded. Any other failure is thrown.
 */
async function embedAll(
  ai: AIAdapter,
  writes: { id: string; text: string }[]
): Promise<{ vectors: Map<string, number[]>; rejected: string[] }> {
  const vectors = new Map<string, number[]>()
  const rejected: string[] = []
  const embed = (texts: string[]) =>
    ai.embedBatch(texts, { type: 'document', timeoutMs: EMBED_TIMEOUT_MS })
  if (writes.length === 0) return { vectors, rejected }
  try {
    const all = await embed(writes.map((w) => w.text))
    writes.forEach((w, i) => vectors.set(w.id, all[i]))
    return { vectors, rejected }
  } catch (err) {
    if (!(err instanceof AiInputRejectedError)) throw err
  }
  for (const w of writes) {
    try {
      vectors.set(w.id, (await embed([w.text]))[0])
    } catch (err) {
      if (!(err instanceof AiInputRejectedError)) throw err
      rejected.push(w.id)
    }
  }
  return { vectors, rejected }
}

/** Tag names per package, in a stable order — they join the hashed text */
async function tagsOf(db: Database, packageIds: string[]): Promise<Map<string, string[]>> {
  const byPackage = new Map<string, string[]>()
  if (packageIds.length === 0) return byPackage
  const rows = await db
    .select({ packageId: packageTag.packageId, name: tag.name })
    .from(packageTag)
    .innerJoin(tag, eq(packageTag.tagId, tag.id))
    .where(inArray(packageTag.packageId, packageIds))
    .orderBy(tag.name)
  for (const { packageId, name } of rows) {
    byPackage.set(packageId, [...(byPackage.get(packageId) ?? []), name])
  }
  return byPackage
}

type Settled =
  | Extract<Planned, { action: 'keep' | 'drop' }>
  | (Extract<Planned, { action: 'write' }> & { vector: number[] })
  | { id: string; dueAt: string; action: 'reject'; hash: string }

/**
 * One statement for the batch, each row only if its mark is still the one
 * read: write the vector (`write`), clear it (`drop`), leave it (`keep`), or
 * record that the model refused this text (`reject`) — no vector, but this
 * model's key and this text's hash, so a regenerate does not send it again and
 * the missing count does not ask for it: only a new text or a new model will.
 * The mark is cleared in all four. Returns what it did, a row at a time.
 */
async function settle(db: Database, rows: Settled[], key: string): Promise<Settled['action'][]> {
  if (rows.length === 0) return []
  const values = sql.join(
    rows.map((r) => {
      const vector = r.action === 'write' ? JSON.stringify(r.vector) : null
      const hash = r.action === 'write' || r.action === 'reject' ? r.hash : null
      return sql`(${r.id}::uuid, ${r.dueAt}::timestamptz, ${r.action}, ${vector}::vector, ${hash}::text)`
    }),
    sql`, `
  )
  const changed = await db.execute<{ action: Settled['action'] }>(sql`
    UPDATE resource r SET
      embedding = CASE v.action WHEN 'write' THEN v.embedding WHEN 'keep' THEN r.embedding END,
      embedding_model = CASE v.action WHEN 'drop' THEN NULL WHEN 'keep' THEN r.embedding_model ELSE ${key} END,
      embedding_hash = CASE v.action WHEN 'drop' THEN NULL WHEN 'keep' THEN r.embedding_hash ELSE v.hash END,
      embedding_due_at = NULL
    FROM (VALUES ${values}) AS v(id, due_at, action, embedding, hash)
    WHERE r.id = v.id AND r.embedding_due_at = v.due_at
    RETURNING v.action`)
  return changed.rows.map((r) => r.action)
}
