/**
 * What a full generation of abstracts would cover, and roughly what it costs
 * (ADR-053 §11.2).
 *
 * Shown before the button is pressed, because this is the one control in the
 * catalog that spends money per resource. It is also the observation point the
 * limits are tuned from: a large `tooLarge` says the limits are set wrong for
 * this catalog, and a large `noMaterial` says the pipeline is not producing
 * what the abstracts are made from.
 */

import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { Database } from '@kukan/db'
import {
  packageTable,
  resource,
  resourcePipeline,
  resourcePipelineStep,
  resourceVersion,
} from '@kukan/db'
import type { DocumentInfo } from '@kukan/ai-adapter'
import {
  isCsvFormat,
  isImageFormat,
  isOfficeFormat,
  isPdfFormat,
  isTextFormat,
  isZipFormat,
  SUMMARY_MAX_DOC_BYTES,
  SUMMARY_MAX_OFFICE_BYTES,
  SUMMARY_MAX_PDF_PAGES,
  SUMMARY_PDF_TOKENS_PER_PAGE,
  tokenRate,
  tokensToUsd,
  type SummaryLocale,
} from '@kukan/shared'

/**
 * Input tokens for a resource whose material is a schema and five rows, the
 * head of a text file, or a file listing. Measured at 1 to 2k, and unlike the
 * originals it does not move with the file: a 78MB CSV costs this too.
 */
const MATERIAL_TOKENS = 2_000
/** An Office original, mid-range of what fits under its byte limit */
const OFFICE_TOKENS = 14_000
/** A downscaled image is about 1,700 — cheaper than one PDF page */
const IMAGE_TOKENS = 1_700
/** 3 to 4 sentences, measured at 200 to 260 tokens */
const OUTPUT_TOKENS = 300

/** What one of the two operations would cover, and roughly cost */
export interface SummaryEstimateOperation {
  resources: number
  estimatedInputTokens: { low: number; high: number }
  estimatedOutputTokens: number
  /** Both token counts priced at the model's rate; null where none is recorded */
  estimatedCostUsd: { low: number; high: number } | null
}

export interface SummaryEstimate {
  /** The model that would write them, shown beside the buttons */
  model: string | null
  /** And the language they would be written in (runtime setting, §6.2) */
  locale: SummaryLocale
  /** Abstracts that are missing — what the ordinary generation writes */
  fill: SummaryEstimateOperation
  /**
   * Those, plus the ones another model, prompt version or language wrote.
   *
   * Kept apart because they are different amounts of money for different
   * reasons, and the screen has to be able to say which button costs which.
   * Changing a prompt makes every abstract in the catalogue stale at once;
   * nobody should find that out from a bill.
   */
  refresh: SummaryEstimateOperation
  skipped: {
    tooLarge: number
    unsupportedFormat: number
    /** The pipeline wrote nothing an abstract could be made from (§11.2) */
    noMaterial: number
  }
}

/**
 * The version each resource serves its content from, as the walk picks it: the
 * highest active version whose bytes are the ones the row points at (ADR-046).
 *
 * Not `MAX(version)` over every live version, which is a different number after
 * a purge — and the number a refusal records is this one, so comparing against
 * the other leaves the estimate and the worker permanently disagreeing about a
 * file neither will touch.
 */
function liveContentVersionAgg(db: Database) {
  return (
    db
      .selectDistinctOn([resourceVersion.resourceId, resourceVersion.hash], {
        resourceId: resourceVersion.resourceId,
        hash: resourceVersion.hash,
        liveVersion: resourceVersion.version,
        // Carried, not just counted. The walk classifies on the version's label
        // and measures the version's bytes; classifying here on the row's own
        // would have the two disagree about any resource whose label was edited
        // without refetching — the estimate quoting nothing while the worker
        // generates, or the reverse.
        format: resourceVersion.format,
        size: resourceVersion.size,
      })
      .from(resourceVersion)
      .where(eq(resourceVersion.state, 'active'))
      // Highest version first, so DISTINCT ON keeps the same row the walk takes
      .orderBy(resourceVersion.resourceId, resourceVersion.hash, desc(resourceVersion.version))
      .as('live_version_agg')
  )
}

