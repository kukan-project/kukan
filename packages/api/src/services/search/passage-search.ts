/**
 * Passage search: the parts of documents a query matches, each with where it
 * is in the file (ADR-061 §決定 4).
 *
 * Two stages, and no index of passages. The first finds resources with the
 * dataset search as it is. The second picks the passages inside them — cut by
 * the search backend from the text it indexes, where it does, or found by the
 * query's words in the text, where it does not — and places each on the pages
 * and headings of the document's text artifact.
 */

import { eq, inArray } from 'drizzle-orm'
import { packageTable, resource, type Database } from '@kukan/db'
import type { SearchFilters } from '@kukan/search-adapter'
import type { StorageAdapter } from '@kukan/storage-adapter'
import type { DocumentTextLoc, SemanticState } from '@kukan/shared'
import type { AuthUser } from '../../auth/permissions'
import { ResourceService, latestLiveVersionAgg } from '../resource-service'
import { PipelineService, type DocumentTextTarget } from '../pipeline/pipeline-service'
import { cutAt, isGone, readDocumentBlocks, type SectionPosition } from '../document-text'
import { Semaphore } from '../concurrency/semaphore'
import { mapWithConcurrency } from '../concurrency/map-with-concurrency'
import { hybridSearch, type HybridSearchDeps } from './hybrid-search'
import {
  FragmentFinder,
  WordFinder,
  cutPassages,
  passageScores,
  queryWords,
  type CutPassage,
  type PassageFinder,
} from './passage-text'
import {
  PASSAGE_CANDIDATE_RESOURCES,
  PASSAGE_DATASETS,
  PASSAGE_DEFAULT_K,
  PASSAGE_PER_RESOURCE,
  PASSAGE_FRAGMENTS_PER_CHUNK,
  PASSAGE_FRAGMENT_CHARS,
  PASSAGE_MAX_CONCURRENT,
  PASSAGE_MAX_MARKS,
  PASSAGE_MAX_READ_CHARS,
  PASSAGE_QUERY_MAX_WORDS,
  PASSAGE_QUEUE_MAX,
  PASSAGE_QUEUE_WAIT_MS,
  PASSAGE_READS_PER_SEARCH,
  PASSAGE_SCAN_MAX_PASSAGES,
  PASSAGE_CHUNKS_PER_RESOURCE,
  PASSAGE_WIDEN_CHARS,
  RRF_K,
  MCP_SECTION_DEFAULT_CHARS,
} from '../../config'

export interface PassageSearchDeps extends HybridSearchDeps {
  storage: StorageAdapter
}

export interface PassageSearchQuery {
  q: string
  /** The caller's visibility scope, and any narrowing (organizations, tags) */
  filters: SearchFilters
  viewer?: AuthUser
  /** Passages to return at most (default PASSAGE_DEFAULT_K) */
  k?: number
  /** Characters of passage text to return at most, all passages together */
  maxChars?: number
  /** Passages from one resource at most (default PASSAGE_PER_RESOURCE) */
  perResource?: number
  /** false leaves the vector leg out of the first stage */
  semantic?: boolean
}

/** A resource a passage is from, with what a citation of it needs. */
export interface PassageSource {
  id: string
  name: string | null
  format: string | null
  url: string | null
  urlType: string | null
  packageName: string
  packageTitle: string | null
  latestVersion: number | null
  text: DocumentTextTarget
}

export interface Passage {
  resourceId: string
  text: string
  /** The words that matched, as written in the text */
  words: string[]
  /** Where its first and last block are: page, slide or sheet */
  first: DocumentTextLoc
  last: DocumentTextLoc
  /** The headings its first block is under */
  headings: string[]
  /** Where get_document_section reads on from: the passage's page, or the passage itself in a long block */
  readFrom: SectionPosition
}

