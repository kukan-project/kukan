/**
 * KUKAN Pipeline — Index Step
 * Extracts text content from resources and indexes it into OpenSearch (kukan-contents).
 * Text formats are processed as a stream — no file size limit on indexable content.
 * Large texts are split into multiple chunks (up to MAX_CONTENT_CHUNKS × MAX_CONTENT_CHUNK_SIZE).
 * Also records content indexing metadata in resource_pipeline.metadata.
 *
 * Document formats additionally persist the head of the extracted text to
 * storage as AI-suggest material (ADR-040 addendum). Drafts run only that
 * extraction + persistence — search indexing starts at publish (ADR-039).
 *
 * Supported formats: CSV, TSV, TXT, MD, HTML, HTM, JSON, GeoJSON, XML, ZIP,
 *                    PDF, DOCX, XLSX, PPTX, ODT, ODP, ODS, RTF
 * Non-text formats (DOC, XLS, PPT, RDF, images) are skipped (contentIndexed: false).
 */

import { randomUUID } from 'node:crypto'
import {
  isTextFormat,
  isCsvFormat,
  isZipFormat,
  isDocumentFormat,
  getPreviewKey,
  type ContentType,
} from '@kukan/shared'
import { OfficeParser } from 'officeparser'
import type { ContentDoc } from '@kukan/search-adapter'
import type { PipelineContext } from '../types'
import type { InterpretResult } from './interpret'
import { streamToBuffer, streamUtf8Lines, streamToTempFile, cleanupTempFile } from '../node-utils'
import { bufferToUtf8, stripTrailingReplacementChar } from '@kukan/shared/encoding-node'
import { MAX_CONTENT_CHUNK_SIZE, MAX_FETCH_SIZE, TEXT_HEAD_ARTIFACT_SIZE } from '@/config'

export interface IndexContentResult {
  contentIndexed: boolean
  contentType: ContentType | null
  contentOriginalSize: number
  contentIndexedSize: number
  contentTruncated: boolean
  contentChunks: number
  /** Storage key/size of the persisted text head — document formats only (ADR-040) */
  textHeadKey?: string
  textHeadBytes?: number
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

  // Draft packages stay out of the content index until publish (ADR-039), but
  // document formats still persist the text-head artifact so AI suggestions
  // work during draft editing (ADR-040 addendum). Deleted/purging packages
  // skip everything — they must not be re-indexed.
  const pkgState = await ctx.getPackageState(packageId)
  if (pkgState !== 'active' && pkgState !== 'draft') return null

  const contentType = getContentType(normalizedFormat)
  if (pkgState === 'draft' && contentType !== 'document') return null

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
    return indexDocument(
      resourceId,
      packageId,
      storageKey,
      normalizedFormat!,
      contentType,
      pkgState === 'active',
      ctx
    )
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
 * Extract text from a binary document (PDF, etc.), persist the text head as
 * AI-suggest material (ADR-040), then chunk and index. When `indexToSearch`
 * is false (draft package) only the artifact is produced.
 */
async function indexDocument(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string,
  contentType: ContentType,
  indexToSearch: boolean,
  ctx: PipelineContext
): Promise<IndexContentResult> {
  const stream = await ctx.storage.download(storageKey)
  const tempPath = await streamToTempFile(stream, format)

  try {
    const text = await extractDocumentText(tempPath)
    if (!text) {
      return {
        contentIndexed: false,
        contentType,
        contentOriginalSize: 0,
        contentIndexedSize: 0,
        contentTruncated: false,
        contentChunks: 0,
      }
    }
    const contentOriginalSize = Buffer.byteLength(text, 'utf-8')

    // officeparser output is already a JS string, so the artifact is plain
    // UTF-8 — the suggest side reads it without encoding detection. Pre-slice
    // by char count before the byte-limit cut: every UTF-16 code unit encodes
    // to ≥1 UTF-8 byte, so this avoids buffering the full text to keep 64 KB
    // (a char broken by the slice can only be the last one — the byte cut and
    // trailing-U+FFFD strip clean it up).
    const textHead = Buffer.from(
      truncateToByteLimit(text.slice(0, TEXT_HEAD_ARTIFACT_SIZE), TEXT_HEAD_ARTIFACT_SIZE),
      'utf-8'
    )
    const textHeadKey = getPreviewKey(packageId, resourceId, 'txt', randomUUID())
    await ctx.putObject(textHeadKey, textHead, {
      contentType: 'text/plain; charset=utf-8',
    })

    let chunks: string[] = []
    let totalIndexedBytes = 0

    if (indexToSearch) {
      await ctx.deleteContent(resourceId)

      chunks = splitIntoChunks(text, MAX_CONTENT_CHUNK_SIZE, Infinity)
      for (let i = 0; i < chunks.length; i++) {
        const chunkSize = Buffer.byteLength(chunks[i], 'utf-8')
        const doc: ContentDoc = {
          resourceId,
          packageId,
          extractedText: chunks[i],
          contentType,
          chunkIndex: i,
          chunkSize,
        }
        await ctx.indexContent(doc)
        totalIndexedBytes += chunkSize
      }
    }

    return {
      contentIndexed: chunks.length > 0,
      contentType,
      contentOriginalSize,
      contentIndexedSize: totalIndexedBytes,
      contentTruncated: false,
      contentChunks: chunks.length,
      textHeadKey,
      textHeadBytes: textHead.length,
    }
  } finally {
    await cleanupTempFile(tempPath)
  }
}

/** Extract text from a document file (PDF, DOCX, XLSX, PPTX) using officeparser. */
async function extractDocumentText(filePath: string): Promise<string> {
  const ast = await OfficeParser.parseOffice(filePath)
  return ast.toText()
}

/** Stream text content line-by-line, chunking and indexing incrementally */
async function indexTextStream(
  resourceId: string,
  packageId: string,
  storageKey: string,
  format: string,
  contentType: ContentType,
  interpretResult: InterpretResult | null,
  ctx: PipelineContext
): Promise<IndexContentResult> {
  const stream = await ctx.storage.download(storageKey)
  const encoding = interpretResult?.encoding ?? 'UTF8'
  const isHtml = format === 'html' || format === 'htm'
  const enc = encoding.toLowerCase()
  const isUtf8 = enc === 'utf8' || enc === 'utf-8' || enc === 'ascii' || enc === 'unknown'

  // Non-UTF-8: buffer file and convert (stateful encodings need full context).
  // Cap the buffer at the max legitimate file size so an oversize object can't
  // OOM the worker; a truncated tail is acceptable degradation for indexing.
  let lines: AsyncIterable<string> | Iterable<string>
  if (isUtf8) {
    lines = streamUtf8Lines(stream)
  } else {
    const buf = await streamToBuffer(stream, MAX_FETCH_SIZE)
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
  if (isDocumentFormat(format)) return 'document'
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
  return stripTrailingReplacementChar(sliced.toString('utf-8'))
}
