import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gridSheet,
  type CellRange,
  type GridCell,
  type GridRow,
  type GridSheet,
} from '@/pipeline/interpret/table/grid'
import {
  columnLetters,
  judgePlainTable,
  type PlainTableJudgment,
} from '@/pipeline/interpret/table/plain-table'
import { xlsxGrid } from '@/pipeline/interpret/table/xlsx-grid'
import { xlsGrid } from '@/pipeline/interpret/table/xls-grid'
import { xlsxBuffer } from '../../../test-helpers/xlsx'
import { biff, compoundFile, xlsBuffer } from '../../../test-helpers/legacy-office'

/** A cell: a string is text, a number a number, `{ date }` a date; null or '' is empty. */
type Value = string | number | null | { date: string } | { bool: boolean }

interface SheetOptions {
  name?: string
  hidden?: boolean
  /** Column of each row's first value. */
  startCol?: number
  merges?: CellRange[]
  frozenRows?: number
  printTitleRows?: [number, number]
  uncachedFormulas?: number
}

function cellOf(col: number, value: Value): GridCell | undefined {
  if (value === null || value === '') return undefined
  if (typeof value === 'number') return { col, kind: 'number', value: String(value) }
  if (typeof value === 'string') return { col, kind: 'text', value }
  if ('date' in value) return { col, kind: 'date', value: value.date }
  return { col, kind: 'boolean', value: value.bool ? 'TRUE' : 'FALSE' }
}

function sheet(rows: Value[][], opts: SheetOptions = {}, index = 1): GridSheet {
  const start = opts.startCol ?? 1
  return gridSheet(
    {
      sheet: index,
      name: opts.name ?? `Sheet${index}`,
      hidden: opts.hidden ?? false,
      ...(opts.printTitleRows && { printTitles: { rows: opts.printTitleRows } }),
    },
    (layout) => {
      layout.merges.push(...(opts.merges ?? []))
      if (opts.frozenRows) layout.frozen = { rows: opts.frozenRows, columns: 0 }
      layout.uncachedFormulas = opts.uncachedFormulas ?? 0
      const out: GridRow[] = []
      rows.forEach((values, r) => {
        const cells = values
          .map((v, c) => cellOf(start + c, v))
          .filter((c): c is GridCell => c !== undefined)
        if (cells.length > 0) out.push({ row: r + 1, cells })
      })
      return out
    }
  )
}

async function* book(...sheets: GridSheet[]): AsyncGenerator<GridSheet> {
  yield* sheets
}

const judge = (...sheets: GridSheet[]): Promise<PlainTableJudgment> =>
  judgePlainTable(book(...sheets))

