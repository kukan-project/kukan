import type { ColumnFilter, DuckDBQueryParams } from './use-duckdb'

export function parquetFileName(resourceId: string): string {
  return `preview_${resourceId}.parquet`
}

/** Escape for DuckDB standard string literals ('...'). Only single quotes need escaping. */
export function escapeSQL(value: string): string {
  return value.replace(/'/g, "''")
}

/** Escape for ILIKE patterns with ESCAPE '$'. Escapes $, %, _ in the pattern. */
export const LIKE_ESCAPE_CHAR = '$'
export function escapeLike(value: string): string {
  // '$$$$' in replace() produces literal '$$' (JS replace special: $$ → $)
  return escapeSQL(value).replace(/\$/g, '$$$$').replace(/%/g, '$%').replace(/_/g, '$_')
}

export function quoteColumn(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export function buildWhereClause(
  columns: string[],
  filters?: ColumnFilter[],
  searchKeyword?: string
): string {
  const conditions: string[] = []
  const columnSet = new Set(columns)

  if (filters) {
    for (const f of filters) {
      if (!columnSet.has(f.column) || !f.value) continue
      const col = quoteColumn(f.column)
      const val = escapeSQL(f.value)
      switch (f.operator) {
        case 'eq':
          conditions.push(`CAST(${col} AS VARCHAR) = '${val}'`)
          break
        case 'neq':
          conditions.push(`CAST(${col} AS VARCHAR) != '${val}'`)
          break
        case 'contains':
          conditions.push(
            `CAST(${col} AS VARCHAR) ILIKE '%${escapeLike(f.value)}%' ESCAPE '${LIKE_ESCAPE_CHAR}'`
          )
          break
        case 'starts_with':
          conditions.push(
            `CAST(${col} AS VARCHAR) ILIKE '${escapeLike(f.value)}%' ESCAPE '${LIKE_ESCAPE_CHAR}'`
          )
          break
        case 'ends_with':
          conditions.push(
            `CAST(${col} AS VARCHAR) ILIKE '%${escapeLike(f.value)}' ESCAPE '${LIKE_ESCAPE_CHAR}'`
          )
          break
      }
    }
  }

  if (searchKeyword) {
    const escaped = escapeLike(searchKeyword)
    const colConditions = columns.map(
      (c) => `CAST(${quoteColumn(c)} AS VARCHAR) ILIKE '%${escaped}%' ESCAPE '${LIKE_ESCAPE_CHAR}'`
    )
    conditions.push(`(${colConditions.join(' OR ')})`)
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
}

export function buildQuery(
  fileName: string,
  columns: string[],
  params: DuckDBQueryParams
): { dataSQL: string; countSQL: string } {
  const where = buildWhereClause(columns, params.filters, params.searchKeyword)
  const orderBy =
    params.sort && new Set(columns).has(params.sort.column)
      ? `ORDER BY ${quoteColumn(params.sort.column)} ${params.sort.direction === 'DESC' ? 'DESC' : 'ASC'}`
      : ''
  const offset = params.page * params.pageSize

  const dataSQL = `SELECT * FROM '${fileName}' ${where} ${orderBy} LIMIT ${params.pageSize} OFFSET ${offset}`
  const countSQL = `SELECT COUNT(*) AS cnt FROM '${fileName}' ${where}`

  return { dataSQL, countSQL }
}
