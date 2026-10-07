/**
 * Reading a document's text artifact back: the blocks the worker wrote, with
 * where each sits in the file (see `DocumentTextBlock`). What the resource page
 * shows beside the original, so that what extraction made of a file can be
 * seen and the extraction tuned.
 */

import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { documentTextBlocks, type DocumentText, type DocumentTextBlock } from '@kukan/shared'

/**
 * The artifact's blocks, up to `limit` bytes of them as stored: the rest is
 * left unread, and `truncated` says there was more. Counted by the line rather
 * than the text, so a document of figures is bounded too; a block is never cut
 * — the one that crosses the limit is the last returned.
 */
export async function readDocumentText(
  storage: StorageAdapter,
  key: string,
  limit: number
): Promise<DocumentText> {
  const source = await storage.download(key)
  // pipeline, not pipe: a download that fails midway has to fail the read
  const lines = createInterface({
    input: pipeline(source, createZstdDecompress(), () => {}),
    crlfDelay: Infinity,
  })
  let bytes = 0
  async function* counted() {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line, 'utf-8')
      yield line
    }
  }
  const blocks: DocumentTextBlock[] = []
  let full = false
  let truncated = false
  try {
    for await (const block of documentTextBlocks(counted())) {
      // Only a block past the limit says there was more
      if (full) {
        truncated = true
        break
      }
      blocks.push(block)
      full = bytes >= limit
    }
  } finally {
    lines.close()
    source.destroy()
  }
  return { blocks, truncated }
}
