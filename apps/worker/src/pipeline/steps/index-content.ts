/**
 * KUKAN Pipeline — Index Step
 * Extracts text content from resources and indexes it into OpenSearch (kukan-contents).
 * Text formats are processed as a stream — no file size limit on indexable content.
 * Large texts are split into multiple chunks (up to MAX_CONTENT_CHUNKS × MAX_CONTENT_CHUNK_SIZE).
 * Also records content indexing metadata in resource_pipeline.metadata.
 *
 * Supported formats: CSV, TSV, TXT, MD, HTML, HTM, JSON, GeoJSON, XML, ZIP
 * Non-text formats (PDF, Office, RDF, images) are skipped (contentIndexed: false).
 */

import { isTextFormat, isCsvFormat, isZipFormat, type ContentType } from '@kukan/shared'
import type { ContentDoc } from '@kukan/search-adapter'
import type { PipelineContext } from '../types'
import type { ExtractResult } from './extract'
import { streamToBuffer, streamUtf8Lines, bufferToUtf8 } from '../node-utils'
import { MAX_CONTENT_CHUNK_SIZE } from '@/config'

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
  extractResult: ExtractResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult | null> {
  const normalizedFormat = format?.toLowerCase() ?? null

  const contentType = getContentType(normalizedFormat)
  if (!contentType) {
    return null
  }

  const res = await ctx.getResource(resourceId)
  if (!res) return null

  if (contentType === 'manifest') {
    return indexManifest(resourceId, packageId, contentType, extractResult, ctx)
  }

  return indexTextStream(
    resourceId,
    packageId,
    storageKey,
    normalizedFormat!,
    contentType,
    extractResult,
    ctx
  )
}

/** Index ZIP manifest (small JSON, loaded fully) */
async function indexManifest(
  resourceId: string,
  packageId: string,
  contentType: ContentType,
  extractResult: ExtractResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult | null> {
  if (!extractResult?.previewKey) return null

  const manifestStream = await ctx.storage.download(extractResult.previewKey)
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

/** Stream text content line-by-line, chunking and indexing incrementally */
async function indexTextStream(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string,
  contentType: ContentType,
  extractResult: ExtractResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult> {
  const stream = await ctx.storage.download(storageKey)
  const encoding = extractResult?.encoding ?? 'UTF8'
  const isHtml = format === 'html' || format === 'htm'
  const isUtf8 = encoding === 'UTF8' || encoding === 'ASCII' || encoding === 'UNKNOWN'

  // Non-UTF-8: buffer entire file and convert (stateful encodings need full context)
  let lines: AsyncIterable<string> | Iterable<string>
  if (isUtf8) {
    lines = streamUtf8Lines(stream)
  } else {
    const buf = await streamToBuffer(stream)
    const text = bufferToUtf8(buf, encoding)
    lines = text.split('\n')
  }

  await ctx.deleteContent(resourceId)

  let chunkLines: string[] = []
  let chunkBytes = 0
  let chunkIndex = 0
  let totalOriginalBytes = 0
  let totalIndexedBytes = 0

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
    await ctx.indexContent(doc)

    totalIndexedBytes += textBytes
    chunkIndex++
    chunkLines = []
    chunkBytes = 0
  }

  let lineCount = 0
  for await (const rawLine of lines) {
    let line = rawLine
    if (isHtml) {
      line = line
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!line) continue
    }

    const lineBytes = Buffer.byteLength(line, 'utf-8')
    totalOriginalBytes += lineBytes + (lineCount > 0 ? 1 : 0) // +1 for newline separator
    lineCount++

    const lineBytesWithSep = lineBytes + (chunkLines.length > 0 ? 1 : 0)
    if (chunkBytes + lineBytesWithSep > MAX_CONTENT_CHUNK_SIZE && chunkLines.length > 0) {
      await flushChunk()
    }

    if (lineBytes > MAX_CONTENT_CHUNK_SIZE) {
      if (chunkLines.length > 0) {
        await flushChunk()
      }
      chunkLines.push(truncateToByteLimit(line, MAX_CONTENT_CHUNK_SIZE))
      chunkBytes = MAX_CONTENT_CHUNK_SIZE
      await flushChunk()
      continue
    }

    chunkLines.push(line)
    chunkBytes += lineBytesWithSep
  }

  // Flush remaining lines
  if (chunkLines.length > 0) {
    await flushChunk()
  }

  return {
    contentIndexed: chunkIndex > 0,
    contentType,
    contentOriginalSize: totalOriginalBytes,
    contentIndexedSize: totalIndexedBytes,
    contentTruncated: false,
    contentChunks: chunkIndex,
  }
}

/** Determine content type for indexing, or null if not indexable */
function getContentType(format: string | null): ContentType | null {
  if (isCsvFormat(format)) return 'tabular'
  if (isZipFormat(format)) return 'manifest'
  if (isTextFormat(format)) return 'text'
  return null
}

/**
 * Split text into chunks at line boundaries.
 * Each chunk is at most `maxChunkBytes` UTF-8 bytes.
 * Returns at most `maxChunks` chunks.
 */
export function splitIntoChunks(text: string, maxChunkBytes: number, maxChunks: number): string[] {
  const totalBytes = Buffer.byteLength(text, 'utf-8')

  if (totalBytes <= maxChunkBytes) {
    return [text]
  }

  const lines = text.split('\n')
  const chunks: string[] = []
  let currentLines: string[] = []
  let currentBytes = 0

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1

    if (currentBytes + lineBytes > maxChunkBytes && currentLines.length > 0) {
      chunks.push(currentLines.join('\n'))
      if (chunks.length >= maxChunks) return chunks
      currentLines = []
      currentBytes = 0
    }

    if (lineBytes > maxChunkBytes) {
      if (currentLines.length > 0) {
        chunks.push(currentLines.join('\n'))
        if (chunks.length >= maxChunks) return chunks
        currentLines = []
        currentBytes = 0
      }
      chunks.push(truncateToByteLimit(line, maxChunkBytes))
      if (chunks.length >= maxChunks) return chunks
      continue
    }

    currentLines.push(line)
    currentBytes += lineBytes
  }

  if (currentLines.length > 0 && chunks.length < maxChunks) {
    chunks.push(currentLines.join('\n'))
  }

  return chunks
}

/** Truncate a UTF-8 string to fit within a byte limit without splitting multi-byte characters */
function truncateToByteLimit(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) return text
  const sliced = buf.subarray(0, maxBytes)
  return sliced.toString('utf-8').replace(/\uFFFD$/, '')
}
