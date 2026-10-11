/**
 * The text of a Markdown file, a block per run of lines from one heading to
 * the next, under the path of headings the file marks — `#` headings and the
 * underlined kind — the way a Word document is read under its heading styles.
 * The lines are kept as written, marks and all: the content index holds the
 * file as it is, and a passage search finds an indexed fragment in the
 * artifact verbatim. What the reader adds is where the headings are. A title
 * alone is kept without its link, code and emphasis marks, as an outline
 * shows it.
 *
 * Read a line at a time: the file is never held whole, and a run of lines
 * longer than a block is cut as `bounded` would cut it, before it is held. A
 * `#` in a fenced code block or in front matter is no heading.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { DocumentTextBlock } from '@kukan/shared'
import {
  BLOCK_MAX_CHARS,
  HEADING_MAX_CHARS,
  headingsOver,
  oneHeading,
  pushHeading,
  type HeadingPath,
} from './blocks'

/** The marks alone, the title read off the rest: a pattern over the title backtracks quadratically. */
const ATX_HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const FRONT_MATTER_FENCE = /^(---|\.\.\.)[ \t]*$/
/** A list item's or a quote's line: not a paragraph's, so an underline after it is a rule. */
const NOT_PARAGRAPH = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]|^[ \t]*>/
const DELIMITER_CELL = /^:?-+:?$/
/** A line that starts another block: a heading, a rule, a fence or a quote. */
const TABLE_END =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|`{3,}|~{3,}|>)/

export async function* markdownBlocks(filePath: string): AsyncGenerator<DocumentTextBlock> {
  const path: HeadingPath = []
  let run: string[] = []
  let runChars = 0
  /** The fence a code block was opened with, while inside one. */
  let fence: { marker: string; length: number } | undefined
  let inFrontMatter = false
  /** Inside a table's rows, which run to the next blank line and are no paragraph's. */
  let inTable = false
  /** The last line pushed was a paragraph's, so an underline after it is a heading. */
  let afterParagraph = false
  let first = true

  function* flush(): Generator<DocumentTextBlock> {
    while (run.length > 0 && run[run.length - 1].trim() === '') pop()
    if (run.length > 0) yield { loc: {}, ...headingsOver(path), text: run.join('\n') }
    run = []
    runChars = 0
  }
  function push(line: string): void {
    // A run starts at its first line with text; the blanks before it are the gap after the last
    if (run.length === 0 && line.trim() === '') return
    run.push(line)
    runChars += line.length + 1
  }
  function pop(): string {
    const line = run.pop()!
    runChars -= line.length + 1
    return line
  }

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  for await (let line of lines) {
    if (first) {
      first = false
      if (line.startsWith('\uFEFF')) line = line.slice(1)
      inFrontMatter = line === '---'
    } else if (inFrontMatter) {
      // Its closing fence too: read here, it is no underline of the line before
      inFrontMatter = !FRONT_MATTER_FENCE.test(line)
      push(line)
      continue
    }
    // Cut here rather than by `bounded`, so a file with no headings is not
    // held whole. A paragraph line last may be the title of an underline to
    // come, and starts the next run instead of ending this one.
    if (runChars >= BLOCK_MAX_CHARS) {
      const held = afterParagraph ? pop() : undefined
      yield* flush()
      if (held !== undefined) push(held)
    }
    const paragraph = yield* readLine(line)
    afterParagraph = paragraph
  }
  yield* flush()

  /** Read `line` into the run; whether it is a paragraph's, which an underline would title. */
  function* readLine(line: string): Generator<DocumentTextBlock, boolean> {
    if (fence) {
      const close = line.match(FENCE)
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length &&
        line.slice(close[0].length).trim() === ''
      ) {
        fence = undefined
      }
      push(line)
      return false
    }
    // A table runs to a blank line, or to where another block starts — a fence among them
    if (inTable && (line.trim() === '' || TABLE_END.test(line))) inTable = false
    // A backtick fence's info string holds no backtick: a line starting with a
    // code span (```x``` …) opens none
    const open = line.match(FENCE)
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length }
      push(line)
      return false
    }
    if (inTable) {
      push(line)
      return false
    }
    // A table starts where a paragraph line is followed by a delimiter row of
    // as many cells (GFM): `a | b` over `---` is a heading, `| a |` over it a table
    if (afterParagraph && isDelimiterRow(line, run[run.length - 1])) {
      inTable = true
      push(line)
      return false
    }
    const underline = afterParagraph && line.match(SETEXT_UNDERLINE)
    if (underline) {
      const title = pop()
      yield* flush()
      pushHeading(path, underline[1][0] === '=' ? 1 : 2, oneHeading(titleText(title)))
      push(title)
      push(line)
      return false
    }
    const atx = line.match(ATX_HEADING)
    if (atx) {
      yield* flush()
      pushHeading(path, atx[1].length, oneHeading(titleText(line.slice(atx[0].length))))
      push(line)
      return false
    }
    push(line)
    return line.trim() !== '' && !NOT_PARAGRAPH.test(line)
  }
}

/** A table row's cells, split at its unescaped pipes, the outer ones left off. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
}

/** Whether `line` is the delimiter row of a table whose header row is `header`. */
function isDelimiterRow(line: string, header: string): boolean {
  if (!line.includes('-') || !(line.includes('|') || header.includes('|'))) return false
  const delimiters = cells(line)
  return (
    delimiters.length === cells(header).length &&
    delimiters.every((cell) => DELIMITER_CELL.test(cell.trim()))
  )
}

/**
 * A heading's title as an outline shows it: its words, without the marks
 * around them. Only the head of the line is read: the title is cut to
 * HEADING_MAX_CHARS anyway, and the patterns are not run over a line of any
 * length a file cares to write.
 */
function titleText(title: string): string {
  return title
    .slice(0, HEADING_MAX_CHARS * 4)
    .replace(/[ \t]+#+$/, '')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g, '$1')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/\*{1,3}|~~|(^|[\s(])_{1,3}(?=\S)|(?<=\S)_{1,3}(?=$|[\s).,;:!?])/g, '$1')
}
