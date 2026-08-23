/**
 * What the version API answers with (ADR-043) — one declaration for the service
 * that builds it and the screen that renders it.
 *
 * Restating a response shape on the client is a copy with no compile-time tie to
 * the original, so a rename or a widened union server-side lands silently: the
 * client keeps type-checking, its tests keep passing, and only the screen is
 * wrong. The diff panel held such a copy — the reasons a diff can be refused,
 * spelled out again as string literals — and a reason added server-side left it
 * stale with nothing to object; the screen printed the translation key. Sharing
 * the declaration is what makes that a build failure. What a new reason then
 * *says* is still the message catalogue's to answer.
 *
 * **These are the shapes after JSON**, which is the only form both sides see. A
 * timestamp is therefore an ISO string rather than a `Date`: shared as a `Date`
 * the type would be true on the server and false in every browser, and the one
 * place to settle that is where the view is built.
 */
import type { VersionOrigin } from './formats'
import type {
  DiffUnavailableReason,
  LakeIngestReason,
  NoTableReason,
  ResourceSchema,
} from './pipeline-types'

/**
 * `superseded` is legacy only: a revert publishes forward and never writes it
 * (ADR-044 §4), but rows from before that change keep it and are left alone.
 * Named here because the view carries whatever the row says — dropped from the
 * union, the view's cast would assert something false, and a reader switching
 * exhaustively would miss the case the database can still hand it.
 */
export type VersionState = 'active' | 'purging' | 'purged' | 'superseded'

/**
 * A version as exposed through the API. Purged versions are tombstones: their
 * content-bearing fields (storageKey/hash/size/schema) are withheld.
 *
 * **`purgeReason` is not here at all**. It is free text an
 * administrator writes about why content had to go, so for a takedown it can
 * describe — or quote — the very thing the purge was destroying, and this view is
 * readable by anyone who can read the resource. Withholding the content while
 * publishing the account of it is the wrong way round.
 *
 * Nothing is lost: the audit log records who purged what, when and why, and
 * accountability lives there. Dropped rather than gated on permission, because no
 * screen reads it — passing a viewer in to keep a value nobody displays would be
 * API surface for its own sake. `purgedAt` stays: version numbers skip where a
 * purge happened and that needs explaining, which a date alone does without
 * leaking anything.
 */
