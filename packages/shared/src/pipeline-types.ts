/**
 * KUKAN Pipeline Type Definitions (shared between API and Worker)
 */

import { z } from 'zod'
import { csvDialectSchema } from './csv-records'

/**
 * `cancelled` is a run that was stopped on purpose — a replacement was started,
 * or an operator killed it (ADR-044 §4). Distinct from `error`, which means the
 * run tried and failed: nothing went wrong here, and the resource is left
 * holding content no derivative describes.
 */
export type PipelineStatus =
  'pending' | 'queued' | 'processing' | 'complete' | 'error' | 'cancelled'
export type PipelineStepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped'
export type PipelineStepName = 'fetch' | 'version' | 'interpret' | 'lake' | 'index' | 'summarize'

/**
 * Step names that runs no longer write but rows still carry.
 *
 * `extract` became `interpret` when the stage did (ADR-046). Steps are cleared
 * at the start of each run, so these disappear resource by resource as the
 * pipeline runs again — until then the history has to be able to label them.
 *
 * Removable when `SELECT count(*) FROM resource_pipeline_step WHERE step_name =
 * 'extract'` reaches zero, along with the `pipelineStepExtract` message keys.
 */
export type LegacyPipelineStepName = 'extract'

/** Content type for indexed resource text */
export type ContentType = 'tabular' | 'text' | 'manifest' | 'document'

// ── Resource (column) schema (ADR-032) ──
// The column schema inferred while generating the preview Parquet (ADR-029) is
// persisted to resource_pipeline.metadata.schema so it can be surfaced before
// the data is downloaded (e.g. the get_resource_schema MCP tool). Column types
// mirror the inferred types from the Interpret step.

/**
 * Inferred column type. `date` and `timestamp` arrived with DuckDB's sniffer
 * (ADR-046): the hand-written inference deliberately left dates as strings
 * because the format was ambiguous, which is a judgement the sniffer makes for
 * us. Appending to the set keeps schemas written before then valid.
 */
export const RESOURCE_COLUMN_TYPES = [
  'integer',
  'float',
  'boolean',
  'string',
  'date',
  'timestamp',
] as const
export type ResourceColumnType = (typeof RESOURCE_COLUMN_TYPES)[number]

/**
 * Min/max bounds for a numeric column. Present iff the column `type` is
 * `integer` or `float` (such columns always have at least one non-null value),
 * and absent for `boolean`/`string` — so presence is fully determined by
 * `type`. Integer bounds are decimal strings (INT64 can exceed JS Number's safe
 * range, so a string preserves exact digits); float bounds are numbers. `min`
 * and `max` are therefore always the same type within a column — the paired
 * union below rejects a mixed `{ min: string, max: number }`.
 */
export const columnStatsSchema = z.union([
  z.object({ min: z.string(), max: z.string() }),
  z.object({ min: z.number(), max: z.number() }),
])
export type ColumnStats = z.infer<typeof columnStatsSchema>

export const resourceColumnSchema = z.object({
  /** Column name (header, or `column_{index}` when the header is blank). */
  name: z.string(),
  /** Inferred semantic type. */
  type: z.enum(RESOURCE_COLUMN_TYPES),
  /** Whether the column has any missing (empty) values. */
  nullable: z.boolean(),
  /** Number of missing (empty) values in the column. */
  nullCount: z.number().int().nonnegative(),
  /**
   * Distinct non-null values, counted exactly over every row. Optional because
   * schemas written before ADR-046 have no such count — absent means unknown,
   * not zero.
   */
  distinctCount: z.number().int().nonnegative().optional(),
  /**
   * Whether the column identifies a row: every value distinct and none missing.
   * What the primary-key picker offers as candidates (ADR-046).
   */
  unique: z.boolean().optional(),
  /** Min/max bounds for numeric columns (omitted for boolean/string/all-null). */
  stats: columnStatsSchema.optional(),
})
export type ResourceColumn = z.infer<typeof resourceColumnSchema>

