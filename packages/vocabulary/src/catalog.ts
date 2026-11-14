/**
 * KUKAN column vocabulary — the packs the product ships, and the registry a
 * set of them makes (ADR-073 §決定 7, §決定 8)
 */

import { createRegistry, type Registry } from './registry'
import type { Pack } from './types'

/**
 * Each pack the product ships, loaded when asked for: a code table is hundreds
 * of kilobytes, and a site enabling no pack never reads one.
 */
const PACKS = {
  JP: async () => (await import('./packs/jp')).JP_PACK,
} satisfies Record<string, () => Promise<Pack>>

export type PackId = keyof typeof PACKS
export const PACK_IDS = Object.keys(PACKS) as PackId[]

// Own keys only: `in` would take `constructor` and `toString` for packs
export const isPackId = (id: string): id is PackId => Object.hasOwn(PACKS, id)

/**
 * The shape a pack id has, whether or not this release ships the pack: a
 * region's code or a country's (`JP`, `EU`). What a site setting checks, so a
 * setting a newer release wrote reads here with its unknown packs ignored.
 */
export const PACK_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,15}$/

/** One registry per set of packs, rebuilt when the day moves on. */
const registries = new Map<string, { today: string; registry: Promise<Registry> }>()

/**
 * The registry of the given packs, built once per set of packs and day: the day
 * is what coverage is counted on. Unknown ids are left out — a site setting
 * written by a newer release names a pack this one does not ship.
 */
export function registryFor(
  ids: readonly string[],
  today: string = new Date().toISOString().slice(0, 10)
): Promise<Registry> {
  const known = [...new Set(ids.filter(isPackId))].sort()
  const set = known.join(',')
  const slot = registries.get(set)
  if (slot?.today === today) return slot.registry
  const registry = Promise.all(known.map((id) => PACKS[id]())).then((packs) =>
    createRegistry(packs, today)
  )
  registries.set(set, { today, registry })
  // A pack that failed to load is tried again next time, not remembered failing
  registry.catch(() => registries.delete(set))
  return registry
}
