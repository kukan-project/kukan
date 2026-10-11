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
import { isJsonFormat, MAX_PARQUET_SOURCE_SIZE, toCharset } from '@kukan/shared'
import type { NoTableReason, ResourceSchema } from '@kukan/shared'
import {
  cleanupTempFile,
  readEncodingSample,
  streamToTempFile,
  transcodeToUtf8,
} from '../node-utils'
import { HeavyTooLargeError, runHeavy } from '@/heavy'
import type { HeavyRequest } from '@/heavy/protocol'
import { countTitleRows } from './table/csv-title-rows'
import { jsonStartsWithObject } from './table/json'
import type { PipelineContext } from '../run/types'
import type { InterpretedProfile } from './table/table-profile'
import type { InterpretedTableFile } from './table/write-table'
import { MAX_JSON_OBJECT_SIZE, MAX_TABLE_COLUMNS } from '@/config'

/** The interpretation, for as long as the callback runs. */
export interface InterpretedTable {
  /** The Parquet on local disk. Gone once the callback returns. */
  parquetPath: string
  schema: ResourceSchema
  /** The table profile (ADR-063), where one was asked for; its artifact is on
   *  local disk until the callback returns. */
  profile?: InterpretedProfile
}

export interface InterpretOutcome<T> {
  /** Detected on the version file; reported whether or not a table came out. */
  encoding: string
  /**
   * The interpretation — with no columns when the file held none, and **null
   * when nothing was interpreted at all**.
   *
   * An empty one is the answer "there is nothing here to load", and it has to be
   * written down (ADR-046): a version with no schema is one nothing has
   * interpreted yet, so without it the hourly sweep hands the file out every
   * hour for good.
   *
   * Null is the other thing — the file was refused, not read. Writing an empty
   * schema for it would claim an interpretation that never happened, and would
   * settle a verdict that is not the version's to keep: over-cap is a fact about
   * the cap, and the sweep re-reads that every pass so raising it is enough on
   * its own.
   */
  schema: ResourceSchema | null
  /** What the callback returned, absent when there was no table to give it. */
  used?: T
  /** Rows in a row group of the Parquet that was written.
   *  @see InterpretedTableFile.rowGroupRows */
  rowGroupRows?: number
  /**
   * Why no table came out, when none did.
   *
   * The empty schema says "interpreted, nothing to load" and stops there; this
   * says which nothing, which is what an operator asking "why is there no
   * preview?" is after. Absent whenever a table *was* produced.
   */
  reason?: NoTableReason
}

/** What an interpretation that found nothing reports. */
const NO_TABLE: ResourceSchema = { rowCount: 0, columns: [] }

/**
 * Interpret a CSV/TSV or JSON/GeoJSON version file and hand the table to `use`.
 *
 * @param fmt - lowercased format; the caller has already established that this
 *   is one an interpretation may make a table from (`isTableSourceFormat`).
 *   Whether it is within the interpret cap is this function's to answer, so
 *   both callers give one answer.
 * @param opts.profile - write the profile artifact too (ADR-063), for a caller
 *   that publishes one.
 */
export async function withInterpretedVersion<T>(
  source: { storageKey: string; size: number },
  fmt: string,
  ctx: PipelineContext,
  use: (table: InterpretedTable) => Promise<T>,
  onEncoding?: (encoding: string) => Promise<void>,
  opts: { profile?: boolean } = {}
): Promise<InterpretOutcome<T>> {
  // Too large to interpret. Answered here rather than by each caller, so the
  // pipeline and the lake retry give the same answer — and answered as an
  // interpretation that produced no table, with the reason, rather than as an
  // absence: a version with no schema is one nothing has interpreted yet, which
  // the hourly sweep hands out every hour for good.
  //
  // Sampled rather than transferred: the version row was measured at create and
  // the file behind it never changes, so the size decides this before the
  // download, and the encoding still comes back.
  if (isJsonFormat(fmt)) return interpretJsonVersion(source, ctx, use, onEncoding, opts)
  if (source.size > MAX_PARQUET_SOURCE_SIZE) {
    const sample = await readEncodingSample(await ctx.storage.download(source.storageKey))
    const encoding = detectEncoding(fmt, sample)
    await onEncoding?.(encoding)
    return { encoding, schema: null, reason: 'too-large' }
  }

  // Streamed to disk rather than buffered: DuckDB reads the file from there,
  // and the JS heap never holds the whole table (ADR-046).
  const rawPath = await streamToTempFile(await ctx.storage.download(source.storageKey), 'csv')
  try {
    // Off disk, and only as far as detection needs. Reading every byte was the
    // blunt answer to "a 64KB head is not enough" (measured, ADR-046) — it is
    // also up to 100MB on the heap and a second of chardet per megabyte, for an
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
    // Dead the moment it has been transcoded, and up to 100MB of it would
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
    if (columnCount > MAX_TABLE_COLUMNS) {
      return { encoding, schema: NO_TABLE, reason: 'too-many-columns' }
    }

    // Awaited here, or the `finally` below removes the file under it
    return await interpretOnDisk(
      csvPath,
      encoding,
      (parquetPath, profilePath) => ({
        kind: 'interpret-csv',
        csvPath,
        parquetPath,
        skipRows: titleRows,
        profilePath,
      }),
      ctx,
      use,
      opts
    )
  } finally {
    // Every file this made lives in the directory this made, so one removal
    // covers whatever a given path left behind.
    await cleanupTempFile(rawPath)
  }
}

