/**
 * KUKAN Worker — Resource Embedding (ADR-034 / ADR-054)
 *
 * Generates one semantic-search vector per resource of a package, from the
 * package's title and tags followed by the resource's own
 * (section / name / description / abstract). The job is still enqueued per
 * package — the debounce lives there (EMBED_DEBOUNCE_MS) — and now embeds that
 * package's resources.
 *
 * **Why the resource and not the package (ADR-054).** A vector of a package's
 * resources concatenated is a centroid, and a centroid holds no per-resource
 * score: it cannot say which of nineteen sheets a query is about, and the
 * further apart the sheets are the less it resembles any of them. One vector
 * per resource lets a hit name the table, and puts the package at its closest
 * resource's position.
 */

import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, packageTag, tag } from '@kukan/db'
import { type AIAdapter, embeddingKey } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { EMBED_BATCH_SIZE, EMBED_RESOURCE_RESERVE_CHARS, MAX_EMBED_TEXT_LENGTH } from '../config'

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

export type EmbedPackageResult = 'embedded' | 'skipped' | 'cleared' | 'not-found'

/**
 * Embed one package's resources. A resource whose text and model key are
 * unchanged is left alone (embedding_hash); one with nothing to embed has its
 * vector cleared. Reports what happened to any of them: `embedded` if one was,
 * else `cleared` if one was, else `skipped`.
 */
export async function embedPackage(
  packageId: string,
  db: Database,
  ai: AIAdapter,
  log: Logger
): Promise<EmbedPackageResult> {
  const info = ai.getEmbeddingInfo()
  if (!info) {
    log.warn({ packageId }, 'Embed job received but embedding is unavailable')
    return 'skipped'
  }

  const [pkg] = await db
    .select({ state: packageTable.state, title: packageTable.title })
    .from(packageTable)
    .where(eq(packageTable.id, packageId))
    .limit(1)
  if (!pkg) return 'not-found'
  // Drafts are embedded at publish (ADR-039); deleted packages never
  if (pkg.state !== 'active') return 'skipped'

  // Stable ordering — the tags join the hashed text, so an unspecified order
  // would re-embed unchanged resources on every reindex
  const [tags, resources] = await Promise.all([
    db
      .select({ name: tag.name })
      .from(packageTag)
      .innerJoin(tag, eq(packageTag.tagId, tag.id))
      .where(eq(packageTag.packageId, packageId))
      .orderBy(tag.name),
    db
      .select({
        id: resource.id,
        name: resource.name,
        description: resource.description,
        section: resource.section,
        summary: resource.summary,
        summaryMeta: resource.summaryMeta,
        embeddingModel: resource.embeddingModel,
        embeddingHash: resource.embeddingHash,
      })
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
      .orderBy(resource.position, resource.created, resource.id),
  ])

  const key = embeddingKey(info)
  // The package's context is in every resource's text, so editing a title or
  // a tag re-embeds all of the package's resources, not one — N calls where
  // the package vector cost one. Accepted in ADR-054 decision 3: the context
  // is what makes「13_shisetsu.csv」findable at all, and the debounce keeps a
  // burst of edits to one run per minute.
  const context = { title: pkg.title, tags: tags.map((t) => t.name) }
  const pending: Array<{ id: string; text: string; hash: string }> = []
  const toClear: string[] = []
  for (const r of resources) {
    const text = buildResourceEmbeddingText({
      ...context,
      section: r.section,
      name: r.name,
      description: r.description,
      // An editor who hid an abstract hid it from the search too: it is off the
      // page, and a vector still pulled toward it is the version of "hidden"
      // nobody can see or check. Decided here rather than in SQL — the row is
      // read either way, and the column is never filtered on (ADR-053 §4.1).
      summary: r.summaryMeta?.hidden ? null : r.summary,
    })
    if (!text) {
      if (r.embeddingModel !== null) toClear.push(r.id)
      continue
    }
    const hash = createHash('sha256').update(text).digest('hex')
    if (r.embeddingHash === hash && r.embeddingModel === key) continue
    pending.push({ id: r.id, text, hash })
  }

  if (toClear.length > 0) {
    await db
      .update(resource)
      .set({ embedding: null, embeddingModel: null, embeddingHash: null })
      .where(inArray(resource.id, toClear))
  }
  if (pending.length === 0) return toClear.length > 0 ? 'cleared' : 'skipped'

  // Fixed-size batches, each written back before the next (EMBED_BATCH_SIZE):
  // one statement per batch, as the embed call is one — a many-sheet package
  // is otherwise a round trip and a commit per sheet
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE)
    const vectors = await ai.embedBatch(
      batch.map((p) => p.text),
      { type: 'document' }
    )
    const values = sql.join(
      batch.map((p, j) => sql`(${p.id}::uuid, ${JSON.stringify(vectors[j])}::vector, ${p.hash})`),
      sql`, `
    )
    await db.execute(sql`
      UPDATE ${resource} SET embedding = v.embedding, embedding_model = ${key}, embedding_hash = v.hash
      FROM (VALUES ${values}) AS v(id, embedding, hash)
      WHERE ${resource.id} = v.id`)
  }
  return 'embedded'
}