export const resourceSchemaSchema = z.object({
  columns: z.array(resourceColumnSchema),
  /** Number of data rows (excluding the header). */
  rowCount: z.number().int().nonnegative(),
  /**
   * Lines of the file the reader refused, because they do not split into the
   * header's fields (ADR-046).
   *
   * The refusal is what stops one such line costing the file every column it
   * has — the sniffer would otherwise abandon the delimiter and read the whole
   * thing as one text column — and this count is what stops the refusal
   * being silent, which is the state it was found in.
   *
   * **Both ways a line can go.** The reader refuses one written short, and the
   * table trim takes the same note padded out to the width; which of them acted
   * is this file's business, not a reader's. What is counted is what the file
   * held and the table does not.
   *
   * Optional because schemas written before it have no such count — absent
   * means unknown, not zero.
   */
  droppedRows: z.number().int().nonnegative().optional(),
  /**
   * Where those lines are — the first few, in order (ADR-046).
   *
   * A count on its own says something is missing and leaves the publisher to
   * find it; these are what there is to act on, and the fix is usually one
   * character on one line.
   *
   * Numbered as the CSV reader counts, from the start of the file including the
   * header and any title rows: 1-based, and a record whose quoted cell holds
   * newlines counts once rather than once per line. On a file with no such cell
   * — nearly all of them — that is the line a text editor shows.
   *
   * **Only the lines the reader refused can be here.** A row the table trim took
   * cannot be traced back to a line of the file: by then the blank lines are
   * gone and a quoted newline has folded a record onto one. So this can be
   * shorter than {@link droppedRows} says, or absent while it counts.
   *
   * Bounded for the same reason as well — a file can be wrong this way from end
   * to end, and a schema is a row in a database.
   */
  droppedLines: z.array(z.number().int().positive()).optional(),
  /**
   * The dialect the reader sniffed, written beside {@link droppedLines}
   * because it is what their numbers count under. What an absence means, and
   * how a view numbers a file by it, is `csv-records.ts`.
   */
  dialect: csvDialectSchema.optional(),
  /**
   * Set where the file would not read as standard CSV and was read with the
   * standard relaxed (DuckDB `strict_mode = false`): line endings mixed within
   * one file, a quote left bare inside a quoted cell. Absent where it read to
   * the standard, which is nearly every file.
   *
   * What it costs a reader: under the relaxed reading a row with more fields
   * than the header is cut to width **without being counted** — the standard
   * reader refuses such a row and it reaches {@link droppedRows}. So on a
   * schema carrying this, the counts are a floor rather than the number.
   */
  lenient: z.literal(true).optional(),
})
export type ResourceSchema = z.infer<typeof resourceSchemaSchema>

/**
 * Why a resource is not served as an OData feed (ADR-055), or how it is not.
 *
 * The API decides this and the resource page explains it, so the set of
 * reasons has one owner rather than a spelling at each end. When Step 1's
 * heading rules change, a page that has not kept up is a type error here
 * rather than a message lookup that quietly comes back undefined.
 *
 * `not-queryable` is the one the page never shows: a resource with no table at
 * all says nothing about feeds. The narrowed parameter is how a reader of the
 * response declares it handles only what it is given.
 *
 * A page that cannot be read for want of memory is not among these: only the
 * read can answer that, and it raises its own 501 where it happens rather than
 * having the page decide in advance (ADR-055 §6).
 */
export type OdataRefusalReason =
  'not-queryable' | 'not-public' | 'unsupported-columns' | 'duplicate-columns'

export interface OdataRefusal<R extends OdataRefusalReason = OdataRefusalReason> {
  reason: R
  /** The headings at fault, where headings are the reason; empty otherwise. */
  columns: string[]
}

/**
 * Why the OData feed identifies rows by a column of its own making rather than
 * by the publisher's primary key (ADR-055 残課題 2).
 *
 * Each of these is a different next step for whoever published the table —
 * designate a key, choose another column, fix the data, or wait — which is why
 * the page is given the reason rather than a sentence about tables in general.
 * `unverified` is the one that passes on its own: a composite key is settled by
 * the layer-2 ingest, and until that version lands there is nothing to stand on.
 *
 * **Built on {@link KeyCheckFault} rather than beside it.** Four of these are
 * the faults a key check already answers, and giving them second names would
 * mean a second message and a hand-written arm for each one the day a fifth
 * arrives — with no type error when one is forgotten. The three added here are
 * the ones only a feed has: no key designated at all, digits a JSON number
 * cannot carry, and a key nothing has checked against the rows being served.
 */
export type OdataKeyFallback = KeyCheckFault | 'not-designated' | 'unsafe-integers' | 'unverified'

/** What the feed declares as the entity key, and whether it had to invent it. */
export interface OdataKey {
  /** The properties `<Key>` names. */
  names: string[]
  /** Whether those are a column the feed added rather than the table's own. */
  synthetic: boolean
  /** Why it was added, or null where the table's own key is used. */
  fallback: OdataKeyFallback | null
}