export interface VersionView {
  version: number
  origin: VersionOrigin
  state: VersionState
  /**
   * Whether this is the version the resource is serving right now.
   *
   * **Answered here because a client cannot answer it.** The live pointer names
   * an object, not a version, and two shapes defeat the rules a client would
   * reach for instead (spec §9.6, with an integration test each):
   *
   * - **"the highest version"** — purging the newest leaves its tombstone on top
   *   with live below it, and a row an old-style revert set aside outranks live
   *   for as long as it is unconverted (ADR-044 §4)
   * - **"the highest `active` version"** — not during a purge: live stands on a
   *   `purging` version until the worker moves the pointer, and every active
   *   version is then something else
   *
   * It is what a purge acts on, so the confirmation screen needs it to say what a
   * purge will do rather than describing every branch.
   *
   * **True now, not a promise about later.** Live can move between a read of this
   * and anything done about it — another run publishing, a concurrent revert — so
   * a screen that names the case still says it conditionally.
   */
  isLive: boolean
  /**
   * The version serving would land on if this one were purged.
   *
   * **Set only when {@link isLive}**, because only that purge moves serving at
   * all: taking any other version leaves the pointer, the preview and the index
   * where they are. Null therefore means either "not the version being served" or
   * "nothing would be left to serve" — the difference is `isLive`, which a caller
   * reading this has already.
   *
   * The other half of what the confirmation screen says, and here for the same
   * reason as {@link isLive}: it is a rule about which versions a restore may
   * stand on (the service's `newestActiveVersion`), and a client that re-derived
   * it would go stale the moment that rule changed — while its own tests kept
   * passing. It also stops depending on the client holding every version, which a
   * paginated list would break (spec §14.1 open issue 13).
   */
  purgeFallsBackTo: number | null
  /** What this version was read as (ADR-046 §6). Kept on a tombstone: it
   *  describes how the content was interpreted, not the content itself. */
  format: string | null
  /**
   * The columns this version's rows were identified by, or null for a version
   * read without a key (spec §6.4).
   *
   * The other half of "these bytes, read this way". The resource's own setting
   * says what the *next* version will be read under, which is a different
   * question for as long as a queued run has not landed — so the history is the
   * only place that answers this one.
   *
   * **Withheld on a tombstone, unlike {@link format}**, though both are the
   * operator's decision rather than the content. A key is only settable over
   * columns the content has (the service checks that before accepting one), so
   * the names are a subset of the {@link schema}
   * withheld two lines below — publisher-authored strings, where a format is a
   * closed vocabulary. That is enough on its own, and there is a second channel:
   * a revert copies its destination's key, so an alive `revert` version showing a
   * key that only one tombstone carries reconstructs the {@link restoredFrom}
   * this view nulls for exactly that pair (spec §9.4).
   *
   * Why the version was *refused* is not here at all: it is a statement about
   * the content, and it belongs where someone asks for the diff it explains
   * ({@link DiffUnavailableReason}), which is behind the editor permission its
   * audience implies.
   */
  keyColumns: string[] | null
  size: number | null
  hash: string | null
  schema: ResourceSchema | null
  /**
   * Why there is no table, when there is none.
   *
   * Beside the empty schema it explains: the schema says "interpreted, nothing
   * to load" and stops there, and that is not what someone asking why there is
   * no preview wants to know (ADR-046).
   *
   * `too-large` is derived rather than read from the row. It is a fact about the
   * cap, not about the version — persist it and a version settled under an old
   * cap keeps saying so after the cap moves. The two the row does carry are facts
   * about the bytes, and the bytes never change.
   */
  noTableReason: NoTableReason | null
  /**
   * The version this one re-published, for the ones a revert issued (ADR-044
   * §4). Null everywhere else.
   *
   * On the view because the history is the only place that answers it: content
   * and its reading repeat by design (ADR-046 §3), so a client comparing hashes
   * would name whichever match it happened to pick.
   *
   * **Withheld on a tombstone**, like the hash it would otherwise reconstruct:
   * saying a purged version re-published v5 states that its content was
   * identical to v5, which is the check hiding the hash exists to prevent
   * (spec §9.4). The column stays on the row — this is exposure, not erasure.
   */
  restoredFrom: number | null
  /** ISO 8601, as JSON leaves it. */
  created: string
  /** When the version was retracted — the whole of what a tombstone says about it,
   *  since the reason is not exposed (see above). ISO 8601. */
  purgedAt: string | null
}

/** What the primary-key picker reads before it offers anything (spec §6.4). */
export interface ColumnSettingsView {
  /** What the resource is set to read versions under from here on (spec §6.2). */
  primaryKey: string[] | null
  /**
   * Whether the newest standing version was already read under {@link primaryKey}.
   *
   * False means a rebuild is owed and the setting has not reached a version
   * yet — which is a state the screen has to be able to name, because the
   * setting and the version disagreeing is normal for as long as the run has
   * not landed, not a fault.
   */
  carried: boolean
  /**
   * The columns a key may be chosen from — the live version's frozen
   * interpretation. Null before anything has been interpreted.
   *
   * Every column, not only the ones that could stand alone: a composite key is
   * built out of columns that individually repeat, and `unique` on each column
   * is what marks the ones that need no checking (ADR-046).
   */
  schema: ResourceSchema | null
  /**
   * Whether the interpretation's Parquet can be shown as a sample of what the
   * columns hold.
   *
   * Answered here because it is the same predicate the key check reports as
   * `checked: false`, and the two must not disagree about whether the preview is
   * about the live bytes — a picker showing rows the resource does not serve is
   * choosing a key over the wrong content.
   */
  preview: 'ready' | PreviewUnusable
}

/** Why the interpretation's Parquet cannot be read for this resource. */
export type PreviewUnusable = 'no-preview' | 'preview-stale'

/**
 * What a key check can say (spec §6.4).
 *
 * Three states, not two: "it will work", "this is what would stop it", and
 * "this cannot be established" — the last because the apply asks nothing of the
 * content, so a resource whose preview is missing can still be settled and a
 * screen must not read "cannot check" as "do not apply".
 */
