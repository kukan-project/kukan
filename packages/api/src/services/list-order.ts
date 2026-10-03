import { asc, desc, type AnyColumn, type SQLWrapper } from 'drizzle-orm'

/**
 * ORDER BY for an organization or group listing: the field asked for, then the
 * name, which settles ties and is the order when nothing is asked. A count
 * reads largest first unless told otherwise.
 */
export function orderTerms(
  orderBy: 'name' | 'title' | 'datasetCount' | undefined,
  sortOrder: 'asc' | 'desc' | undefined,
  columns: { name: AnyColumn; title: AnyColumn; datasetCount: SQLWrapper }
) {
  const dir = sortOrder ?? (orderBy === 'datasetCount' ? 'desc' : 'asc')
  const by = (column: AnyColumn | SQLWrapper) => (dir === 'asc' ? asc : desc)(column)
  if (!orderBy || orderBy === 'name') return [by(columns.name)]
  return [by(columns[orderBy]), asc(columns.name)]
}
