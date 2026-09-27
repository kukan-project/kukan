import { afterEach, describe, it, expect, vi } from 'vitest'
import { lookup } from 'dns/promises'
import { httpWake, isWakeAuthorized, wakeAuthorization } from '../wake'

vi.mock('dns/promises', () => ({ lookup: vi.fn() }))

const SECRET = 'a'.repeat(32)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isWakeAuthorized', () => {
  it('accepts the token derived from the same secret', () => {
    expect(isWakeAuthorized(wakeAuthorization(SECRET), SECRET)).toBe(true)
  })

  it('refuses a token from another secret, a bare secret, or none', () => {
    expect(isWakeAuthorized(wakeAuthorization('b'.repeat(32)), SECRET)).toBe(false)
    expect(isWakeAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(false)
    expect(isWakeAuthorized(undefined, SECRET)).toBe(false)
  })
})

describe('httpWake', () => {
  const addresses = [
    { address: '10.0.1.5', family: 4 },
    { address: '10.0.2.7', family: 4 },
  ]

  it('POSTs the token to every task the name resolves to', async () => {
    vi.mocked(lookup).mockResolvedValue(addresses as never)
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)

    await httpWake('http://worker.kukan-dev.internal:8080/wake', SECRET)()

    expect(lookup).toHaveBeenCalledWith('worker.kukan-dev.internal', { all: true })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://10.0.1.5:8080/wake',
      'http://10.0.2.7:8080/wake',
    ])
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: wakeAuthorization(SECRET) },
      })
    )
  })

  it('succeeds when any task answered, and fails only when none did', async () => {
    vi.mocked(lookup).mockResolvedValue(addresses as never)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error('gone'))
    vi.stubGlobal('fetch', fetch)
    const wake = httpWake('http://worker:8080/wake', SECRET)

    await expect(wake()).resolves.toBeUndefined()

    fetch.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(wake()).rejects.toThrow('401')
  })
})