/** A list of n rows under a header: a name, a number and a date. */
function list(n: number): Value[][] {
  return [
    ['名称', '人数', '日付'],
    ...Array.from({ length: n }, (_, i): Value[] => [
      `施設${i + 1}`,
      i * 10,
      { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` },
    ]),
  ]
}

function reasons(judgment: PlainTableJudgment): string[] {
  return 'reasons' in judgment ? judgment.reasons : []
}

describe('a plain table', () => {
  it('is read from its header to its last row', async () => {
    expect(await judge(sheet(list(10), { name: '一覧' }))).toEqual({
      reading: {
        sheet: '一覧',
        sheetNumber: 1,
        from: 'A1',
        to: 'C11',
        headerRows: 1,
        columnNames: ['名称', '人数', '日付'],
        range: { top: 1, left: 1, bottom: 11, right: 3 },
      },
    })
  })

  it('leaves titles above it and notes below it out of the range', async () => {
    const rows: Value[][] = [
      ['施設の一覧'],
      ['（令和7年4月1日現在）'],
      [],
      ...list(10),
      ['注：人数は定員'],
      [],
      ['資料：市'],
    ]
    const judgment = await judge(
      sheet(rows, { merges: [{ top: 1, left: 1, bottom: 1, right: 3 }] })
    )
    expect(judgment).toMatchObject({ reading: { from: 'A4', to: 'C14' } })
  })

  it('starts where the table starts, not at A1', async () => {
    const judgment = await judge(sheet([[], ...list(8)], { startCol: 2 }))
    expect(judgment).toMatchObject({ reading: { from: 'B2', to: 'D10' } })
  })

  it('reads hidden columns inside the range', async () => {
    const judgment = await judge(
      gridSheet({ sheet: 1, name: 's', hidden: false }, (layout) => {
        layout.hiddenColumns.push([2, 2])
        return [
          {
            row: 1,
            cells: ['a', 'b', 'c'].map((v, i) => ({ col: i + 1, kind: 'text' as const, value: v })),
          },
          ...Array.from({ length: 8 }, (_, r) => ({
            row: r + 2,
            cells: [1, 2, 3].map((col) => ({
              col,
              kind: 'number' as const,
              value: String(r * col),
            })),
          })),
        ]
      })
    )
    expect(judgment).toMatchObject({ reading: { from: 'A1', to: 'C9' } })
  })

  it('takes the one table sheet among a cover, an empty sheet and a hidden one', async () => {
    const judgment = await judge(
      sheet([['表紙'], ['市']], { name: 'cover' }, 1),
      sheet([], {}, 2),
      sheet(list(10), { name: 'data' }, 3),
      sheet(list(10), { name: 'work', hidden: true }, 4)
    )
    expect(judgment).toMatchObject({ reading: { sheet: 'data' } })
  })

  it('reads a text column with a no-value mark at its bottom', async () => {
    const rows = [...list(10), ['施設11', '－', { date: '2026-02-01' }]]
    expect(await judge(sheet(rows))).toMatchObject({ reading: { to: 'C12' } })
  })

  it('agrees with the frozen pane and print titles on the header row', async () => {
    const rows = [['表題'], ...list(10)]
    expect(await judge(sheet(rows, { frozenRows: 2, printTitleRows: [2, 2] }))).toMatchObject({
      reading: { from: 'A2' },
    })
  })

  it('writes column names trimmed and with a line break as a space, but compares them folded', async () => {
    const rows: Value[][] = [['　名称 ', '人数\n（人）', 'ＡＢＣ'], ...list(8).slice(1)]
    expect(await judge(sheet(rows))).toMatchObject({
      reading: { columnNames: ['名称', '人数 （人）', 'ＡＢＣ'] },
    })
    const dup: Value[][] = [['ＡＢＣ', 'ABC', 'x'], ...list(8).slice(1)]
    expect(reasons(await judge(sheet(dup)))).toContain('header-duplicate')
    // And by ASCII case, as DuckDB compares column names
    const cased: Value[][] = [['ID', 'id', 'x'], ...list(8).slice(1)]
    expect(reasons(await judge(sheet(cased)))).toContain('header-duplicate')
    const accented: Value[][] = [['Äb', 'äb', 'x'], ...list(8).slice(1)]
    expect(reasons(await judge(sheet(accented)))).not.toContain('header-duplicate')
  })
})

describe('not a plain table', () => {
  it('no-table: no sheet holds a table', async () => {
    expect(await judge(sheet([]), sheet(list(10), { hidden: true }))).toEqual({
      reasons: ['no-table'],
    })
  })

  it('no-table: a sheet of prose', async () => {
    const prose = Array.from({ length: 30 }, (_, i): Value[] => [`第${i}条 本文の文章`])
    expect(await judge(sheet(prose))).toEqual({ reasons: ['no-table'] })
  })

  it('multiple-sheets', async () => {
    expect(await judge(sheet(list(10), {}, 1), sheet(list(10), {}, 2))).toEqual({
      reasons: ['multiple-sheets'],
    })
  })

  it('title-or-footer: a row of two values above the table', async () => {
    const rows: Value[][] = [['表題', '令和7年'], [], ...list(10)]
    expect(reasons(await judge(sheet(rows)))).toEqual(['title-or-footer'])
  })

  it('title-or-footer: a total label under a numeric column', async () => {
    const rows: Value[][] = [
      ['名称', '人数', '定員'],
      ...list(10)
        .slice(1)
        .map((r) => [r[0], 1, 2]),
    ]
    rows.push(['合計', '計', 20])
    expect(reasons(await judge(sheet(rows)))).toEqual(['title-or-footer'])
  })

  it('header-blank', async () => {
    const rows: Value[][] = [['名称', null, '日付'], ...list(10).slice(1)]
    expect(reasons(await judge(sheet(rows)))).toEqual(['header-blank'])
  })

  it('header-blank and not-rectangular: an empty top-left header cell over row labels', async () => {
    const rows: Value[][] = [[null, '人数', '日付'], ...list(10).slice(1)]
    expect(reasons(await judge(sheet(rows)))).toEqual(['header-blank', 'not-rectangular'])
  })

  it('header-not-text: years as columns', async () => {
    const rows: Value[][] = [
      ['区分', 2023, 2024],
      ...Array.from({ length: 10 }, (_, i) => [`区${i}`, i, i]),
    ]
    expect(reasons(await judge(sheet(rows)))).toEqual(['header-not-text'])
  })

  it('multi-row-header: a second header row looks like the first data row', async () => {
    const rows: Value[][] = [
      ['名称', '人数', '日付'],
      ['', '（人）', '（日）'],
      ...list(10).slice(1),
    ]
    expect(reasons(await judge(sheet(rows)))).toEqual(['multi-row-header'])
  })

  it('multi-row-header and merged-cells: a merge on the first data row', async () => {
    const merges = [{ top: 2, left: 1, bottom: 3, right: 1 }]
    expect(reasons(await judge(sheet(list(10), { merges })))).toEqual([
      'multi-row-header',
      'merged-cells',
    ])
  })

  it('multi-row-header: the frozen pane or print titles end below the header', async () => {
    expect(reasons(await judge(sheet(list(10), { frozenRows: 2 })))).toEqual(['multi-row-header'])
    expect(reasons(await judge(sheet(list(10), { printTitleRows: [1, 2] })))).toEqual([
      'multi-row-header',
    ])
  })

  it('merged-cells: a merge among the data', async () => {
    const merges = [{ top: 5, left: 2, bottom: 5, right: 3 }]
    expect(reasons(await judge(sheet(list(10), { merges })))).toEqual(['merged-cells'])
  })

  it('not-rectangular and header-blank: a value right of the header', async () => {
    const rows = list(10)
    rows[4] = [...rows[4]!, 'メモ']
    expect(reasons(await judge(sheet(rows)))).toEqual(['header-blank', 'not-rectangular'])
  })

  it('section-rows', async () => {
    const rows = [...list(10)]
    rows.splice(5, 0, ['〈北部〉'])
    expect(reasons(await judge(sheet(rows)))).toEqual(['section-rows'])
  })

  it('multiple-tables: the header again further down', async () => {
    const rows = [...list(10), ...list(10)]
    expect(reasons(await judge(sheet(rows)))).toEqual(['multiple-tables'])
  })

  it('multiple-tables: two tables side by side', async () => {
    const rows = list(10).map((r) => [...r, ...r])
    expect(reasons(await judge(sheet(rows)))).toEqual(['header-duplicate', 'multiple-tables'])
  })

  it('multiple-tables and title-or-footer: two blocks of the same size', async () => {
    const rows = [
      ...list(10),
      [],
      ...list(10).map((r) => r.map((v) => (typeof v === 'string' ? `${v}'` : v))),
    ]
    expect(reasons(await judge(sheet(rows)))).toEqual(['title-or-footer', 'multiple-tables'])
  })

  it('uncached-formulas', async () => {
    expect(reasons(await judge(sheet(list(10), { uncachedFormulas: 1 })))).toEqual([
      'uncached-formulas',
    ])
  })

  it('too-small: a header with no data', async () => {
    const rows: Value[][] = [['表題'], ...Array.from({ length: 20 }, (_, i) => [i]), [], ['a', 'b']]
    expect(reasons(await judge(sheet(rows)))).toContain('too-small')
  })

  it('every reason it hits, in order', async () => {
    const rows: Value[][] = [['表題', 'x'], [], ['名称', null, 2024], ...list(10).slice(1)]
    expect(reasons(await judge(sheet(rows, { uncachedFormulas: 2 })))).toEqual([
      'title-or-footer',
      'header-blank',
      'header-not-text',
      'uncached-formulas',
    ])
  })
})

