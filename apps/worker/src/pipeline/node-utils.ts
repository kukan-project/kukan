/**
 * Node.js-specific utilities (Buffer, Readable, encoding detection).
 */

import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { promisify } from 'node:util'
import Encoding from 'encoding-japanese'

const pipelineAsync = promisify(pipeline)

// ---------------------------------------------------------------------------
// Encoding detection
// ---------------------------------------------------------------------------

/** Formats that need encoding-japanese auto-detection */
const AUTO_DETECT_FORMATS = new Set(['csv', 'tsv', 'txt', 'text', 'html', 'htm'])

/**
 * Detect encoding based on format-specific rules.
 * - CSV/TSV/TXT/HTML/HTM: encoding-japanese auto-detection
 * - XML: parse <?xml encoding="..."> declaration, default UTF-8
 * - JSON/GeoJSON/MD: UTF-8 fixed (by spec)
 *
 * @param format - lowercase format string
 */
export function detectEncoding(format: string, buffer: Buffer): string {
  if (AUTO_DETECT_FORMATS.has(format)) {
    const detected = Encoding.detect(buffer)
    return typeof detected === 'string' ? detected : 'UTF8'
  }
  if (format === 'xml') {
    return parseXmlDeclaredEncoding(buffer)
  }
  return 'UTF8'
}

/**
 * Parse encoding from XML declaration (<?xml ... encoding="..." ?>).
 * Returns encoding-japanese compatible name, or 'UTF8' if no declaration.
 */
function parseXmlDeclaredEncoding(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString('ascii')
  const match = head.match(/<\?xml[^?]*encoding=["']([^"']+)["']/)
  if (!match) return 'UTF8'
  return xmlEncodingToDetectName(match[1])
}

/** Map XML encoding declaration values to encoding-japanese names */
const XML_ENCODING_MAP: Record<string, string> = {
  'utf-8': 'UTF8',
  shift_jis: 'SJIS',
  'euc-jp': 'EUCJP',
  'iso-2022-jp': 'JIS',
}

function xmlEncodingToDetectName(declared: string): string {
  return XML_ENCODING_MAP[declared.toLowerCase()] ?? 'UTF8'
}

/** Convert buffer to UTF-8 string using detected encoding */
export function bufferToUtf8(buf: Buffer, encoding: string): string {
  if (encoding !== 'UTF8' && encoding !== 'ASCII' && encoding !== 'UNKNOWN') {
    const converted = Encoding.convert(buf, { to: 'UNICODE', from: encoding as Encoding.Encoding })
    return Encoding.codeToString(converted)
  }
  return buf.toString('utf-8')
}

/** Collect a Readable stream into a single Buffer, optionally capped at maxBytes */
export async function streamToBuffer(stream: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += buf.length
    if (maxBytes && totalSize > maxBytes) {
      stream.destroy()
      break
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Yield lines from a UTF-8 stream without loading the entire file into memory.
 *  Uses StringDecoder to handle multi-byte characters split across chunk boundaries. */
export async function* streamUtf8Lines(stream: Readable): AsyncGenerator<string> {
  const { StringDecoder } = await import('node:string_decoder')
  const decoder = new StringDecoder('utf-8')
  let leftover = ''

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const text = decoder.write(buf)
    const parts = (leftover + text).split('\n')
    leftover = parts.pop()!
    for (const line of parts) {
      yield line
    }
  }

  const remaining = decoder.end()
  if (remaining || leftover) {
    yield leftover + remaining
  }
}

/** Write a Readable stream to a temp file and return its path */
export async function streamToTempFile(stream: Readable): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kukan-'))
  const filePath = join(dir, 'data')
  await pipelineAsync(stream, createWriteStream(filePath))
  return filePath
}

/** Remove the temp file and its parent directory */
export async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true })
}