/**
 * Which steps failed in the run that last touched each resource.
 *
 * The artifacts a failed step leaves behind describe the version before it, and
 * the worker refuses them (see `usableFor`). Asking only whether a key is on
 * the row would count those as work — an estimate for a file the run will call
 * `no-material`.
 */
function failedStepAgg(db: Database) {
  return db
    .select({
      resourceId: resourcePipeline.resourceId,
      interpretFailed: sql<boolean>`bool_or(${resourcePipelineStep.stepName} = 'interpret')`.as(
        'interpret_failed'
      ),
      indexFailed: sql<boolean>`bool_or(${resourcePipelineStep.stepName} = 'index')`.as(
        'index_failed'
      ),
    })
    .from(resourcePipeline)
    .innerJoin(
      resourcePipelineStep,
      and(
        eq(resourcePipelineStep.pipelineId, resourcePipeline.id),
        eq(resourcePipelineStep.status, 'error')
      )
    )
    .groupBy(resourcePipeline.resourceId)
    .as('failed_step_agg')
}

/**
 * @param documentInfo what the configured provider takes as an original, or
 *   null where it takes none. Asked rather than assumed, so the estimate counts
 *   what the step would actually attempt — PPT is an Office format to the
 *   preview and not a format any provider reads.
 */
export async function summaryEstimate(
  db: Database,
  documentInfo: DocumentInfo | null,
  /** How this deployment writes abstracts now — see generationKey */
  genKey: string,
  /** The model that would write them; prices the estimate and is shown as-is */
  model: string | null,
  locale: SummaryLocale
): Promise<SummaryEstimate> {
  const versionAgg = liveContentVersionAgg(db)
  const failedAgg = failedStepAgg(db)
  const takes = (format: string | null) =>
    Boolean(documentInfo?.documentFormats.includes((format ?? '').toLowerCase()))
  // The abstract does not describe the version this resource serves — it is
  // missing, or it was written from a version that has since been replaced.
  // **Both halves have to be here.** An ordinary run writes an abstract whose
  // version has moved (ADR-053 §4.2), so counting only the missing ones quotes
  // a price and then bills past it — and where a stale version is all there is,
  // the estimate reads zero and the admin screen disables the button for work
  // the run would have done.
  const describesLive = sql`((${resource.summaryMeta}->>'version')::int
    IS NOT DISTINCT FROM ${versionAgg.liveVersion})`
  // Not one this same model has already refused *for the version it still
  // serves*: that refusal stands until the file or the generation moves, so
  // quoting for it would promise work that will not happen. A refusal against
  // an older version is not a refusal of this one, and the run asks again.
  // `format-mismatch` stands on the same footing: both are facts about these
  // bytes read under this generation, settled until one of the two moves.
  // Reasons that turn on an artifact the pipeline may yet write —
  // `no-material`, `unsupported-format`, `too-large` — are deliberately *not*
  // here; those are re-asked below, because understating a bill is the worse
  // error to make.
  const standingRefusal = sql`(${resource.summaryMeta}->>'skipReason' IN ('rejected', 'format-mismatch')
    AND ${resource.summaryMeta}->>'genKey' IS NOT DISTINCT FROM ${genKey}
    AND ${describesLive})`
  // What each count is taken over. Spelled once and combined, because the
  // difference between them is one predicate and hand-writing every pairing
  // is how two of them come to disagree.
  const fillWrites = sql`(${resource.summary} IS NULL OR NOT ${describesLive})
    AND NOT ${standingRefusal}`
  // Only a refresh reaches these: the abstract describes the live version, and
  // the deployment has since changed how it writes them. Disjoint from
  // `fillWrites` by the version test both sides share, so the refresh total
  // adds the two without counting a resource twice.
  const refreshAdds = sql`${resource.summary} IS NOT NULL AND ${describesLive}
    AND ${resource.summaryMeta}->>'genKey' IS DISTINCT FROM ${genKey}`
  // The version's bytes, as the walk measures them
  const withinDoc = sql`${versionAgg.size} <= ${SUMMARY_MAX_DOC_BYTES}`
  const withinOffice = sql`${versionAgg.size} <= ${SUMMARY_MAX_OFFICE_BYTES}`
  // A run that failed outright, or in the step that wrote what this path reads.
  // Absent rows are not failures: a pipeline from before a step was named has
  // none, and the worker reads their absence the same way.
  const ranCleanly = sql`COALESCE(${resourcePipeline.status}, '') <> 'error'`
  const interpretOk = sql`(${ranCleanly} AND NOT COALESCE(${failedAgg.interpretFailed}, false))`
  const indexOk = sql`(${ranCleanly} AND NOT COALESCE(${failedAgg.indexFailed}, false))`
  // The derivatives, as they stand right now. Asked on every estimate rather
  // than trusting the reason a past run recorded: a re-interpretation that
  // finally writes a schema does not create a version, so a refusal pinned to
  // one would hide work that will happen — and understating a bill is the
  // worse direction to be wrong in.
  // A table's material is its schema; the sample rows are an enhancement the
  // query path can refuse on its own, so a preview with no schema beside it is
  // nothing to describe. An archive's is the manifest the preview key names.
  const hasSchema = sql`(${resourcePipeline.metadata}->'schema' IS NOT NULL AND ${interpretOk})`
  const hasManifest = sql`(${resourcePipeline.previewKey} IS NOT NULL AND ${interpretOk})`
  const extracted = sql`(${resourcePipeline.metadata}->>'textHeadKey' IS NOT NULL AND ${indexOk})`
  // Past the byte limit the original cannot go, but the extracted text still
  // can — so a large PDF with a text layer is work, not a refusal.
  const pdfReadable = sql`(${withinDoc} OR ${extracted})`
  const counted = (base: SQL, and_?: SQL) =>
    sql<number>`count(*) FILTER (WHERE ${base}${and_ ? sql` AND ${and_}` : sql``})::int`

  // Grouped in SQL rather than read row by row: this runs on a catalog of any
  // size, and the only things the classification needs are the format, whether
  // the file is under each limit, what the pipeline left on the row, and
  // whether an abstract is already there.
  const rows = await db
    .select({
      // The version's label, not the row's — the walk classifies on this one
      format: sql<string | null>`COALESCE(${versionAgg.format}, ${resource.format})`,
      missing: counted(fillWrites),
      // Written some other way: another model, generation or language
      stale: counted(refreshAdds),
      // The same two, against each path's own condition, because only what a
      // path can actually reach is billed
      missingSchema: counted(fillWrites, hasSchema),
      staleSchema: counted(refreshAdds, hasSchema),
      missingManifest: counted(fillWrites, hasManifest),
      staleManifest: counted(refreshAdds, hasManifest),
      missingExtracted: counted(fillWrites, extracted),
      staleExtracted: counted(refreshAdds, extracted),
      missingPdf: counted(fillWrites, pdfReadable),
      stalePdf: counted(refreshAdds, pdfReadable),
      missingOffice: counted(fillWrites, withinOffice),
      staleOffice: counted(refreshAdds, withinOffice),
    })
    .from(resource)
    .innerJoin(packageTable, eq(resource.packageId, packageTable.id))
    // The same join the walk makes, so the two count the same resources. A
    // resource with no version holding its content is one the walk cannot
    // reach — it is not work anybody will do, and quoting for it was 27 of the
    // 92 resources the first catalogue this ran against was billed for.
    .innerJoin(
      versionAgg,
      and(eq(versionAgg.resourceId, resource.id), eq(versionAgg.hash, resource.hash))
    )
    .leftJoin(resourcePipeline, eq(resourcePipeline.resourceId, resource.id))
    .leftJoin(failedAgg, eq(failedAgg.resourceId, resource.id))
    .where(
      and(
        eq(resource.state, 'active'),
        eq(packageTable.state, 'active'),
        eq(packageTable.private, false),
        // An editor's own text is never overwritten and a hidden abstract is
        // never regenerated, so neither is ever billed. Counted in, a catalogue
        // that has been curated by hand would be quoted for work it will not do.
        sql`COALESCE(${resource.summaryMeta}->>'source', 'ai') <> 'human'`,
        sql`COALESCE(${resource.summaryMeta}->>'hidden', 'false') <> 'true'`
      )
    )
    .groupBy(sql`COALESCE(${versionAgg.format}, ${resource.format})`)

  const empty = (): SummaryEstimateOperation => ({
    resources: 0,
    estimatedInputTokens: { low: 0, high: 0 },
    estimatedOutputTokens: 0,
    estimatedCostUsd: null,
  })
  const estimate: SummaryEstimate = {
    model,
    locale,
    fill: empty(),
    refresh: empty(),
    skipped: { tooLarge: 0, unsupportedFormat: 0, noMaterial: 0 },
  }
  const add = (op: SummaryEstimateOperation, n: number, low: number, high: number) => {
    op.resources += n
    op.estimatedInputTokens.low += n * low
    op.estimatedInputTokens.high += n * high
    op.estimatedOutputTokens += n * OUTPUT_TOKENS
  }
  /** A refresh covers what is missing and what was written some other way */
  const both = (missing: number, stale: number, low: number, high: number) => {
    add(estimate.fill, missing, low, high)
    add(estimate.refresh, missing + stale, low, high)
  }

  for (const row of rows) {
    const format = row.format

    // Tables and archives are made from what Interpret wrote, and a run that
    // produced none leaves nothing to send however small the file is. Nothing
    // else is out of range here: a schema and five rows cost the same whatever
    // the file weighs.
    if (isCsvFormat(format, null)) {
      both(row.missingSchema, row.staleSchema, MATERIAL_TOKENS, MATERIAL_TOKENS)
      estimate.skipped.noMaterial += row.missing - row.missingSchema
      continue
    }

    if (isZipFormat(format)) {
      both(row.missingManifest, row.staleManifest, MATERIAL_TOKENS, MATERIAL_TOKENS)
      estimate.skipped.noMaterial += row.missing - row.missingManifest
      continue
    }

    // A text file is read from the object itself, which the join has already
    // established is there. Only its length can refuse it, and that is not
    // visible from here.
    if (isTextFormat(format)) {
      both(row.missing, row.stale, MATERIAL_TOKENS, MATERIAL_TOKENS)
      continue
    }

    if (isPdfFormat(format)) {
      if (!takes(format)) {
        // Without the original the only path left is the text layer, and
        // below the floor the step calls that an unreadable format — the same
        // word, so the quote and the reason on the row agree.
        both(row.missingExtracted, row.staleExtracted, MATERIAL_TOKENS, MATERIAL_TOKENS)
        estimate.skipped.unsupportedFormat += row.missing - row.missingExtracted
        continue
      }
      // Which path a file inside the limit takes is not visible until its text
      // layer is measured. The span covers both: extracted text at the bottom,
      // the page limit at the top.
      estimate.skipped.tooLarge += row.missing - row.missingPdf
      both(
        row.missingPdf,
        row.stalePdf,
        MATERIAL_TOKENS,
        SUMMARY_MAX_PDF_PAGES * SUMMARY_PDF_TOKENS_PER_PAGE
      )
      continue
    }

    if (isOfficeFormat(format)) {
      if (!takes(format)) {
        // PPT: no original can go, and the extracted text is read instead —
        // with none, the step records an unreadable format (§3.5)
        both(row.missingExtracted, row.staleExtracted, MATERIAL_TOKENS, MATERIAL_TOKENS)
        estimate.skipped.unsupportedFormat += row.missing - row.missingExtracted
        continue
      }
      // An Office original past the limit has no text fallback: the step
      // refuses it before it looks for one.
      estimate.skipped.tooLarge += row.missing - row.missingOffice
      both(row.missingOffice, row.staleOffice, MATERIAL_TOKENS, OFFICE_TOKENS)
      continue
    }

    if (isImageFormat(format)) {
      if (!documentInfo?.imageFormats.includes((format ?? '').toLowerCase())) {
        estimate.skipped.unsupportedFormat += row.missing
        continue
      }
      both(row.missing, row.stale, IMAGE_TOKENS, IMAGE_TOKENS)
      continue
    }

    estimate.skipped.unsupportedFormat += row.missing
  }

  // Priced last, from the totals: output is a third of this bill on a catalogue
  // of small files, so quoting input alone would understate it badly.
  const rate = tokenRate(model)
  if (rate) {
    for (const op of [estimate.fill, estimate.refresh]) {
      op.estimatedCostUsd = {
        low: tokensToUsd(rate, op.estimatedInputTokens.low, op.estimatedOutputTokens),
        high: tokensToUsd(rate, op.estimatedInputTokens.high, op.estimatedOutputTokens),
      }
    }
  }
  return estimate
}