/**
 * Why an interpretation produced no table, when it produced none (ADR-046).
 *
 * An empty schema records that a version has been interpreted and holds nothing
 * to load — which is what stops the hourly lake sweep handing the file out
 * every hour for good. It does not say *which* nothing, and they are not the
 * same thing to whoever is asking why there is no preview: a file with no
 * columns at all, one wider than a preview can carry, one too large to
 * interpret, and one whose rows do not agree on how many fields they have.
 *
 * `ragged-rows` is the last of those, and it is a refusal rather than a limit.
 * A line that does not split into the header's columns is dropped by the reader
 * — that is what stops one of them costing the file every column it has.
 * A line taken for a sign-off is dropped and the table served without it;
 * anything else refuses the table, because a table quietly short of a row is
 * worse than no table — the missing row is invisible in every count the
 * catalogue publishes.
 *
 * **Which it is, is a guess** — a short line in a table far wider than it reads
 * as a sign-off, and a row truncated that badly reads the same way. The worker's
 * `refusedMoreThanNotes` is where that is argued and tuned; here it is enough
 * that {@link droppedRows} and {@link droppedLines} are how the guess reaches a
 * reader rather than being kept.
 */
export type NoTableReason = 'no-columns' | 'too-many-columns' | 'too-large' | 'ragged-rows'

/**
 * Why a version was not loaded into layer 2, when the key is what stopped it
 * (spec §6.6).
 *
 * **Written once, never cleared**, and deliberately not folded into
 * `no_table_reason`: that column belongs to the interpretation and is cleared
 * whenever a re-interpretation finds a table, which would take this reason with
 * it every hour. What this stops is the sweep offering a version that can never
 * be loaded — the ingest refuses it, the sweep has no way to know, and the pair
 * queues and refuses for ever.
 *
 * `key-missing` is separate because it is the one answered before the content is
 * read: the version's frozen schema either has the columns or it does not, and
 * issuing the `MERGE` without them is a binder error rather than a refusal.
 *
 * `ingest-failed` is the terminal state for an *error* rather than a refusal:
 * loading the version failed `LAKE_INGEST_FAILURE_LIMIT` times, a sweep apart.
 * Its own type below, because a key check can never answer it: the picker
 * renders what a check says, and must not be handed a value it has no words
 * for.
 */
export type KeyFault = 'key-missing' | 'key-null' | 'key-not-unique'
export type LakeIngestReason = KeyFault | 'ingest-failed'

/**
 * What a key check can answer, which is the recorded reasons plus one they will
 * never include.
 *
 * `key-float` is not a {@link KeyFault} because **no load ever decides it**.
 * `lake_ingest_reason` records why the ingest refused a version, and a float
 * key does not make it refuse one: the `MERGE` matches such a column like any
 * other ({@link canIdentifyRows}), so the rows load and there is nothing to
 * write down. What the key cannot do is be quoted back from outside, which is
 * settled where the key is set rather than where a version is loaded.
 *
 * **Such a version can still exist**, and the setting is not the only way in:
 * the type is inferred per version, so a column keyed while it read as
 * `integer` can read as `float` in the next one, under a key nothing re-asks
 * about (frozen at the Version step). That is the same drift a key column can
 * disappear into, and it is left alone here for the reason above — the load is
 * not what the type breaks.
 */
export type KeyCheckFault = KeyFault | 'key-float'

/**
 * Whether a column of this type can identify a row.
 *
 * Binary floating point is the one that cannot, and not because layer 2 breaks
 * on it: DuckDB's `=` holds for `NaN = NaN` and for `-0.0 = 0.0`, so a `MERGE`
 * matches such a column the way it matches any other. It fails at the boundary
 * — the value written out as text and read back by something else. `1.0` and
 * `1` are the same double, so two spellings a file keeps apart collapse into
 * one key, and a decimal spelling is not guaranteed to return to the bits it
 * came from. An identifier that cannot be quoted back is not one, whoever is
 * quoting: OData leaves `Edm.Double` out of the key types CSDL 4.01 §6.5
 * allows, and keeps `Edm.Decimal` in (ADR-055).
 *
 * Only inference produces types today (ADR-029), and it has no decimal to offer
 * — a column of exact decimals reads as `float` and is refused with the rest.
 * Settled types (ii-c, spec §6.5) are where that gets an answer.
 */
export function canIdentifyRows(type: ResourceColumnType): boolean {
  return type !== 'float'
}

