/**
 * The text of a document text artifact (see `DocumentTextBlock`), as lines:
 * what the content index is built from, and what the text head is cut from.
 * Apart from the extraction so the parent process can read an artifact
 * without loading the document parsers.
 */

import type { Readable } from 'node:stream'
import { documentTextBlocks } from '@kukan/shared'
import { zstdLines } from './node-utils'

/** Each block's lines, the blocks with none left out. */
export async function* documentTextLines(artifact: Readable): AsyncGenerator<string> {
  for await (const { text } of documentTextBlocks(zstdLines(artifact))) {
    if (text) yield* text.split('\n')
  }
}
