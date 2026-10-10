/**
 * Cutting passages out of a document's text (ADR-061 §決定 4, the second stage).
 *
 * The text is the artifact's blocks with text, joined by a newline: what the
 * content index was built from, so a fragment the index cut is found in it
 * verbatim. The artifact is read once, as a stream, and only a window of its
 * text is held — a workbook's text can run to tens of megabytes.
 */

import type { DocumentTextBlock, DocumentTextLoc } from '@kukan/shared'
import { ContentChunkCutter, indexedLines } from '@kukan/shared/content-chunks'
import { PASSAGE_MARK } from '@kukan/search-adapter'

/** [start, end) in a text */
export type Span = [number, number]

/** A fragment with its marks taken out: its text, and where the marked words are in it. */
export interface UnmarkedText {
  text: string
  marks: Span[]
}

export function unmark(fragment: string): UnmarkedText {
  const marks: Span[] = []
  let text = ''
  let open = -1
  for (const char of fragment) {
    if (char === PASSAGE_MARK.open) open = text.length
    else if (char === PASSAGE_MARK.close) {
      if (open >= 0) marks.push([open, text.length])
      open = -1
    } else text += char
  }
  return { text, marks }
}

/** A block with text, where its text starts in the joined text; its text itself is not kept. */
export interface TextBlockAt {
  /** The block's index in the artifact, as get_document_section's cursor counts it */
  index: number
  start: number
  end: number
  loc: DocumentTextLoc
  headings?: string[]
}

/** A passage found in the text: offsets are into the whole joined text. */
export interface FoundPassage {
  start: number
  end: number
  /** The matched words, in the same offsets */
  marks: Span[]
}

export interface CutPassage extends FoundPassage {
  text: string
  /** The blocks the passage spans, first to last */
  blocks: TextBlockAt[]
  /** The matched words, as written in the text */
  words: string[]
}

/**
 * The text read so far, of which only the tail from `base` is held, with the
 * blocks it is in from there on and where each chunk of the content index is
 * in it — cut by the worker's own rule, so the two cannot disagree.
 */
export class TextWindow {
  private buf = ''
  private base = 0
  private lines = 0
  private readonly cutter = new ContentChunkCutter()
  /** Whether the last chunk may take more lines */
  private chunkOpen = false
  readonly blocks: TextBlockAt[] = []
  /** Where each chunk of the content index is in the text, in order */
  readonly chunks: Span[] = []

  get end(): number {
    return this.base + this.buf.length
  }

  get start(): number {
    return this.base
  }

  append(index: number, block: DocumentTextBlock) {
    const lines = indexedLines(block)
    if (lines.length === 0) return
    const blockStart = this.end + (this.lines > 0 ? 1 : 0)
    for (const line of lines) {
      if (this.lines++ > 0) this.buf += '\n'
      const lineStart = this.end
      this.buf += line
      const { breakBefore, kept, alone } = this.cutter.place(line)
      if (breakBefore || !this.chunkOpen) {
        this.chunks.push([lineStart, lineStart])
        this.chunkOpen = true
      }
      this.chunks.at(-1)![1] = lineStart + kept.length
      // Nothing after a line cut to a chunk of its own joins that chunk
      if (alone) this.chunkOpen = false
    }
    this.blocks.push({
      index,
      start: blockStart,
      end: this.end,
      loc: block.loc,
      headings: block.headings,
    })
  }

  /** The text has ended: its last chunk takes nothing more. */
  close() {
    this.chunkOpen = false
  }

  /** Whether chunk `n` has all its lines: a later one has begun, or it can take no more. */
  chunkComplete(n: number): boolean {
    return n < this.chunks.length - 1 || (n === this.chunks.length - 1 && !this.chunkOpen)
  }

  slice(start: number, end: number): string {
    return this.buf.slice(start - this.base, end - this.base)
  }

  indexOf(text: string, from: number): number {
    const at = this.buf.indexOf(text, Math.max(0, from - this.base))
    return at < 0 ? -1 : at + this.base
  }

  lastIndexOf(text: string, before: number): number {
    const at = this.buf.lastIndexOf(text, before - this.base)
    return at < 0 ? -1 : at + this.base
  }

