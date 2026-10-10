/**
 * What the preview reader can actually decode.
 *
 * The hook's own tests mock hyparquet, so they say nothing about codecs. This
 * reads real files — written by the same DuckDB `COPY` the Interpret step uses
 * (ADR-046) — because the point of adding `hyparquet-compressors` is a claim
 * about bytes, not about wiring.
 *
 * Both codecs, and both in one reader: the writer switches to ZSTD only after
 * this ships, and existing previews are never rewritten (ADR-029 §7), so the
 * two are expected to coexist for good. SNAPPY is not in `compressors` — it
 * reaches hyparquet's built-in decoder, which is the point, so a test that
 * reads a SNAPPY file is checking that the omission is correct.
 *
 * Fixtures hold 30k rows in five row groups. They were written when the Interpret
 * step asked for 5,000 rows a group, which DuckDB rounded up to 6,144 — checked
 * against the files rather than assumed, since that rounding is why the constant
 * is now a multiple of the 2,048-row vector. An earlier pair used 200 rows and
 * got one group, which made the mid-file case below assert nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parquetReadObjects, parquetMetadataAsync } from 'hyparquet'
import { compressors } from '../parquet-codecs'

const fixture = (name: string) => {
  const bytes = readFileSync(join(__dirname, 'fixtures', name))
  // Copied into an ArrayBuffer made here rather than handing over the one
  // behind the Buffer: hyparquet checks `instanceof ArrayBuffer`, and under
  // jsdom the global is not the realm Node's file read allocates in.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  // hyparquet reads through an AsyncBuffer; in the browser that is a ranged
  // fetch, here the whole file.
  return {
    byteLength: buffer.byteLength,
    slice: async (s?: number, e?: number) => buffer.slice(s, e),
  }
}

describe('the preview reader', () => {
  it.each(['snappy', 'zstd'])('reads %s data pages', async (codec) => {
    const rows = await parquetReadObjects({
      file: fixture(`${codec}.parquet`),
      compressors,
      rowStart: 0,
      rowEnd: 3,
    })

    expect(rows).toEqual([
      { id: 1n, name: 'row-1', score: 1.5 },
      { id: 2n, name: 'row-2', score: 3 },
      { id: 3n, name: 'row-3', score: 4.5 },
    ])
  })

  it('reads a page from a later row group, not the first', async () => {
    // 6,144 rows a group, so row 16,000 sits in the third — a group the reader
    // has not already touched, which is the path a page turn takes and the one a
    // single-group fixture cannot exercise.
    const rows = await parquetReadObjects({
      file: fixture('zstd.parquet'),
      compressors,
      rowStart: 16000,
      rowEnd: 16002,
    })

    expect(rows).toEqual([
      { id: 16001n, name: 'row-16001', score: 24001.5 },
      { id: 16002n, name: 'row-16002', score: 24003 },
    ])
  })

  it('reads the schema of a ZSTD file without the compressors', async () => {
    // Why `use-parquet-schema` needs no decoder: the footer is not compressed,
    // so the column list survives a codec the reader cannot decode. Worth
    // pinning — it is what keeps the item list working if the two services roll
    // out in the wrong order.
    const meta = await parquetMetadataAsync(fixture('zstd.parquet'))

    expect(meta.schema.filter((s) => !s.num_children).map((s) => s.name)).toEqual([
      'id',
      'name',
      'score',
    ])
  })

  it('is smaller than the same rows under snappy', async () => {
    const size = (name: string) => readFileSync(join(__dirname, 'fixtures', name)).byteLength
    expect(size('zstd.parquet')).toBeLessThan(size('snappy.parquet'))
  })
})
