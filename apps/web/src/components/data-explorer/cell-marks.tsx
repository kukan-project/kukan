'use client'

import { createContext } from 'react'

/**
 * Cells a screen around the preview wants marked — the Table settings tab's
 * values a type being chosen would not convert. A context rather than a prop:
 * the preview is drawn through several layers that have no part in it.
 */
export interface CellMarks {
  /** The cells of these rows to mark, as {@link cellKey}s */
  judge(rows: Record<string, string>[]): Promise<Set<string>>
  /** What a marked cell says on hover */
  title: string
}

export const CellMarksContext = createContext<CellMarks | null>(null)

/** A cell, by its row on the page and its column. */
export const cellKey = (row: number, column: string) => `${row}\u0000${column}`
