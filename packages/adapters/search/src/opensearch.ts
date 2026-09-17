/**
 * KUKAN OpenSearch Adapter
 * Full-text search with kuromoji analyzer for Japanese text.
 *
 * Two indices:
 *   kukan-packages  — dataset-level metadata (title, notes, tags, org, …)
 *   kukan-resources  — resource-level metadata + extracted text content
 *
 * Searching with `q` fires an msearch across both indices and merges results.
 */

import { randomBytes } from 'node:crypto'
import { Client, errors as osErrors } from '@opensearch-project/opensearch'
import { createLogger, ServiceUnavailableError, type Logger } from '@kukan/shared'
import type {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  SearchFilters,
  ResourceCountQuery,
  SearchFacets,
  SearchFacetBucket,
  DatasetDoc,
  ResourceDoc,
  ContentDoc,
  MatchedResource,
  IndexStats,
  BrowseResult,
  ContentBrowseResult,
  ContentBrowseItem,
  MatchedResourcesCount,
} from './adapter'
import { MAX_MATCHED_RESOURCES_PER_PACKAGE, MATCHED_FIELDS } from './adapter'

/** The one shape of the search index: the create body, and what an index
 *  created under an older shape is brought up to (see ensureWritableIndex). */
type MappingProperties = NonNullable<
  Parameters<Client['indices']['putMapping']>[0]['body']
>['properties']

const SEARCH_PROPERTIES: MappingProperties = {
  // Join field: package is parent, resource and content are children
  join_field: {
    type: 'join',
    relations: { package: ['resource', 'content'] },
  },
  // --- Package fields ---
  id: { type: 'keyword' },
  name: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
    fields: { keyword: { type: 'keyword' } },
  },
  title: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
    fields: { keyword: { type: 'keyword' } },
  },
  notes: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
  },
  tags: { type: 'keyword' },
  organization: { type: 'keyword' },
  license_id: { type: 'keyword' },
  groups: { type: 'keyword' },
  formats: { type: 'keyword' },
  private: { type: 'boolean' },
  owner_org_id: { type: 'keyword' },
  creator_user_id: { type: 'keyword' },
  created: { type: 'date' },
  updated: { type: 'date' },
  // --- Resource fields ---
  packageId: { type: 'keyword' },
  description: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
  },
  format: { type: 'keyword' },
  // The section a resource is drawn under (ADR-050): a search term, not a facet
  section: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
  },
  // The AI-written abstract (ADR-053). It is told to gloss official terms with
  // the everyday word in parentheses, which is vocabulary the keyword leg has
  // nowhere else — a person's description rarely spells both.
  summary: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    search_analyzer: 'kuromoji_query_analyzer',
  },
  // --- Content fields ---
  resourceId: { type: 'keyword' },
  extractedText: {
    type: 'text',
    analyzer: 'kuromoji_analyzer',
    // Request boilerplate is dropped from the query, and nothing else is: a
    // document's own text is where a particle or a bare「こと」is the thing
    // someone is looking for, so `ja_stop` has no business here.
    search_analyzer: 'kuromoji_content_query_analyzer',
    index_options: 'offsets',
  },
  contentType: { type: 'keyword' },
  chunkIndex: { type: 'integer' },
  chunkSize: { type: 'integer' },
}

/** Highlight config for a short field marked whole rather than in fragments */
const WHOLE_FIELD_HIGHLIGHT = {
  number_of_fragments: 0,
  pre_tags: ['<mark>'],
  post_tags: ['</mark>'],
}

/** Highlight config for content snippets (shared between search stages) */
const CONTENT_HIGHLIGHT = {
  fields: {
    extractedText: {
      fragment_size: 300,
      number_of_fragments: 1,
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
    },
  },
}

/** Check if an error is an OpenSearch 404 (not found) */
function isNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 404)
}

/**
 * Whether an error means the OpenSearch backend is unreachable or overloaded
 * (timeout, lost connection, 5xx, or 429 circuit breaker) rather than a bad request.
 * Used to map only these to a 503 — a 4xx (e.g. a malformed query) or any non-client
 * error (e.g. a response-parsing bug) must propagate as 500 so it stays visible.
 */
function isBackendUnavailable(err: unknown): boolean {
  if (
    err instanceof osErrors.TimeoutError ||
    err instanceof osErrors.ConnectionError ||
    err instanceof osErrors.NoLivingConnectionsError
  ) {
    return true
  }
  if (err instanceof osErrors.ResponseError) {
    const status = err.statusCode ?? 0
    return status >= 500 || status === 429
  }
  return false
}

/**
 * Sanitize OpenSearch highlight output: allow only bare <mark> and </mark> tags.
 * The output is parsed downstream on `/` with `</mark>` spared (a section label
 * drawn as a trail), so it must stay bare `<mark>` and `</mark>` and nothing else.
 */
/** `hits.total` as a number, whichever shape the engine sent it in */
function hitsTotal(total: unknown): number {
  return typeof total === 'number' ? total : ((total as { value?: number })?.value ?? 0)
}

/**
 * How many resources a package's hits stand for. inner_hits is capped, so the
 * metadata count comes from its `total`; a content hit is a chunk, so one on a
 * resource not among the carried metadata hits counts only when nothing went
 * uncarried — otherwise it may be one of those. Content hits past the cap, or a
 * `gte` total, leave the count a floor too.
 */
function matchedResourcesCount(hit: {
  resourceTotal: { value?: number; relation?: string } | number | undefined
  carried: number
  contentOnly: number
  contentCapped: boolean
  matched: number
}): MatchedResourcesCount {
  const metadata = hitsTotal(hit.resourceTotal)
  const truncated = metadata > hit.carried
  const total = Math.max(truncated ? metadata : metadata + hit.contentOnly, hit.matched)
  const relation = typeof hit.resourceTotal === 'object' ? hit.resourceTotal?.relation : undefined
  return { total, atLeast: truncated || hit.contentCapped || relation === 'gte' }
}

function sanitizeHighlight(html: string): string {
  return html.replace(/<mark\b[^>]*>/gi, '<mark>').replace(/<\/?(?!mark\b)[a-z][^>]*>/gi, '')
}

export interface OpenSearchConfig {
  endpoint: string
  indexPrefix?: string
  /** Number of replicas per index shard (default: 0). Set to 1+ for multi-node clusters. */
  replicas?: number
  auth?: {
    username: string
    password: string
  }
  /** Optional structured logger (pino). Falls back to no-op if omitted. */
  logger?: Logger
}

/**
 * An analysis definition as one comparable string: every value stringified and
 * every key in one order, so what differs is the settings and not the shape the
 * cluster chose to answer in.
 */
function normaliseAnalysis(value: unknown): string {
  const normalise = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalise)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, normalise(x)])
          )
        : String(v)
  return JSON.stringify(normalise(value))
}

/**
 * Documents per `_reindex` batch when the index is re-analysed.
 *
 * Small because a content chunk is up to 500KB and the batch is held in heap:
 * measured 2026-09-17, 50 a batch took a 285MB index to 80% heap and 1.6gb
 * against the 1.8gb parent breaker, close enough that a concurrent search was
 * rejected. Ten keeps a batch near 3MB, and `t3.small.search` — the smallest
 * deployment size — runs on half the heap that measurement had.
 */
