/**
 * KUKAN Pipeline — Index Step
 * Extracts text content from resources and indexes it into OpenSearch (kukan-contents).
 * Text formats are processed as a stream — no file size limit on indexable content.
 * Large texts are split into chunks of up to MAX_CONTENT_CHUNK_SIZE (`@kukan/shared/content-chunks`).
 * Also records content indexing metadata in resource_pipeline.metadata.
 *
 * Document formats are indexed from the text artifact the Interpret step
 * wrote, which the AI suggestion reads its text head from too (ADR-040).
 * Drafts are not indexed — search indexing starts at publish (ADR-039).
 *
 * Supported formats: CSV, TSV, TXT, MD, HTML, HTM, JSON, GeoJSON, XML, ZIP,
 *                    PDF, DOCX, XLSX, PPTX, ODT, ODP, ODS, RTF
 * Non-text formats (DOC, XLS, PPT, RDF, images) are skipped (contentIndexed: false).
 */

import {
  contentTypeOf,
  type ContentType,
  type TableProfile,
  type TableProfileLine,
} from '@kukan/shared'
import type { ContentDoc } from '@kukan/search-adapter'
import type { PipelineContext } from '../run/types'
import type { InterpretedDocument, InterpretResult } from './interpret'
import { documentTextLines } from '../interpret/document/document-text-lines'
import { streamToBuffer, streamUtf8Lines, zstdLines } from '../node-utils'
import { bufferToUtf8, stripTrailingReplacementChar } from '@kukan/shared/encoding-node'
import { ContentChunkCutter } from '@kukan/shared/content-chunks'
import { MAX_FETCH_SIZE, UNPROFILED_TABLE_HEAD_SIZE } from '@/config'

export interface IndexContentResult {
  contentIndexed: boolean
  contentType: ContentType | null
  contentOriginalSize: number
  contentIndexedSize: number
  contentTruncated: boolean
  contentChunks: number
}

/**
 * Extract text from the resource and index it into the search engine.
 * Text formats are streamed line-by-line to avoid loading the entire file into memory.
 * Returns metadata about the indexing, or null if the format is not indexable.
 */