  /** Let go of the text before `pos`, and of the blocks that end before it. */
  dropBefore(pos: number) {
    if (pos <= this.base) return
    this.buf = this.buf.slice(pos - this.base)
    this.base = pos
    const kept = this.blocks.findIndex((b) => b.end > pos)
    this.blocks.splice(0, kept < 0 ? this.blocks.length : kept)
  }

  /** The block `pos` is in, or the last before it. */
  blockAt(pos: number): TextBlockAt | undefined {
    let found: TextBlockAt | undefined
    for (const block of this.blocks) {
      if (block.start > pos) break
      found = block
    }
    return found
  }

  /** The blocks [start, end) overlaps. */
  blocksOver(start: number, end: number): TextBlockAt[] {
    return this.blocks.filter((b) => b.start < end && b.end > start)
  }
}

/** What finds passages in the text as it is read. */
export interface PassageFinder {
  /** The text has grown: the passages now found. */
  feed(window: TextWindow): FoundPassage[]
  /** The text has ended: the rest. */
  finish(window: TextWindow): FoundPassage[]
  /** The earliest offset still to be looked at. */
  keepFrom(window: TextWindow): number
  /** Whether nothing is left to find: the read stops. */
  done(): boolean
}

/** A fragment as the index cut it, and the chunk of the text it is from. */
export interface IndexedFragment {
  fragment: string
  chunkIndex: number
}

/**
 * Finds the fragments a search backend cut, which are verbatim in the chunk
 * of the text they are from. A fragment is looked for in that chunk alone, and
 * once, when the chunk is all read: the same words elsewhere — a table of
 * contents, a header on every page — are not where the index matched, and a
 * fragment the chunk does not hold (an index older than the text) is given up
 * there, not after the whole of a long document.
 */
export class FragmentFinder implements PassageFinder {
  private pending: { text: string; marks: Span[]; chunk: number }[]

  constructor(fragments: IndexedFragment[]) {
    this.pending = fragments
      .map(({ fragment, chunkIndex }) => ({ ...unmark(fragment), chunk: chunkIndex }))
      .filter((f) => f.text.length > 0)
  }

  feed(window: TextWindow): FoundPassage[] {
    const found: FoundPassage[] = []
    this.pending = this.pending.filter((f) => {
      if (!window.chunkComplete(f.chunk)) return true
      const [start, end] = window.chunks[f.chunk]!
      const at = window.indexOf(f.text, start)
      if (at >= 0 && at + f.text.length <= end) {
        found.push({
          start: at,
          end: at + f.text.length,
          marks: f.marks.map(([s, e]) => [at + s, at + e]),
        })
      }
      return false
    })
    return found
  }

  finish(window: TextWindow): FoundPassage[] {
    return this.feed(window)
  }

  keepFrom(window: TextWindow): number {
    return Math.min(
      window.end,
      ...this.pending.map((f) => window.chunks[f.chunk]?.[0] ?? window.end)
    )
  }

  done(): boolean {
    return this.pending.length === 0
  }
}

/**
 * Full-width letters, digits and signs made narrow, and upper case lower — a
 * character for a character, so the offsets stay those of the text. What a
 * query is made into by NFKC, short of the half-width katakana a document
 * seldom holds.
 */
function foldWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E\u3000A-Z]/g, (c) => {
    if (c === '\u3000') return ' '
    const narrow = c > '\u00FF' ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c
    return narrow.toLowerCase()
  })
}

/**
 * The words to look for, where nothing analyses the query: the words it is
 * spaced into, and within each, its runs of kanji, katakana, letters and
 * digits — the hiragana between them, in Japanese written without spaces, is
 * mostly particles. A word in Latin letters and digits is kept whole
 * (`COVID-19`), and so is one that leaves no run of two characters.
 */
export function queryWords(q: string, max = Infinity): string[] {
  const words = new Set<string>()
  for (const token of q.normalize('NFKC').split(/\s+/)) {
    if (!token) continue
    const runs = /^[\p{Script=Latin}\p{N}\p{P}]+$/u.test(token)
      ? [token]
      : (
          token.match(/[\p{Script=Han}\p{Script=Katakana}ー々〆ヶ\p{Script=Latin}\p{N}]+/gu) ?? []
        ).filter((run) => run.length >= 2)
    for (const word of runs.length > 0 ? runs : [token]) words.add(foldWidth(word))
  }
  return [...words].slice(0, max)
}