export interface PassageSearchResult {
  passages: Passage[]
  sources: Map<string, PassageSource>
  /** What the first stage's vector leg did */
  semantic: SemanticState
  /** How many of q's words the first stage settled for, where no dataset held them all */
  minWords?: number
  /** Where the passages were cut: by the search backend, or by reading the text for the query's words */
  via: 'index' | 'scan'
  /** Whether passages were cut or left out to keep to `maxChars` */
  truncated: boolean
  /** Whether more passages were found than `k` let through */
  more: boolean
}

/**
 * The second stage reads documents' text into the web task's memory — up to
 * PASSAGE_CANDIDATE_RESOURCES of them a search — so the searches reading at
 * once are bounded, and the rest queue.
 */
const passageSemaphore = new Semaphore(
  PASSAGE_MAX_CONCURRENT,
  PASSAGE_QUEUE_MAX,
  PASSAGE_QUEUE_WAIT_MS,
  {
    full: 'Too many passage searches at once; please retry shortly',
    timedOut: 'Timed out waiting to search passages; please retry shortly',
  }
)

/** Run `fn` holding a turn to read documents' text, released however it ends. */
async function withPassageSlot<T>(fn: () => Promise<T>): Promise<T> {
  await passageSemaphore.acquire()
  try {
    return await fn()
  } finally {
    passageSemaphore.release()
  }
}

/** The resources, those of them the viewer may read and that have text, in the order given. */
async function loadSources(
  db: Database,
  ids: string[],
  viewer: AuthUser | undefined
): Promise<PassageSource[]> {
  const readable = [...(await new ResourceService(db).readableIds(ids, viewer))]
  if (readable.length === 0) return []
  const versionAgg = latestLiveVersionAgg(db)
  const [rows, texts] = await Promise.all([
    db
      .select({
        id: resource.id,
        name: resource.name,
        format: resource.format,
        url: resource.url,
        urlType: resource.urlType,
        packageName: packageTable.name,
        packageTitle: packageTable.title,
        latestVersion: versionAgg.maxVersion,
      })
      .from(resource)
      .innerJoin(packageTable, eq(packageTable.id, resource.packageId))
      .leftJoin(versionAgg, eq(versionAgg.resourceId, resource.id))
      .where(inArray(resource.id, readable)),
    new PipelineService(db).getDocumentTexts(readable),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    const text = texts.get(id)
    return row && text?.hasText ? [{ ...row, text }] : []
  })
}

/** The passages of one resource, or none where its text has gone since the key was read. */
async function cutFrom(
  storage: StorageAdapter,
  source: PassageSource,
  finder: PassageFinder
): Promise<CutPassage[]> {
  try {
    return await cutPassages(
      readDocumentBlocks(storage, source.text.key),
      finder,
      PASSAGE_WIDEN_CHARS,
      PASSAGE_MAX_READ_CHARS,
      PASSAGE_SCAN_MAX_PASSAGES
    )
  } catch (err) {
    if (isGone(err)) return []
    throw err
  }
}

/** Where get_document_section should start to show a passage with what leads up to it. */
function readFrom(passage: CutPassage): SectionPosition {
  const block = passage.blocks[0]!
  const offset = Math.max(0, passage.start - block.start)
  // From the top of its page, unless the block is long enough that the top is far off
  return { block: block.index, offset: offset <= PASSAGE_FRAGMENT_CHARS * 2 ? 0 : offset }
}

