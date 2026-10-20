import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFString } from '@cantoo/pdf-lib'
import sharp from 'sharp'
import { answer } from '../../heavy/answer'

// The abstract's kinds, answered in this process: the same code the heavy
// process runs, without one

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kukan-answer-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function pdfFile(pages: number, encrypted = false): Promise<string> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200, 200])
  if (encrypted) {
    // Only the /Encrypt entry, which is all the reader consults
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({
        Filter: 'Standard',
        V: 1,
        R: 2,
        O: PDFString.of('x'.repeat(32)),
        U: PDFString.of('y'.repeat(32)),
        P: -1,
      })
    )
  }
  const path = join(dir, 'in.pdf')
  await writeFile(path, await doc.save())
  return path
}

describe('read-pdf', () => {
  const read = async (pdfPath: string, cutPast = 0) =>
    answer({ kind: 'read-pdf', pdfPath, cutTo: 3, cutPast, outPath: join(dir, 'front.pdf') })

  it('counts a document within the cut, and leaves it whole', async () => {
    expect(await read(await pdfFile(3))).toEqual({ pages: 3, cut: false })
  })

  it('counts a longer one, and writes its first pages as a PDF of their own', async () => {
    expect(await read(await pdfFile(9))).toEqual({ pages: 9, cut: true })
    const front = await PDFDocument.load(await readFile(join(dir, 'front.pdf')))
    expect(front.getPageCount()).toBe(3)
  })

  it('does not cut one short of where the caller would send the cut', async () => {
    expect(await read(await pdfFile(9), 9)).toEqual({ pages: 9, cut: false })
  })

  it('counts an encrypted one, and will not cut it, whose pages would come out blank', async () => {
    expect(await read(await pdfFile(9, true))).toEqual({ pages: 9, cut: false, encrypted: true })
  })

  it('answers a file pdf-lib cannot parse with no count, rather than failing', async () => {
    const pdfPath = join(dir, 'in.pdf')
    await writeFile(pdfPath, '%PDF-1.4\nnot really a pdf')
    expect(await read(pdfPath)).toMatchObject({
      pages: null,
      cut: false,
      why: expect.any(String),
    })
  })
})

describe('downscale-image', () => {
  it('fits the long edge to the limit', async () => {
    const imagePath = join(dir, 'in')
    const outPath = join(dir, 'out')
    await sharp({ create: { width: 3200, height: 100, channels: 3, background: '#808080' } })
      .png()
      .toFile(imagePath)

    expect(await answer({ kind: 'downscale-image', imagePath, outPath })).toEqual({
      written: true,
    })
    expect((await sharp(outPath).metadata()).width).toBe(1600)
  })

  it('refuses one whose header claims more pixels than the limit', async () => {
    // A JPEG header claiming 10,000 by 10,000, and no pixels behind it
    const segment = (marker: number, data: number[]) =>
      Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data])
    const imagePath = join(dir, 'in')
    await writeFile(
      imagePath,
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        segment(0xdb, [0, ...Array<number>(64).fill(1)]),
        segment(0xc0, [8, 0x27, 0x10, 0x27, 0x10, 1, 1, 0x11, 0]),
        segment(0xda, [1, 1, 0, 0, 63, 0]),
        Buffer.from([0, 0, 0, 0, 0xff, 0xd9]),
      ])
    )

    expect(await answer({ kind: 'downscale-image', imagePath, outPath: join(dir, 'out') })).toEqual(
      { written: false }
    )
  })
})
