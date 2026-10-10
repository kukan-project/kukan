/**
 * MCP Tools — A document's text, by where it is in the file
 *
 * Read from the text artifact the Interpret step writes (`text.ndjson.zst`),
 * whose blocks say which page, slide or sheet their text is from and the
 * headings it is under. No model is called: what comes back is the file's own
 * text, with what an answer needs to cite it.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { publicOrigin, type DocumentTextBlock, type Env } from '@kukan/shared'
import type { Database } from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AuthUser } from '../../auth/permissions'
import { ResourceService, resourceDownloadPath } from '../../services/resource-service'
import { PipelineService } from '../../services/pipeline/pipeline-service'
import {
  blockUnit,
  readDocumentOutline,
  readDocumentSection,
  unitKind,
  type DocumentOutline,
  type DocumentSection,
  type DocumentSectionPart,
  type SectionPosition,
  type SectionQuery,
  type UnitKind,
  type UnitRange,
} from '../../services/document-text'
import {
  MCP_OUTLINE_MAX_CHARS,
  MCP_OUTLINE_TITLE_CHARS,
  MCP_SECTION_DEFAULT_CHARS,
  MCP_SECTION_MAX_BLOCKS,
  MCP_SECTION_MAX_CHARS,
  MCP_SECTION_MAX_UNIT,
} from '../../config'

interface DocumentToolsContext {
  db: Database
  storage: StorageAdapter
  env: Env
  user?: AuthUser
}

/**
 * What a cursor carries: the selection it continues, where it stopped, and
 * which artifact it stopped in. A block index means nothing in another one, so
 * a cursor from another document, or from before this one was extracted again,
 * is refused rather than followed.
 */
const cursorSchema = z.object({
  k: z.string(),
  q: z.object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    heading: z.string().optional(),
  }),
  at: z.object({ block: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }),
})

function artifactTag(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 12)
}

function encodeCursor(key: string, q: SectionQuery, at: SectionPosition): string {
  return Buffer.from(JSON.stringify({ k: artifactTag(key), q, at })).toString('base64url')
}

function decodeCursor(text: string): z.infer<typeof cursorSchema> | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString()))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The rows of a sheet a part's text is: the block's text has a line per row
 * (`DocumentTextLoc.rows`), so a part cut from it holds the rows its lines are.
 */
function partRows({ block, text, offset }: DocumentSectionPart): number[] {
  const lines = (s: string) => s.split('\n').length
  const first = lines(block.text.slice(0, offset)) - 1
  return (block.loc.rows ?? []).slice(first, first + lines(text.replace(/\n$/, '')))
}

/** `5`, or `5–60`. */
function range({ min, max }: UnitRange): string {
  return min === max ? `${min}` : `${min}–${max}`
}

/** `page 5`, `pages 5–60`, `rows 1–9`: a span of what a kind counts. */
function span(kind: UnitKind | 'row', units: UnitRange): string {
  return `${kind}${units.min === units.max ? '' : 's'} ${range(units)}`
}

/** Where a part is, as a citation names it: `page 3 (iv)`, `slide 2`, `sheet 1 "Data", rows 4–20`. */
function partPlace(part: DocumentSectionPart): string {
  const { loc } = part.block
  switch (unitKind(loc)) {
    case 'page':
      return `page ${loc.page}${loc.label ? ` (${loc.label})` : ''}`
    case 'slide':
      return `slide ${loc.slide}`
    case 'sheet': {
      const rows = partRows(part)
      const at = rows.length ? `, ${span('row', { min: rows[0]!, max: rows.at(-1)! })}` : ''
      return `sheet ${loc.sheet}${loc.sheetName ? ` "${loc.sheetName}"` : ''}${at}`
    }
    default:
      return ''
  }
}

const UNREADABLE_NOTE: Record<NonNullable<DocumentTextBlock['unreadable']>, string> = {
  'no-text': '[This page has no text to read — a scan or a page of images.]',
  'unmapped-fonts':
    '[Most of this page is in fonts whose characters cannot be read; only the rest is shown.]',
}

/** For a page with some characters left out, but not most. */
const partlyUnreadableNote = (chars: number) =>
  `[${chars} characters of this page are in glyphs its fonts give no character for, and are left out of the text below.]`

