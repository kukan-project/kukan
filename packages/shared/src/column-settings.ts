/**
 * The settled column layer — what a person decided about a resource's columns
 * (ADR-043 layer 2 / Phase ii-b, spec §6.1).
 *
 * Everything else KUKAN holds about columns is *inferred*: the interpretation
 * re-derives `resource_version.schema` on every run (ADR-029, ADR-046). This is
 * the other half, and the two must not share a home — a re-interpretation
 * rewrites what it inferred, and would take a person's decision with it.
 *
 * **Held on the resource, frozen onto the version.** The resource carries the
 * setting to apply to versions from here on; a version carries the setting it
 * was created under (`lake_key_columns`), because "how was this version read"
 * is a question only the version can answer once the setting moves on. That is
 * the same pair `format` already forms (ADR-046 §6).
 *
 * ii-b puts the primary key here. ii-c adds settled types as `types` on the same
 * object (spec §6.2), which is why this is an object and not an array of columns.
 */
import { z } from 'zod'

/**
 * A resource's settled column information. Empty is the ordinary state — most
 * resources never get a key.
 */
export const columnSettingsSchema = z.object({
  /**
   * The columns whose values identify a row, in the order the person chose
   * (a composite key's order is stable in the picker and in what the version
   * freezes). **Absent, never empty**: "no key set" and "the key is empty" are
   * the same state, so it has one spelling: the schema refuses an empty array on
   * the way in, and readers ask whether the field is there rather than whether
   * it has entries.
   */
  primaryKey: z.array(z.string()).nonempty().optional(),
})
export type ColumnSettings = z.infer<typeof columnSettingsSchema>

/**
 * A stored key column list, in the one spelling readers may assume: a list with
 * entries, or null.
 *
 * The empty check is against what the database holds, not what the schema
 * allows: `$type` is a cast, and a row written before the schema or by hand can
 * still carry `[]`. Every reader downstream of here — {@link sameKeyColumns},
 * the keyed load, the keyed diff — is written against "null or a real key", and
 * an `[]` that reaches them is a key with no columns: a `MERGE` with an empty
 * `ON`, or two versions declared to share a key they do not have.
 *
 * So the two representations collapse where the value is read out of a row,
 * once, rather than in each reader's own guard.
 */
export function keyColumnsOf(columns: string[] | null | undefined): string[] | null {
  return columns === undefined || columns === null || columns.length === 0 ? null : columns
}

/** The key columns a setting names, or null when it names none. */
export function primaryKeyOf(settings: ColumnSettings | null | undefined): string[] | null {
  return keyColumnsOf(settings?.primaryKey)
}

/**
 * Whether two versions were read under the same key, which is what lets a diff
 * match their rows (spec §7).
 *
 * **Order-sensitive, though the order carries no meaning.** Every operation that
 * uses a key ands its columns together — the load's `MERGE ON`, the diff's
 * `FULL OUTER JOIN`, the uniqueness count — so `[a, b]` and `[b, a]` are the
 * same comparison over the same rows. What this compares is the declared key as
 * a record, not what it does: a version froze a list, and answering that a
 * differently-ordered list is the same one would let the stored order change
 * with no version saying it had.
 *
 * The cost of the strictness is that reordering a key issues a version and
 * degrades the diff across it, for no change in behaviour. Nothing reorders a
 * key on its own, so this only reaches someone who retypes one.
 */
export function sameKeyColumns(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((column, i) => column === b[i])
}

/**
 * The key two versions were **both** read under, or null when they were not
 * read under the same one.
 *
 * The question every operation that puts one version's rows against another's
 * has to ask before it can match them: the ingest, of the contents it writes
 * onto (spec §6.6), and the diff, of the two ends it compares (spec §7). Rows
 * matched under one rule and counted against rows identified by another give a
 * number belonging to neither, so both degrade to comparing whole rows instead.
 *
 * One function because the two must not answer differently, and because
 * "compare, then pick a side" is the step that is easy to write as "pick a
 * side" — which is a keyed comparison across a key change.
 */
export function sharedKeyColumns(a: string[] | null, b: string[] | null): string[] | null {
  return sameKeyColumns(a, b) ? a : null
}