/** Characters of text a word scan looks through at once: what bounds the hits it holds. */
const SCAN_STEP = 16_384

/**
 * Finds the words in the text by their letters, where there is no index to
 * have cut the passages: a passage is opened around the first occurrence not
 * in one yet, and takes in the occurrences that fall inside it. Every word is
 * looked for in each stretch of the text before the next, so no word's hits
 * crowd out another's; which passages are kept is left to `cutPassages`.
 */
export class WordFinder implements PassageFinder {
  private longest: number
  private scannedTo = 0
  private open: FoundPassage | null = null
  /** How many of each word the open passage has recorded */
  private openCounts: number[] = []

  constructor(
    private words: string[],
    private chars: number,
    /** Occurrences of one word a passage records, at most */
    private maxMarks = Infinity
  ) {
    this.longest = Math.max(1, ...words.map((w) => w.length))
  }

  feed(window: TextWindow): FoundPassage[] {
    return this.scan(window, window.end - this.longest + 1)
  }

  finish(window: TextWindow): FoundPassage[] {
    const found = this.scan(window, window.end)
    if (this.open) found.push(this.open)
    this.open = null
    return found
  }

  private scan(window: TextWindow, upTo: number): FoundPassage[] {
    const found: FoundPassage[] = []
    for (let from = Math.max(window.start, this.scannedTo); from < upTo; from = this.scannedTo) {
      found.push(...this.scanStretch(window, from, Math.min(upTo, from + SCAN_STEP)))
    }
    return found
  }

  /** The words whose occurrences begin in [from, to), placed in passages. */
  private scanStretch(window: TextWindow, from: number, to: number): FoundPassage[] {
    const text = foldWidth(window.slice(from, to + this.longest - 1))
    // [start, end, which word]
    const hits: [number, number, number][] = []
    for (const [w, word] of this.words.entries()) {
      for (
        let at = text.indexOf(word);
        at >= 0 && from + at < to;
        at = text.indexOf(word, at + 1)
      ) {
        hits.push([from + at, from + at + word.length, w])
      }
    }
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    this.scannedTo = to
    const found: FoundPassage[] = []
    for (const [start, end, w] of hits) {
      if (this.open && start < this.open.end) {
        // Counted by the word, so a word on every line leaves room for the others
        if (this.openCounts[w]! < this.maxMarks) {
          this.open.marks.push([start, end])
          this.openCounts[w]!++
        }
        continue
      }
      if (this.open) found.push(this.open)
      // A little before the word, but not back into the page before
      const opens = Math.max(window.blockAt(start)?.start ?? 0, start - Math.floor(this.chars / 4))
      this.open = { start: opens, end: opens + this.chars, marks: [[start, end]] }
      this.openCounts = this.words.map((_, i) => (i === w ? 1 : 0))
    }
    // Closed once the text past its end has been looked at
    if (this.open && this.open.end <= this.scannedTo) {
      found.push(this.open)
      this.open = null
    }
    return found
  }

  keepFrom(window: TextWindow): number {
    const back = Math.min(this.scannedTo, window.end) - this.longest - Math.floor(this.chars / 4)
    return Math.min(this.open?.start ?? Infinity, back)
  }

  done(): boolean {
    return false
  }
}

/** How much a cut passage holds of the query: its different words, then all its matches. */
function holds(passage: CutPassage): [number, number] {
  return [
    new Set(passage.words.map((w) => w.normalize('NFKC').toLowerCase())).size,
    passage.marks.length,
  ]
}

/**
 * Read `blocks` once — no further than `maxChars` of their text — and cut the
 * passages `finder` finds, each widened by up to `widen` characters to start
 * and end on a line break, keeping the `maxPassages` that hold most of the query. The text a passage needs
 * is held until it is cut; the rest is let go of as the read goes on.
 */
