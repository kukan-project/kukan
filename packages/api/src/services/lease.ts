/**
 * The one shape every row-held lease in this package tests: a timestamp
 * column that is either unset or older than the window.
 *
 * On the database clock, never the process's: the API and the worker both run
 * as several tasks, and a window opened by one task's clock and tested by
 * another's is as wide or as narrow as the two disagree.
 */

import { sql, type Column, type SQL } from 'drizzle-orm'

/**
 * @param column - the table's column, or — for raw SQL that reads it under an
 *   alias or out of a CTE — the reference spelled as SQL.
 */
export function leasePassed(column: string | Column, windowMs: number): SQL {
  const ref = typeof column === 'string' ? sql.raw(column) : sql`${column}`
  return sql`(${ref} IS NULL OR ${ref} <= now() - ${`${windowMs} milliseconds`}::interval)`
}
