/**
 * Node.js-specific utilities (Buffer, Readable, encoding detection).
 */

import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { promisify } from 'node:util'
import chardet from 'chardet'

const pipelineAsync = promisify(pipeline)

// ---------------------------------------------------------------------------
// Encoding detection
// ---------------------------------------------------------------------------

const AUTO_DETECT_FORMATS = new Set(['csv', 'tsv', 'txt', 'text', 'html', 'htm'])

/**
 * Detect encoding based on format-specific rules.
 * - CSV/TSV/TXT/HTML/HTM: chardet auto-detection (Mozilla universal charset detector)
 * - XML: parse <?xml encoding="..."> declaration, default UTF-8
 * - JSON/GeoJSON/MD: UTF-8 fixed (by spec)
 *
 * chardet returns encoding names in IANA format (e.g. "Shift_JIS", "UTF-8").
 * bufferToUtf8() uses TextDecoder which accepts IANA names directly.
 *
 * @param format - lowercase format string
 */
export function detectEncoding(format: string, buffer: Buffer): string {
  if (AUTO_DETECT_FORMATS.has(format)) {
    const detected = chardet.detect(buffer)
    return detected ?? 'UTF-8'
  }
  if (format === 'xml') {
    return parseXmlDeclaredEncoding(buffer)
  }
  return 'UTF-8'
}

/**
 * Parse encoding from XML declaration (<?xml ... encoding="..." ?>).
 * Returns IANA encoding name, or 'UTF-8' if no declaration.
 */
function parseXmlDeclaredEncoding(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString('ascii')
  const match = head.match(/<\?xml[^?]*encoding=["']([^"']+)["']/)
  return match ? match[1] : 'UTF-8'
}

/** Map legacy encoding-japanese names to IANA names for TextDecoder */
const LEGACY_ENCODING_MAP: Record<string, string> = {
  utf8: 'utf-8',
  sjis: 'shift_jis',
  eucjp: 'euc-jp',
  jis: 'iso-2022-jp',
  unicode: 'utf-8',
  unknown: 'utf-8',
}

/** Convert buffer to UTF-8 string using detected encoding.
 *  Uses Node.js TextDecoder which supports IANA encoding names
 *  (Shift_JIS, EUC-JP, EUC-KR, Big5, GB18030, ISO-8859-*, Windows-125*, etc.).
 *  Also accepts legacy encoding-japanese names (SJIS, EUCJP, JIS) for
 *  backward compatibility with existing pipeline data. */
export function bufferToUtf8(buf: Buffer, encoding: string): string {
  const lower = encoding.toLowerCase()
  const iana = LEGACY_ENCODING_MAP[lower] ?? lower
  if (iana === 'utf-8' || iana === 'ascii') {
    return buf.toString('utf-8')
  }
  const decoder = new TextDecoder(iana)
  return decoder.decode(buf)
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
export async function streamToTempFile(stream: Readable, ext?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kukan-'))
  const safeExt = ext?.replace(/[^a-zA-Z0-9]/g, '')
  const filePath = join(dir, safeExt ? `data.${safeExt}` : 'data')
  await pipelineAsync(stream, createWriteStream(filePath))
  return filePath
}

/** Remove the temp file and its parent directory */
export async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true })
}
