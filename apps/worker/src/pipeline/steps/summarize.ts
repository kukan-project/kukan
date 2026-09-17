/**
 * KUKAN Pipeline — Summarize Step (ADR-053)
 *
 * Writes the resource's abstract: a short, accurate statement of what the file
 * holds, shown on the resource page and carried into the embedding.
 *
 * Last in the pipeline and best-effort, which is the whole of its contract with
 * the steps before it — a provider that is slow, throttled or down must not
 * cost the catalog a preview or an index entry. The step decides for itself
 * whether there is work: it does not ride the `derivativesReused` skip, so a
 * site that switches generation on gets its abstracts from ordinary runs rather
 * than from a rebuild of every derivative.
 *
 * **The AI's inference is limited to these sentences.** No column type, no
 * primary key, no header row is decided here (ADR-053 §2).
 */

import { and, eq, sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import type { Database } from '@kukan/db'
import {
  organization,
  packageTable,
  packageTag,
  resource,
  resourcePipeline,
  resourcePipelineStep,
  tag,
} from '@kukan/db'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { AIAdapter, CompletionAttachment } from '@kukan/ai-adapter'
import { AiInputRejectedError } from '@kukan/ai-adapter'
import {
  isImageFormat,
  isOfficeFormat,
  isPdfFormat,
  normalizeFormat,
  generationKey,
  PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE,
  SUMMARY_CONTEXT_NOTES_CHARS,
  SUMMARY_IMAGE_RESIZE_PX,
  SUMMARY_MAX_DOC_BYTES,
  SUMMARY_MAX_OFFICE_BYTES,
  SUMMARY_MAX_PDF_PAGES,
  SUMMARY_MIN_MATERIAL_CHARS,
  type Logger,
  type ResourceSummaryMeta,
  type SummaryCoverage,
  type SummaryLocale,
  type SummaryMaterial,
  type SummarySkipReason,
  declaredFormatMismatch,
} from '@kukan/shared'
import { stillHeld, type ResourceClaim } from '@kukan/api/services/pipeline-claim'
import {
  loadMaterial,
  materialKind,
  readAll,
  readArtifactTextHead,
  textHeadKeyOf,
  textHeadWasCapped,
  EMPTY_MATERIAL,
  type LoadedMaterial,
  type MaterialArtifacts,
  type MaterialKind,
} from '@kukan/api/services/suggest/materials'
import type { ResourceMaterial } from '@kukan/api/services/suggest/prompt'
import {
  buildSummarySystemPrompt,
  buildSummaryUserContent,
  summaryLlmOutputSchema,
  type SummaryLlmOutput,
  SUMMARY_OUTPUT_JSON_SCHEMA,
  type SummaryDatasetContext,
} from '@kukan/api/services/suggest/summary-prompt'
import { SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS } from '@/config'

export interface SummaryDeps {
  db: Database
  storage: StorageAdapter
  ai: AIAdapter
  log: Logger
  /** The generation language, read per call so a change takes effect (ADR-053) */
  locale: () => Promise<SummaryLocale>
  /** The model to write with. Never defaulted — see getSummaryModel */
  model: string
}

export interface SummaryInput {
  resourceId: string
  packageId: string
  /** The version the material was read from, named in the notice */
  version: number
  /** The version's object — the abstract is made from settled bytes (ADR-046) */
  storageKey: string
  /** The version's format, not the row's label (ADR-046 §6) */
  format: string | null
  size: number | null
  /** Conditions the write, so a stopped run's abstract does not land */
  claim?: ResourceClaim
  /**
   * Rewrite abstracts a different model, generation or language produced.
   *
   * Off for an ordinary run, which acts on the version changing and nothing
   * else: raising the generation must not turn every upload into a completion
   * somebody did not ask for. The full generation asks for it explicitly, and
   * because it compares rather than ignores, pressing it twice is free.
   */
  refresh?: boolean
}

export type SummaryOutcome =
  | { status: 'written'; material: SummaryMaterial; grounded: boolean }
  /** Already describes this material, or is a person's own text */
  | { status: 'unchanged' }
  | {
      status: 'skipped'
      reason: SummarySkipReason
      /** What an over-limit refusal reported the request came to */
      rejectedTokens?: number
      /** What was refused — the version and the generation — so the next run
       *  and the estimate recognise it (§3.4) */
      genKey?: string
      version?: number
    }

/**
 * Write one resource's abstract, or decide not to.
 *
 * Throws only on a failure of the moment — a throttle, a timeout, a read that
 * broke. Everything that is true about the file itself comes back as `skipped`,
 * because the two are recorded in different places: one on the run, one on the
 * resource, where it is shown to a reader as the reason there is no abstract.
 */
export async function executeSummarize(
  input: SummaryInput,
  deps: SummaryDeps
): Promise<SummaryOutcome> {
  const completion = deps.ai.getCompletionInfo()
  if (!completion) return { status: 'skipped', reason: 'provider-unavailable' }

  const row = await readRow(input, deps)
  if (!row) return { status: 'skipped', reason: 'not-public' }
  // Drafts and private packages are not sent to a provider without someone
  // pressing something — the line embedding draws (ADR-039). The manual
  // suggestion (ADR-040) is where a draft gets a description, and pressing it
  // is the consent this path has none of.
  if (row.packageState !== 'active' || row.packagePrivate) {
    return { status: 'skipped', reason: 'not-public' }
  }
  if (row.meta.hidden) return { status: 'skipped', reason: 'hidden' }
  // A person's text is never overwritten, and never regenerated over.
  if (row.meta.source === 'human') return { status: 'unchanged' }

  const plan = await planMaterial(input, row.artifacts, row.usable, deps)
  if ('reason' in plan) return { status: 'skipped', reason: plan.reason }

  const material: ResourceMaterial = {
    id: input.resourceId,
    name: row.name,
    description: row.description,
    format: input.format,
    size: input.size,
    ...EMPTY_MATERIAL,
    ...plan.material,
  }
  const locale = await deps.locale()
  const genKey = generationKey(deps.model, locale)
  // An abstract stands while its version does. Not while a digest of the
  // derived material does: that regenerated on every internal change of the
  // pipeline — a column statistic added, a settled version re-keyed — unquoted,
  // because the estimate counts by version and a digest cannot be recomputed in
  // SQL. What the model is shown for the same file changes only when the code
  // does, and that is a decision, taken by raising the generation.
  const sameVersion = row.meta.version === input.version
  const sameGeneration = row.meta.genKey === genKey
  // Describes this version, and — when the refresh asked — was written the way
  // this deployment writes them now.
  if (sameVersion && (!input.refresh || sameGeneration) && row.summary) {
    return { status: 'unchanged' }
  }
  // The same version, refused by the same generation. **Both halves matter
  // here even without a refresh**: a refusal is a fact about the input and the
  // model that read it, so a deployment that moves to a longer context has a
  // file worth trying again.
  if (row.meta.skipReason === 'rejected' && sameVersion && sameGeneration) {
    return { status: 'unchanged' }
  }

  let output: SummaryLlmOutput
  try {
    output = await generate(input, material, row.context, plan, locale, deps)
  } catch (err) {
    const rejected = rejectionReason(err)
    // A refusal of the moment goes up: the caller records it on the run and
    // tries again. Only a refusal of the input itself is the file's answer.
    if (!rejected) throw err
    return { status: 'skipped', ...rejected, genKey, version: input.version }
  }

  const written = await write(input, deps, output.summary, {
    source: 'ai',
    version: input.version,
    material: plan.kind,
    coverage: plan.coverage,
    generatedAt: new Date().toISOString(),
    genKey,
    model: deps.model,
    grounded: output.groundedInMaterial,
  })
  // An editor took the abstract over while the provider was working. Their text
  // stands; this completion is simply spent.
  if (!written) return { status: 'unchanged' }
  return { status: 'written', material: plan.kind, grounded: output.groundedInMaterial }
}

/**
 * Whether the derivatives on the row describe the content being summarized.
 *
 * **The run's own status does not answer this.** A failed interpretation is
 * recorded on its step and the run goes on to finish, so a resource whose new
 * version was never interpreted sits at `complete` with the *previous*
 * version's preview still on it. Reading that as this version's material is how
 * an abstract comes to describe a file nobody has.
 *
 * So it is asked of the step that writes each artifact, in the run that last
 * touched the resource — step rows are cleared at the start of every run, so
 * what is there describes that run. The originals are exempt: a version's
 * object is settled (ADR-046), so the paths that send one need nothing from
 * here.
 */
interface ArtifactsUsable {
  /** Schema, sample rows and the ZIP manifest — written by Interpret */
  interpreted: boolean
  /** The extracted-text artifact — written by Index */
  textHead: boolean
}

// ── Material ──

export interface MaterialPlan {
  kind: SummaryMaterial
  material: Partial<ResourceMaterial>
  attachment?: CompletionAttachment
  /** What the notice tells the reader was read (ADR-053 §7) */
  coverage?: SummaryCoverage
}

/**
 * What this file can be described from, and whether its original has to be sent.
 *
 * The rule in one line: **the original goes only when nothing else gets at the
 * content.** Tables, text and archives already have material; a PDF with a text
 * layer has one too, and sending its pages as images instead costs 1.7 to 9.3
 * times more for an output that is no better (ADR-053 §3.6).
 */
export async function planMaterial(
  input: SummaryInput,
  artifacts: MaterialArtifacts,
  usable: ArtifactsUsable,
  deps: SummaryDeps
): Promise<MaterialPlan | { reason: SummarySkipReason }> {
  // Lower-cased: the format is matched against what the provider lists, and
  // every provider enum spells these in lower case.
  const format = normalizeFormat(input.format ?? '').toLowerCase()
  const documentInfo = deps.ai.getDocumentInfo()

  if (isImageFormat(input.format)) {
    if (!documentInfo?.imageFormats.includes(format)) return { reason: 'unsupported-format' }
    return {
      kind: 'image',
      material: EMPTY_MATERIAL,
      attachment: {
        kind: 'image',
        format,
        name: 'image',
        bytes: await downloadImage(input, documentInfo.maxImageBytes, deps),
      },
    }
  }

  if (isPdfFormat(input.format)) {
    return planPdf(input, artifacts, documentInfo, deps, usable.textHead)
  }

  if (isOfficeFormat(input.format)) {
    if (!documentInfo?.documentFormats.includes(format)) {
      // No provider lists PPT, so its original can never go. That was once the
      // whole answer, but Phase B settled that extracted text reads at least
      // as well as a document sent whole (§3.6) — and Index has already
      // written some for every one of these formats. Refusing before looking
      // at it threw away material that was sitting on the row.
      return (
        textPlan(await readExtractedText(artifacts, deps, usable.textHead)) ?? {
          reason: 'unsupported-format',
        }
      )
    }
    // An Office original cannot be measured before it is opened: a 1.5MB XLSX
    // measured 919k tokens, and 92KB of DOCX measured 14k. The byte limit is
    // the only gate there is before sending, and the provider's refusal is the
    // rest of it (ADR-053 §3.4).
    if (!withinBytes(input.size, SUMMARY_MAX_OFFICE_BYTES)) return { reason: 'too-large' }
    const bytes = await readAll(await deps.storage.download(input.storageKey))
    // The same test as the PDF path: an office format is a ZIP container, and
    // a publisher's error page is not one (ADR-047)
    if (declaredFormatMismatch(input.format, bytes)) return { reason: 'format-mismatch' }
    return {
      kind: 'original',
      material: EMPTY_MATERIAL,
      attachment: { kind: 'document', format, name: format, bytes },
    }
  }

  const kind = materialKind({ id: input.resourceId, format: input.format }, artifacts)
  if (!kind || !usableFor(kind, usable)) return { reason: 'no-material' }
  const loaded = await loadMaterial(
    kind,
    { id: input.resourceId, format: input.format },
    artifacts,
    deps
  )
  if (isEmpty(loaded)) return { reason: 'no-material' }
  return { kind: MATERIAL_OF[kind], material: loaded, coverage: coverageOf(kind, loaded) }
}

/**
 * The extracted text as a plan, or null when there is not enough of it.
 *
 * Both the paths that cannot send an original end here: a PDF whose pages are
 * not worth the tokens, and a format no provider takes as a document at all.
 */
function textPlan(text: string | null): MaterialPlan | null {
  if (!text || text.trim().length < SUMMARY_MIN_MATERIAL_CHARS) return null
  return {
    kind: 'text-head',
    material: { ...EMPTY_MATERIAL, textHead: text },
    coverage: { read: text.length },
  }
}

/** The Index step's extracted text, where this run's Index is to be trusted */
async function readExtractedText(
  artifacts: MaterialArtifacts,
  deps: SummaryDeps,
  usable: boolean
): Promise<string | null> {
  const key = usable ? textHeadKeyOf(artifacts.pipelineMetadata) : null
  if (!key) return null
  return readArtifactTextHead(key, deps).catch(() => null)
}

/** What was actually read, in the unit the material is counted in */
function coverageOf(kind: MaterialKind, loaded: LoadedMaterial): SummaryCoverage {
  switch (kind) {
    case 'tabular':
      return { read: loaded.sampleRows?.length ?? 0, total: loaded.schema?.rowCount ?? undefined }
    case 'zip':
      return { read: loaded.fileList?.length ?? 0, total: loaded.fileCount ?? undefined }
    default:
      // Characters, which is what the notice quotes for text — the byte budget
      // is ours, not something a reader can check against anything.
      return { read: loaded.textHead?.length ?? 0 }
  }
}

/**
 * Whether the step that writes what this kind reads left something describing
 * this content.
 *
 * Asked per kind, because the kinds do not read the same artifact. A table and
 * an archive come from Interpret; the extracted text of an ODT or an RTF comes
 * from Index, and asking Interpret about it is how a run whose Index failed
 * gets to describe the file with the *previous* version's text. A text file
 * comes from the object itself, which is settled (ADR-046) and answers to no
 * step at all.
 */
function usableFor(kind: MaterialKind, usable: ArtifactsUsable): boolean {
  switch (kind) {
    case 'tabular':
    case 'zip':
      return usable.interpreted
    case 'document':
      return usable.textHead
    case 'text':
      return true
  }
}

/** Keyed on every kind, so adding one does not silently miss this table */
const MATERIAL_OF = {
  tabular: 'schema',
  text: 'text',
  document: 'text-head',
  zip: 'files',
} as const satisfies Record<MaterialKind, SummaryMaterial>

/**
 * A PDF is routed on characters per page, not on whether anything could be
 * extracted at all: an extraction that failed and a page that is hard to read
 * are different axes, and only the first is visible from here (ADR-053 §6). So
 * where the text layer is thin the original goes, and the model given it is one
 * that can read a poor scan.
 */
async function planPdf(
  input: SummaryInput,
  artifacts: MaterialArtifacts,
  documentInfo: ReturnType<AIAdapter['getDocumentInfo']>,
  deps: SummaryDeps,
  artifactsUsable: boolean
): Promise<MaterialPlan | { reason: SummarySkipReason }> {
  const textHeadKey = artifactsUsable ? textHeadKeyOf(artifacts.pipelineMetadata) : null
  const textHead = textHeadKey
    ? await readArtifactTextHead(textHeadKey, deps).catch(() => null)
    : null
  const asText = textPlan(textHead)

  // Past the byte limit the original is not an option, so the text layer is
  // judged on its own: either it says something or there is nothing to say.
  if (!withinBytes(input.size, SUMMARY_MAX_DOC_BYTES)) {
    return asText ?? { reason: 'too-large' }
  }

  const bytes = await readAll(await deps.storage.download(input.storageKey))
  const pages = await pageCount(bytes, deps)

  // Two things make the ratio meaningless, and both mean take the text.
  //
  // A head that hit its cap measures the budget, not the document: 16KB of
  // Japanese over a 467-page yearbook reads as 11 characters a page whatever
  // the file holds, and that one held 1,034. Treating the cap as thinness sent
  // the original for every PDF past about fifty pages — and the original is
  // not the path that reads everything, as that yearbook showed when the model
  // reported it could extract nothing from it.
  //
  // A page count we could not read is a different thing again. It means our own
  // parser could not open the file, which is poor evidence that the provider
  // will make more of the whole of it — so where text was extracted, that is
  // the surer path as well as the cheaper one.
  const thinLayer = (text: string, pageCount: number) =>
    !textHeadWasCapped(text) && text.length / pageCount < PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE
  if (asText && (pages === null || !thinLayer(textHead!, pages))) return asText
  // Not a PDF at all — a dead link the publisher answered with a page, which
  // is what this catalogue's 44KB「PDF」holding `<!doctype html>` turned out to
  // be (ADR-047). Distinct from a PDF we could not parse: the signature is
  // absent, not merely unreadable. A fact about these bytes, so it is recorded
  // as standing rather than re-asked on every run.
  if (pages === null && declaredFormatMismatch(input.format, bytes)) {
    return { reason: 'format-mismatch' }
  }

  if (!documentInfo?.documentFormats.includes('pdf')) {
    // No provider for the original: a thin text layer is all there is, and
    // below the floor it describes nothing.
    return asText ?? { reason: 'unsupported-format' }
  }
  // Tokens follow pages, not bytes — 1,985 to 3,078 a page whether the page
  // holds 1,559 characters or none — so the page count is the limit that binds.
  //
  // Past it the front of the document goes rather than nothing. A statistical
  // yearbook is exactly the file an abstract is worth most on, and refusing it
  // outright bought nothing: the ceiling on what one PDF can cost is the same
  // either way, because that ceiling *is* this limit. What the reader is owed
  // is knowing it happened, and the notice says so from the coverage below.
  if (pages !== null && pages > SUMMARY_MAX_PDF_PAGES) {
    const front = await firstPages(bytes, SUMMARY_MAX_PDF_PAGES, deps)
    // A file we cannot cut is one pdf-lib could count but not copy — untested,
    // because a document that parses far enough for the first and not the
    // second is not something we could construct. The text layer is the only
    // path left, and below the floor there is none.
    if (!front) return asText ?? { reason: 'too-large' }
    return {
      kind: 'original',
      material: EMPTY_MATERIAL,
      attachment: { kind: 'document', format: 'pdf', name: 'pdf', bytes: front },
      coverage: { read: SUMMARY_MAX_PDF_PAGES, total: pages },
    }
  }
  return {
    kind: 'original',
    material: EMPTY_MATERIAL,
    attachment: { kind: 'document', format: 'pdf', name: 'pdf', bytes },
  }
}

/**
 * The first `count` pages as a PDF of their own, or null where the document
 * will not give them up.
 *
 * Copying rather than deleting the rest: `copyPages` builds a new document from
 * the pages it is given, so what a damaged page further in does to the file
 * cannot reach this one.
 */
async function firstPages(bytes: Buffer, count: number, deps: SummaryDeps): Promise<Buffer | null> {
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    // Counting the pages of an encrypted document is safe; taking them out is
    // not. `ignoreEncryption` parses the structure without decrypting it, so
    // the content streams cross into a document with no key and every page
    // arrives blank — 50 of them, from a yearbook holding 575,761 characters.
    if (src.isEncrypted) {
      deps.log.info({ component: 'summarize' }, 'an encrypted PDF cannot be cut; sending nothing')
      return null
    }
    const cut = await PDFDocument.create()
    const copied = await cut.copyPages(src, [...Array(count).keys()])
    for (const page of copied) cut.addPage(page)
    return Buffer.from(await cut.save())
  } catch (err) {
    deps.log.warn({ component: 'summarize', err }, 'could not cut the PDF down to its first pages')
    return null
  }
}

