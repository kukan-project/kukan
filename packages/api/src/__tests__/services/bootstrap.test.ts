import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockDb } from '../test-helpers/mock-db'
import {
  claimBootstrapPromotion,
  isBootstrapActive,
  isRegistrationAllowed,
  resetBootstrapCache,
} from '../../services/bootstrap'
import { REGISTRATION_ENABLED_KEY, type SystemSettingService } from '../../services/system-setting'

describe('isBootstrapActive', () => {
  beforeEach(() => {
    resetBootstrapCache()
  })

  it('is active while the user table is empty and keeps re-checking', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 0 }])
    expect(await isBootstrapActive(db)).toBe(true)

    // An empty table is never cached — the next call queries again
    addResult([{ value: 1 }])
    expect(await isBootstrapActive(db)).toBe(false)
  })

  it('caches the existence of users and skips further queries', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 3 }])
    expect(await isBootstrapActive(db)).toBe(false)

    // No queued result: a DB round-trip would yield an empty result set,
    // so a false return proves the cached path was taken
    expect(await isBootstrapActive(db)).toBe(false)
  })
})

describe('claimBootstrapPromotion', () => {
  beforeEach(() => {
    resetBootstrapCache()
  })

  it("returns 'inactive' once users exist", async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 1 }]) // count
    expect(await claimBootstrapPromotion(db)).toBe('inactive')
  })

  it("returns 'claimed' when the sentinel insert wins", async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 0 }]) // count
    addResult([{ id: 'claim-id' }]) // insert ... returning
    expect(await claimBootstrapPromotion(db)).toBe('claimed')
  })

  it("steals a stale leftover claim and returns 'claimed'", async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 0 }]) // count
    addResult([]) // insert conflicts
    addResult([{ id: 'claim-id' }]) // stale-claim update ... returning
    expect(await claimBootstrapPromotion(db)).toBe('claimed')
  })

  it("returns 'in-progress' while a fresh claim is held", async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 0 }]) // count
    addResult([]) // insert conflicts
    addResult([]) // update matches nothing — claim is fresh
    expect(await claimBootstrapPromotion(db)).toBe('in-progress')
  })
})

describe('isRegistrationAllowed', () => {
  beforeEach(() => {
    resetBootstrapCache()
  })

  it('is true while bootstrapping without consulting the setting', async () => {
    const { db, addResult } = createMockDb()
    addResult([{ value: 0 }])
    const settings = { getSetting: vi.fn() } as unknown as SystemSettingService

    expect(await isRegistrationAllowed(db, settings)).toBe(true)
    expect(settings.getSetting).not.toHaveBeenCalled()
  })

  it('follows the runtime setting once users exist', async () => {
    for (const enabled of [true, false]) {
      const { db, addResult } = createMockDb()
      addResult([{ value: 2 }])
      const settings = {
        getSetting: vi.fn().mockResolvedValue(enabled),
      } as unknown as SystemSettingService

      expect(await isRegistrationAllowed(db, settings)).toBe(enabled)
      expect(settings.getSetting).toHaveBeenCalledWith(REGISTRATION_ENABLED_KEY)
      resetBootstrapCache()
    }
  })
})
