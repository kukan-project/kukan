import JSZip from 'jszip'

/**
 * An XLSX of the parts its text comes from: the shared strings, and each
 * sheet's rows of cells. A cell is a number, or `{ s: n }` for the nth shared
 * string, or `{ inline: text }`, or `{ empty: true }` for one formatted but
 * empty; a row may be empty. `tabs` writes the workbook with its sheets in
 * that order, its relationships pointing at them through `target` (by default
 * `worksheets/`), and `raw` a sheet's XML as given.
 */
type Cell = number | { s: number } | { inline: string } | { empty: true }

function cellXml(cell: Cell): string {
  if (typeof cell === 'number') return `<c><v>${cell}</v></c>`
  if ('s' in cell) return `<c t="s"><v>${cell.s}</v></c>`
  if ('empty' in cell) return `<c s="1"/>`
  return `<c t="inlineStr"><is><t>${cell.inline}</t></is></c>`
}

export async function xlsxBuffer(opts: {
  shared?: string[]
  sheets: Record<number, Cell[][]>
  tabs?: number[]
  target?: string
  raw?: Record<number, string>
}): Promise<Buffer> {
  const zip = new JSZip()
  if (opts.shared) {
    zip.file(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${opts.shared.join('')}</sst>`
    )
  }
  for (const [n, rows] of Object.entries(opts.sheets)) {
    const xml = rows
      .map((cells, r) => `<row r="${r + 1}">${cells.map(cellXml).join('')}</row>`)
      .join('')
    zip.file(
      `xl/worksheets/sheet${n}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`
    )
  }
  for (const [n, xml] of Object.entries(opts.raw ?? {}))
    zip.file(`xl/worksheets/sheet${n}.xml`, xml)
  if (opts.tabs) {
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${opts.tabs
        .map((n) => `<sheet name="s${n}" sheetId="${n}" r:id="rId${n}"/>`)
        .join('')}</sheets></workbook>`
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.tabs
        .map(
          (n) =>
            `<Relationship Id="rId${n}" Target="${opts.target ?? 'worksheets/'}sheet${n}.xml"/>`
        )
        .join('')}</Relationships>`
    )
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}
