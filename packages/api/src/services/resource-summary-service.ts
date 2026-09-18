/**
 * What an editor decides about an abstract (ADR-053 §10.2).
 *
 * Both operations are decisions later generation has to respect, which is why
 * they are written as state and not as an absence: text of one's own is marked
 * as a person's and never overwritten, and hidden survives the next run rather
 * than being undone by it. Deleting the text alone would not have held — the
 * pipeline would have written it again.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import { resource } from '@kukan/db'
import { NotFoundError, type ResourceSummaryMeta } from '@kukan/shared'

export interface SummaryUpdate {
  id: string
  packageId: string
  summary: string | null
  summaryMeta: ResourceSummaryMeta
  /**
   * Whether what a reader — and the embedding — sees has changed. Hiding an
   * abstract and rewriting one both change it; toggling hidden back on text
   * that was never there does not, and re-embedding for that would be work for
   * nothing.
   */
  embeddingChanged: boolean
}

/**
 * What this service can change, which is wider than what an editor may send.
 *
 * The route takes `hidden` alone (`resourceSummaryBodySchema`): the override is
 * withheld until the provenance it leaves behind is settled. The branch stays
 * here because the pipeline's guard — Summarize declines to overwrite an
 * abstract whose source is `human` — has no other way to be put in that state,
 * and a guard nothing can produce the state for is a guard nothing tests.
 */
export interface SetResourceSummaryInput {
  summary?: string | null
  hidden?: boolean
}

/**
 * Apply an editor's decision about an abstract.
 *
 * **The route reaches only the hiding half.** Overriding the text is withheld
 * (see {@link SetResourceSummaryInput}); what an editor can do through the API
 * is take a generated sentence off the page, which is the answer to one that
 * should not be there.
 */
export async function setResourceSummary(
  db: Database,
  id: string,
  input: SetResourceSummaryInput
): Promise<SummaryUpdate> {
  const [current] = await db
    .select({
      packageId: resource.packageId,
      summary: resource.summary,
      meta: resource.summaryMeta,
    })
    .from(resource)
    .where(and(eq(resource.id, id), eq(resource.state, 'active')))
    .limit(1)
  if (!current) throw new NotFoundError('Resource', id)

  const meta: ResourceSummaryMeta = { ...(current.meta ?? {}) }
  let summary = current.summary

  if (input.summary !== undefined) {
    summary = input.summary || null
    if (summary) {
      meta.source = 'human'
      meta.generatedAt = new Date().toISOString()
      // A person's text answers whatever the last run could not do, so the
      // reason it gave stops being the page's explanation.
      delete meta.skipReason
      // And it was not written by any generation
      delete meta.genKey
      delete meta.grounded
      delete meta.model
    } else {
      // Handed back to generation, which starts again from the material.
      delete meta.source
      delete meta.genKey
      delete meta.generatedAt
      delete meta.grounded
      delete meta.model
    }
  }

  if (input.hidden !== undefined) {
    if (input.hidden) meta.hidden = true
    else delete meta.hidden
  }

  // The mark rides with the write, not beside it: a crash between the two would
  // leave an edit the index has never heard of and nothing saying so. Hiding is
  // the case that matters — the projection takes a hidden abstract off the
  // document, and one that kept it answers searches with text somebody took
  // down (ADR-053 §9.3).
  await db
    .update(resource)
    .set({ summary, summaryMeta: meta, docSyncDueAt: sql`NOW()` })
    .where(eq(resource.id, id))

  const visibleBefore = current.meta?.hidden ? null : current.summary
  const visibleAfter = meta.hidden ? null : summary
  return {
    id,
    packageId: current.packageId,
    summary,
    summaryMeta: meta,
    embeddingChanged: visibleBefore !== visibleAfter,
  }
}
