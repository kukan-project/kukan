import { Readable } from 'node:stream'
import { documentTextBlocks, type DocumentTextBlock } from '@kukan/shared'
import { zstdLines } from '../../pipeline/node-utils'

/** A document text artifact's blocks, read as the pipeline reads them. */
export async function artifactBlocks(artifact: Buffer): Promise<DocumentTextBlock[]> {
  const blocks: DocumentTextBlock[] = []
  for await (const block of documentTextBlocks(zstdLines(Readable.from(artifact)))) {
    blocks.push(block)
  }
  return blocks
}
