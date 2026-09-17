/**
 * AI-generated resource abstracts (ADR-053).
 *
 * An abstract in the bibliographic sense: a short, accurate statement of what a
 * file holds, so someone can judge it without opening it — and, as a side
 * effect, more for the embedding to work from. **The AI's inference is limited
 * to these sentences.** Nothing a machine believes — a column type, a primary
 * key, a header row — is generated here, which is what keeps the abstract a
 * reversible artifact nothing else depends on (ADR-046, ADR-043).
 */

/**
 * What the abstract was written from. Shown in the notice, because knowing the
 * material is what tells a reader which part to check.
 */
export type SummaryMaterial =
  /** Column names and types plus sample rows (CSV/TSV) */
  | 'schema'
  /** Head of the stored original (text formats) */
  | 'text'
  /** The Index step's extracted-text artifact (documents with a text layer) */
  | 'text-head'
  /** The file itself, sent to the provider */
  | 'original'
  /** The image itself, downscaled where the API required it */
  | 'image'
  /** A ZIP's file listing */
  | 'files'

/**
 * Why no abstract was written. Shown on the page: nothing there and a stated
 * reason read differently, and the count of each is how we learn whether the
 * limits are set anywhere near right (ADR-053 §5).
 *
 * A transient failure is not one of these — it is the run's, not the file's,
 * and belongs in the step record. The feature being switched off is not one
 * either: nothing is written at all then, so a site that switches it on later
 * has nothing to clear.
 */
export type SummarySkipReason =
  | 'provider-unavailable'
  | 'unsupported-format'
  /** The bytes are not what the resource declares them to be (ADR-047) — a
   *  dead link the publisher answered with a page. A fact about this version,
   *  so it stands until the content changes */
  | 'format-mismatch'
  | 'too-large'
  | 'rejected'
  | 'no-material'
  | 'not-public'
  | 'hidden'

/**
 * How much of the file the abstract was written from.
 *
 * The notice has to answer "all of it, or part of it" (ADR-053 §7), and until
 * it did, the model answered for it: given five sample rows it wrote that a
 * column "was null in the sample rows" — true, and unreadable to someone who
 * was never told there were sample rows. The reader is told the extent here,
 * and the model is told to write about the file instead.
 *
 * Absent on abstracts written before this was recorded; the notice then falls
 * back to naming the material without a quantity.
 */
export interface SummaryCoverage {
  /** Rows, characters or file names actually read */
  read?: number
  /** How many there are in total, where the material says */
  total?: number
}

/** The language abstracts are written in (runtime setting, ADR-053 §6.2) */
export type SummaryLocale = 'ja' | 'en'

/**
 * Everything about a resource's abstract except the text, held as one jsonb
 * column (ADR-053 §4.1).
 *
 * The split is the one {@link HealthCheckState} makes: only what a query filters
 * on earns a column, and nothing here is ever filtered on — both the embedding
 * assembly and the public projection decide after they have read the row.
 *
 * The last four are the worker talking to itself. They must not reach the
 * public projection — see `publicSummary`, which is the only place this is
 * turned into a response.
 */
export interface ResourceSummaryMeta {
  /** 'human' is an editor's own text, which generation never overwrites */
  source?: 'ai' | 'human'
  /** An editor hid it: no display, no embedding, and no regeneration */
  hidden?: boolean
  /** The version it was generated from (ADR-043), named in the notice */
  version?: number
  material?: SummaryMaterial
  /** How much of the file was read — shown in the notice (ADR-053 §7) */
  coverage?: SummaryCoverage
  /** ISO-8601 */
  generatedAt?: string
  skipReason?: SummarySkipReason
  /**
   * Model, generation version and language, as one string (ADR-053 §4.2).
   *
   * Held apart from the version because it moves for a different reason and
   * costs a different thing. An ordinary run acts on the version alone: the
   * file changed, and regenerating is the only way to describe it. Raising
   * the generation makes every abstract in the catalogue stale at once, and
   * letting an ordinary run act on that turns a one-line edit into a bill
   * nobody chose — so the refresh is asked for explicitly, and this is what
   * it compares.
   */
  genKey?: string
  model?: string
  /** The model's own answer to "was the material enough". Measured, never acted on */
  grounded?: boolean
  /** What an over-limit refusal said the request came to, so the next run refuses it first */
  rejectedTokens?: number
}

