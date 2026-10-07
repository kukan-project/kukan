import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { DOCUMENT_TEXT_SCHEMA, documentTextBlocks, type DocumentTextBlock } from '@kukan/shared'
import { zstdLines } from '../../pipeline/node-utils'

/** A document text artifact holding `blocks`, as Interpret writes one. */
export function artifactOf(blocks: DocumentTextBlock[]): Buffer {
  return zstdCompressSync(
    [{ schema: DOCUMENT_TEXT_SCHEMA }, ...blocks]
      .map((line) => JSON.stringify(line) + '\n')
      .join('')
  )
}

/** A document text artifact's blocks, read as the pipeline reads them. */
export async function artifactBlocks(artifact: Buffer): Promise<DocumentTextBlock[]> {
  const blocks: DocumentTextBlock[] = []
  for await (const block of documentTextBlocks(zstdLines(Readable.from(artifact)))) {
    blocks.push(block)
  }
  return blocks
}