function partLines(part: DocumentSectionPart): string[] {
  const { block, text } = part
  const continued = part.offset > 0
  const label = [
    partPlace(part),
    block.headings?.length ? block.headings.join(' > ') : '',
    block.figure ? 'figure' : '',
    continued ? '(continued)' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return [
    `--- ${label}`.trimEnd(),
    ...(block.unreadable && !continued ? [UNREADABLE_NOTE[block.unreadable]] : []),
    ...(!block.unreadable && block.unmappedChars && !continued
      ? [partlyUnreadableNote(block.unmappedChars)]
      : []),
    ...(text ? [text] : []),
  ]
}

/** The places a section spans, for its summary line: `pages 3–5`. In document order. */
function spanText(parts: DocumentSectionPart[]): string {
  const located = parts.filter((p) => blockUnit(p.block.loc) !== undefined)
  if (located.length === 0) return ''
  const [first, last] = [located[0]!.block.loc, located.at(-1)!.block.loc]
  return span(unitKind(first)!, { min: blockUnit(first)!, max: blockUnit(last)! })
}

const KIND_PLURAL: Record<UnitKind, string> = { page: 'Pages', slide: 'Slides', sheet: 'Sheets' }

/** What an outline lists, and how a reader takes it on to get_document_section. */
function outlineIntro({ units, entries }: DocumentOutline): string {
  const kind = units?.kind
  if (kind === 'sheet') {
    // An Ichitaro document's sheets have no rows, nor names
    return entries.some((e) => e.rows)
      ? "Sheets with their rows. Give a sheet's name as heading, or its number as from/to, to get_document_section:"
      : 'Sheets. Give their numbers as from/to to get_document_section:'
  }
  if (entries.length === 0) {
    return kind
      ? `This document marks no headings. Read it by ${kind}s with get_document_section from/to.`
      : 'This document marks no headings and has no pages. Read it from the start with get_document_section.'
  }
  return kind
    ? `Headings with the ${kind}s they span. Give one (or a path of them, \`A > B\`) as heading, or its ${kind}s as from/to, to get_document_section:`
    : 'Headings. Give one (or a path of them, `A > B`) as heading to get_document_section:'
}

function outlineLines(
  outline: DocumentOutline,
  { from, to }: { from?: number; to?: number }
): (string | false)[] {
  const { units, entries, unreadable, partlyUnreadable } = outline
  const ranged = from !== undefined || to !== undefined
  if (!units && ranged) {
    return [
      '',
      `Nothing is on pages, slides or sheets ${from ?? 1}–${to ?? '…'}. Call without from and to for the whole outline.`,
    ]
  }
  const labels = entries.map((e) => (units && e.units ? span(units.kind, e.units) : ''))
  const width = Math.max(0, ...labels.map((l) => l.length))
  // Cut to a budget like a section's, so a long outline does not fill the reader's context.
  // The unreadable pages, and then those partly so, take at most a quarter of it, for a scan
  // interleaved with text can have thousands of them; the headings take the rest.
  let chars = 0
  const shown = (ranges: UnitRange[]) => {
    const texts: string[] = []
    for (const r of ranges) {
      const text = range(r)
      if (chars + text.length > MCP_OUTLINE_MAX_CHARS / 4) break
      texts.push(text)
      chars += text.length + 2
    }
    const omitted = ranges.length - texts.length
    return `${texts.join(', ')}${omitted > 0 ? `, … and ${omitted} more ranges; give from/to to see those of part of the document` : ''}`
  }
  const unreadableShown = shown(unreadable)
  const partlyShown = shown(partlyUnreadable)
  const listed: string[] = []
  for (const [i, e] of entries.entries()) {
    const title =
      e.title.length > MCP_OUTLINE_TITLE_CHARS
        ? `${e.title.slice(0, MCP_OUTLINE_TITLE_CHARS)}…`
        : e.title
    // A sheet with no name is titled by its number, which its label already gives
    const line =
      title === labels[i]
        ? title
        : `${width ? `${labels[i]!.padEnd(width)}  ` : ''}${'  '.repeat(e.depth)}${title}${e.rows ? `  (${span('row', e.rows)})` : ''}`
    if (chars + line.length > MCP_OUTLINE_MAX_CHARS) break
    listed.push(line)
    chars += line.length + 1
  }
  const omitted = entries.length - listed.length
  return [
    !!units && `${KIND_PLURAL[units.kind]}${ranged ? ' shown' : ''}: ${range(units)}`,
    unreadable.length > 0 &&
      `${KIND_PLURAL[units?.kind ?? 'page']} whose text cannot be read (scans, or fonts with no map, or an incomplete one, to characters): ${unreadableShown}`,
    partlyUnreadable.length > 0 &&
      `${KIND_PLURAL[units?.kind ?? 'page']} with some characters that cannot be read, left out of their text: ${partlyShown}`,
    '',
    outlineIntro(outline),
    ...listed,
    omitted > 0 &&
      (units
        ? `… and ${omitted} more. Give from/to to see the outline of part of the document.`
        : `… and ${omitted} more headings, which cannot be listed; give get_document_section a heading to read them.`),
  ]
}

/** Blank lines stay: they part the source from the text. */
function reply(lines: (string | false | null)[]) {
  return {
    content: [
      { type: 'text' as const, text: lines.filter((line) => typeof line === 'string').join('\n') },
    ],
  }
}

/** Purged or replaced between reading the key and the object. */
function isGone(err: unknown): boolean {
  return err instanceof Error && err.name === 'NoSuchKey'
}

const gone = (id: string) =>
  reply([
    `The text of resource ${id} is not available just now; the file may be being processed again. Try again later.`,
  ])

export function registerDocumentTools(server: McpServer, ctx: DocumentToolsContext) {
  const { db, storage, env, user } = ctx

  /**
   * The resource as this viewer may see it, its text artifact, and the source
   * a citation of it gives — or why there is no text to read.
   */
  async function openDocument(id: string, { needsText }: { needsText: boolean }) {
    const [{ resource: res, pkg }, text] = await Promise.all([
      new ResourceService(db).getByIdWithOwnership(id, user),
      new PipelineService(db).getDocumentText(id),
    ])
    if (!text) {
      return reply([
        `Resource ${id} has no extracted document text. Text is extracted from PDF, Word, PowerPoint, Excel and Ichitaro files when they are processed.`,
      ])
    }
    // An outline is worth having without text: the pages, the bookmarks, which to read by OCR
    if (needsText && !text.hasText) {
      return reply([
        `Resource ${id} has no text to read: its pages are scans or images, and text is not read from pictures.`,
      ])
    }
    const origin = publicOrigin(env)
    const file = res.urlType === 'upload' ? `${origin}${resourceDownloadPath(res.id)}` : res.url
    const source = (isPdf: boolean) => [
      `Source: ${res.name || '(untitled)'}${pkg.title ? ` — ${pkg.title}` : ''}`,
      `Resource page: ${origin}/dataset/${pkg.name}/resource/${res.id}`,
      !!file && `File: ${file}${isPdf ? ' (add #page=N to open a PDF at page N)' : ''}`,
      !!res.format && `Format: ${res.format}`,
      // A failed Interpret keeps the text of the bytes before: the version to
      // cite is the one the text is from, kept apart from the file's
      ...(text.describesLiveContent
        ? [res.latestVersion != null && `Version: ${res.latestVersion}`]
        : [
            `Text from: ${text.sourceVersion != null ? `version ${text.sourceVersion}` : 'an earlier version of the file'}`,
            res.latestVersion != null && `Current file version: ${res.latestVersion}`,
            'Note: the file has changed since this text was extracted; cite the version the text is from.',
          ]),
    ]
    return { text, source }
  }

  const idSchema = z.string().describe('Resource UUID, as get_dataset or search_datasets gives it')
  // Bounded only so the schema does not advertise 2^53 as a page number
  const unitSchema = z.number().int().min(1).max(MCP_SECTION_MAX_UNIT).optional()
  const fromSchema = unitSchema.describe(
    'First page (PDF), slide (PowerPoint) or sheet (Excel), 1-based. A Word file has none.'
  )
  const toSchema = unitSchema.describe('Last page, slide or sheet, inclusive')

  server.registerTool(
    'get_document_outline',
    {
      description:
        "List a document resource's headings (PDF bookmarks or heading tags, Word heading styles, slide titles) or a workbook's sheets, each with the pages, slides or rows it spans, and how many pages it has. " +
        'For PDF, Word, PowerPoint and Excel files, the formats before 2007 (DOC, PPT, XLS) included, and Ichitaro (JTD, JTT); not for CSV (use get_resource_schema and query_resource for those tables). ' +
        "A DOC or an Ichitaro file marks no headings a reader of it can find: its text is one block, an Ichitaro file's a block a sheet where it has several. " +
        'Call it before get_document_section to choose what to read: give that tool a heading or the pages listed here. ' +
        'It also names the pages whose text cannot be read (scans): get_document_section returns nothing for them, as text is not read from images. ' +
        'The response opens with the source to cite. A long outline is cut; give from/to to see that of part of the document.',
      inputSchema: { id: idSchema, from: fromSchema, to: toSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ id, from, to }) => {
      const doc = await openDocument(id, { needsText: false })
      if ('content' in doc) return doc
      let outline: DocumentOutline
      try {
        outline = await readDocumentOutline(storage, doc.text.key, { from, to })
      } catch (err) {
        if (isGone(err)) return gone(id)
        throw err
      }
      return reply([
        ...doc.source(outline.units?.kind === 'page'),
        ...outlineLines(outline, { from, to }),
      ])
    }
  )

  server.registerTool(
    'get_document_section',
    {
      description:
        "Read a document resource's text (PDF, Word, PowerPoint, Excel, Ichitaro) by where it is in the file: a range of pages (a PDF's pages, a presentation's slides, a workbook's sheets), a heading, or both. " +
        'Call get_document_outline first to see the headings and the pages they span. A Word file has no pages: select it by heading. ' +
        'A heading selects everything under it, its subheadings included; give the deepest heading, or a path (`Chapter 1 > Overview`), to narrow it. ' +
        "A workbook's text is its rows with tab-separated cells; to compute over a CSV's values, use query_resource instead. " +
        'Every block of text is labelled with its page, slide or sheet (and rows) and the headings it is under, and the response opens with the source to cite — resource and dataset name, URL and version. ' +
        "Cite pages as labelled: `page 15` is the PDF's 15th page, which the file URL with #page=15 opens; the number printed on it, where the PDF records one, follows in brackets. " +
        'Long sections are cut and continue with the returned cursor. ' +
        'This server returns the text and where it is from; judging what it means — whether it applies, whether it is decided — is left to you.',
      inputSchema: {
        id: idSchema,
        from: fromSchema,
        to: toSchema,
        heading: z
          .string()
          .regex(/\S/, 'Give some text of the heading')
          .optional()
          .describe(
            "Part of a heading the text is under (a bookmark, a heading style, a slide's title), a path of them (`Chapter 1 > Overview`), or part of a sheet's name, as get_document_outline lists them. Case, width and spaces are ignored."
          ),
        max_chars: z
          .number()
          .int()
          .min(1)
          .max(MCP_SECTION_MAX_CHARS)
          .optional()
          .describe(
            `Characters of text to return (default ${MCP_SECTION_DEFAULT_CHARS}, at most ${MCP_SECTION_MAX_CHARS})`
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            'The cursor a previous response ended with, to read on; from, to and heading are then taken from it'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, from, to, heading, max_chars, cursor }) => {
      const doc = await openDocument(id, { needsText: true })
      if ('content' in doc) return doc
      const { text } = doc

      let query: SectionQuery = { from, to, heading }
      let start: SectionPosition = { block: 0, offset: 0 }
      if (cursor) {
        const decoded = decodeCursor(cursor)
        if (!decoded) return reply(['The cursor is not one this tool returned.'])
        if (decoded.k !== artifactTag(text.key)) {
          return reply([
            'The cursor is from another document, or from before this one was extracted again. Start again without it.',
          ])
        }
        query = decoded.q
        start = decoded.at
      }

      let section: DocumentSection
      try {
        section = await readDocumentSection(storage, text.key, query, start, {
          maxChars: max_chars ?? MCP_SECTION_DEFAULT_CHARS,
          maxBlocks: MCP_SECTION_MAX_BLOCKS,
        })
      } catch (err) {
        if (isGone(err)) return gone(id)
        throw err
      }

      if (section.unmatched) {
        const { units } = section.unmatched
        const asked = [
          (query.from !== undefined || query.to !== undefined) &&
            `pages/slides/sheets ${query.from ?? 1}–${query.to ?? '…'}`,
          query.heading && `heading "${query.heading}"`,
        ]
          .filter(Boolean)
          .join(' and ')
        return reply([
          ...doc.source(false),
          '',
          `No text matches ${asked || 'this request'}.`,
          units && `This document's pages, slides or sheets run ${units.min}–${units.max}.`,
          'Call get_document_outline to see its headings and the pages they span.',
        ])
      }

      const isPdf = section.parts.some((p) => p.block.loc.page !== undefined)
      const span = spanText(section.parts)
      return reply([
        ...doc.source(isPdf),
        !!span && `Showing: ${span}`,
        '',
        ...section.parts.flatMap((part, i) => [...(i > 0 ? [''] : []), ...partLines(part)]),
        '',
        section.next
          ? `More text follows. Call get_document_section with cursor "${encodeCursor(text.key, query, section.next)}" to read on.`
          : 'End of the selected text.',
      ])
    }
  )
}
