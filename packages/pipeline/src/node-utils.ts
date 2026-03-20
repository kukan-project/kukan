/**
 * Node.js-specific utilities (Buffer, Readable).
 */

import { Readable } from 'stream'
import Encoding from 'encoding-japanese'

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