/**
 * What a version's frozen counts say about a key, or `undefined` where they
 * cannot say (spec §6.3).
 *
 * The counts answer for **one column** — `nullCount` and `distinctCount`, both
 * recorded over every row when the version was interpreted (ADR-046). A
 * combination is outside what they hold, and a schema written before ADR-046
 * carries no `distinctCount` at all; in either case the answer has to come from
 * the content (`keyFault`), which is why this returns `undefined` rather than a
 * verdict.
 *
 * **One arithmetic, two readers.** The key-setting check and the OData feed
 * both ask whether a key identifies a row, and an answer they do not share is a
 * product that contradicts itself — a key the picker accepts and the feed
 * quietly refuses, with nothing able to explain the difference. (The lake
 * ingest asks the content instead, through `keyFault`.)
 */
export function frozenKeyFault(
  schema: ResourceSchema,
  key: readonly string[]
): KeyFault | null | undefined {
  if (key.length === 0) return undefined
  // Every column, not just the first: a combination stops at the guard below,
  // and a caller told `undefined` goes on to read columns that are not there.
  const named = key.map((name) => schema.columns.find((c) => c.name === name))
  if (named.some((column) => !column)) return 'key-missing'
  const column = named[0]!
  if (key.length > 1 || column.distinctCount === undefined) return undefined
  if (column.nullCount > 0) return 'key-null'
  return column.distinctCount === schema.rowCount ? null : 'key-not-unique'
}

/**
 * Why two versions could not be compared row by row (spec §7).
 *
 * Here rather than beside the service that produces it because the screen that
 * renders it needs the same list: the panel used to restate the union as string
 * literals, which is a set of cases that goes stale silently — a reason added
 * server-side renders as its own translation key.
 */
export type DiffUnavailableReason =
  /** The version has no predecessor (it is the first). */
  | 'no-previous-version'
  /**
   * One side has no row-level snapshot, and no key fault to name as what
   * stopped it.
   *
   * **Not a cause.** A version reaches this from every direction the
   * interpretation and the load can fail or decline, and from the ordinary gap
   * between the two: the load runs after the version exists, so a version
   * opened in that window is here and will leave it. Naming causes ("not
   * tabular, or from before the feature") reads as a diagnosis, and is wrong
   * for most of them.
   *
   * **A cause can still be recorded and still be this reason.** `noTableReason`
   * settles three of them at interpretation, and a version carrying one answers
   * here all the same — this is what is left once a `LakeIngestReason` is ruled
   * out, not "nothing is known". The version is where the rest is answered,
   * beside the version it belongs to.
   */
  | 'not-ingested'
  /** One side's content was purged, so it can no longer be compared. */
  | 'purged'
  /**
   * One side was given up on (spec §6.6) — reported as the reason itself rather
   * than folded into `not-ingested`, because these are the ones an operator can
   * act on: a key can be corrected, and the next version takes the correction;
   * a load that kept failing is one to go and look at. Told "not covered by
   * diffs", they would go looking for a cause that is not there.
   */
  | LakeIngestReason

// ── Queue job types ──
// Each job carries a validated payload (schemas below) so the worker never trusts
// an unvalidated queue message body.

/** Pipeline (data-plane): process one resource through Fetch → Version → Interpret → Lake → Index → Summarize. */
export const PIPELINE_JOB_TYPE = 'resource-pipeline' as const

/** Maintenance: rebuild the search metadata index (optionally re-enqueue content). */
export const REINDEX_JOB_TYPE = 'reindex-metadata' as const

/** Maintenance: rebuild the search index under the current analysis (ADR-025). */
export const REANALYSE_INDEX_JOB_TYPE = 'reanalyse-search-index' as const

/** Maintenance: permanently erase a soft-deleted organization (externals then DB rows). */
export const PURGE_ORG_JOB_TYPE = 'purge-organization' as const

/**
 * Semantic search: build the vectors of every resource marked due
 * (`embedding_due_at`, ADR-054).
 *
 * The same shape as the document sync below: the write that changes a
 * resource's text marks the row in the same statement, and this job works
 * through the marks, not a payload — so one waiting job covers every mark set
 * before it runs (`unlessWaiting`), and the marks it reads together go to the
 * provider in one call rather than one call each.
 */
export const EMBED_JOB_TYPE = 'embed-resources' as const

/** Make one resource version unobtainable; layer 2 may keep its rows (ADR-043 §5). */
export const PURGE_VERSION_JOB_TYPE = 'purge-resource-version' as const

/** One-time migration: snapshot the current file of every unversioned resource
 *  as v1 (ADR-043). No re-fetch/re-index — just copies the live key. */
export const BACKFILL_VERSIONS_JOB_TYPE = 'backfill-resource-versions' as const

/**
 * One-time migration: record what each preview's row groups hold (ADR-055 §6).
 *
 * A Parquet read decodes a whole row group, so the feed pages by that number —
 * and previews written before it was recorded do not carry it. A page can ask
 * the file, but only the interpretation and this migration write it down.
 */
