import { describe, it, expect } from 'vitest'
import { OfficeParser, type OfficeContentNode } from 'officeparser'
import { rawPdf } from './test-helpers/raw-pdf'

/**
 * patches/officeparser@*.patch adds `headingDetection: 'tags'`: a heading only
 * where a PDF's tags mark one, never one guessed from the font size. pnpm
 * refuses to install when the patched version is gone; this catches a patch
 * that still applies but no longer takes effect.
 */

/**
 * A page with a heading in body-sized type, a paragraph, and a short line in
 * large type: tagged H1 and P, the large line outside the tags, where `tagged`;
 * or none of it tagged.
 */
function pdfWithLargeLine(tagged: boolean): Buffer {
  const mark = (tag: string, mcid: number, text: string) =>
    tagged ? `/${tag} << /MCID ${mcid} >> BDC ${text} EMC` : text
  const content = [
    mark('H1', 0, 'BT /F1 12 Tf 72 720 Td (Purpose) Tj ET'),
    mark('P', 1, 'BT /F1 12 Tf 72 700 Td (The plan sets out what the city will do.) Tj ET'),
    'BT /F1 30 Tf 72 600 Td (2024) Tj ET',
  ].join('\n')
  const page = tagged ? ' /StructParents 0' : ''
  const catalog = tagged
    ? '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 6 0 R >>'
    : '<< /Type /Catalog /Pages 2 0 R >>'
  return rawPdf([
    catalog,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R${page} >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /StructTreeRoot /K [7 0 R] /ParentTree << /Nums [0 [8 0 R 9 0 R]] >> >>',
    '<< /Type /StructElem /S /Document /P 6 0 R /K [8 0 R 9 0 R] >>',
    '<< /Type /StructElem /S /H1 /P 7 0 R /Pg 3 0 R /K 0 >>',
    '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 1 >>',
  ])
}

async function headings(pdf: Buffer, headingDetection: 'auto' | 'tags'): Promise<string[]> {
  const ast = await OfficeParser.parseOffice(pdf, {
    pdfParserConfig: { headingDetection },
  })
  const found: string[] = []
  const walk = (node: OfficeContentNode) => {
    if (node.type === 'heading') found.push(node.text ?? '')
    node.children?.forEach(walk)
  }
  ast.content.forEach(walk)
  return found
}

describe('officeparser as patched', () => {
  it('makes a heading only of what the tags mark one', async () => {
    const pdf = pdfWithLargeLine(true)

    // Unpatched behaviour, still the default: the large line is guessed a heading too
    expect(await headings(pdf, 'auto')).toEqual(['Purpose', '2024'])
    expect(await headings(pdf, 'tags')).toEqual(['Purpose'])
  })

  it('makes no heading of an untagged PDF', async () => {
    const pdf = pdfWithLargeLine(false)

    expect(await headings(pdf, 'auto')).toEqual(['2024'])
    expect(await headings(pdf, 'tags')).toEqual([])
  })
})
