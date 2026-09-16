/**
 * KUKAN Worker — Package Embedding (Phase 5a, ADR-034)
 * Generates the semantic-search embedding vector for one package from its
 * metadata (title / notes / tags) concatenated with its resources' metadata,
 * the sections they are drawn under included (ADR-050).
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, packageTag, tag } from '@kukan/db'
import { type AIAdapter, embeddingKey } from '@kukan/ai-adapter'
import type { Logger } from '@kukan/shared'
import { MAX_EMBED_TEXT_LENGTH } from '../config'

export interface EmbedSource {
  title: string | null
  notes: string | null
  tags: string[]
  resources: Array<{
    name: string | null
    description: string | null
    section: string | null
    /** The abstract, null when there is none or an editor hid it (ADR-053) */
    summary?: string | null
  }>
}

/**
 * Build the embedding source text (truncated to MAX_EMBED_TEXT_LENGTH).
 *
 * The abstracts go second, ahead of the resource names and descriptions, which
 * is what decides what is lost when a package is too big to fit: the
 * descriptions, which are the most likely to repeat what is already above them
 * (ADR-053 §8). Measured, the budget is not reached — 196 characters on
 * average — so this is the safety net for a dataset with a hundred files.
 *
 * The abstracts are also the reason the cut moved off the character count: they
 * are whole sentences, and a hard slice ends one mid-word.
 */
export function buildEmbeddingText(source: EmbedSource): string {
  const parts = [
    source.title ?? '',
    source.notes ?? '',
    source.tags.join(' '),
    // Each section once: a label names a run of resources, not each of them
    [...new Set(source.resources.map((r) => r.section).filter(Boolean))].join(' '),
    ...source.resources.map((r) => r.summary ?? ''),
    ...source.resources.map((r) => r.name ?? ''),
    ...source.resources.map((r) => r.description ?? ''),
  ]
  return truncateAtBoundary(parts.filter(Boolean).join('\n'), MAX_EMBED_TEXT_LENGTH)
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
 * Embed one package. Skips when the source text and model key are unchanged
 * (embedding_hash comparison); clears the vector when there is nothing to embed.
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
    .select({
      state: packageTable.state,
      title: packageTable.title,
      notes: packageTable.notes,
      embeddingModel: packageTable.embeddingModel,
      embeddingHash: packageTable.embeddingHash,
    })
    .from(packageTable)
    .where(eq(packageTable.id, packageId))
    .limit(1)
  if (!pkg) return 'not-found'
  // Drafts are embedded at publish (ADR-039); deleted packages never
  if (pkg.state !== 'active') return 'skipped'

  // Stable ordering — the hash is computed over the joined text, so an
  // unspecified row order would re-embed unchanged packages on every reindex
  const [tags, resources] = await Promise.all([
    db
      .select({ name: tag.name })
      .from(packageTag)
      .innerJoin(tag, eq(packageTag.tagId, tag.id))
      .where(eq(packageTag.packageId, packageId))
      .orderBy(tag.name),
    db
      .select({
        name: resource.name,
        description: resource.description,
        section: resource.section,
        summary: resource.summary,
        summaryMeta: resource.summaryMeta,
      })
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active')))
      .orderBy(resource.position, resource.created, resource.id),
  ])

  const text = buildEmbeddingText({
    title: pkg.title,
    notes: pkg.notes,
    tags: tags.map((t) => t.name),
    resources: resources.map((r) => ({
      ...r,
      // An editor who hid an abstract hid it from the search too: it is off the
      // page, and a vector still pulled toward it is the version of "hidden"
      // nobody can see or check. Decided here rather than in SQL — the row is
      // read either way, and the column is never filtered on (ADR-053 §4.1).
      summary: r.summaryMeta?.hidden ? null : r.summary,
    })),
  })

  if (!text) {
    await db
      .update(packageTable)
      .set({ embedding: null, embeddingModel: null, embeddingHash: null })
      .where(eq(packageTable.id, packageId))
    return 'cleared'
  }

  const key = embeddingKey(info)
  const hash = createHash('sha256').update(text).digest('hex')
  if (pkg.embeddingHash === hash && pkg.embeddingModel === key) return 'skipped'

  const embedding = await ai.embed(text, { type: 'document' })
  await db
    .update(packageTable)
    .set({ embedding, embeddingModel: key, embeddingHash: hash })
    .where(eq(packageTable.id, packageId))
  return 'embedded'
}