export type KeyCheck =
  | { checked: true; primaryKey: string[] | null; fault: LakeIngestReason | null }
  | { checked: false; primaryKey: string[]; reason: PreviewUnusable }

/** A column of a version's table, as the diff names it. */
export interface DiffColumn {
  name: string
  type: string
}

export interface SchemaDiff {
  added: DiffColumn[]
  removed: DiffColumn[]
  retyped: { name: string; from: string; to: string }[]
}

/** One sampled row, by column name. Wide cells arrive trimmed — the sample is
 *  there to recognize a change, not to read the value back. */
export interface DiffRow {
  [column: string]: unknown
}

/**
 * Either the columns lined up and the rows were compared, or they did not and
 * only the schema change is reported. A union rather than one shape with nulls,
 * so neither side carries filler the other has to guard against.
 *
 * Built in `@kukan/lake` and handed on unchanged, so it is declared here with
 * the view that wraps it rather than there: the panel renders these fields
 * verbatim, which makes them API surface wherever they are produced.
 */
export type VersionDiff =
  | { schemaChanged: true; schemaDiff: SchemaDiff }
  | {
      schemaChanged: false
      /**
       * Whether rows were identified by a declared primary key.
       *
       * False here: the rows were compared whole, so an edited row is one
       * addition and one removal and no count of edits exists. Stated rather
       * than left to be inferred from an absent `changedRows` — absence would
       * mean both "not measured" and "measured zero", and a reader picking the
       * wrong one reports edits that did not happen or none where there were
       * some.
       */
      keyed: false
      /** Rows in `to` that are absent from `from`, and the converse. */
      addedRows: number
      removedRows: number
      sampleAdded: DiffRow[]
      sampleRemoved: DiffRow[]
    }
  | {
      schemaChanged: false
      /**
       * The rows were matched by a key both ends were loaded under, so an edit
       * is one changed row rather than an addition and a removal.
       */
      keyed: true
      /** Keys in `to` that `from` did not have, and the converse. */
      addedRows: number
      removedRows: number
      /** Keys both hold, whose other columns differ. */
      changedRows: number
      sampleAdded: DiffRow[]
      sampleRemoved: DiffRow[]
      /** The changed rows **as `to` holds them** — the name says which side. */
      sampleChangedAfter: DiffRow[]
      /**
       * The same rows as `from` held them, aligned by position with
       * {@link sampleChangedAfter}: without it a changed row shows its new
       * values and nothing to read them against, which is the one thing
       * "changed" is supposed to say.
       *
       * **Only the columns that differ**, so a reader marks a cell by whether
       * this row has it rather than by comparing the two values. Comparing is
       * not open to it: cells are trimmed for display, so two long values that
       * share their opening arrive identical, and the one cell that moved would
       * be shown as unmoved. Which columns moved is decided in SQL, over the
       * whole value.
       *
       * The key columns are never among them — a changed row matched on its
       * key, so both sides hold it — and carrying them twice would widen what
       * the window buffers over every changed row before the sample is cut, for
       * values already in the other half.
       */
      sampleChangedBefore: DiffRow[]
    }

/** A diff of two versions, or the reason there is none. */
export type VersionDiffView =
  | {
      available: false
      reason: DiffUnavailableReason
      from: number | null
      to: number
      /**
       * The version the `reason` is about, when it is about one of the two.
       *
       * A diff has two ends, and every reason but `no-previous-version` belongs
       * to whichever end carries it — routinely **not** the one the reader
       * opened. For a key fault the repair path makes that the common case: the
       * key is corrected, the next version takes the correction and loads, and
       * the reader opens *that* version's diff, whose other end is the refused
       * one. It happens to `not-ingested` just as easily, since a resource
       * gains snapshots from the version it was first keyed on. Unnamed, the
       * sentence reads as a verdict on the version in front of the reader —
       * which is the one where nothing is wrong.
       *
       * Null only where no single version is the subject: no predecessor to
       * compare against, and a purge, which the answer states of the pair
       * because either end being a tombstone stops the comparison the same way.
       */
      reasonVersion: number | null
    }
  | ({ available: true; from: number; to: number } & VersionDiff)