describe('from an XLSX', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plain-table-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a plain table the grid reader gives', async () => {
    const path = join(dir, 'book.xlsx')
    const header = ['<si><t>名称</t></si>', '<si><t>人数</t></si>', '<si><t>表題</t></si>']
    const rows = [
      [{ s: 2 }],
      [],
      [{ s: 0 }, { s: 1 }],
      ...Array.from({ length: 20 }, (_, i) => [i, i * 2]),
    ]
    await writeFile(path, await xlsxBuffer({ shared: header, sheets: { 1: rows } }))
    expect(await judgePlainTable(xlsxGrid(path))).toMatchObject({
      reading: { from: 'A3', to: 'B23', columnNames: ['名称', '人数'] },
    })
  })
})

describe('an encrypted workbook', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plain-table-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is a reason, not a failure: an XLS with a password to open it', async () => {
    const path = join(dir, 'book.xls')
    await writeFile(
      path,
      xlsBuffer({ globals: [biff(0x002f, Buffer.alloc(6))], sheets: [{ name: 's', cells: [] }] })
    )
    expect(await judgePlainTable(xlsGrid(path))).toEqual({ reasons: ['encrypted'] })
  })

  it('and an XLSX, which encrypted is a compound file holding the package', async () => {
    const path = join(dir, 'book.xlsx')
    await writeFile(
      path,
      compoundFile({ EncryptionInfo: Buffer.alloc(64), EncryptedPackage: Buffer.alloc(64) })
    )
    expect(await judgePlainTable(xlsGrid(path))).toEqual({ reasons: ['encrypted'] })
  })
})

describe('columnLetters', () => {
  it('writes a column as Excel does', () => {
    expect([1, 26, 27, 52, 703, 16384].map(columnLetters)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'AAA',
      'XFD',
    ])
  })
})