interface ReindexResponse {
  total?: number
  created?: number
  updated?: number
  deleted?: number
  noops?: number
  version_conflicts?: number
  timed_out?: boolean
  canceled?: string
  failures?: unknown[]
}

/**
 * What a finished `_reindex` task actually copied.
 *
 * `failures` empty is not the same as "all of them": a cancelled task reports
 * `completed: true`, no `error` and no failures, having copied whatever it had
 * reached — and the alias would then be swapped onto a truncated index while
 * the complete one is deleted. So the documents are counted, and anything the
 * copy left behind is reported as a failure of the copy.
 */
function countCopied(r: ReindexResponse): { total: number; failures: unknown[] } {
  const total = r.total ?? 0
  const handled = (r.created ?? 0) + (r.updated ?? 0) + (r.deleted ?? 0) + (r.noops ?? 0)
  const shortfall: unknown[] = []
  if (r.canceled) shortfall.push({ canceled: r.canceled })
  if (r.timed_out) shortfall.push({ timed_out: true })
  if (r.version_conflicts) shortfall.push({ version_conflicts: r.version_conflicts })
  if (handled !== total) shortfall.push({ copied: handled, of: total })
  return { total, failures: [...(r.failures ?? []), ...shortfall] }
}

/**
 * Whether the cluster refused a request outright, so nothing it asked for was
 * applied.
 *
 * A 4xx is an answer: the action list was rejected and the cluster is as it
 * was. A timeout, a dropped connection or a 5xx is not — the request may still
 * be working its way through, and treating that as "it did not happen" is how a
 * caller undoes something that is about to take effect.
 */
function refusedOutright(err: unknown): boolean {
  if (!(err instanceof osErrors.ResponseError)) return false
  const status = err.statusCode ?? 0
  return status >= 400 && status < 500
}

/** The 400 that means "someone else got here first", as opposed to a bad mapping */
function isAlreadyExists(err: unknown): boolean {
  const type = (err as { meta?: { body?: { error?: { type?: string } } } })?.meta?.body?.error?.type
  return type === 'resource_already_exists_exception'
}

/**
 * How much a child match is worth against a match on the package itself.
 *
 * A resource's own metadata — its name, description, abstract — is a statement
 * about what the dataset holds. Text lifted out of a file is not: a word can
 * appear once in a free-text answer among a thousand, and `score_mode: 'max'`
 * lets that one chunk speak for the whole dataset. Held at the same weight, a
 * survey whose respondents happened to use the word outranked the documents
 * whose abstracts are about it.
 *
 * Measured on the golden set (dev catalogue, 168 packages, 2026-09-17) by
 * sweeping the content weight with everything else held still:
 *
 * | content weight | `word` nDCG, keyword leg | fused |
 * | -------------- | ------------------------ | ----- |
 * | 0 (off)        | 62%                      |       |
 * | 0.05           | 67%                      |       |
 * | 0.15           | 67%                      | 71%   |
 * | 0.25           | 64%                      |       |
 * | 0.4            | 54%                      | 66%   |
 *
 * Lowered rather than removed: at zero it loses 5 points, so content earns its
 * place — it just must not outvote what a dataset says about itself. `exact`
 * stays at 100% throughout. `score_mode` was the other candidate and is not the
 * answer: `sum` drops `exact` to 87%, because a long document that repeats a
 * name outscores the dataset that carries it.
 */
const RESOURCE_LEG_WEIGHT = 0.4
const CONTENT_LEG_WEIGHT = 0.15

const REINDEX_BATCH_DOCS = 10
/** Between polls of the copy task */
const REINDEX_POLL_MS = 5_000
const REINDEX_TIMEOUT_MS = 60 * 60_000

export class OpenSearchAdapter implements SearchAdapter {
  private client: Client
  /**
   * What every read and write names. An alias in a deployment created since
   * ADR-025's re-analysis work, the concrete index itself in one created
   * before it — every operation here works through either (verified: search,
   * count, index, delete_by_query, putMapping, cat.indices), so only the
   * lifecycle below has to tell them apart.
   */
  private searchIndex: string
  private replicas: number
  private log: Logger
  private initializedAt = 0
  /** The mapping brought up to date, once per process (see ensureWritableIndex) */
  private mapping: Promise<void> | null = null

  constructor(config: OpenSearchConfig) {
    this.client = new Client({
      node: config.endpoint,
      ...(config.auth && {
        auth: { username: config.auth.username, password: config.auth.password },
      }),
      // Reuse TCP connections instead of opening a new socket per request,
      // bounding socket count to avoid ephemeral-port exhaustion under load.
      agent: { keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 50, maxFreeSockets: 10 },
      // Reduce recovery time after transient connection failures (e.g. during deploy).
      // 'optimistic' skips ping check and sends real requests to revive dead nodes faster.
      maxRetries: 3,
      requestTimeout: 10_000,
      resurrectStrategy: 'optimistic',
    })
    const prefix = config.indexPrefix || 'kukan'
    this.searchIndex = `${prefix}-search`
    this.replicas = config.replicas ?? 0
    this.log = config.logger ?? createLogger({ name: 'opensearch', level: 'silent' })
  }

  // ------------------------------------------------------------------
  // Index initialisation
  // ------------------------------------------------------------------

