/**
 * The parsing the abstract's material needs of an original (ADR-053): a PDF's
 * page count, its first pages, and an image cut down to what the API takes.
 * Run in the heavy process (ADR-059), where a file that outgrows the memory or
 * stalls the parser takes that process and not the worker.
 *
 * What the parser refuses comes back as a result, so that anything thrown —
 * the module failing to load, say — is not taken for a fact about the file.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { PDFDocument } from '@cantoo/pdf-lib'
import sharp from 'sharp'
import { SUMMARY_IMAGE_RESIZE_PX } from '@kukan/shared'
import { SUMMARY_IMAGE_MAX_INPUT_PIXELS } from '@/config'

export interface ReadPdf {
  /** Null where pdf-lib could not parse the file */
  pages: number | null
  /** Whether the first `cutTo` pages are at `outPath`: only asked past `cutPast` */
  cut: boolean
  /** Set where the cut was refused because the document is encrypted */
  encrypted?: true
  /** Why it was not parsed, or not cut */
  why?: string
}

/**
 * Count the pages and, past `cutPast` (at least `cutTo`), write the first
 * `cutTo` to `outPath` as a PDF of their own — one parse for both. The caller
 * raises `cutPast` to where the cut would be sent, so a document whose text is
 * taken instead is not cut for nothing.
 *
 * Copying rather than deleting the rest: `copyPages` builds a new document from
 * the pages it is given, so what a damaged page further in does to the file
 * cannot reach this one.
 */
export async function readPdf(
  pdfPath: string,
  cutTo: number,
  cutPast: number,
  outPath: string
): Promise<ReadPdf> {
  let src: PDFDocument
  let pages: number
  try {
    // An encrypted PDF still parses far enough to be counted. The count is
    // inside: a load can succeed on a file with no page tree
    src = await PDFDocument.load(await readFile(pdfPath), {
      ignoreEncryption: true,
      updateMetadata: false,
    })
    pages = src.getPageCount()
  } catch (err) {
    return { pages: null, cut: false, why: (err as Error).message }
  }
  if (pages <= Math.max(cutTo, cutPast)) return { pages, cut: false }
  // Counting the pages of an encrypted document is safe; taking them out is
  // not. `ignoreEncryption` parses the structure without decrypting it, so
  // the content streams cross into a document with no key and every page
  // arrives blank — 50 of them, from a yearbook holding 575,761 characters.
  if (src.isEncrypted) return { pages, cut: false, encrypted: true }
  try {
    const cut = await PDFDocument.create()
    const copied = await cut.copyPages(src, [...Array(cutTo).keys()])
    for (const page of copied) cut.addPage(page)
    await writeFile(outPath, await cut.save())
    return { pages, cut: true }
  } catch (err) {
    return { pages, cut: false, why: (err as Error).message }
  }
}

/**
 * The image at `imagePath` downscaled to `outPath`, or `written: false` where
 * its header claims more pixels than the limit — read before any pixel is, as
 * the header cannot say whether a JPEG will shrink on load.
 */
export async function downscaleImage(
  imagePath: string,
  outPath: string
): Promise<{ written: boolean }> {
  try {
    await sharp(imagePath, { limitInputPixels: SUMMARY_IMAGE_MAX_INPUT_PIXELS })
      .resize({
        width: SUMMARY_IMAGE_RESIZE_PX,
        height: SUMMARY_IMAGE_RESIZE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFile(outPath)
    return { written: true }
  } catch (err) {
    if (err instanceof Error && /pixel limit/i.test(err.message)) return { written: false }
    throw err
  }
}
