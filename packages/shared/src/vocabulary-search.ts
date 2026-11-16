/**
 * KUKAN — what a table's column vocabulary puts in its search document
 * (ADR-073 Step 1c §4.1; experimental)
 */

import type { z } from 'zod'
import { columnVocabularySchema, type vocabularySearchSchema } from './pipeline-types'

/**
 * Top-level places a table has to cover to be nationwide: indexed as such, not
 * under each prefecture, where it would bury the data of that area (§4.2). Set
 * for Japan's 47 prefectures, the one pack there is; a second pack decides
 * whether it becomes the pack's to say.
 */
export const NATIONWIDE_ROOTS = 40

/** The `area_roots` value of a nationwide table. */
export const NATIONWIDE = '*'

export type VocabularySearchFields = z.infer<typeof vocabularySearchSchema>

/**
 * The search fields of a table's column vocabularies, as its profile holds
 * them: decided ones only, over every column together. Top-level places are
 * roots and never places; a table whose columns cover most of them is
 * nationwide, whichever column covers them. A field with nothing is left out.
 */
export function vocabularySearchFields(
  vocabularies: readonly unknown[] | null | undefined
): VocabularySearchFields {
  const meanings = new Set<string>()
  const roots = new Set<string>()
  const places = new Set<string>()
  for (const raw of vocabularies ?? []) {
    const parsed = columnVocabularySchema.safeParse(raw)
    if (!parsed.success || parsed.data.alternatives || !parsed.data.kind) continue
    const v = parsed.data
    meanings.add(`${v.concept}:${v.kind}`)
    for (const r of v.roots ?? []) roots.add(r)
    for (const p of v.places ?? []) places.add(p)
  }
  for (const r of roots) places.delete(r)
  const nationwide = roots.size >= NATIONWIDE_ROOTS
  const sorted = (set: Set<string>) => [...set].sort()
  return {
    ...(meanings.size > 0 && { vocab_meanings: sorted(meanings) }),
    ...(roots.size > 0 && { area_roots: nationwide ? [NATIONWIDE] : sorted(roots) }),
    ...(places.size > 0 && !nationwide && { area_places: sorted(places) }),
  }
}
