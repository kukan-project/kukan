/**
 * Node.js-specific stream and temp-file utilities (Buffer, Readable).
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { promisify } from 'node:util'

import { ENCODING_SAMPLE_SIZE, ENCODING_SCAN_LIMIT } from '@/config'

const pipelineAsync = promisify(pipeline)

/** Collect a Readable stream into a single Buffer, optionally capped at maxBytes.
 *  When capped, the chunk that crosses the cap IS included, so the returned
 *  buffer is >= maxBytes exactly when the source was truncated — callers can
 *  detect truncation by length. (Bounded overshoot of one chunk; never the
 *  whole oversize object.) */
export async function streamToBuffer(stream: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    chunks.push(buf)
    totalSize += buf.length
    if (maxBytes && totalSize >= maxBytes) {
      stream.destroy()
      break
    }
  }
  return Buffer.concat(chunks)
}

/**
 * Read as much of a stream as encoding detection needs, and no more.
 *
 * A fixed head is not enough. Detection learns only from the **non-ASCII**
 * bytes, and a file whose first megabyte is ids, dates and numbers holds none —
 * so a 64KB sample answers from nothing, and the Japanese further down comes
 * back as mojibake. Measured on a 104KB Shift_JIS text whose first 102KB were
 * ASCII: the sample said UTF-8, the whole file said Shift_JIS.
 *
 * So this reads until a non-ASCII byte turns up, then takes `window` bytes from
 * there. Everything before it is dropped as it goes: it is not evidence
 * ({@link detectEncoding} discards it anyway), and keeping it would mean
 * concatenating up to `limit` to return 64KB.
 *
 * A file that is ASCII to `limit` has nothing to find, and the head is returned
 * — chardet is synchronous and takes ~1s over 8MB where 64KB takes ~16ms, for
 * the same answer.
 */
export async function readEncodingSample(
  stream: Readable,
  window = ENCODING_SAMPLE_SIZE,
  limit = ENCODING_SCAN_LIMIT
): Promise<Buffer> {
  const kept: Buffer[] = []
  let keptBytes = 0
  let scanned = 0
  let found = false

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    scanned += buf.length

    if (found) {
      kept.push(buf)
      keptBytes += buf.length
    } else {
      const at = firstNonAscii(buf)
      if (at === -1) {
        // Still nothing. Hold the head in case the whole file is ASCII, and let
        // the rest go by — it would only be scanned again as filler.
        if (keptBytes < window) {
          kept.push(buf)
          keptBytes += buf.length
        }
      } else {
        found = true
        kept.length = 0
        kept.push(buf.subarray(at))
        keptBytes = buf.length - at
      }
    }

    if (scanned >= limit || keptBytes >= window) {
      stream.destroy()
      break
    }
  }
  // One chunk is the common case for a small file; concatenating it would copy
  // for nothing.
  return kept.length === 1 ? kept[0] : Buffer.concat(kept)
}

/**
 * Offset of the first byte the candidate encodings could disagree about.
 *
 * A plain loop rather than `findIndex`, whose per-byte JS callback costs ~7x
 * over the megabytes this scans before giving up on an ASCII file.
 */
function firstNonAscii(buf: Buffer): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] & 0x80) return i
  }
  return -1
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

/**
 * Rewrite a file as UTF-8 beside itself, returning the new path.
 *
 * Decoded a chunk at a time so a large file never becomes a single JS string —
 * the allocation ADR-046 set out to remove. `TextDecoderStream` carries the
 * decoder across chunk boundaries, which matters for every multi-byte encoding
 * and is the whole reason this cannot be a per-chunk `toString`.
 */
export async function transcodeToUtf8(filePath: string, charset: string): Promise<string> {
  const outPath = `${filePath}.utf8`
  await pipelineAsync(
    Readable.toWeb(createReadStream(filePath)) as unknown as NodeJS.ReadableStream,
    new TextDecoderStream(charset) as unknown as NodeJS.ReadWriteStream,
    createWriteStream(outPath)
  )
  return outPath
}

/** First `maxBytes` of a file. Allocates that much, so callers bound it. */
export async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Remove the temp file and its parent directory */
export async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true })
}