  private static readonly KUROMOJI_ANALYSIS = {
    analysis: {
      filter: {
        // Request boilerplate in question-form queries ("〜が欲しい", "〜を教えて").
        // Listed as kuromoji_baseform output. Applied query-side only (metadata
        // fields' search_analyzer) so these terms never become required matches
        // under operator:'and', while indexed documents keep their full text.
        // Honorific prefixes:「お」年寄り,「ご」案内. kuromoji tags them
        // 接頭詞-名詞接続 and the default stoptags do not drop them, so they
        // reach the index as terms of their own — and under operator:'and' they
        // become required ones. Nobody searching for「お年寄り」means「お」.
        //
        // It looked handled because `ja_stop` happens to list「お」, but that is
        // a word list, not a part of speech:「ご」survived it, on both sides,
        // and「お」survived on the index side, which has no ja_stop — so the
        // highlighter lit up every honorific in the document:「お問い合わせ」,
        //「お姉さん」, the「お」inside「におい」.
        //
        // Applied to both analyzers, unlike ja_stop: a prefix is not a term in
        // a document either. Words the dictionary holds whole are untouched
        //（お茶, お金, お守り, お年玉, ご飯）; the ones it splits lose a prefix
        // that was never the search term（ご祝儀 → 祝儀, お手洗い → 手洗い）.
        //
        // Measured on the golden set (Cohere v4), with and without, both
        // `_reindex`ed from the same source: the ranking does not move — one
        // query per leg reshuffles at ranks 7–10, every type's mean is
        // unchanged, and so are the content match counts. It earns its place
        // on the highlighter and on the two sides agreeing, not on the score.
        ja_prefix: {
          type: 'kuromoji_part_of_speech' as const,
          stoptags: ['接頭詞-名詞接続'],
        },
        ja_request_words: {
          type: 'stop' as const,
          stopwords: [
            '欲しい',
            'ほしい',
            '教える',
            'くださる',
            'ください',
            '下さい',
            '知る',
            '分かる',
            'わかる',
            '調べる',
            '探す',
            '見る',
            'お願い',
            '願う',
            'もらう',
            'いただく',
            '頂く',
          ],
        },
      },
      analyzer: {
        kuromoji_analyzer: {
          type: 'custom' as const,
          tokenizer: 'kuromoji_tokenizer',
          filter: ['kuromoji_baseform', 'kuromoji_part_of_speech', 'ja_prefix', 'lowercase'],
        },
        kuromoji_query_analyzer: {
          type: 'custom' as const,
          tokenizer: 'kuromoji_tokenizer',
          filter: [
            'kuromoji_baseform',
            'kuromoji_part_of_speech',
            'ja_prefix',
            'lowercase',
            'ja_stop',
            'ja_request_words',
          ],
        },
        /**
         * The query side for a document's own text: `ja_request_words` without
         * `ja_stop`.
         *
         * Metadata is written to be searched, so the general stopword list
         * costs it nothing. Extracted text is not: `ja_stop` drops「こと」
         *「もの」「ため」「する」, words a document uses and a reader may be
         * looking for. What has to go is the request form a person wraps a
         * question in —「〜を教えてください」— because every one of those
         * becomes a term the document is required to contain.
         */
        kuromoji_content_query_analyzer: {
          type: 'custom' as const,
          tokenizer: 'kuromoji_tokenizer',
          filter: [
            'kuromoji_baseform',
            'kuromoji_part_of_speech',
            'ja_prefix',
            'lowercase',
            'ja_request_words',
          ],
        },
      },
    },
  }

  /**
   * Ensure the search index exists with kuromoji mapping and join field. Idempotent.
   * Re-checks every 60 seconds to recover from index loss (e.g. OpenSearch maintenance).
   */
  async ensureIndex(): Promise<void> {
    if (Date.now() - this.initializedAt < 60 * 1000) return
    await this.ensureSearchIndex()
    this.initializedAt = Date.now()
  }