export async function searchPassages(
  deps: PassageSearchDeps,
  query: PassageSearchQuery
): Promise<PassageSearchResult> {
  const { db, search, storage } = deps
  const k = query.k ?? PASSAGE_DEFAULT_K
  const perResource = query.perResource ?? PASSAGE_PER_RESOURCE
  const maxChars = query.maxChars ?? MCP_SECTION_DEFAULT_CHARS
  const found = await hybridSearch(deps, {
    q: query.q,
    offset: 0,
    limit: PASSAGE_DATASETS,
    filters: query.filters,
    semantic: query.semantic,
    // Not a list to answer with but the documents to read: finding none reads nothing
    relax: true,
  })
  // The resources as the datasets matched them: dataset by dataset, each one's best first
  const candidates = [
    ...new Set(found.items.flatMap((item) => (item.matchedResources ?? []).map((r) => r.id))),
  ].slice(0, PASSAGE_CANDIDATE_RESOURCES)

  // The index cuts its fragments while the database says which candidates may be
  // read; a fragment of one that may not is dropped with it
  const fetchPassages = search.fetchContentPassages?.bind(search)
  const [sources, hits] = await Promise.all([
    loadSources(db, candidates, query.viewer),
    fetchPassages?.(
      candidates,
      query.q,
      {
        fragmentChars: PASSAGE_FRAGMENT_CHARS,
        fragmentsPerChunk: PASSAGE_FRAGMENTS_PER_CHUNK,
        chunksPerResource: PASSAGE_CHUNKS_PER_RESOURCE,
      },
      query.filters
    ),
  ])
  const words = hits ? [] : queryWords(query.q, PASSAGE_QUERY_MAX_WORDS)
  const finderFor = (source: PassageSource): PassageFinder | null => {
    if (!hits) {
      return words.length > 0
        ? new WordFinder(words, PASSAGE_FRAGMENT_CHARS, PASSAGE_MAX_MARKS)
        : null
    }
    const fragments = hits
      .filter((hit) => hit.resourceId === source.id)
      .flatMap((hit) => hit.fragments.map((fragment) => ({ fragment, chunkIndex: hit.chunkIndex })))
    return fragments.length > 0 ? new FragmentFinder(fragments) : null
  }
  const perSource = await withPassageSlot(() =>
    mapWithConcurrency(sources, PASSAGE_READS_PER_SEARCH, async (source) => {
      const finder = finderFor(source)
      return finder ? cutFrom(storage, source, finder) : []
    })
  )

  // Ranked twice and fused: by the passage's own words, and by where its
  // resource stood in the first stage — neither alone
  const all = perSource.flatMap((passages, rank) =>
    passages.map((passage) => ({ passage, source: sources[rank]!, resourceRank: rank }))
  )
  const scores = passageScores(
    all.map((a) => a.passage),
    query.q
  )
  const scoreRank = new Array<number>(all.length)
  all
    .map((_, i) => i)
    .sort((a, b) => scores[b]! - scores[a]!)
    .forEach((i, rank) => (scoreRank[i] = rank))
  const fused = all.map(
    (a, i) => 1 / (RRF_K + scoreRank[i]! + 1) + 1 / (RRF_K + a.resourceRank + 1)
  )
  const order = all
    .map((_, i) => i)
    .sort((a, b) => fused[b]! - fused[a]! || scores[b]! - scores[a]!)

  const passages: Passage[] = []
  const taken = new Map<string, CutPassage[]>()
  let chars = 0
  let truncated = false
  let more = false
  for (const i of order) {
    const { passage, source } = all[i]!
    const mine = taken.get(source.id) ?? []
    if (mine.length >= perResource) continue
    if (mine.some((p) => p.start < passage.end && passage.start < p.end)) continue
    if (passages.length >= k) {
      more = true
      break
    }
    const room = maxChars - chars
    // The first is given whatever the budget, cut to it: nothing found is not what happened
    if (passages.length > 0 && room < Math.min(passage.text.length, PASSAGE_WIDEN_CHARS)) {
      truncated = true
      break
    }
    const text = passage.text.slice(0, cutAt(passage.text, room))
    if (text.length < passage.text.length) truncated = true
    chars += text.length
    mine.push(passage)
    taken.set(source.id, mine)
    const first = passage.blocks[0]!
    passages.push({
      resourceId: source.id,
      text,
      words: [...new Set(passage.words)],
      first: first.loc,
      last: passage.blocks.at(-1)!.loc,
      headings: first.headings ?? [],
      readFrom: readFrom(passage),
    })
  }

  return {
    passages,
    sources: new Map(sources.map((s) => [s.id, s])),
    semantic: found.semantic,
    minWords: found.minWords,
    via: hits ? 'index' : 'scan',
    truncated,
    more,
  }
}