export async function executeIndexContent(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string | null,
  interpretResult: InterpretResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult | null> {
  const normalizedFormat = format?.toLowerCase() ?? null

  // Draft packages stay out of the content index until publish (ADR-039), and
  // deleted/purging ones must not be re-indexed. A draft document's text and
  // its head (ADR-040 addendum) were kept by Interpret, which drafts run too.
  const pkgState = await ctx.getPackageState(packageId)
  if (pkgState !== 'active') return null

  // A JSON whose records the interpretation read as a table is indexed as one
  // (ADR-063 §決定 10); its format alone says text
  const contentType = interpretResult?.schema?.columns.length
    ? 'tabular'
    : contentTypeOf(normalizedFormat)

  if (!contentType) {
    // Clean up any previously indexed content (e.g. format changed to non-indexable)
    await ctx.deleteContent(resourceId)
    return null
  }

  const res = await ctx.getResource(resourceId)
  if (!res) return null

  if (contentType === 'manifest') {
    return indexManifest(resourceId, packageId, contentType, interpretResult, ctx)
  }

  if (contentType === 'document') {
    return indexDocument(resourceId, packageId, contentType, interpretResult?.documentText, ctx)
  }

  // A table by its profile (ADR-063 §決定 7). One the interpretation made no
  // table of — too wide, rows it would not read, too large — or whose profile
  // failed, by the head of its contents: the rest of a table is codes and
  // counts, which search has no use for.
  if (contentType === 'tabular') {
    const profile = interpretResult?.profile
    if (profile && !profile.error) return indexTableProfile(resourceId, packageId, profile, ctx)
    const head = await indexTextStream(
      resourceId,
      packageId,
      storageKey,
      normalizedFormat!,
      contentType,
      interpretResult,
      ctx,
      UNPROFILED_TABLE_HEAD_SIZE
    )
    return head.contentTruncated && res.size ? { ...head, contentOriginalSize: res.size } : head
  }

  return indexTextStream(
    resourceId,
    packageId,
    storageKey,
    normalizedFormat!,
    contentType,
    interpretResult,
    ctx
  )
}

/**
 * Index a table by its profile artifact: the values of each listed column as
 * `列名: 値、値、…` lines, then a line per free-text sentence. Row numbers and
 * counts stay in the artifact — the index has nowhere to use them (ADR-063
 * §決定 7).
 *
 * A table with nothing to list — numbers and codes — has no artifact and no
 * content documents, and is indexed all the same: the record says the index
 * holds what this content gives it, which here is nothing.
 */
async function indexTableProfile(
  resourceId: string,
  packageId: string,
  profile: TableProfile,
  ctx: PipelineContext
): Promise<IndexContentResult> {
  await ctx.deleteContent(resourceId)
  const written = profile.key
    ? await writeChunks(
        resourceId,
        packageId,
        'tabular',
        profileLines(zstdLines(await ctx.storage.download(profile.key))),
        ctx
      )
    : { chunks: 0, indexedBytes: 0, originalBytes: 0 }
  return {
    contentIndexed: true,
    contentType: 'tabular',
    contentOriginalSize: written.originalBytes,
    contentIndexedSize: written.indexedBytes,
    contentTruncated: false,
    contentChunks: written.chunks,
  }
}

/**
 * Characters of values put on one line, its heading repeated on the next.
 * Short, so a snippet started near its match often starts at the heading
 * and says which column the value is in.
 */
const PROFILE_LINE_CHARS = 120

/** The artifact's lines as text to index. */
async function* profileLines(ndjson: AsyncIterable<string>): AsyncGenerator<string> {
  let heading: string | null = null
  let values: string[] = []
  let chars = 0
  const flush = () => {
    const line = `${heading}: ${values.join('、')}`
    values = []
    chars = 0
    return line
  }
  for await (const raw of ndjson) {
    if (!raw.trim()) continue
    const line = JSON.parse(raw) as TableProfileLine
    if (line.kind === 'sentence') {
      if (values.length > 0) yield flush()
      yield line.text
      continue
    }
    if (line.column !== heading || chars + line.text.length > PROFILE_LINE_CHARS) {
      if (values.length > 0) yield flush()
      heading = line.column
    }
    values.push(line.text)
    chars += line.text.length + 1
  }
  if (values.length > 0) yield flush()
}

/** Index ZIP manifest (small JSON, loaded fully) */
async function indexManifest(
  resourceId: string,
  packageId: string,
  contentType: ContentType,
  interpretResult: InterpretResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult | null> {
  if (!interpretResult?.previewKey) return null

  const manifestStream = await ctx.storage.download(interpretResult.previewKey)
  const manifestBuf = await streamToBuffer(manifestStream)
  const manifest = JSON.parse(manifestBuf.toString('utf-8'))
  const paths = (manifest.entries ?? []).map((e: { path: string }) => e.path).join('\n')

  const originalSize = Buffer.byteLength(paths, 'utf-8')

  await ctx.deleteContent(resourceId)

  const doc: ContentDoc = {
    resourceId,
    packageId,
    extractedText: paths,
    contentType,
    chunkIndex: 0,
    chunkSize: originalSize,
  }
  await ctx.indexContent(doc)

  return {
    contentIndexed: true,
    contentType,
    contentOriginalSize: originalSize,
    contentIndexedSize: originalSize,
    contentTruncated: false,
    contentChunks: 1,
  }
}

/**
 * Index a document's content from the text artifact its interpretation wrote
 * (see `interpretDocument`).
 *
 * A document with no text, or none interpreted this run, leaves what was
 * indexed before as it was: the old chunks are deleted only once there are
 * new ones to write.
 */
async function indexDocument(
  resourceId: string,
  packageId: string,
  contentType: ContentType,
  text: InterpretedDocument | undefined,
  ctx: PipelineContext
): Promise<IndexContentResult | null> {
  if (!text) return null
  if (text.bytes === 0) {
    return {
      contentIndexed: false,
      contentType,
      contentOriginalSize: 0,
      contentIndexedSize: 0,
      contentTruncated: false,
      contentChunks: 0,
    }
  }
  await ctx.deleteContent(resourceId)
  const written = await writeChunks(
    resourceId,
    packageId,
    contentType,
    documentTextLines(await ctx.storage.download(text.key)),
    ctx
  )
  return {
    contentIndexed: written.chunks > 0,
    contentType,
    contentOriginalSize: text.bytes,
    contentIndexedSize: written.indexedBytes,
    contentTruncated: false,
    contentChunks: written.chunks,
  }
}

/**
 * Write a stream of chunks, waiting for the index to refresh on the last one
 * only (see `indexContent`). Which chunk is last is known only when the text
 * ends, so each is held back until the next arrives.
 */
function chunkWriter(ctx: PipelineContext) {
  let pending: ContentDoc | undefined
  return {
    async write(doc: ContentDoc) {
      if (pending) await ctx.indexContent(pending, { waitForRefresh: false })
      pending = doc
    },
    async close() {
      if (pending) await ctx.indexContent(pending)
    },
  }
}

/** Stream text content line-by-line, chunking and indexing incrementally */
async function indexTextStream(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string,
  contentType: ContentType,
  interpretResult: InterpretResult | null,
  ctx: PipelineContext,
  maxBytes?: number
): Promise<IndexContentResult> {
  const stream = await ctx.storage.download(storageKey)
  const encoding = interpretResult?.encoding ?? 'UTF8'
  const isHtml = format === 'html' || format === 'htm'
  const enc = encoding.toLowerCase()
  const isUtf8 = enc === 'utf8' || enc === 'utf-8' || enc === 'ascii' || enc === 'unknown'

  let lines: AsyncIterable<string> | Iterable<string>
  let truncated = false
  if (maxBytes !== undefined) {
    // A byte past the cap, so a file of exactly the cap is not called cut
    const buf = await streamToBuffer(stream, maxBytes + 1)
    truncated = buf.length > maxBytes
    const head = buf.subarray(0, maxBytes)
    lines = stripTrailingReplacementChar(
      isUtf8 ? head.toString('utf-8') : bufferToUtf8(head, encoding)
    )
      .replace(/\n$/, '')
      .split('\n')
  } else if (isUtf8) {
    lines = streamUtf8Lines(stream)
  } else {
    // Non-UTF-8: buffer file and convert (stateful encodings need full context).
    // Cap the buffer at the max legitimate file size so an oversize object can't
    // OOM the worker; a truncated tail is acceptable degradation for indexing.
    const buf = await streamToBuffer(stream, MAX_FETCH_SIZE)
    const text = bufferToUtf8(buf, encoding)
    lines = text.split('\n')
  }

  await ctx.deleteContent(resourceId)
  const written = await writeChunks(
    resourceId,
    packageId,
    contentType,
    isHtml ? withoutTags(lines) : lines,
    ctx
  )
  return {
    contentIndexed: written.chunks > 0,
    contentType,
    contentOriginalSize: written.originalBytes,
    contentIndexedSize: written.indexedBytes,
    contentTruncated: truncated,
    contentChunks: written.chunks,
  }
}

/** HTML lines as their text, the lines left with none dropped */
async function* withoutTags(lines: AsyncIterable<string> | Iterable<string>) {
  for await (const line of lines) {
    const text = line
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) yield text
  }
}

interface WrittenChunks {
  chunks: number
  indexedBytes: number
  originalBytes: number
}

/**
 * Index `lines` in chunks of up to MAX_CONTENT_CHUNK_SIZE, split at line
 * boundaries; a longer line is cut to a chunk of its own.
 */
async function writeChunks(
  resourceId: string,
  packageId: string,
  contentType: ContentType,
  lines: AsyncIterable<string> | Iterable<string>,
  ctx: PipelineContext
): Promise<WrittenChunks> {
  let chunkLines: string[] = []
  let chunkIndex = 0
  let totalOriginalBytes = 0
  let totalIndexedBytes = 0
  const writer = chunkWriter(ctx)

  async function flushChunk() {
    const text = chunkLines.join('\n')
    const textBytes = Buffer.byteLength(text, 'utf-8')

    const doc: ContentDoc = {
      resourceId,
      packageId,
      extractedText: text,
      contentType,
      chunkIndex,
      chunkSize: textBytes,
    }
    await writer.write(doc)

    totalIndexedBytes += textBytes
    chunkIndex++
    chunkLines = []
  }

  const cutter = new ContentChunkCutter()
  let lineCount = 0
  for await (const line of lines) {
    const { bytes, breakBefore, kept, alone } = cutter.place(line)
    totalOriginalBytes += bytes + (lineCount > 0 ? 1 : 0) // +1 for newline separator
    lineCount++

    if (breakBefore) await flushChunk()
    chunkLines.push(kept)
    if (alone) await flushChunk()
  }

  // Flush remaining lines
  if (chunkLines.length > 0) {
    await flushChunk()
  }
  await writer.close()

  return { chunks: chunkIndex, indexedBytes: totalIndexedBytes, originalBytes: totalOriginalBytes }
}
