/**
 * KUKAN Pipeline — Index Step
 * Extracts text content from resources and indexes it into OpenSearch (kukan-contents).
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
import { streamToBuffer, bufferToUtf8 } from '../node-utils'
import { MAX_CONTENT_CHUNK_SIZE, MAX_CONTENT_CHUNKS, MAX_CONTENT_DOWNLOAD_SIZE } from '@/config'

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

  // Determine content type
  const contentType = getContentType(normalizedFormat)
  if (!contentType) {
    return null // Not indexable (PDF, Office, etc.)
  }

  // Get resource metadata for the search document
  const res = await ctx.getResource(resourceId)
  if (!res) return null

  let extractedText: string

  if (contentType === 'manifest') {
    // ZIP: read manifest JSON from preview key
    if (!extractResult?.previewKey) return null
    const manifestStream = await ctx.storage.download(extractResult.previewKey)
    const manifestBuf = await streamToBuffer(manifestStream, MAX_CONTENT_DOWNLOAD_SIZE)
    const manifest = JSON.parse(manifestBuf.toString('utf-8'))
    // Extract file paths as searchable text
    const paths = (manifest.entries ?? []).map((e: { path: string }) => e.path).join('\n')
    extractedText = paths
  } else {
    // Text formats: download original file
    const stream = await ctx.storage.download(storageKey)
    const buf = await streamToBuffer(stream, MAX_CONTENT_DOWNLOAD_SIZE)
    const encoding = extractResult?.encoding ?? 'UTF8'
    extractedText = bufferToUtf8(buf, encoding)

    // Strip HTML tags for HTML/HTM
    if (normalizedFormat === 'html' || normalizedFormat === 'htm') {
      extractedText = extractedText
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
  }

  const originalSize = Buffer.byteLength(extractedText, 'utf-8')

  const chunks = splitIntoChunks(extractedText, MAX_CONTENT_CHUNK_SIZE, MAX_CONTENT_CHUNKS)
  const truncated = originalSize > MAX_CONTENT_CHUNK_SIZE * MAX_CONTENT_CHUNKS

  await ctx.deleteContent(resourceId)

  let totalIndexedSize = 0
  for (let i = 0; i < chunks.length; i++) {
    const doc: ContentDoc = {
      resourceId,
      packageId,
      extractedText: chunks[i],
      contentType,
      chunkIndex: i,
      totalChunks: chunks.length,
      contentTruncated: truncated,
      contentOriginalSize: originalSize,
    }
    await ctx.indexContent(doc)
    totalIndexedSize += Buffer.byteLength(chunks[i], 'utf-8')
  }

  return {
    contentIndexed: true,
    contentType,
    contentOriginalSize: originalSize,
    contentIndexedSize: totalIndexedSize,
    contentTruncated: truncated,
    contentChunks: chunks.length,
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

  // Small enough for a single chunk
  if (totalBytes <= maxChunkBytes) {
    return [text]
  }

  const lines = text.split('\n')
  const chunks: string[] = []
  let currentLines: string[] = []
  let currentBytes = 0

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1 // +1 for newline

    if (currentBytes + lineBytes > maxChunkBytes && currentLines.length > 0) {
      // Flush current chunk
      chunks.push(currentLines.join('\n'))
      if (chunks.length >= maxChunks) return chunks

      currentLines = []
      currentBytes = 0
    }

    // Handle single line exceeding chunk size: truncate it
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

  // Flush remaining
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
