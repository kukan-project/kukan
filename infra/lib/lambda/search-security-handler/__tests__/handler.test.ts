import { describe, it, expect, vi, beforeEach } from 'vitest'

const requestMock = vi.fn()
const sleepMock = vi.fn()

vi.mock('../transport.js', () => ({
  signedRequest: requestMock,
  sleep: sleepMock,
}))

const { handler } = await import('../index.js')

const ENDPOINT = 'vpc-kukan-dev-search-abc.ap-northeast-1.es.amazonaws.com'

function site(name: string) {
  return {
    Name: name,
    Permissions: {
      cluster_permissions: ['cluster_composite_ops'],
      index_permissions: [
        { index_patterns: [`${name}-search*`], allowed_actions: ['indices_all'] },
      ],
    },
    BackendRoles: [
      `arn:aws:iam::123456789012:role/${name}-web-task`,
      `arn:aws:iam::123456789012:role/${name}-worker-task`,
    ],
  }
}

function event(requestType: 'Create' | 'Update' | 'Delete', names: string[], oldNames?: string[]) {
  return {
    RequestType: requestType,
    PhysicalResourceId: requestType === 'Create' ? undefined : 'kukan-search-site-roles',
    ResourceProperties: { Endpoint: ENDPOINT, Roles: names.map(site) },
    OldResourceProperties: oldNames && { Endpoint: ENDPOINT, Roles: oldNames.map(site) },
  }
}

/** Each call as `METHOD path`. */
function calls(): string[] {
  return requestMock.mock.calls.map(([, method, path]) => `${method} ${path}`)
}

/** Run with fake timers, each sleep moving the clock as the real one would. */
async function withClockMovedBySleep(run: () => Promise<void>) {
  vi.useFakeTimers()
  sleepMock.mockImplementation((ms: number) => {
    vi.advanceTimersByTime(ms)
    return Promise.resolve()
  })
  try {
    await run()
  } finally {
    vi.useRealTimers()
  }
}

/** Time spent in sleeps so far. */
const waited = () => sleepMock.mock.calls.reduce((sum, [ms]) => sum + (ms as number), 0)

beforeEach(() => {
  vi.clearAllMocks()
  requestMock.mockResolvedValue({ status: 200, body: '{}' })
  sleepMock.mockResolvedValue(undefined)
})

