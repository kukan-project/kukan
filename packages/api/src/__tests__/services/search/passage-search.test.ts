import { describe, it, expect, vi } from 'vitest'
import { TooManyRequestsError } from '@kukan/shared'
import { searchPassages, type PassageSearchDeps } from '../../../services/search/passage-search'
import { PASSAGE_CALLER_MAX } from '../../../config'

// The first stage holds each search until the test lets it fail
const firstStage = vi.hoisted(() => ({ fail: [] as Array<() => void> }))
vi.mock('../../../services/search/hybrid-search', () => ({
  hybridSearch: () =>
    new Promise((_, reject) => firstStage.fail.push(() => reject(new Error('released')))),
}))

const deps = {} as PassageSearchDeps
const releaseAll = () => firstStage.fail.splice(0).forEach((fail) => fail())

describe('searchPassages per caller', () => {
  it.each([
    ['an anonymous address', { ip: '203.0.113.5' }],
    ['a signed-in user', { userId: 'u1', ip: '203.0.113.5' }],
  ])('refuses %s past its share in flight, and admits it again after', async (_, caller) => {
    const search = () => searchPassages(deps, { q: 'x', filters: {}, caller })
    const running = Array.from({ length: PASSAGE_CALLER_MAX }, () => search().catch(() => {}))
    await expect(search()).rejects.toThrow(TooManyRequestsError)
    // Another caller is not counted against this one
    const other = searchPassages(deps, { q: 'x', filters: {}, caller: { ip: '198.51.100.7' } })

    releaseAll()
    await Promise.all(running)
    await other.catch(() => {})

    const again = search()
    releaseAll()
    await expect(again).rejects.toThrow('released')
  })
})
