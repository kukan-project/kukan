/**
 * KUKAN column vocabulary — which packs the product ships, by id alone
 * (ADR-073 §決定 8). Apart from the catalog so a screen can list them without
 * bundling a code table.
 */

export const PACK_IDS = ['JP'] as const
export type PackId = (typeof PACK_IDS)[number]

export const isPackId = (id: string): id is PackId => (PACK_IDS as readonly string[]).includes(id)

/**
 * The shape a pack id has, whether or not this release ships the pack: a
 * region's code or a country's (`JP`, `EU`). What a site setting checks, so a
 * setting a newer release wrote reads here with its unknown packs ignored.
 */
export const PACK_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,15}$/
