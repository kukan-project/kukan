import type { GridRow, GridSheet, SheetLayout } from '@/pipeline/interpret/table/grid'

/** A sheet of a grid, its rows read and its layout taken. */
export type ReadSheet = Omit<GridSheet, 'rows' | 'layout'> & {
  rows: GridRow[]
  layout: SheetLayout
}

/** Every sheet a grid reader gives, each read to its end before the next is asked for. */
export async function collectGrid(sheets: AsyncIterable<GridSheet>): Promise<ReadSheet[]> {
  const read: ReadSheet[] = []
  for await (const { rows: stream, layout, ...sheet } of sheets) {
    const rows: GridRow[] = []
    for await (const row of stream) rows.push(row)
    read.push({ ...sheet, rows, layout: layout() })
  }
  return read
}