async function pageCount(bytes: Buffer, deps: SummaryDeps): Promise<number | null> {
  try {
    // An encrypted PDF still parses far enough to be counted; anything else
    // that throws here is a file we would not have described anyway.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    return doc.getPageCount()
  } catch (err) {
    deps.log.warn({ component: 'summarize', err }, 'could not read the PDF page count')
    return null
  }
}

/**
 * The image, within the API's hard limit.
 *
 * Downscaling does not cost what it looks like it costs: JPEG shrink-on-load
 * works in libjpeg's DCT stage, which took an 8,256 by 5,504 photo from 365MB
 * of peak RSS to 105MB. And an image's tokens follow its pixels, not its bytes
 * — 1600px on the long edge is about 1,697 tokens, cheaper than one PDF page.
 */
async function downloadImage(
  input: SummaryInput,
  maxBytes: number,
  deps: SummaryDeps
): Promise<Buffer> {
  const bytes = await readAll(await deps.storage.download(input.storageKey))
  if (bytes.byteLength <= maxBytes) return bytes
  return sharp(bytes)
    .resize({
      width: SUMMARY_IMAGE_RESIZE_PX,
      height: SUMMARY_IMAGE_RESIZE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toBuffer()
}

function withinBytes(size: number | null, limit: number): boolean {
  // An unknown size is not a small one: nothing here can bound what would be
  // sent, so it is refused like an oversized file.
  return size !== null && size > 0 && size <= limit
}

function isEmpty(loaded: {
  schema: unknown
  sampleRows: unknown[] | null
  textHead: string | null
  fileList: string[] | null
}): boolean {
  if (loaded.schema) return false
  if (loaded.sampleRows?.length) return false
  if (loaded.fileList?.length) return false
  return (loaded.textHead?.trim().length ?? 0) < SUMMARY_MIN_MATERIAL_CHARS
}

// ── Generation ──

async function generate(
  input: SummaryInput,
  material: ResourceMaterial,
  context: SummaryDatasetContext,
  plan: MaterialPlan,
  locale: SummaryLocale,
  deps: SummaryDeps
) {
  const raw = await deps.ai.complete(buildSummaryUserContent(material, context), {
    system: buildSummarySystemPrompt(locale),
    model: deps.model,
    maxTokens: SUMMARY_MAX_TOKENS,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    jsonSchema: { name: 'resource_abstract', schema: SUMMARY_OUTPUT_JSON_SCHEMA },
    ...(plan.attachment && { attachments: [plan.attachment] }),
    // The one line that says what an abstract actually cost. Written per
    // resource because that is the unit the bill scales in, and with the
    // material because which path a file took is what makes the difference —
    // an estimate built from per-format averages is checkable against this
    // and against nothing else (ADR-053 §11.2).
    onUsage: (usage) =>
      deps.log.info(
        {
          component: 'summarize',
          resourceId: input.resourceId,
          packageId: input.packageId,
          model: deps.model,
          material: plan.kind,
          format: input.format,
          ...usage,
        },
        'abstract generated'
      ),
  })
  const parsed = summaryLlmOutputSchema.safeParse(JSON.parse(raw))
  if (!parsed.success || !parsed.data.summary.trim()) {
    throw new Error('The provider returned no usable abstract')
  }
  return parsed.data
}

// ── The row ──

async function readRow(input: SummaryInput, deps: SummaryDeps) {
  const [row] = await deps.db
    .select({
      name: resource.name,
      description: resource.description,
      summary: resource.summary,
      meta: resource.summaryMeta,
      packageState: packageTable.state,
      packagePrivate: packageTable.private,
      title: packageTable.title,
      notes: packageTable.notes,
      organization: organization.title,
      previewKey: resourcePipeline.previewKey,
      pipelineStatus: resourcePipeline.status,
      pipelineMetadata: resourcePipeline.metadata,
      liveStorageKey: resource.storageKey,
    })
    .from(resource)
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    .leftJoin(organization, eq(packageTable.ownerOrg, organization.id))
    .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
    .where(and(eq(resource.id, input.resourceId), eq(resource.state, 'active')))
    .limit(1)
  if (!row) return null

  const failed = await deps.db
    .select({ stepName: resourcePipelineStep.stepName })
    .from(resourcePipelineStep)
    .innerJoin(resourcePipeline, eq(resourcePipelineStep.pipelineId, resourcePipeline.id))
    .where(
      and(
        eq(resourcePipeline.resourceId, input.resourceId),
        eq(resourcePipelineStep.status, 'error')
      )
    )
  const failedSteps = new Set(failed.map((f) => f.stepName))
  // A run that failed outright (only Fetch can) left nothing describing this
  // content either.
  const ranCleanly = row.pipelineStatus !== 'error'

  const tags = await deps.db
    .select({ name: tag.name })
    .from(packageTag)
    .innerJoin(tag, eq(packageTag.tagId, tag.id))
    .where(eq(packageTag.packageId, input.packageId))
    .orderBy(tag.name)

  return {
    ...row,
    meta: row.meta ?? {},
    context: {
      title: row.title,
      organization: row.organization,
      tags: tags.map((t) => t.name),
      // The most useful context and the most parroted, so it is capped
      notes: row.notes?.slice(0, SUMMARY_CONTEXT_NOTES_CHARS) ?? null,
    } satisfies SummaryDatasetContext,
    usable: {
      interpreted: ranCleanly && !failedSteps.has('interpret'),
      textHead: ranCleanly && !failedSteps.has('index'),
    } satisfies ArtifactsUsable,
    artifacts: {
      pipelineStatus: row.pipelineStatus,
      previewKey: row.previewKey,
      pipelineMetadata: row.pipelineMetadata,
      liveStorageKey: row.liveStorageKey,
    } satisfies MaterialArtifacts,
  }
}

/**
 * The write, conditioned on the run still holding the resource (ADR-044 §4).
 * A run stopped mid-completion lands on nothing, which is what keeps a replaced
 * file from being described by the abstract of the one before it.
 *
 * And conditioned on the editor not having taken the abstract over while the
 * provider was working. The gates at the top of {@link executeSummarize} read
 * the row as it was up to two minutes earlier; an editor who writes their own
 * text or hides the abstract inside that window would otherwise have it
 * overwritten by a completion that started before they did. The conditions are
 * repeated here because this is the statement that can enforce them — the read
 * cannot.
 *
 * @returns whether the abstract was written. False means an editor won.
 */
async function write(
  input: SummaryInput,
  deps: SummaryDeps,
  summary: string,
  meta: ResourceSummaryMeta
): Promise<boolean> {
  const written = await deps.db
    .update(resource)
    // The mark rides with the write that earns it. Two statements leave a
    // window where a new abstract exists and nothing says the index has not
    // heard of it — invisible to the sweep, which is the thing that was
    // supposed to catch this (ADR-053 §9.3).
    .set({ summary, summaryMeta: meta, docSyncDueAt: sql`NOW()` })
    .where(
      and(
        eq(resource.id, input.resourceId),
        stillHeld(input.claim),
        sql`COALESCE(${resource.summaryMeta}->>'source', 'ai') <> 'human'`,
        sql`COALESCE(${resource.summaryMeta}->>'hidden', 'false') <> 'true'`
      )
    )
    .returning({ id: resource.id })
  return written.length > 0
}

/** Record why no abstract was written, on the resource, where the page reads it */
export async function recordSkip(
  input: SummaryInput,
  deps: SummaryDeps,
  reason: SummarySkipReason,
  extra?: { rejectedTokens?: number; genKey?: string; version?: number }
): Promise<void> {
  await mergeMeta(input, deps, {
    skipReason: reason,
    ...(extra?.rejectedTokens && { rejectedTokens: extra.rejectedTokens }),
    // What was refused, so the next run recognises it before paying for the
    // same refusal again (§3.4)
    ...(extra?.genKey && { genKey: extra.genKey }),
    ...(extra?.version && { version: extra.version }),
  })
}

/**
 * Add to what the row already says about its abstract, under this run's claim.
 *
 * Merged rather than replaced, so a reason never takes away an abstract that is
 * still true of the file: a resource that grew past the limit keeps the one the
 * version that fitted got, with the reason beside it.
 */
async function mergeMeta(
  input: SummaryInput,
  deps: SummaryDeps,
  fields: Partial<ResourceSummaryMeta>
): Promise<void> {
  const merged = JSON.stringify(fields)
  await deps.db
    .update(resource)
    .set({ summaryMeta: sql`COALESCE(${resource.summaryMeta}, '{}'::jsonb) || ${merged}::jsonb` })
    .where(and(eq(resource.id, input.resourceId), stillHeld(input.claim)))
}

/** The provider's refusal of the file itself, as the resource's own answer */
export function rejectionReason(
  err: unknown
): { reason: SummarySkipReason; rejectedTokens?: number } | null {
  if (!(err instanceof AiInputRejectedError)) return null
  return err.reason === 'too-long'
    ? { reason: 'rejected', rejectedTokens: err.actualTokens }
    : { reason: 'unsupported-format' }
}
