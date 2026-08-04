/**
 * KUKAN Pipeline — interpreting one version file (ADR-046)
 *
 * The re-runnable unit. A version file never changes, so interpreting it again
 * always gives the same answer — which is what lets a failed interpretation be
 * retried instead of pinned to whatever it managed to produce the first time.
 *
 * Two callers want different things from the result: the pipeline publishes a
 * preview and records the schema, a lake retry only wants the table. So the
 * table is handed to a callback while it exists rather than returned, and the
 * temp directory stays this function's to clean up.
 */

import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { detectEncoding } from '@kukan/shared/encoding-node'
import { toCharset } from '@kukan/shared'
import type { ResourceSchema } from '@kukan/shared'
import {
  cleanupTempFile,
  readEncodingSample,
  streamToTempFile,
  transcodeToUtf8,
} from '../node-utils'
import { interpretCsv } from './csv'
import { countTitleRows } from './csv-title-rows'
import type { PipelineContext } from '../types'
import { MAX_CSV_COLUMNS } from '@/config'

/** The interpretation, for as long as the callback runs. */
export interface InterpretedTable {
  /** The Parquet on local disk. Gone once the callback returns. */
  parquetPath: string
  schema: ResourceSchema
}

export interface InterpretOutcome<T> {
  /** Detected on the version file; reported whether or not a table came out. */
  encoding: string
  /**
   * The interpretation, always — with no columns when the file held none.
   *
   * Recorded on the version either way (ADR-046). An empty one is the answer
   * "there is nothing here to load", and it has to be written down: a version
   * with no schema is one nothing has interpreted yet, and the hourly sweep
   * would otherwise hand this file out again every hour for good.
   */
  schema: ResourceSchema
  /** What the callback returned, absent when there was no table to give it. */
  used?: T
  /**
   * Why no table came out, when none did.
   *
   * The empty schema says "interpreted, nothing to load" and stops there; this
   * says which nothing, which is what an operator asking "why is there no
   * preview?" is after. Absent whenever a table *was* produced.
   */
  reason?: NoTableReason
}

/** Why an interpretation produced no table. */
export type NoTableReason = 'no-columns' | 'too-many-columns'

/** What an interpretation that found nothing reports. */
const NO_TABLE: ResourceSchema = { rowCount: 0, columns: [] }

/**
 * Interpret a CSV/TSV version file and hand the table to `use`.
 *
 * @param fmt - lowercased format; the caller has already established that this
 *   is one of the tabular ones and that the file is within the interpret cap.
 */
export async function withInterpretedVersion<T>(
  source: { storageKey: string },
  fmt: string,
  ctx: PipelineContext,
  use: (table: InterpretedTable) => Promise<T>,
  onEncoding?: (encoding: string) => Promise<void>
): Promise<InterpretOutcome<T>> {
  // Streamed to disk rather than buffered: DuckDB reads the file from there,
  // and the JS heap never holds the whole table (ADR-046).
  const rawPath = await streamToTempFile(await ctx.storage.download(source.storageKey), 'csv')
  try {
    // Off disk, and only as far as detection needs. Reading every byte was the
    // blunt answer to "a 64KB head is not enough" (measured, ADR-046) — it is
    // also up to 50MB on the heap and a second of chardet per megabyte, for an
    // answer `readEncodingSample` reaches with a bound.
    const encoding = detectEncoding(fmt, await readEncodingSample(createReadStream(rawPath)))
    // Handed over the moment it is settled, like everything else this function
    // produces. Nothing below can fail in a way that takes it back — which is
    // the point: a DuckDB OOM used to discard an answer that was already right,
    // and silently, since all three readers fall back to UTF-8 and serve
    // mojibake rather than erroring.
    await onEncoding?.(encoding)

    const charset = toCharset(encoding)
    const csvPath = charset === 'utf-8' ? rawPath : await transcodeToUtf8(rawPath, charset)
    // Dead the moment it has been transcoded, and up to 50MB of it would
    // otherwise sit on disk under the whole DuckDB pass.
    if (csvPath !== rawPath) await rm(rawPath, { force: true })

    const { rows: titleRows, columnCount } = await countTitleRows(csvPath)
    if (columnCount === 0) return { encoding, schema: NO_TABLE, reason: 'no-columns' }
    // Too wide to preview (e.g. a pivot table). Reported as an interpretation
    // that produced no table rather than as a failure: the width is a property
    // of the file, so retrying reaches it again — and a version with no schema
    // is one nothing has interpreted yet, which the hourly sweep hands out
    // every hour for good. The reason is recorded so "no table here" and "too
    // wide for one" stay distinguishable.
    if (columnCount > MAX_CSV_COLUMNS) {
      return { encoding, schema: NO_TABLE, reason: 'too-many-columns' }
    }

    const parquetPath = `${csvPath}.parquet`
    const schema = await interpretCsv(csvPath, parquetPath, titleRows)
    // And the source is dead once it has been interpreted. What the callback
    // does next — an upload, a wait on the catalog-wide lock — would hold it
    // for nothing.
    await rm(csvPath, { force: true })

    return { encoding, schema, used: await use({ parquetPath, schema }) }
  } finally {
    // Every file this made lives in the directory this made, so one removal
    // covers whatever a given path left behind.
    await cleanupTempFile(rawPath)
  }
}
