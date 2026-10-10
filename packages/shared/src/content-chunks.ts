/**
 * Where the content index's chunks break (ADR-021). Node only: it counts bytes.
 *
 * A document's text is indexed as the lines of its blocks, joined by a newline,
 * cut into chunks of up to MAX_CONTENT_CHUNK_SIZE bytes at a line's end; a line
 * longer than that is cut to a chunk of its own. The worker cuts the text by
 * it, and a passage search finds which part of a document's text a chunk holds
 * by it (ADR-061 §決定 4) — the one rule for both, so a fragment the index cut
 * is looked for where it is.
 */

import { MAX_CONTENT_CHUNK_SIZE } from './formats'
import { truncateToByteLimit } from './encoding-node'
import type { DocumentTextBlock } from './pipeline-types'

/** The lines a block adds to the indexed text: none for a block without text. */
export function indexedLines(block: DocumentTextBlock): string[] {
  return block.text ? block.text.split('\n') : []
}

export interface PlacedLine {
  /** The line's UTF-8 bytes */
  bytes: number
  /** The chunk so far ends before this line */
  breakBefore: boolean
  /** What of the line the chunk holds: all of it, or — where it is longer than a
   *  chunk — as much as fits, in a chunk of its own that the next line does not join */
  kept: string
  alone: boolean
}

export class ContentChunkCutter {
  private bytes = 0
  private lines = 0

  constructor(private readonly max = MAX_CONTENT_CHUNK_SIZE) {}

  place(line: string): PlacedLine {
    const bytes = Buffer.byteLength(line, 'utf-8')
    // The newline is counted against the chunk it joins, even where the line
    // goes on to start the next one
    const withNewline = bytes + (this.lines > 0 ? 1 : 0)
    let breakBefore = false
    if (this.lines > 0 && this.bytes + withNewline > this.max) {
      breakBefore = true
      this.bytes = 0
      this.lines = 0
    }
    if (bytes > this.max) {
      return { bytes, breakBefore, kept: truncateToByteLimit(line, this.max), alone: true }
    }
    this.lines++
    this.bytes += withNewline
    return { bytes, breakBefore, kept: line, alone: false }
  }
}
