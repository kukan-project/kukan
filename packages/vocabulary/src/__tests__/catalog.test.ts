import { describe, it, expect } from 'vitest'
import { registryFor } from '../catalog'
import { PACK_IDS, isPackId } from '../pack-ids'

describe('registryFor', () => {
  it('builds a set of packs once, whatever order they are named in', async () => {
    const a = await registryFor(['JP'], '2026-11-15')
    expect(await registryFor(['JP', 'JP'], '2026-11-15')).toBe(a)
    expect(a.schemes.map((s) => s.def.id)).toEqual(['jp-lg-code'])
  })

  it('leaves out a pack this release does not ship', async () => {
    // A setting written by a newer release can name one
    const registry = await registryFor(['ZZ', 'JP'], '2026-11-15')
    expect(registry.state).not.toContain('ZZ')
    expect(PACK_IDS).toContain('JP')
  })

  it('takes no inherited property for a pack', () => {
    expect(isPackId('constructor')).toBe(false)
    expect(isPackId('toString')).toBe(false)
    expect(isPackId('JP')).toBe(true)
  })

  it('reads nothing with no pack', async () => {
    expect((await registryFor([], '2026-11-15')).schemes).toEqual([])
  })
})
