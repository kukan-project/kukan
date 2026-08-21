/**
 * The SQL a keyed (ii-b) version load uses, in one place.
 *
 * It lives here rather than in the tests because the spike tests, the purge
 * tests and the compaction benchmark all have to exercise *this* shape:
 * measuring one form and shipping another is how §11-2.1's numbers came to
 * describe a write path we had decided against (spec §11-2.4).
 *
 * Two properties are load-bearing and neither is obvious from the text:
 *
 * - **Two statements, one transaction.** DuckLake takes a single UPDATE/DELETE
 *   action per `MERGE`, so "upsert what the version has, delete what it does
 *   not" cannot be one statement. Wrapping them keeps one version = one
 *   snapshot, which every version-to-version diff depends on.
 * - **The value predicate.** Without `IS DISTINCT FROM`, `WHEN MATCHED`
 *   rewrites every matched row and the whole file with it — the storage
 *   difference between the two is 315x on append-mostly data. `MERGE` and
 *   `UPDATE` behave identically here; what picks the write path is only how
 *   many rows the statement touches (ducklake#462).
 */

/** Column list of the table being loaded, keys first is not required. */
export interface KeyedLoadShape {
  /** Table reference, e.g. `lake.t`. */
  table: string
  /** Relation holding the incoming version, e.g. `src` or a `read_parquet(…)`. */
  source: string
  /** Key columns — matched with `=`, so none of them may be NULL (spec §6.4). */
  keys: string[]
  /** Non-key columns to carry over. */
  values: string[]
}

const q = (c: string) => `"${c.replace(/"/g, '""')}"`

/**
 * The rows are the same row: every key column equal, on the two aliases the
 * caller gave them.
 *
 * **Shared with the diff** (`diff.ts`), which has to match rows exactly as the
 * load did — a `changedRows` count is by construction the set the load's
 * `WHEN MATCHED` would have updated, and two spellings of "the same row" make
 * that agreement a coincidence rather than a fact.
 */
export function keyMatchSql(keys: string[], left: string, right: string): string {
  return keys.map((k) => `${left}.${q(k)} = ${right}.${q(k)}`).join(' AND ')
}

/**
 * Something other than the key moved, or null when nothing could have: with no
 * value columns a row can only be added or removed, never changed.
 *
 * `IS DISTINCT FROM`, so a value that became null (or stopped being one) is a
 * change rather than an unknown — and, on the load side, so a matched row whose
 * values are unchanged is not rewritten, which is what keeps a five-row change
 * to five rows written (spec §11-2.4).
 */
export function valuesDifferSql(values: string[], left: string, right: string): string | null {
  if (values.length === 0) return null
  return values.map((c) => `${left}.${q(c)} IS DISTINCT FROM ${right}.${q(c)}`).join(' OR ')
}

/**
 * The upsert half. Updates only rows whose values actually differ, so a version
 * that changes five rows writes five rows.
 *
 * With no non-key columns — a one-column list of identifiers, or a code table
 * where the whole row is the key — there is nothing an update could carry, and
 * the update branch is left out entirely. Emitting it would be a parse error
 * (`WHEN MATCHED AND () THEN UPDATE SET`), and the diff agrees: with no value
 * columns to compare, a row can only be added or removed, never changed
 * (spec §7).
 */
export function keyedUpsertSql({ table, source, keys, values }: KeyedLoadShape): string {
  const on = keyMatchSql(keys, 't', 's')
  const cols = [...keys, ...values]
  const insert = `WHEN NOT MATCHED THEN INSERT (${cols.map(q).join(', ')})
    VALUES (${cols.map((c) => `s.${q(c)}`).join(', ')})`
  const changed = valuesDifferSql(values, 't', 's')
  if (changed === null) return `MERGE INTO ${table} AS t USING ${source} AS s ON ${on}\n  ${insert}`
  const set = values.map((c) => `${q(c)} = s.${q(c)}`).join(', ')
  return `MERGE INTO ${table} AS t USING ${source} AS s ON ${on}
  WHEN MATCHED AND (${changed}) THEN UPDATE SET ${set}
  ${insert}`
}

/** The delete half: rows the incoming version no longer carries. */
export function keyedDeleteSql({ table, source, keys }: KeyedLoadShape): string {
  const on = keyMatchSql(keys, 't', 's')
  return `MERGE INTO ${table} AS t USING ${source} AS s ON ${on}
  WHEN NOT MATCHED BY SOURCE THEN DELETE`
}

/**
 * Both halves in commit order. The caller wraps them in one transaction — it
 * owns the connection, and the tests and the benchmark drive different ones.
 */
export function keyedLoadSql(shape: KeyedLoadShape): [upsert: string, remove: string] {
  return [keyedUpsertSql(shape), keyedDeleteSql(shape)]
}