describe('search-security-handler', () => {
  it('puts each site role and its mapping to the domain, as the security API takes them', async () => {
    const result = await handler(event('Create', ['kukan-dev-citya', 'kukan-dev-cityb']))

    expect(result.PhysicalResourceId).toBe('kukan-search-site-roles')
    expect(calls()).toEqual([
      'PUT /_plugins/_security/api/roles/kukan-dev-citya',
      'PUT /_plugins/_security/api/rolesmapping/kukan-dev-citya',
      'PUT /_plugins/_security/api/roles/kukan-dev-cityb',
      'PUT /_plugins/_security/api/rolesmapping/kukan-dev-cityb',
      'DELETE /_plugins/_security/api/rolesmapping/default_role',
    ])
    expect(requestMock.mock.calls[0][0]).toBe(ENDPOINT)
    expect(requestMock.mock.calls[0][3]).toEqual(site('kukan-dev-citya').Permissions)
    expect(requestMock.mock.calls[1][3]).toEqual({
      backend_roles: site('kukan-dev-citya').BackendRoles,
      hosts: [],
      users: [],
    })
  })

  it('converges again on a repeat, with the same requests', async () => {
    await handler(event('Create', ['kukan-dev-citya']))
    const first = calls()
    requestMock.mockClear()
    await handler(event('Update', ['kukan-dev-citya'], ['kukan-dev-citya']))

    expect(calls()).toEqual(first)
  })

  it('removes the role and mapping of a site the update no longer lists', async () => {
    await handler(event('Update', ['kukan-dev-citya'], ['kukan-dev-citya', 'kukan-dev-cityb']))

    expect(calls()).toEqual([
      'PUT /_plugins/_security/api/roles/kukan-dev-citya',
      'PUT /_plugins/_security/api/rolesmapping/kukan-dev-citya',
      'DELETE /_plugins/_security/api/rolesmapping/kukan-dev-cityb',
      'DELETE /_plugins/_security/api/roles/kukan-dev-cityb',
      'DELETE /_plugins/_security/api/rolesmapping/default_role',
    ])
  })

  it('fails the deploy when the default_role mapping cannot be removed', async () => {
    // Left in place, it would let every site's tasks past their own role
    requestMock.mockImplementation((_host: string, method: string) =>
      Promise.resolve(
        method === 'DELETE' ? { status: 400, body: 'reserved' } : { status: 200, body: '{}' }
      )
    )

    await expect(handler(event('Create', ['kukan-dev-citya']))).rejects.toThrow(
      /DELETE \/_plugins\/_security\/api\/rolesmapping\/default_role → 400/
    )
  })

  it('treats a default_role mapping already gone as removed', async () => {
    requestMock.mockImplementation((_host: string, method: string) =>
      Promise.resolve(method === 'DELETE' ? { status: 404, body: '' } : { status: 200, body: '{}' })
    )

    await expect(handler(event('Create', ['kukan-dev-citya']))).resolves.toBeDefined()
  })

  it('stops a delete once its budget is spent, whatever is left', async () => {
    requestMock.mockResolvedValue({ status: 503, body: 'unavailable' })
    const names = Array.from({ length: 50 }, (_, i) => `kukan-dev-site${i}`)

    await withClockMovedBySleep(async () => {
      await handler(event('Delete', names))
      // Out of time before reaching most of them: no request sent past the budget
      expect(waited()).toBeLessThanOrEqual(2 * 60_000)
      expect(requestMock.mock.calls.length).toBeLessThan(names.length)
    })
  })

  it('treats a role already gone as removed', async () => {
    requestMock.mockImplementation((_host: string, method: string) =>
      Promise.resolve(method === 'DELETE' ? { status: 404, body: '' } : { status: 200, body: '' })
    )

    await expect(
      handler(event('Update', ['kukan-dev-citya'], ['kukan-dev-cityb']))
    ).resolves.toBeDefined()
  })

  it('removes every role it manages on delete', async () => {
    const result = await handler(event('Delete', ['kukan-dev-citya', 'kukan-dev-cityb']))

    expect(result.PhysicalResourceId).toBe('kukan-search-site-roles')
    expect(calls()).toEqual([
      'DELETE /_plugins/_security/api/rolesmapping/kukan-dev-citya',
      'DELETE /_plugins/_security/api/roles/kukan-dev-citya',
      'DELETE /_plugins/_security/api/rolesmapping/kukan-dev-cityb',
      'DELETE /_plugins/_security/api/roles/kukan-dev-cityb',
    ])
  })

  it('does not fail a delete it cannot carry out, which would wedge the stack', async () => {
    requestMock.mockResolvedValue({ status: 400, body: 'nope' })

    await expect(handler(event('Delete', ['kukan-dev-citya']))).resolves.toEqual({
      PhysicalResourceId: 'kukan-search-site-roles',
    })
  })

  it('retries while the security API is not ready yet', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 503, body: 'unavailable' })
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ status: 403, body: 'no permissions' })
      .mockResolvedValue({ status: 200, body: '{}' })

    await handler(event('Create', ['kukan-dev-citya']))

    expect(sleepMock).toHaveBeenCalledTimes(3)
    // Two writes after three tries, and the default_role mapping
    expect(calls()).toHaveLength(6)
  })

  it('fails the deploy on a refusal, with what the domain said', async () => {
    requestMock.mockResolvedValue({ status: 400, body: '{"reason":"bad role"}' })

    await expect(handler(event('Create', ['kukan-dev-citya']))).rejects.toThrow(
      /PUT \/_plugins\/_security\/api\/roles\/kukan-dev-citya → 400 .*bad role/
    )
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it('gives up once retries would outrun the budget', async () => {
    requestMock.mockResolvedValue({ status: 503, body: 'unavailable' })

    await withClockMovedBySleep(async () => {
      await expect(handler(event('Create', ['kukan-dev-citya']))).rejects.toThrow(/503/)
      expect(waited()).toBeLessThanOrEqual(12 * 60_000)
    })
  })

  it('refuses a role name that is not safe in a request path', async () => {
    await expect(handler(event('Create', ['../config']))).rejects.toThrow(/Unsafe/)
    expect(requestMock).not.toHaveBeenCalled()
  })
})