/** JSON is UTF-8 by specification (RFC 8259): nothing to detect, in the spelling Interpret has always recorded for it. */
const JSON_ENCODING = 'UTF8'

/**
 * The JSON half of `withInterpretedVersion` (ADR-063 extension). No encoding
 * to detect and no title rows; what is the file's own is whether it is one
 * object, which the reader holds whole and so takes only up to
 * {@link MAX_JSON_OBJECT_SIZE}.
 */
async function interpretJsonVersion<T>(
  source: { storageKey: string; size: number },
  ctx: PipelineContext,
  use: (table: InterpretedTable) => Promise<T>,
  onEncoding?: (encoding: string) => Promise<void>,
  opts: { profile?: boolean } = {}
): Promise<InterpretOutcome<T>> {
  const encoding = JSON_ENCODING
  await onEncoding?.(encoding)
  // The cap every table file has, answered as `withInterpretedVersion` does
  if (source.size > MAX_PARQUET_SOURCE_SIZE) return { encoding, schema: null, reason: 'too-large' }

  // Decided from the head of the object, before anything is transferred.
  // Settled with an empty schema, as a width is: the layer-2 sweep goes by the
  // 100MB cap alone, and would hand an unsettled version out every hour. A
  // raised cap reaches these by reprocessing them.
  if (source.size > MAX_JSON_OBJECT_SIZE) {
    if (await jsonStartsWithObject(await ctx.storage.download(source.storageKey))) {
      return { encoding, schema: NO_TABLE, reason: 'too-large' }
    }
  }

  const jsonPath = await streamToTempFile(await ctx.storage.download(source.storageKey), 'json')
  try {
    return await interpretOnDisk(
      jsonPath,
      encoding,
      (parquetPath, profilePath) => ({
        kind: 'interpret-json',
        jsonPath,
        parquetPath,
        profilePath,
      }),
      ctx,
      use,
      opts
    )
  } finally {
    await cleanupTempFile(jsonPath)
  }
}

/**
 * What every table file ends with once it is on disk and read as far as its
 * format alone can take it: the heavy process reads it, the source goes, and
 * the table is handed to `use` while the Parquet still exists.
 *
 * @param request - the heavy request for the file, given where its outputs go.
 */
async function interpretOnDisk<T>(
  sourcePath: string,
  encoding: string,
  request: (
    parquetPath: string,
    profilePath: string | undefined
  ) => Extract<HeavyRequest, { kind: 'interpret-csv' | 'interpret-json' }>,
  ctx: PipelineContext,
  use: (table: InterpretedTable) => Promise<T>,
  opts: { profile?: boolean }
): Promise<InterpretOutcome<T>> {
  const parquetPath = `${sourcePath}.parquet`
  const profilePath = opts.profile ? `${sourcePath}.profile.ndjson.zst` : undefined
  // In the heavy process, where a file that outgrows the memory takes that
  // process and not the worker (ADR-059). Recorded like the bounds above:
  // interpreting it again on the same task would end the same way, and the
  // hourly sweep would hand it out every hour to find that out.
  let interpreted: InterpretedTableFile
  try {
    interpreted = (await runHeavy(
      request(parquetPath, profilePath),
      ctx.assertHeld
    )) as InterpretedTableFile
  } catch (err) {
    if (!(err instanceof HeavyTooLargeError)) throw err
    return { encoding, schema: NO_TABLE, reason: 'out-of-memory' }
  }
  const { schema, reason, rowGroupRows, profile } = interpreted
  // And the source is dead once it has been interpreted. What the callback
  // does next — an upload, a wait on the catalog-wide lock — would hold it
  // for nothing.
  await rm(sourcePath, { force: true })

  // Refused rather than read: there is no Parquet to hand on, and the reason
  // is what stops "no preview" reading as "not interpreted yet".
  if (reason) return { encoding, schema, reason }

  return {
    encoding,
    schema,
    rowGroupRows,
    used: await use({ parquetPath, schema, ...(profile && { profile }) }),
  }
}
