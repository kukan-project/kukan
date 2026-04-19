/**
 * KUKAN Pipeline — Index Step
 * Extracts text content from resources and indexes it into OpenSearch (kukan-resources).
 * Also records content indexing metadata in resource_pipeline.metadata.
 *
 * Supported formats: CSV, TSV, TXT, MD, HTML, HTM, JSON, GeoJSON, XML, ZIP
 * Non-text formats (PDF, Office, RDF, images) are skipped (contentIndexed: false).
 */

import { isTextFormat, isCsvFormat, isZipFormat, type ContentType } from '@kukan/shared'
import type { ResourceDoc } from '@kukan/search-adapter'
import type { PipelineContext } from '../types'
import type { ExtractResult } from './extract'
import { streamToBuffer, bufferToUtf8 } from '../node-utils'
import { MAX_CONTENT_INDEX_SIZE, MAX_CONTENT_DOWNLOAD_SIZE } from '@/config'

export interface IndexContentResult {
  contentIndexed: boolean
  contentType: ContentType | null
  contentOriginalSize: number
  contentIndexedSize: number
  contentTruncated: boolean
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
    const paths = (manifest.entries ?? [])
      .map((e: { path: string }) => e.path)
      .join('\n')
    extractedText = paths
  } else {
    // Text formats: download original file
    const stream = await ctx.storage.download(storageKey)
    const buf = await streamToBuffer(stream, MAX_CONTENT_DOWNLOAD_SIZE)
    const encoding = extractResult?.encoding ?? 'UTF8'
    extractedText = bufferToUtf8(buf, encoding)

    // Strip HTML tags for HTML/HTM
    if (normalizedFormat === 'html' || normalizedFormat === 'htm') {
      extractedText = extractedText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    }
  }

  const originalSize = Buffer.byteLength(extractedText, 'utf-8')
  let indexedText = extractedText
  let truncated = false

  if (originalSize > MAX_CONTENT_INDEX_SIZE) {
    // Truncate at character boundary near the byte limit
    indexedText = truncateToByteLimit(extractedText, MAX_CONTENT_INDEX_SIZE)
    truncated = true
  }

  const indexedSize = Buffer.byteLength(indexedText, 'utf-8')

  // Build and index the resource document
  const doc: ResourceDoc = {
    id: resourceId,
    packageId,
    name: res.name ?? res.url ?? undefined,
    description: res.description ?? undefined,
    format: res.format ?? undefined,
    extractedText: indexedText,
    contentType,
    contentTruncated: truncated,
    contentOriginalSize: originalSize,
  }

  await ctx.indexResource(doc)

  return {
    contentIndexed: true,
    contentType,
    contentOriginalSize: originalSize,
    contentIndexedSize: indexedSize,
    contentTruncated: truncated,
  }
}

/** Determine content type for indexing, or null if not indexable */
function getContentType(format: string | null): ContentType | null {
  if (isCsvFormat(format)) return 'tabular'
  if (isZipFormat(format)) return 'manifest'
  if (isTextFormat(format)) return 'text'
  return null
}

/** Truncate a UTF-8 string to fit within a byte limit without splitting multi-byte characters */
function truncateToByteLimit(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) return text
  // Slice at byte boundary, then decode — invalid trailing bytes are dropped
  const sliced = buf.subarray(0, maxBytes)
  return sliced.toString('utf-8').replace(/\uFFFD$/, '')
}
