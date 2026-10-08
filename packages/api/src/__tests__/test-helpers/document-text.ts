import { zstdCompressSync } from 'node:zlib'
import { DOCUMENT_TEXT_SCHEMA, type DocumentTextBlock } from '@kukan/shared'

/** A document text artifact holding `lines` — blocks, or raw lines to break it — as Interpret writes one. */
export function artifactOf(lines: (DocumentTextBlock | string)[]): Buffer {
  return zstdCompressSync(
    [{ schema: DOCUMENT_TEXT_SCHEMA }, ...lines]
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
      .join('')
  )
}
