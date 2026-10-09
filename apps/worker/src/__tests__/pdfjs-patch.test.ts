import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rawPdf } from './test-helpers/raw-pdf'

/**
 * patches/pdfjs-dist@*.patch stops pdf.js compiling each glyph of a font to a
 * path, which we never draw. pnpm refuses to install when the patched version
 * is gone; this catches a patch that still applies but no longer takes effect.
 */

// The pdf.js officeparser loads, not whichever the workspace happens to hoist
const officeparserRequire = createRequire(createRequire(import.meta.url).resolve('officeparser'))
const pdfjsPath = officeparserRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const fontPath = join(dirname(pdfjsPath), '../../standard_fonts/LiberationSans-Regular.ttf')

/** One page of text in an embedded TrueType font. */
function pdfWithEmbeddedFont(font: Buffer): Buffer {
  const content = 'BT /F1 24 Tf 72 700 Td (Hello) Tj ET'
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FontDescriptor 6 0 R >>',
    '<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -212 1000 905] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 /FontFile2 7 0 R >>',
    Buffer.concat([
      Buffer.from(`<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n`),
      font,
      Buffer.from('\nendstream'),
    ]),
  ])
}

describe('pdf.js as patched', () => {
  it('loads an embedded font without compiling its glyphs to paths', async () => {
    const pdfjs = await import(pdfjsPath)
    const task = pdfjs.getDocument({
      data: new Uint8Array(pdfWithEmbeddedFont(await readFile(fontPath))),
      isEvalSupported: false,
      verbosity: 0,
    })
    try {
      const page = await (await task.promise).getPage(1)
      await page.getOperatorList()
      const ids = [...page.commonObjs].map(([id]: [string]) => id)
      // The font itself was loaded, so the check below is not vacuous
      expect(ids.some((id) => !id.includes('_path_'))).toBe(true)
      expect(ids.filter((id) => id.includes('_path_'))).toEqual([])
    } finally {
      await task.destroy()
    }
  })
})