/** The abstract as the public API returns it (ADR-053 §10.1) */
export interface ResourceSummaryView {
  /** null when hidden, or when none was written */
  text: string | null
  source: 'ai' | 'human' | null
  version: number | null
  material: SummaryMaterial | null
  coverage: SummaryCoverage | null
  generatedAt: string | null
  skipReason: SummarySkipReason | null
}

// ── Limits (ADR-053 §3.2) ──
// Applied only to formats whose original is sent. A CSV's material is its
// schema and five rows, so a 78MB one costs the same as a 6KB one.

/**
 * Documents whose original is sent.
 *
 * **This limit does not guard cost.** Measured on Sonnet 4.6 with the page
 * count pinned at two and the bytes padded: 3MB and 22.6MB both billed 3,158
 * input tokens, and 22.9MB was refused as too long. Tokens follow pages, which
 * is what {@link SUMMARY_MAX_PDF_PAGES} already bounds — so the ceiling on one
 * PDF is the same whatever it weighs.
 *
 * What it guards is the API's own limit, measured at about 22.7MB, and the
 * worker's memory, since counting a PDF's pages means holding all of it. The
 * margin is for the rest of the request: the measurement sent an attachment
 * and little else, and the prompt rides along with it.
 *
 * It was 4MB, which fitted 87% of the PDFs in the measured catalog — a
 * coverage figure, answering neither of the two questions above. What it cost
 * was the scans: a 38-page survey of 6.9MB has no text layer at all, so the
 * original is the only path it has, and the byte limit was the only thing
 * stopping it.
 */
export const SUMMARY_MAX_DOC_BYTES = 16 * 1024 * 1024
/**
 * Office formats, held lower than PDF: a 1.5MB XLSX measured 919k tokens, which
 * a million-token model would accept and bill at $2–$4.6 for one file.
 */
export const SUMMARY_MAX_OFFICE_BYTES = 1 * 1024 * 1024
/**
 * A PDF's tokens track its page count, not its bytes — 1,985–3,078 per page
 * whether the page holds 1,559 characters or none. 50 pages keeps 90% of them;
 * the API's own ceiling is 100.
 */
export const SUMMARY_MAX_PDF_PAGES = 50
/** Per-page estimate for the pre-flight cost estimate */
export const SUMMARY_PDF_TOKENS_PER_PAGE = 2500
/**
 * Where extracted text stops being worth sending the original for. Below this
 * the text layer is too thin to describe the file; above it, extracted text
 * costs 1.7–9.3× less and reads at least as well (ADR-053 §3.6).
 *
 * It says nothing about whether the pages are legible — that is a separate
 * axis, and why the original path is given a model that can read a poor scan.
 */
export const PDF_TEXT_LAYER_MIN_CHARS_PER_PAGE = 100
/** Non-space characters below which material counts as absent */
export const SUMMARY_MIN_MATERIAL_CHARS = 50
/** Long edge an over-limit image is downscaled to before sending */
export const SUMMARY_IMAGE_RESIZE_PX = 1600
/** Characters of the dataset's notes passed as context, capped against parroting */
export const SUMMARY_CONTEXT_NOTES_CHARS = 400

/**
 * Raised by the change that alters what the model is shown for the same file,
 * or how it is asked: the prompt and its locale addenda, the size and page
 * limits, how a material is chosen, an extraction improvement the abstracts
 * should reflect. Not by a refactor, a UI change, or a model switch — the
 * model is its own half of {@link generationKey}.
 *
 * It is half of {@link generationKey}, so raising it makes every stored
 * abstract "written some other way" — visible on the admin screen with its
 * cost, and rewritten only when someone asks for a refresh. An ordinary run
 * does not act on it: a one-line edit here must not turn every upload into a
 * completion nobody chose. This is the one lever, on purpose: a run that
 * compared the derived material instead would regenerate on every internal
 * change of the pipeline, unquoted.
 *
 * 3: an abstract now stands while its version does (was: while a digest of
 *    the derived material did)
 */
