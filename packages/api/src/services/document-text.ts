/**
 * Reading a document's text artifact back: the blocks the worker wrote, with
 * where each sits in the file (see `DocumentTextBlock`). What the resource page
 * shows beside the original, so that what extraction made of a file can be
 * seen and the extraction tuned, and the head of the text the suggestion and
 * the abstract are written from (ADR-040, ADR-053).
 */

import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { StorageAdapter } from '@kukan/storage-adapter'
import { documentTextBlocks, type DocumentText, type DocumentTextBlock } from '@kukan/shared'
import { truncateToByteLimit } from '@kukan/shared/encoding-node'

/** The artifact's lines as decompressed; what is left unread is not downloaded. */
async function* artifactLines(storage: StorageAdapter, key: string): AsyncGenerator<string> {
  const source = await storage.download(key)
  // pipeline, not pipe: a download that fails midway has to fail the read
  const lines = createInterface({
    input: pipeline(source, createZstdDecompress(), () => {}),
    crlfDelay: Infinity,
  })
  try {
    yield* lines
  } finally {
    lines.close()
    source.destroy()
  }
}

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
  let bytes = 0
  async function* counted() {
    for await (const line of artifactLines(storage, key)) {
      bytes += Buffer.byteLength(line, 'utf-8')
      yield line
    }
  }
  const blocks: DocumentTextBlock[] = []
  let full = false
  let truncated = false
  for await (const block of documentTextBlocks(counted())) {
    // Only a block past the limit says there was more
    if (full) {
      truncated = true
      break
    }
    blocks.push(block)
    full = bytes >= limit
  }
  return { blocks, truncated }
}

/**
 * The first `limit` UTF-8 bytes of the text, a newline between the blocks
 * that have any; a character the cut splits is dropped.
 */
export async function readDocumentTextHead(
  storage: StorageAdapter,
  key: string,
  limit: number
): Promise<string> {
  const texts: string[] = []
  let bytes = 0
  for await (const { text } of documentTextBlocks(artifactLines(storage, key))) {
    if (!text) continue
    // The newline is before every block but the first
    bytes += Buffer.byteLength(text, 'utf-8') + (texts.length > 0 ? 1 : 0)
    texts.push(text)
    if (bytes >= limit) break
  }
  return truncateToByteLimit(texts.join('\n'), limit)
}
