/**
 * Node.js-specific stream and temp-file utilities (Buffer, Readable).
 */

import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import { promisify } from 'node:util'

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