export const SUMMARY_GENERATION_VERSION = 3

/**
 * How a deployment writes abstracts now: the model, the generation and the
 * language.
 *
 * Readable rather than hashed, because the admin screen counts the abstracts
 * written some other way and has to compare this value in SQL — a digest could
 * only say "different".
 */
export function generationKey(model: string, locale: SummaryLocale): string {
  return `${model}|${SUMMARY_GENERATION_VERSION}|${locale}`
}

/**
 * What a model costs, per million tokens.
 *
 * Held as the **global rate**, with the premium applied on top, because that is
 * how Bedrock actually prices these: every Claude model the Price List API
 * returns for ap-northeast-1 quotes the geo-limited profile at exactly 1.1×
 * its global one (2026-09). Storing one number and a rule keeps the two from
 * drifting apart, which two columns of hand-copied figures would.
 *
 * Provenance, because these are money: Opus 4.7 / 4.8 / 5, Sonnet 5 and the
 * Fable and Mythos lines come from the AWS Price List API, both figures. Haiku
 * 4.5 and Sonnet 4.5 / 4.6 have their input from the same place and their
 * output from the bill ADR-053 measured — the API publishes no output SKU for
 * them in this Region.
 *
 * **A model that is not listed has no rate, and the screen shows tokens only.**
 * Rates move, and a figure nobody checked is worse than none when the subject
 * is money. Matched on a substring, so one entry covers the bare model id and
 * every profile prefix it can carry.
 */
const BASE_RATES_USD: ReadonlyArray<[match: string, input: number, output: number]> = [
  ['claude-haiku-4-5', 1.0, 5.0],
  ['claude-sonnet-4-5', 3.0, 15.0],
  ['claude-sonnet-4-6', 3.0, 15.0],
  ['claude-sonnet-5', 2.0, 10.0],
  ['claude-opus-4-7', 5.0, 25.0],
  ['claude-opus-4-8', 5.0, 25.0],
  ['claude-opus-5', 5.0, 25.0],
  ['claude-fable-5', 10.0, 50.0],
  ['claude-mythos-5', 10.0, 50.0],
]

/**
 * What a geo-limited inference profile adds.
 *
 * Not a tax and not a markup anyone chose: it is what Bedrock charges to keep
 * the destinations inside one geography, which is the promise a deployment
 * makes when it says the processing stays in the country (ADR-053, cost).
 */
const GEO_PROFILE_PREMIUM = 1.1

/**
 * Amazon's own models are priced per Region rather than per profile, so they
 * carry their Region rate and take no premium. Nova 2.0 Lite is here because it
 * is invokable, not because it should be used — Phase C measured what it does
 * to a scanned page (appendix 18).
 */
const REGION_RATES_USD: ReadonlyArray<[match: string, input: number, output: number]> = [
  ['nova-2-lite', 0.36, 3.01],
]

export interface TokenRate {
  inputPerMillion: number
  outputPerMillion: number
}

/**
 * The rate for a model id as it will be invoked, or null where none is recorded.
 *
 * The prefix is part of the price: `global.*` reaches every commercial Region
 * and pays the base rate, and anything else is geography-limited and pays the
 * premium for it.
 */
export function tokenRate(model: string | null): TokenRate | null {
  if (!model) return null
  const region = REGION_RATES_USD.find(([match]) => model.includes(match))
  if (region) return { inputPerMillion: region[1], outputPerMillion: region[2] }
  const base = BASE_RATES_USD.find(([match]) => model.includes(match))
  if (!base) return null
  const factor = model.startsWith('global.') ? 1 : GEO_PROFILE_PREMIUM
  return {
    inputPerMillion: base[1] * factor,
    outputPerMillion: base[2] * factor,
  }
}

/** USD for a number of tokens at a rate, to the cent */
export function tokensToUsd(rate: TokenRate, input: number, output: number): number {
  const usd = (input * rate.inputPerMillion + output * rate.outputPerMillion) / 1_000_000
  return Math.round(usd * 100) / 100
}