  /**
   * Return the number of package documents in the search index.
   * Ensures index exists before checking. Returns -1 on error.
   */
  async getPackagesDocCount(): Promise<number> {
    await this.ensureIndex()
    try {
      const count = await this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'package' } } },
      })
      return count.body.count
    } catch {
      return -1
    }
  }

  /** The body an index of ours is created with — one place, so the index a
   *  re-analysis builds is the index a fresh deployment would have got */
  private indexBody(meta?: Record<string, unknown>) {
    return {
      settings: { number_of_replicas: this.replicas, ...OpenSearchAdapter.KUROMOJI_ANALYSIS },
      mappings: { ...(meta ? { _meta: meta } : {}), properties: SEARCH_PROPERTIES },
    }
  }

  /** The index the alias points at, or the index itself where there is no alias
   *  (a deployment created before this scheme) */
  private async concreteIndex(): Promise<string> {
    // Asked separately because `ignore: [404]` does not answer with an empty
    // body — it hands back the 404 payload, whose first key is `error`
    const alias = await this.client.indices.existsAlias({ name: this.searchIndex })
    if (!alias.body) return this.searchIndex
    const got = await this.client.indices.getAlias({ name: this.searchIndex })
    const behind = Object.keys(got.body)
    if (behind.length !== 1) {
      // An alias over two indices takes no writes at all ("no write index is
      // defined"), which otherwise shows up only as indexing having stopped
      throw new Error(`${this.searchIndex} covers ${behind.length} indices; expected one`)
    }
    return behind[0]
  }

  /**
   * @returns true if the index was just created (didn't exist before)
   *
   * A new deployment gets an alias in front of a numbered index, so that
   * re-analysis later has somewhere to swap to. An existing one is left as it
   * is: migrating it means copying every document, which is not something a
   * process should decide to do because it started.
   */
  private async ensureSearchIndex(): Promise<boolean> {
    const exists = await this.client.indices.exists({ index: this.searchIndex })
    if (exists.body) return false
    const concrete = `${this.searchIndex}-000001`
    // Two requests, and a process killed between them would otherwise find the
    // index existing and the alias missing on every boot from then on — and
    // every read and write goes through here. So an index that is already there
    // is not an error, it is the second half of this being finished.
    await this.client.indices.create({ index: concrete, body: this.indexBody() }).catch((err) => {
      if (!isAlreadyExists(err)) throw err
    })
    await this.client.indices.putAlias({ index: concrete, name: this.searchIndex })
    this.mapping = Promise.resolve()
    return true
  }

  /**
   * Whether the live index's analysis is the one the code defines.
   *
   * Compared as the cluster reports it against the literal, which needs both to
   * be normalised in two ways: OpenSearch returns every value as a string, and
   * it returns the keys in its own order. Array order is left alone — the order
   * of a filter chain is part of what the analyzer is.
   */
  async analysisStale(): Promise<boolean> {
    // The alias by name: `getSettings` resolves it, and answers keyed by the
    // concrete index either way — which is why the body is read by position.
    // A deployment with no index at all throws into the catch below, where
    // "cannot tell" is already answered as "not stale".
    const got = await this.client.indices.getSettings({ index: this.searchIndex })
    const live = Object.values(got.body)[0]?.settings?.index?.analysis
    return (
      normaliseAnalysis(live) !== normaliseAnalysis(OpenSearchAdapter.KUROMOJI_ANALYSIS.analysis)
    )
  }

  /**
   * A name no other attempt will compute.
   *
   * The sequence is for a person reading `_cat/indices`; the suffix is what
   * makes the name a claim. Two attempts that derive the same destination have
   * to agree about who owns it, and every way of asking — a marker, a lease,
   * a running task — leaves a window in which one deletes what the other is
   * filling. Different names have no such question: each attempt fills its own
   * index, and the alias swap decides which one becomes the catalogue.
   */
  private nextIndexName(current: string): string {
    // Both spellings: an index created before the suffix existed ends at its
    // number, and re-using that number would collide with it
    const n = Number(current.match(/-(\d{6})(?:-[0-9a-f]+)?$/)?.[1] ?? 0) + 1
    const suffix = randomBytes(4).toString('hex')
    return `${this.searchIndex}-${String(n).padStart(6, '0')}-${suffix}`
  }

  /**
   * Delete indexes of ours that no attempt could still be filling.
   *
   * With a name per attempt, a run that died leaves its destination behind and
   * nothing will ever reuse it. Age is the only question worth asking: the
   * deadline is how long a copy may run, so anything older than that belongs to
   * an attempt that is over, and anything younger may be in flight.
   */
  private async sweepAbandonedIndexes(live: string): Promise<void> {
    const got = await this.client.indices.getSettings({
      index: `${this.searchIndex}-*`,
      name: 'index.creation_date',
    })
    const oldest = Date.now() - REINDEX_TIMEOUT_MS
    const body = got.body as unknown as Record<
      string,
      { settings?: { index?: { creation_date?: string } } }
    >
    for (const [index, settings] of Object.entries(body)) {
      if (index === live) continue
      const created = Number(settings.settings?.index?.creation_date)
      if (!Number.isFinite(created) || created > oldest) continue
      this.log.warn({ index }, 'Deleting an index left by a re-analysis that did not finish')
      await this.client.indices.delete({ index }, { ignore: [404] })
    }
  }

  /**
   * Copy `from` into `to` and wait for it, as a task rather than one long
   * request: a copy takes minutes, and an HTTP client — or anything between it
   * and the cluster — gives up long before that.
   */
  private async awaitReindex(
    from: string,
    to: string
  ): Promise<{ total: number; failures: unknown[] }> {
    const started = await this.client.reindex({
      wait_for_completion: false,
      refresh: true,
      body: { source: { index: from, size: REINDEX_BATCH_DOCS }, dest: { index: to } },
    })
    const taskId = (started.body as unknown as { task?: string }).task
    if (!taskId) throw new Error('OpenSearch accepted the copy without naming a task')

    const deadline = Date.now() + REINDEX_TIMEOUT_MS
    for (let first = true; ; first = false) {
      // Plain polling with a wait of our own. Asking the cluster to hold the
      // request instead (`wait_for_completion`) answers a copy still running
      // with a 500 `timeout_exception`, which the transport raises — the loop
      // would end on its first pass for every copy longer than one poll.
      if (!first) await new Promise((resolve) => setTimeout(resolve, REINDEX_POLL_MS))
      const task = await this.client.tasks.get({ task_id: taskId })
      const body = task.body as unknown as {
        completed?: boolean
        response?: ReindexResponse
        error?: unknown
      }
      if (body.completed) {
        if (body.error) throw new Error(`Re-analysis copy failed: ${JSON.stringify(body.error)}`)
        return countCopied(body.response ?? {})
      }
      if (Date.now() > deadline) {
        await this.client.tasks.cancel({ task_id: taskId }).catch(() => {})
        throw new Error(`Re-analysis copy of ${from} did not finish in time`)
      }
    }
  }

  /**
   * Build the next index under the current analysis and swap the alias to it.
   *
   * `_reindex` rather than re-sending the documents from their sources, because
   * `extractedText` lives in `_source`: OpenSearch re-analyses in place and
   * nothing is fetched, extracted or embedded again (seconds, against the hour
   * a content re-processing takes).
   *
   * The batch is small on purpose — see `REINDEX_BATCH_DOCS`.
   */
  async reanalyseIndex(): Promise<{ from: string; to: string; documents: number }> {
    await this.ensureIndex()
    const from = await this.concreteIndex()
    await this.sweepAbandonedIndexes(from)
    const to = this.nextIndexName(from)
    const copyStartedAt = new Date().toISOString()

    // The window this copy cannot see, written on the index it produces. A
    // delivery that arrives after the swap but before the repair finished reads
    // it back from the live index — the one artifact that survives a worker.
    await this.client.indices.create({
      index: to,
      body: this.indexBody({ reanalyse: { copyStartedAt } }),
    })
    let total: number
    let swapRequested = false
    try {
      const copied = await this.awaitReindex(from, to)
      total = copied.total
      if (copied.failures.length > 0) {
        throw new Error(
          `Re-analysis copied ${from} with ${copied.failures.length} failures; kept the old index`
        )
      }

      // One request, and a conditional one. `must_exist` is what makes a second
      // attempt lose rather than land beside the first: without it the removal
      // of an alias that has already moved is a silent no-op and the `add`
      // still runs, leaving the name over two indexes — which takes no writes
      // at all. A deployment created before the alias holds an index under the
      // very name the alias needs, and `remove_index` drops it inside the same
      // action list.
      swapRequested = true
      await this.client.indices.updateAliases({
        body: {
          actions: [
            from === this.searchIndex
              ? { remove_index: { index: from } }
              : { remove: { index: from, alias: this.searchIndex, must_exist: true } },
            { add: { index: to, alias: this.searchIndex } },
          ],
        },
      })
    } catch (err) {
      // Cleaned up only where the alias certainly did not move: before the swap
      // was ever asked for, or where the cluster refused it outright. A request
      // that timed out or lost its connection may still be applied, and reading
      // the alias back proves nothing — it would answer with the old index a
      // moment before the swap lands, and the index deleted on the strength of
      // that answer is the one the alias is about to point at. Left alone, it is
      // a stray index the next run's sweep collects.
      if (!swapRequested || refusedOutright(err)) {
        await this.client.indices.delete({ index: to }, { ignore: [404] })
      } else {
        this.log.warn(
          { err, index: to },
          'Left the copy in place: the swap may yet be applied, and the sweep can collect it'
        )
      }
      throw err
    }

    // Past the point of no return: the alias is on the new index, so the rest
    // is housekeeping and a failure here is a leftover index, not an outage.
    // The sweep at the start of the next run collects it.
    if (from !== this.searchIndex) {
      await this.client.indices
        .delete({ index: from }, { ignore: [404] })
        .catch((err) => this.log.warn({ err, index: from }, 'Could not delete the replaced index'))
    }
    // The new index was created with the current mapping, so the once-per-
    // process update has nothing left to do
    this.mapping = Promise.resolve()
    return { from, to, documents: total }
  }

  /**
   * When the copy that produced the live index began, while its repair is
   * unfinished — null once the repair is recorded, or where there was none.
   *
   * The marker lives on the index rather than in the job, because the job is a
   * queue message that may be delivered again to a process that knows nothing
   * of the first attempt, and what needs repairing is the index.
   */
  async pendingRepair(): Promise<Date | null> {
    const index = await this.concreteIndex()
    const got = await this.client.indices.getMapping({ index }, { ignore: [404] })
    const meta = (
      got.body as unknown as Record<
        string,
        { mappings?: { _meta?: { reanalyse?: { copyStartedAt?: string; repairedAt?: string } } } }
      >
    )[index]?.mappings?._meta?.reanalyse
    if (!meta?.copyStartedAt || meta.repairedAt) return null
    const at = new Date(meta.copyStartedAt)
    return Number.isNaN(at.getTime()) ? null : at
  }

  /** Record that the repair is done, so a later delivery does not redo it */
  async markRepaired(): Promise<void> {
    const index = await this.concreteIndex()
    const pending = await this.pendingRepair()
    if (!pending) return
    await this.client.indices.putMapping({
      index,
      body: {
        _meta: {
          reanalyse: { copyStartedAt: pending.toISOString(), repairedAt: new Date().toISOString() },
        },
      },
    })
  }

  /**
   * What every writer calls: the index, brought up to the current shape before
   * the process's first write. Adding a field is additive and idempotent, so
   * once is enough; a refusal (a write block, an analyzer or a field the index
   * already has another way) is logged and the write goes ahead with the
   * mapping the index has. Readers call ensureIndex and never come here.
   */
  private async ensureWritableIndex(): Promise<void> {
    await this.ensureIndex()
    this.mapping ??= this.client.indices
      .putMapping({ index: this.searchIndex, body: { properties: SEARCH_PROPERTIES } })
      .then(
        () => undefined,
        (err: unknown) =>
          this.log.warn(
            { err },
            'Search index mapping not updated; fields added since the index was created keep the mapping the index gives them'
          )
      )
    await this.mapping
  }

  /** Delete a single document, ignoring 404 */
  private async deleteDoc(index: string, id: string): Promise<void> {
    try {
      await this.client.delete({ index, id, refresh: 'wait_for' })
    } catch (err: unknown) {
      if (isNotFoundError(err)) return
      throw err
    }
  }

  /** Delete all documents of a specific type (package/resource/content) */
  private async deleteByType(type: string): Promise<void> {
    await this.ensureIndex()
    try {
      await this.client.deleteByQuery({
        index: this.searchIndex,
        body: { query: { term: { join_field: type } } },
        refresh: true,
      })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
  }

  // ------------------------------------------------------------------
  // Dataset-level operations (package documents)
  // ------------------------------------------------------------------

  async indexPackage(doc: DatasetDoc): Promise<void> {
    await this.ensureWritableIndex()
    await this.client.index({
      index: this.searchIndex,
      id: doc.id,
      body: { ...doc, join_field: 'package' },
      refresh: 'wait_for',
    })
  }

  async deletePackage(id: string): Promise<void> {
    await this.ensureIndex()
    // Delete all child documents (resources + contents) routed to this package
    try {
      await this.client.deleteByQuery({
        index: this.searchIndex,
        body: {
          query: {
            bool: {
              should: [
                { parent_id: { type: 'resource', id } },
                { parent_id: { type: 'content', id } },
              ],
              minimum_should_match: 1,
            },
          },
        },
        routing: id,
        refresh: true,
      })
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err
    }
    // Then delete the package itself
    await this.deleteDoc(this.searchIndex, id)
  }

  async deleteAllPackages(): Promise<void> {
    await this.deleteByType('package')
  }

  async bulkIndexPackages(docs: DatasetDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureWritableIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.searchIndex, _id: doc.id } },
      { ...doc, join_field: 'package' },
    ])
    const response = await this.client.bulk({ body, refresh: 'wait_for' })
    if (response.body.errors) {
      const failed = response.body.items.filter(
        (item: { index?: { error?: unknown } }) => item.index?.error
      )
      throw new Error(`Bulk indexing failed for ${failed.length} documents`)
    }
  }

  // ------------------------------------------------------------------
  // Resource-level operations (child documents of package)
  // ------------------------------------------------------------------

  async indexResource(doc: ResourceDoc): Promise<void> {
    await this.ensureWritableIndex()
    await this.client.index({
      index: this.searchIndex,
      id: doc.id,
      body: { ...doc, join_field: { name: 'resource', parent: doc.packageId } },
      routing: doc.packageId,
      refresh: 'wait_for',
    })
  }

  async deleteResource(resourceId: string): Promise<void> {
    await this.ensureIndex()
    // deleteByQuery scatters to all shards — works without explicit routing
    await this.client.deleteByQuery({
      index: this.searchIndex,
      body: {
        query: {
          bool: {
            filter: [{ term: { _id: resourceId } }, { term: { join_field: 'resource' } }],
          },
        },
      },
      refresh: true,
    })
  }

  async deleteAllResources(): Promise<void> {
    await this.deleteByType('resource')
  }

  async bulkIndexResources(docs: ResourceDoc[]): Promise<void> {
    if (docs.length === 0) return
    await this.ensureWritableIndex()

    const body = docs.flatMap((doc) => [
      { index: { _index: this.searchIndex, _id: doc.id, routing: doc.packageId } },
      { ...doc, join_field: { name: 'resource', parent: doc.packageId } },
    ])
    const response = await this.client.bulk({ body, refresh: 'wait_for' })
    if (response.body.errors) {
      const failed = response.body.items.filter(
        (item: { index?: { error?: unknown } }) => item.index?.error
      )
      throw new Error(`Bulk resource indexing failed for ${failed.length} documents`)
    }
  }

  // ------------------------------------------------------------------
  // Content-level operations (child documents of package)
  // ------------------------------------------------------------------

  async indexContent(doc: ContentDoc): Promise<void> {
    await this.ensureWritableIndex()
    const docId = `${doc.resourceId}_chunk_${doc.chunkIndex}`
    await this.client.index({
      index: this.searchIndex,
      id: docId,
      body: { ...doc, join_field: { name: 'content', parent: doc.packageId } },
      routing: doc.packageId,
      refresh: 'wait_for',
    })
  }

  /**
   * Distinct `resourceId`s among the content documents, ascending, a page at a
   * time. A composite aggregation because that is the one built to be paged:
   * `after` resumes where the last page stopped, so the whole set can be walked
   * without holding it all at once.
   */
  async indexedContentResources(after?: string, limit = 1_000): Promise<string[]> {
    await this.ensureIndex()
    const res = await this.client.search({
      index: this.searchIndex,
      body: {
        size: 0,
        query: { term: { join_field: 'content' } },
        aggs: {
          by_resource: {
            composite: {
              size: limit,
              sources: [{ resource: { terms: { field: 'resourceId' } } }],
              ...(after ? { after: { resource: after } } : {}),
            },
          },
        },
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buckets = ((res.body.aggregations as any)?.by_resource?.buckets ?? []) as Array<{
      key: { resource: string }
    }>
    return buckets.map((b) => b.key.resource)
  }

  async deleteContent(resourceId: string): Promise<void> {
    await this.ensureIndex()
    // Delete all chunks for a resource — deleteByQuery scatters to all shards
    await this.client.deleteByQuery({
      index: this.searchIndex,
      body: {
        query: {
          bool: { filter: [{ term: { resourceId } }, { term: { join_field: 'content' } }] },
        },
      },
      refresh: true,
    })
  }

  async deleteAllContents(): Promise<void> {
    await this.deleteByType('content')
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  private static readonly VALID_SORT_FIELDS = new Set(['updated', 'created', 'name'])

  private static readonly JOIN_TYPE: Record<'packages' | 'resources' | 'contents', string> = {
    packages: 'package',
    resources: 'resource',
    contents: 'content',
  }

  /** Build OpenSearch sort clause from query */
  private buildSort(query: SearchQuery): (string | Record<string, unknown>)[] {
    if (query.sortBy && OpenSearchAdapter.VALID_SORT_FIELDS.has(query.sortBy)) {
      const order = query.sortOrder ?? 'desc'
      return [{ [query.sortBy]: { order } }]
    }
    return query.q?.trim()
      ? ['_score', { updated: { order: 'desc' as const } }]
      : [{ updated: { order: 'desc' as const } }]
  }

  /** Build OpenSearch filter clauses from SearchFilters */
  private buildFilterClauses(filters?: SearchFilters): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = []

    if (filters?.name) {
      clauses.push({ prefix: { 'name.keyword': filters.name } })
    }
    if (filters?.organizations?.length) {
      clauses.push({ terms: { organization: filters.organizations } })
    }
    if (filters?.tags?.length) {
      for (const t of filters.tags) {
        clauses.push({ term: { tags: t } })
      }
    }
    if (filters?.formats?.length) {
      for (const fmt of filters.formats) {
        clauses.push({ term: { formats: fmt.toUpperCase() } })
      }
    }
    if (filters?.licenses?.length) {
      clauses.push({ terms: { license_id: filters.licenses } })
    }
    if (filters?.groups?.length) {
      for (const g of filters.groups) {
        clauses.push({ term: { groups: g } })
      }
    }
    if (filters?.excludePrivate) {
      if (filters.allowPrivateOrgIds?.length) {
        clauses.push({
          bool: {
            should: [
              { term: { private: false } },
              { terms: { owner_org_id: filters.allowPrivateOrgIds } },
            ],
            minimum_should_match: 1,
          },
        })
      } else {
        clauses.push({ term: { private: false } })
      }
    }
    if (filters?.ownerOrgIds?.length) {
      clauses.push({ terms: { owner_org_id: filters.ownerOrgIds } })
    }
    if (filters?.isPrivate !== undefined) {
      clauses.push({ term: { private: filters.isPrivate } })
    }
    if (filters?.creatorUserId) {
      clauses.push({ term: { creator_user_id: filters.creatorUserId } })
    }

    return clauses
  }

  /** Build a package-level multi_match query clause */
  private buildPackageMultiMatch(q: string): Record<string, unknown> {
    return {
      multi_match: {
        query: q,
        fields: ['title^3', 'name^2', 'notes', 'tags'],
        type: 'cross_fields',
        operator: 'and',
      },
    }
  }

  /**
   * Map an OpenSearch backend outage (timeout / connection / 5xx / 429) to a 503;
   * re-throw anything else (bad query, parsing bug) so it still surfaces as a 500.
   */
  private mapBackendError(err: unknown): never {
    if (isBackendUnavailable(err)) {
      this.log.error({ err }, 'search backend unavailable')
      throw new ServiceUnavailableError('Search is temporarily unavailable')
    }
    throw err
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    // ensureIndex() hits the cluster first, so a down node throws here (not at search()).
    try {
      await this.ensureIndex()
    } catch (err) {
      this.mapBackendError(err)
    }

    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    const hasQuery = Boolean(query.q?.trim())

    // Filters apply at the package (parent) level
    const filter: Record<string, unknown>[] = [{ term: { join_field: 'package' } }]
    filter.push(...this.buildFilterClauses(query.filters))

    // Build the must clause: keyword match or match_all
    const must: Record<string, unknown>[] = []
    if (hasQuery) {
      must.push({
        bool: {
          should: [
            this.buildPackageMultiMatch(query.q!),
            {
              has_child: {
                type: 'resource',
                query: {
                  multi_match: {
                    query: query.q!,
                    fields: ['name^3', 'description^2', 'section', 'summary'],
                    type: 'cross_fields',
                    operator: 'and',
                  },
                },
                score_mode: 'max',
                boost: RESOURCE_LEG_WEIGHT,
                inner_hits: {
                  size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
                  highlight: {
                    fields: {
                      name: WHOLE_FIELD_HIGHLIGHT,
                      description: {
                        fragment_size: 200,
                        number_of_fragments: 1,
                        pre_tags: ['<mark>'],
                        post_tags: ['</mark>'],
                      },
                      section: WHOLE_FIELD_HIGHLIGHT,
                      // Exactly as a description is treated: the abstract is
                      // prose on the metadata document, so it needs the same
                      // fragment around the match and the same marking of it.
                      // What keeps it quiet is the label and the muted styling
                      // on the card, not withholding the mark — a fragment with
                      // nothing marked reads as a wall of text that never says
                      // why the resource is a hit.
                      summary: {
                        fragment_size: 200,
                        number_of_fragments: 1,
                        pre_tags: ['<mark>'],
                        post_tags: ['</mark>'],
                      },
                    },
                  },
                },
              },
            },
            {
              has_child: {
                type: 'content',
                query: {
                  match: { extractedText: { query: query.q!, operator: 'and' } },
                },
                score_mode: 'max',
                boost: CONTENT_LEG_WEIGHT,
                inner_hits: {
                  size: MAX_MATCHED_RESOURCES_PER_PACKAGE,
                  _source: ['resourceId', 'packageId'],
                  name: 'content_hits',
                },
              },
            },
          ],
          minimum_should_match: 1,
        },
      })
    } else {
      must.push({ match_all: {} })
    }

    const aggs = query.facets
      ? {
          organizations: { terms: { field: 'organization', size: 200 } },
          tags: { terms: { field: 'tags', size: 200 } },
          formats: { terms: { field: 'formats', size: 200 } },
          licenses: { terms: { field: 'license_id', size: 200 } },
          groups: { terms: { field: 'groups', size: 200 } },
        }
      : undefined

    const highlight = hasQuery
      ? {
          fields: {
            title: WHOLE_FIELD_HIGHLIGHT,
            notes: {
              fragment_size: 200,
              number_of_fragments: 1,
              pre_tags: ['<mark>'],
              post_tags: ['</mark>'],
            },
          },
        }
      : undefined

    const body = {
      from: offset,
      size: limit,
      query: { bool: { must, filter } },
      sort: this.buildSort(query),
      ...(aggs && { aggs }),
      ...(highlight && { highlight }),
    }

    try {
      const t0 = Date.now()
      const response = await this.client.search({ index: this.searchIndex, body })
      const elapsed = Date.now() - t0

      const result = this.parseSearchResponse(response, query, offset, limit)

      // For content-only matches, fetch resource metadata (name, format) via mget
      if (hasQuery) {
        await this.enrichContentMatchMetadata(result)
      }

      this.log.info({ msg: 'search', q: query.q, took: elapsed, total: result.total })

      return result
    } catch (err) {
      // Backend down/overloaded → 503; bad queries and parsing bugs propagate as 500.
      this.mapBackendError(err)
    }
  }

  /** Parse search response with inner_hits into SearchResult */
  private parseSearchResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    query: SearchQuery,
    offset: number,
    limit: number
  ): SearchResult {
    const hits = response.body.hits
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: DatasetDoc[] = (hits?.hits ?? []).map((hit: any) => {
      const { join_field: _, ...source } = hit._source
      const doc: DatasetDoc = { ...source, id: hit._id }

      // Package-level highlights
      if (hit.highlight?.title?.[0])
        doc.highlightedTitle = sanitizeHighlight(hit.highlight.title[0])
      if (hit.highlight?.notes?.[0])
        doc.highlightedNotes = sanitizeHighlight(hit.highlight.notes[0])

      // Resource metadata matches from inner_hits
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resourceInnerHits = hit.inner_hits?.resource?.hits?.hits as any[] | undefined
      if (resourceInnerHits?.length) {
        const matched: MatchedResource[] = resourceInnerHits.map((rh) => ({
          id: rh._source.id ?? rh._id,
          name: rh._source.name,
          description: rh._source.description,
          format: rh._source.format,
          section: rh._source.section,
          summary: rh._source.summary,
          matchedOn: MATCHED_FIELDS.filter((f) => rh.highlight?.[f]?.[0]),
          matchSource: 'metadata' as const,
          ...(rh.highlight?.name?.[0] && {
            highlightedName: sanitizeHighlight(rh.highlight.name[0]),
          }),
          ...(rh.highlight?.description?.[0] && {
            highlightedDescription: sanitizeHighlight(rh.highlight.description[0]),
          }),
          ...(rh.highlight?.section?.[0] && {
            highlightedSection: sanitizeHighlight(rh.highlight.section[0]),
          }),
          ...(rh.highlight?.summary?.[0] && {
            highlightedSummary: sanitizeHighlight(rh.highlight.summary[0]),
          }),
        }))
        doc.matchedResources = [...(doc.matchedResources ?? []), ...matched]
      }

      // Content matches from inner_hits (resourceId only, highlights loaded lazily)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentInnerHits = hit.inner_hits?.content_hits?.hits?.hits as any[] | undefined
      if (contentInnerHits?.length) {
        const existingResourceIds = new Set((doc.matchedResources ?? []).map((mr) => mr.id))
        for (const ch of contentInnerHits) {
          const resourceId = ch._source.resourceId as string
          // If already matched by metadata, upgrade to content match
          const existing = (doc.matchedResources ?? []).find((mr) => mr.id === resourceId)
          if (existing) {
            existing.matchSource = 'content'
            existing._contentDocId = ch._id as string
          } else if (!existingResourceIds.has(resourceId)) {
            existingResourceIds.add(resourceId)
            doc.matchedResources = [
              ...(doc.matchedResources ?? []),
              {
                id: resourceId,
                matchSource: 'content',
                _contentDocId: ch._id as string,
              },
            ]
          }
        }
      }

      if (doc.matchedResources) {
        const carried = resourceInnerHits?.length ?? 0
        doc.matchedResourcesCount = matchedResourcesCount({
          resourceTotal: hit.inner_hits?.resource?.hits?.total,
          carried,
          contentOnly: doc.matchedResources.length - carried,
          contentCapped: (contentInnerHits?.length ?? 0) >= MAX_MATCHED_RESOURCES_PER_PACKAGE,
          matched: doc.matchedResources.length,
        })
      }

      return doc
    })

    const total = hits?.total
    const totalCount = hitsTotal(total)

    let facets: SearchFacets | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggregations = response.body.aggregations as Record<string, any> | undefined
    if (query.facets && aggregations) {
      const parseBuckets = (aggName: string): SearchFacetBucket[] =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aggregations[aggName]?.buckets ?? []).map((b: any) => ({
          name: b.key as string,
          count: b.doc_count as number,
        }))

      facets = {
        organizations: parseBuckets('organizations'),
        tags: parseBuckets('tags'),
        formats: parseBuckets('formats'),
        licenses: parseBuckets('licenses'),
        groups: parseBuckets('groups'),
      }
    }

    return { items, total: totalCount, offset, limit, ...(facets && { facets }) }
  }

  /** Fetch resource metadata (name, format) for content-only matched resources via mget */
  private async enrichContentMatchMetadata(result: SearchResult): Promise<void> {
    const docsToFetch: Array<{ _id: string; routing: string }> = []
    for (const item of result.items) {
      for (const mr of item.matchedResources ?? []) {
        if (mr.matchSource === 'content' && mr.name === undefined) {
          docsToFetch.push({ _id: mr.id, routing: item.id })
        }
      }
    }
    if (docsToFetch.length === 0) return

    try {
      const resMget = await this.client.mget({
        index: this.searchIndex,
        body: { docs: docsToFetch },
      })
      const metadataMap = new Map<
        string,
        { name?: string; description?: string; format?: string }
      >()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const doc of resMget.body.docs as any[]) {
        if (!doc.found) continue
        metadataMap.set(doc._id, {
          name: doc._source.name,
          description: doc._source.description,
          format: doc._source.format,
        })
      }
      for (const item of result.items) {
        for (const mr of item.matchedResources ?? []) {
          const meta = metadataMap.get(mr.id)
          if (meta) {
            mr.name = meta.name
            mr.description = meta.description
            mr.format = meta.format
          }
        }
      }
    } catch {
      // Best-effort: display without metadata
    }
  }

  /** Fetch content highlights for specific chunk document IDs.
   *  Uses an `ids` query — no collapse, no full-text re-scan.
   *  Returns a map of chunkDocId → sanitized highlight snippet. */
  async fetchContentHighlights(
    chunkDocIds: string[],
    queryText: string,
    filters?: SearchFilters
  ): Promise<Record<string, string>> {
    if (chunkDocIds.length === 0) return {}
    await this.ensureIndex()

    try {
      const response = await this.client.search({
        index: this.searchIndex,
        body: {
          size: chunkDocIds.length,
          query: {
            bool: {
              must: { match: { extractedText: { query: queryText, operator: 'and' } } },
              filter: [
                { ids: { values: chunkDocIds } },
                { term: { join_field: 'content' } },
                // Enforce the caller's visibility: only return chunks whose parent
                // package passes the same private/owner_org filter as search().
                {
                  has_parent: {
                    parent_type: 'package',
                    query: { bool: { filter: this.buildFilterClauses(filters) } },
                  },
                },
              ],
            },
          },
          _source: false,
          highlight: CONTENT_HIGHLIGHT,
        },
      })

      const result: Record<string, string> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const hit of (response.body.hits.hits ?? []) as any[]) {
        const fragment = hit.highlight?.extractedText?.[0] as string | undefined
        if (fragment) {
          result[hit._id as string] = sanitizeHighlight(fragment)
        }
      }
      return result
    } catch {
      return {}
    }
  }

  // ------------------------------------------------------------------
  // Resource count
  // ------------------------------------------------------------------

  async sumResourceCount(query?: ResourceCountQuery): Promise<number> {
    await this.ensureIndex()

    // Count resource child documents whose parent packages match the query/filters
    const must: Record<string, unknown>[] = []
    const parentFilter = this.buildFilterClauses(query?.filters)

    if (query?.q?.trim()) {
      must.push(this.buildPackageMultiMatch(query.q))
    } else {
      must.push({ match_all: {} })
    }

    const countResponse = await this.client.count({
      index: this.searchIndex,
      body: {
        query: {
          bool: {
            filter: [
              { term: { join_field: 'resource' } },
              {
                has_parent: {
                  parent_type: 'package',
                  query: {
                    bool: { must, ...(parentFilter.length > 0 && { filter: parentFilter }) },
                  },
                },
              },
            ],
          },
        },
      },
    })

    return (countResponse.body.count as number) ?? 0
  }

  // ------------------------------------------------------------------
  // Index stats
  // ------------------------------------------------------------------

  async getIndexStats(): Promise<IndexStats> {
    await this.ensureIndex()

    // Count documents by type and get recent docs in parallel
    const [catResponse, pkgCount, resCount, contCount, recentResponse] = await Promise.all([
      this.client.cat.indices({
        index: this.searchIndex,
        format: 'json',
        h: ['index', 'docs.count', 'store.size'],
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'package' } } },
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'resource' } } },
      }),
      this.client.count({
        index: this.searchIndex,
        body: { query: { term: { join_field: 'content' } } },
      }),
      this.client.msearch({
        body: [
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'package' } },
            sort: [{ updated: { order: 'desc' } }],
            _source: ['name', 'title', 'updated'],
          },
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'resource' } },
            sort: [{ _doc: { order: 'desc' } }],
            _source: ['name', 'packageId'],
          },
          { index: this.searchIndex },
          {
            size: 5,
            query: { term: { join_field: 'content' } },
            sort: [{ _doc: { order: 'desc' } }],
            _source: ['contentType'],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ])

    const indices = catResponse.body as Array<{
      index: string
      'docs.count': string
      'store.size': string
    }>
    // One index was asked for, so one row comes back — by position, because
    // `cat.indices` answers an alias with the concrete index behind it and the
    // name that comes back is not the name asked for
    const row = indices[0]
    const sizeBytes = parseSizeToBytes(row?.['store.size'] ?? '0b')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [pkgRecent, resRecent, contRecent] = recentResponse.body.responses as any[]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkgRecentDocs = (pkgRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: (h._source.title ?? h._source.name) as string | undefined,
      updated: h._source.updated as string | undefined,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resRecentDocs = (resRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: h._source.name as string | undefined,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contRecentDocs = (contRecent.hits?.hits ?? []).map((h: any) => ({
      id: h._id as string,
      name: h._source.contentType as string | undefined,
    }))

    return {
      indexName: this.searchIndex,
      totalSizeBytes: sizeBytes,
      packages: { docCount: pkgCount.body.count, recentDocs: pkgRecentDocs },
      resources: { docCount: resCount.body.count, recentDocs: resRecentDocs },
      contents: { docCount: contCount.body.count, recentDocs: contRecentDocs },
    }
  }

  async getDocument(
    index: 'packages' | 'resources' | 'contents',
    id: string
  ): Promise<Record<string, unknown> | null> {
    await this.ensureIndex()
    try {
      const response = await this.client.search({
        index: this.searchIndex,
        body: {
          size: 1,
          query: {
            bool: {
              filter: [
                { term: { _id: id } },
                { term: { join_field: OpenSearchAdapter.JOIN_TYPE[index] } },
              ],
            },
          },
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hit = (response.body.hits?.hits as any[])?.[0]
      return hit ? (hit._source as Record<string, unknown>) : null
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  async browseDocuments(
    index: 'packages' | 'resources' | 'contents',
    options: { q?: string; offset?: number; limit?: number }
  ): Promise<BrowseResult> {
    await this.ensureIndex()

    const offset = options.offset ?? 0
    const limit = Math.min(options.limit ?? 20, 100)
    // Map plural index name to join_field type (e.g. 'packages' → 'package')
    const joinType = OpenSearchAdapter.JOIN_TYPE[index]

    const searchFields: Record<string, string[]> = {
      packages: ['title', 'name', 'notes'],
      resources: ['name', 'description'],
      contents: ['extractedText'],
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      from: offset,
      size: limit,
      sort: [{ _doc: { order: 'desc' } }],
      query: { term: { join_field: joinType } },
      ...(index === 'contents' && { _source: { excludes: ['extractedText'] } }),
    }

    if (options.q?.trim()) {
      body.query = {
        bool: {
          filter: [{ term: { join_field: joinType } }],
          must: [
            {
              multi_match: {
                query: options.q,
                fields: searchFields[index],
                type: 'cross_fields' as const,
                operator: 'and' as const,
              },
            },
          ],
        },
      }
      body.sort = ['_score', { _doc: { order: 'desc' } }]
    }

    const response = await this.client.search({ index: this.searchIndex, body })
    const hits = response.body.hits
    const total = hitsTotal(hits.total)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (hits.hits ?? []).map((hit: any) => ({
      id: hit._id as string,
      source: hit._source as Record<string, unknown>,
    }))

    return { items, total, offset, limit }
  }

  async getContentChunks(
    resourceId: string
  ): Promise<Array<{ id: string; chunkIndex: number; chunkSize: number }>> {
    await this.ensureIndex()

    const response = await this.client.search({
      index: this.searchIndex,
      body: {
        size: 100,
        query: {
          bool: { filter: [{ term: { resourceId } }, { term: { join_field: 'content' } }] },
        },
        _source: ['chunkIndex', 'chunkSize'],
        sort: [{ chunkIndex: { order: 'asc' } }],
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (response.body.hits.hits ?? []).map((hit: any) => ({
      id: hit._id as string,
      chunkIndex: (hit._source.chunkIndex as number) ?? 0,
      chunkSize: (hit._source.chunkSize as number) ?? 0,
    }))
  }

  async browseContentsByResource(options: {
    q?: string
    offset?: number
    limit?: number
  }): Promise<ContentBrowseResult> {
    await this.ensureIndex()

    const offset = options.offset ?? 0
    const limit = Math.min(options.limit ?? 20, 100)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const must: any = options.q?.trim()
      ? { match: { extractedText: { query: options.q, operator: 'and' } } }
      : { match_all: {} }

    const response = await this.client.search({
      index: this.searchIndex,
      body: {
        size: 0,
        query: { bool: { must, filter: [{ term: { join_field: 'content' } }] } },
        aggs: {
          by_resource: {
            terms: {
              field: 'resourceId',
              size: 10000,
              order: { _key: 'asc' as const },
            },
            aggs: {
              sample: { top_hits: { size: 1, _source: ['packageId', 'contentType'] } },
              total_size: { sum: { field: 'chunkSize' } },
            },
          },
        },
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggs = response.body.aggregations as Record<string, any> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buckets = (aggs?.by_resource?.buckets ?? []) as any[]
    const total = buckets.length

    const paginated = buckets.slice(offset, offset + limit)
    const items: ContentBrowseItem[] = paginated.map((bucket) => {
      const hit = bucket.sample.hits.hits[0]?._source ?? {}
      return {
        resourceId: bucket.key as string,
        packageId: hit.packageId ?? '',
        contentType: hit.contentType ?? '',
        chunks: bucket.doc_count as number,
        totalSize: bucket.total_size.value as number,
      }
    })

    // Fetch resource names from search index (resource documents, with routing)
    if (items.length > 0) {
      try {
        const itemLookup = new Map(items.map((item) => [item.resourceId, item]))
        const resMget = await this.client.mget({
          index: this.searchIndex,
          body: {
            docs: items.map((item) => ({ _id: item.resourceId, routing: item.packageId })),
          },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const doc of resMget.body.docs as any[]) {
          if (!doc.found) continue
          const item = itemLookup.get(doc._id)
          if (item) {
            item.resourceName = doc._source.name ?? undefined
            item.resourceFormat = doc._source.format ?? undefined
          }
        }
      } catch {
        // Best-effort
      }
    }

    return { items, total, offset, limit }
  }
}

/** Parse OpenSearch human-readable size (e.g. "12.5kb", "1.2mb") to bytes */
function parseSizeToBytes(size: string): number {
  const match = size.match(/^([\d.]+)(b|kb|mb|gb)$/i)
  if (!match) return 0
  const value = parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multipliers: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }
  return Math.round(value * (multipliers[unit] ?? 1))
}