export const RECORD_ROW_GROUPS_JOB_TYPE = 'record-preview-row-groups' as const

/** One-time migration: convert the versions the revert before ADR-044 §4 set
 *  aside, so `superseded` can leave the language. */
export const CONVERT_SET_ASIDE_JOB_TYPE = 'convert-set-aside-versions' as const

/** Retry a DuckLake ingest the pipeline's advisory Lake step failed (ADR-043). */
export const LAKE_INGEST_JOB_TYPE = 'lake-ingest-version' as const

/**
 * Maintenance: write the abstracts a catalog is missing (ADR-053 §11).
 *
 * Its own job rather than the pipeline's `rebuildOnly`, which bypasses the
 * reuse check and would regenerate every Parquet and re-ingest all of DuckLake
 * to arrive at a sentence. The material is already in storage.
 *
 * Fanned out per package, and each package's resources are done one at a
 * time, one completion to a job (see `summary/backfill.ts` in the worker).
 */
export const SUMMARIZE_ALL_JOB_TYPE = 'summarize-all' as const
export const SUMMARIZE_PACKAGE_JOB_TYPE = 'summarize-package' as const

/**
 * Rewrite the search documents of every resource marked due (`doc_sync_due_at`).
 *
 * The abstract is the one field of a resource's document written outside the
 * API's own edits — by the Summarize step, which is best-effort, and by the
 * editor hiding it (ADR-053 §9.3). Neither can retry the index write, so each
 * marks the row in the statement that makes the document stale and queues
 * this; the retry is the queue's, and the hourly sweep answers a job that was
 * never written.
 *
 * One job for all of them rather than one per resource: the job works through
 * the marks, not its payload, so one waiting job covers every mark set before
 * it runs (`unlessWaiting`), and one bulk write replaces a write — and a wait
 * for the index to refresh — per resource. `resourceId` is accepted from jobs
 * queued before and ignored.
 */
export const SYNC_RESOURCE_DOC_JOB_TYPE = 'sync-resource-doc' as const

/**
 * Where a job stands (ADR-058), in the order a job moves through them: held by
 * a worker, taken by nobody yet, held back, or given up on.
 */
export const JOB_STATUSES = ['running', 'waiting', 'delayed', 'dead'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

// ── Job payload schemas (the worker validates against these before acting) ──

export const pipelineJobSchema = z.object({
  resourceId: z.uuid(),
  /**
   * Rebuild the derivatives from the object the resource already holds, without
   * fetching (ADR-044 §4).
   *
   * What a revert queues. The ordinary run re-reads an external URL, which for
   * a resource reverted *because* that URL served the wrong thing publishes it
   * straight back — undoing the retraction it was queued to finish.
   */
  rebuildOnly: z.boolean().optional(),
})
export const reindexJobSchema = z.object({ includeContent: z.boolean().optional() })
export const reanalyseIndexJobSchema = z.object({})
export const purgeOrgJobSchema = z.object({ organizationId: z.uuid() })
export const embedJobSchema = z.object({})
export const syncResourceDocJobSchema = z.object({ resourceId: z.uuid().optional() })
export const purgeVersionJobSchema = z.object({
  resourceId: z.uuid(),
  version: z.number().int().positive(),
})
export const backfillVersionsJobSchema = z.object({})
export const recordRowGroupsJobSchema = z.object({})
export const convertSetAsideJobSchema = z.object({})
// Ids only, like every other job. What to read is settled by the version row —
// the handler interprets its file again (ADR-046) — so a message carrying
// anything else could only come to disagree with it. Messages queued before
// that carried a `previewKey`; unknown keys are stripped, so they still parse.
export const lakeIngestJobSchema = z.object({
  resourceId: z.uuid(),
  version: z.number().int().positive(),
})
/** `refresh` also rewrites abstracts another model, prompt or language wrote */
export const summarizeAllJobSchema = z.object({ refresh: z.boolean().optional() })
export const summarizePackageJobSchema = z.object({
  packageId: z.uuid(),
  /** Where the walk got to. Absent starts it (ADR-053 §11.1). */
  after: z.uuid().optional(),
  refresh: z.boolean().optional(),
})

/** A single file/directory entry in a ZIP manifest */
export interface ZipEntry {
  path: string
  size: number
  compressedSize: number
  lastModified: string
  isDirectory: boolean
}

/** Manifest describing the contents of a ZIP archive */
export interface ZipManifest {
  totalFiles: number
  totalSize: number
  totalCompressed: number
  truncated: boolean
  entries: ZipEntry[]
}