export async function cutPassages(
  blocks: AsyncIterable<DocumentTextBlock>,
  finder: PassageFinder,
  widen: number,
  maxChars = Infinity,
  maxPassages = Infinity
): Promise<CutPassage[]> {
  const window = new TextWindow()
  const waiting: FoundPassage[] = []
  const cut: CutPassage[] = []
  /** What each of `cut` holds of the query, counted once */
  const held: [number, number][] = []

  const settle = (finished: boolean) => {
    for (let i = waiting.length - 1; i >= 0; i--) {
      const p = waiting[i]!
      // Its end can be widened only once the text past it is in
      if (!finished && window.end < p.end + widen) continue
      waiting.splice(i, 1)
      const end = Math.min(p.end, window.end)
      const lineStart = window.lastIndexOf('\n', p.start - 1) + 1
      const start = p.start - lineStart <= widen && lineStart >= window.start ? lineStart : p.start
      const lineEnd = window.indexOf('\n', end)
      // The text's end is a line's end too, once there is no more of it
      const stop =
        lineEnd >= 0
          ? lineEnd - end <= widen
            ? lineEnd
            : end
          : finished && window.end - end <= widen
            ? window.end
            : end
      const text = window.slice(start, stop)
      if (!text.trim()) continue
      cut.push({
        ...p,
        start,
        end: stop,
        text,
        blocks: window.blocksOver(start, stop),
        words: p.marks.map(([s, e]) => window.slice(s, e)),
      })
      held.push(holds(cut.at(-1)!))
      // Over the most it may keep, the one holding least of the query goes, wherever it is
      if (cut.length > maxPassages) {
        let least = 0
        for (let j = 1; j < held.length; j++) {
          const [k, m] = held[j]!
          const [kl, ml] = held[least]!
          if (k < kl || (k === kl && m < ml)) least = j
        }
        cut.splice(least, 1)
        held.splice(least, 1)
      }
    }
  }

  let index = -1
  for await (const block of blocks) {
    index++
    window.append(index, block)
    waiting.push(...finder.feed(window))
    settle(false)
    if (finder.done() && waiting.length === 0) break
    // Past the most it may read, the text ends here for the finder
    if (window.end >= maxChars) break
    const keep = Math.min(finder.keepFrom(window), ...waiting.map((p) => p.start)) - widen
    window.dropBefore(keep)
  }
  window.close()
  waiting.push(...finder.finish(window))
  settle(true)
  return cut.sort((a, b) => a.start - b.start)
}

const foldWord = (w: string) => w.normalize('NFKC').toLowerCase()

/**
 * The runs of matched words that touch: where an analyser split a compound
 * (再生利用率 → 再生 / 利用 / 率), the words side by side are the compound.
 */
function compoundRuns({ words, marks }: { words: string[]; marks: Span[] }): string[] {
  const runs: string[] = []
  let run = ''
  let joined = false
  let end = -1
  for (const [i, [start, stop]] of marks.entries()) {
    if (start === end) {
      run += words[i]
      joined = true
    } else {
      if (joined) runs.push(run)
      run = words[i] ?? ''
      joined = false
    }
    end = stop
  }
  if (joined) runs.push(run)
  return runs
}

/**
 * Score passages by their matched words, BM25-like across the passages found:
 * a word few of them hold counts for more, and a word's repeats saturate, so a
 * page of an index — every word, many times — does not outrank the paragraph
 * that discusses them. A passage holding a compound of the query whole, its
 * words side by side, gains as though the compound were one more word.
 */
export function passageScores(
  passages: { words: string[]; marks: Span[] }[],
  query: string
): number[] {
  const q = foldWord(query).replace(/\s+/g, '')
  const counts = passages.map((p) => {
    const tf = new Map<string, number>()
    for (const w of p.words.map(foldWord)) tf.set(w, (tf.get(w) ?? 0) + 1)
    return tf
  })
  const df = new Map<string, number>()
  for (const tf of counts) for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1)
  const n = passages.length
  const k1 = 1.2
  const idf = (d: number) => Math.log(1 + (n - d + 0.5) / (d + 0.5))
  // A compound counts as one more word, weighed by how many passages hold it whole
  const compounds = passages.map(
    (p) =>
      new Set(
        compoundRuns(p)
          .map(foldWord)
          .filter((run) => q.includes(run))
      )
  )
  const cdf = new Map<string, number>()
  for (const set of compounds) for (const c of set) cdf.set(c, (cdf.get(c) ?? 0) + 1)
  return counts.map((tf, i) => {
    let score = 0
    for (const [w, f] of tf) score += idf(df.get(w)!) * ((f * (k1 + 1)) / (f + k1))
    for (const c of compounds[i]!) score += idf(cdf.get(c)!)
    return score
  })
}
