import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpretCsv, type CsvStructure } from '@/pipeline/interpret/table/csv'

describe('interpretCsv with a given structure', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kukan-csv-given-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function interpret(content: string, structure: CsvStructure, skipRows = 0) {
    const csvPath = join(dir, 'in.csv')
    writeFileSync(csvPath, content)
    return interpretCsv(
      csvPath,
      join(dir, 'out.parquet'),
      skipRows,
      undefined,
      undefined,
      structure
    )
  }

  const names = (columns: { name: string }[]) => columns.map((c) => c.name)

  it('takes the first line for the header even when it reads like data', async () => {
    const csv = '2020,2021,2022\n1,2,3\n4,5,6\n'
    const given = await interpret(csv, 'given')
    expect(names(given.schema.columns)).toEqual(['2020', '2021', '2022'])
    expect(given.schema.rowCount).toBe(2)
  })

  it('keeps a sparse last row that the inferred structure takes for a note', async () => {
    const header = '地区,1月,2月,3月,4月,5月,6月,計'
    const rows = Array.from({ length: 6 }, (_, i) => `区${i},1,2,3,4,5,6,21`)
    const csv = [header, ...rows, '合計,,,,,,,126', ''].join('\n')

    const inferred = await interpret(csv, 'inferred')
    expect(inferred.schema.rowCount).toBe(6)

    const given = await interpret(csv, 'given')
    expect(given.schema.rowCount).toBe(7)
    expect(given.schema.droppedRows ?? 0).toBe(0)
  })

  it('refuses a broken row rather than reading it as a note', async () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8\n'
    const given = await interpret(csv, 'given')
    expect(given.schema.columns).toEqual([])
    expect(given.reason).toBe('ragged-rows')
  })

  it('has no rows to skip', async () => {
    await expect(interpret('a,b\n1,2\n', 'given', 1)).rejects.toThrow(/no rows to skip/)
  })
})
