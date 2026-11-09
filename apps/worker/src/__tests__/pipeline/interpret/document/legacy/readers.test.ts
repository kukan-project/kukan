import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentBlocks } from '@/pipeline/interpret/document/document-text'
import {
  cell,
  docBuffer,
  jtd,
  jtdBuffer,
  jtdStream,
  ppt,
  pptBuffer,
  pptDocument,
  xlsBuffer,
} from '../../../../test-helpers/legacy-office'

/**
 * The readers of the binary formats take files anyone can upload. Whatever the
 * bytes, they must settle: read the file, or refuse it with their own words. A
 * RangeError or a TypeError would be Node's words reaching the editor — and,
 * for anything but a read past a buffer, a bug.
 */
const FIXTURES: Record<string, Buffer> = {
  doc: docBuffer([{ text: 'Title\rbody\r', compressed: true }], { body: 11 }),
  xls: xlsBuffer({
    sheets: [{ name: 's', cells: [cell.label(0, 0, 'x'), cell.label(1, 1, 'y')] }],
  }),
  ppt: pptBuffer([
    {
      objects: { 1: pptDocument([{ ref: 2, records: [ppt.header(0), ppt.chars('title')] }]) },
    },
  ]),
  jtd: jtdBuffer({
    DocumentText: jtdStream({ blocks: [['一、', ...jtd.inline(true, '午后'), 'の']] }),
  }),
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legacy-readers-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readThrough(bytes: Buffer, format: string): Promise<void> {
  const path = join(dir, `file.${format}`)
  await writeFile(path, bytes)
  for await (const _ of documentBlocks(path, format)) {
    // read every block
  }
}

describe.each(Object.keys(FIXTURES))('%s reader', (format) => {
  const valid = FIXTURES[format]!

  it('reads the fixture', async () => {
    await expect(readThrough(valid, format)).resolves.toBeUndefined()
  })

  it('settles on any damage, in its own words', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ at: fc.nat({ max: valid.length - 1 }), byte: fc.nat({ max: 255 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.option(fc.nat({ max: valid.length }), { nil: undefined }),
        async (writes, cut) => {
          const bytes = Buffer.from(valid.subarray(0, cut ?? valid.length))
          for (const { at, byte } of writes) if (at < bytes.length) bytes[at] = byte
          try {
            await readThrough(bytes, format)
          } catch (err) {
            expect(err).not.toBeInstanceOf(RangeError)
            expect(err).not.toBeInstanceOf(TypeError)
          }
        }
      ),
      { numRuns: 2000 }
    )
  })
})

describe('ppt reader', () => {
  it('reads a container of many atoms without overflowing the stack', async () => {
    // Some 130,000 empty 8-byte atoms in a slide: spread into one push, past the stack
    const atoms = Buffer.alloc(8 * 130_000)
    const list = pptDocument([{ ref: 2, records: [ppt.header(0), ppt.chars('title')] }])
    const bytes = pptBuffer([{ objects: { 1: list, 2: ppt.slide([atoms, ppt.chars('shape')]) } }])
    await expect(readThrough(bytes, 'ppt')).resolves.toBeUndefined()
  })
})
