/**
 * KUKAN Worker — Package Embedding (Phase 5a, ADR-034)
 * Generates the semantic-search embedding vector for one package from its
 * metadata (title / notes / tags) concatenated with its resources' metadata.
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { packageTable, resource, packageTag, tag } from '@kukan/db'
import type { AIAdapter } from '@kukan/ai-adapter'
import type { QueueAdapter } from '@kukan/queue-adapter'
import { EMBED_JOB_TYPE, type Logger } from '@kukan/shared'
import { MAX_EMBED_TEXT_LENGTH } from '../config'

export interface EmbedSource {
  title: string | null
  notes: string | null
  tags: string[]
  resources: Array<{ name: string | null; description: string | null }>
}

/** Build the embedding source text (truncated to MAX_EMBED_TEXT_LENGTH) */
export function buildEmbeddingText(source: EmbedSource): string {
  const parts = [
    source.title ?? '',
    source.notes ?? '',
    source.tags.join(' '),
    ...source.resources.map((r) => `${r.name ?? ''} ${r.description ?? ''}`.trim()),
  ]
  return parts.filter(Boolean).join('\n').slice(0, MAX_EMBED_TEXT_LENGTH)
}

export type EmbedPackageResult = 'embedded' | 'skipped' | 'cleared' | 'not-found'

/**
 * Embed one package. Skips when the source text and model are unchanged
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
      title: packageTable.title,
      notes: packageTable.notes,
      embeddingModel: packageTable.embeddingModel,
      embeddingHash: packageTable.embeddingHash,
    })
    .from(packageTable)
    .where(and(eq(packageTable.id, packageId), eq(packageTable.state, 'active')))
    .limit(1)
  if (!pkg) return 'not-found'

  const [tags, resources] = await Promise.all([
    db
      .select({ name: tag.name })
      .from(packageTag)
      .innerJoin(tag, eq(packageTag.tagId, tag.id))
      .where(eq(packageTag.packageId, packageId)),
    db
      .select({ name: resource.name, description: resource.description })
      .from(resource)
      .where(and(eq(resource.packageId, packageId), eq(resource.state, 'active'))),
  ])

  const text = buildEmbeddingText({
    title: pkg.title,
    notes: pkg.notes,
    tags: tags.map((t) => t.name),
    resources,
  })

  if (!text) {
    await db
      .update(packageTable)
      .set({ embedding: null, embeddingModel: null, embeddingHash: null })
      .where(eq(packageTable.id, packageId))
    return 'cleared'
  }

  const hash = createHash('sha256').update(text).digest('hex')
  if (pkg.embeddingHash === hash && pkg.embeddingModel === info.model) return 'skipped'

  const embedding = await ai.embed(text, { type: 'document' })
  await db
    .update(packageTable)
    .set({ embedding, embeddingModel: info.model, embeddingHash: hash })
    .where(eq(packageTable.id, packageId))
  return 'embedded'
}

const ENQUEUE_BATCH_SIZE = 100

/**
 * Enqueue embed jobs for every active package (used after a metadata reindex).
 * The per-package hash check makes this cheap for unchanged packages.
 * Batched-concurrent like PipelineService.enqueueAll — a sequential loop would
 * block the single-threaded worker for minutes at thousands of packages.
 */
export async function enqueueAllPackageEmbeds(
  db: Database,
  queue: QueueAdapter,
  log: Logger
): Promise<{ enqueued: number; failed: number }> {
  const rows = await db
    .select({ id: packageTable.id })
    .from(packageTable)
    .where(eq(packageTable.state, 'active'))

  let enqueued = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = rows.slice(i, i + ENQUEUE_BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map((row) => queue.enqueue(EMBED_JOB_TYPE, { packageId: row.id }))
    )
    results.forEach((result, j) => {
      if (result.status === 'fulfilled') {
        enqueued++
      } else {
        failed++
        log.error(
          { err: result.reason, packageId: batch[j].id },
          'Failed to enqueue embed-package job'
        )
      }
    })
  }
  return { enqueued, failed }
}
