/**
 * KUKAN — searching by what tables' columns stand for (ADR-073 Step 1c;
 * experimental): the area filters as the index holds them, and the counts
 * named and kept to what was asked
 */

import { NATIONWIDE, type FacetCounts, type FacetItem } from '@kukan/shared'
import {
  canonicalPlace,
  placeName,
  placeRoots,
  registryFor,
  type Registry,
} from '@kukan/vocabulary'
import { VOCABULARY_PACKS_KEY, type SystemSettingService } from '../system-setting'

/**
 * The registry of the packs the site enables, read through the app's shared
 * settings, whose cache spans requests: none read, where the setting cannot be.
 */
export async function siteRegistry(settings: SystemSettingService): Promise<Registry> {
  return registryFor(await settings.getSetting(VOCABULARY_PACKS_KEY).catch(() => []))
}

/**
 * Area filter values as the index holds them: a pack's canonical code however
 * the request wrote it (`13` and `130001` are Tokyo), `*` as it is. A value no
 * pack knows is kept, so it matches nothing rather than nothing narrowing.
 */
export function canonicalAreas(registry: Registry, values?: string[]): string[] | undefined {
  if (!values?.length) return undefined
  return [
    ...new Set(values.map((v) => (v === NATIONWIDE ? v : (canonicalPlace(registry, v) ?? v)))),
  ]
}

type VocabularyFacets = Pick<FacetCounts, 'areas' | 'areaPlaces' | 'meanings'>

/**
 * The vocabulary counts, named from the registry, with the places below kept
 * to the top-level places asked for — and every place asked for there, at 0
 * if nothing holds it, so a choice never vanishes from the screen while the
 * results are still narrowed by it (Step 1c §5.2).
 */
export function nameVocabularyFacets(
  facets: VocabularyFacets,
  registry: Registry,
  asked: { areas?: string[]; places?: string[]; meanings?: string[] }
): VocabularyFacets {
  const name = (code: string) => placeName(registry, code) ?? null
  const under = new Set(asked.areas ?? [])
  const parentOf = (code: string) => {
    const roots = placeRoots(registry, code)
    return roots.find((r) => under.has(r)) ?? roots[0]
  }
  const places: FacetItem[] = facets.areaPlaces
    .filter((b) => placeRoots(registry, b.name).some((r) => under.has(r)))
    .map((b) => ({ ...b, title: name(b.name), parent: parentOf(b.name) }))
  const shown = new Set(places.map((p) => p.name))
  for (const code of asked.places ?? []) {
    if (shown.has(code)) continue
    const count = facets.areaPlaces.find((b) => b.name === code)?.count ?? 0
    places.push({ name: code, title: name(code), count, parent: parentOf(code) })
  }
  const areas = withAsked(facets.areas, asked.areas).map((b) => ({
    ...b,
    title: b.name === NATIONWIDE ? null : name(b.name),
  }))
  return { areas, areaPlaces: places, meanings: withAsked(facets.meanings, asked.meanings) }
}

/** The buckets, and each value asked for that none holds, at 0: still there to take away. */
function withAsked(buckets: FacetItem[], asked: string[] = []): FacetItem[] {
  const held = new Set(buckets.map((b) => b.name))
  return [...buckets, ...asked.filter((v) => !held.has(v)).map((name) => ({ name, count: 0 }))]
}
