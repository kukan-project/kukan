import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DNS_CACHE_TTL_MS,
  HEALTH_CHECK_BATCH_SIZE,
  HEALTH_CHECK_CONCURRENCY,
  MAX_REDIRECT_BODY,
  RESOLUTION_CACHE_MAX,
} from '../config'

// Mock node:dns to control DNS resolution in the Agent's lookup callback.
// c-ares is the only resolver the lookup uses — there is no `dns.lookup`
// fallback — and it reaches it through a `Resolver` instance, so the class is
// what has to be stubbed.
const mockResolve4 = vi.fn()
const mockResolve6 = vi.fn()
const dnsError = (code: string) => Object.assign(new Error(code), { code })
vi.mock('node:dns', () => ({
  promises: {
    Resolver: class {
      resolve4 = (...args: unknown[]) => mockResolve4(...args) as Promise<string[]>
      resolve6 = (...args: unknown[]) => mockResolve6(...args) as Promise<string[]>
    },
  },
}))

// Which families the host can reach decides which queries are sent at all
// (AI_ADDRCONFIG). Stubbed so the suite does not depend on the machine running
// it — the box this was written on has no global IPv6, which would silence
// every AAAA query and quietly make half these tests vacuous.
const mockInterfaces = vi.fn()
vi.mock('node:os', () => ({ networkInterfaces: () => mockInterfaces() }))

const DUAL_STACK = {
  eth0: [
    { address: '192.0.2.10', family: 'IPv4', internal: false },
    { address: '2001:db8::10', family: 'IPv6', internal: false },
  ],
}
const IPV4_ONLY = {
  eth0: [
    { address: '192.0.2.10', family: 'IPv4', internal: false },
    // Link-local only: no route to a global destination, so not IPv6 support.
    { address: 'fe80::215:5dff:fede:5a90', family: 'IPv6', internal: false },
  ],
  lo: [{ address: '::1', family: 'IPv6', internal: true }],
}

// Mock undici fetch — which means the Agent never runs here.
// safe-fetch-agent.test.ts is what covers it.
const mockUndiciFetch = vi.fn()
vi.mock('undici', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    fetch: (...args: unknown[]) => mockUndiciFetch(...args),
  }
})

const { safeFetch, ssrfSafeLookup, forgetResolutions, HopRefusedError } =
  await import('../safe-fetch')

describe('ssrfSafeLookup', () => {
  // The shape `net.connect` actually asks for. Every one of these tests passes
  // it, because the earlier ones did not: they answered as if a single address
  // had come back, so the blocking below never ran against what production
  // hands it and `safeFetch` reached loopback with the check reporting nothing.
  const ALL = { all: true }

  const lookedUp = (hostname: string, options: object = ALL) =>
    new Promise<{ err: Error | null; addresses: unknown }>((resolve) => {
      ssrfSafeLookup(hostname, options, ((err: Error | null, addresses: unknown) =>
        resolve({ err, addresses })) as never)
    })

  beforeEach(() => {
    // Answers are cached across lookups, so a case naming a host an earlier one
    // asked about would be answered from that one's stub.
    forgetResolutions()
    mockResolve4.mockReset()
    mockResolve6.mockReset()
    mockInterfaces.mockReset()
    mockInterfaces.mockReturnValue(DUAL_STACK)
    mockResolve6.mockRejectedValue(dnsError('ENOTFOUND'))
  })

  it('should reject when DNS resolves to loopback', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1'])

    const { err } = await lookedUp('evil.example.com')

    expect(err!.message).toContain('private address')
  })

  it('should reject when DNS resolves to link-local', async () => {
    mockResolve4.mockResolvedValue(['169.254.169.254'])

    const { err } = await lookedUp('evil.example.com')

    expect(err!.message).toContain('169.254.169.254')
  })

  it('should reject a name that answers with a public address beside a private one', async () => {
    // Rebinding: taking the survivors would connect to the loopback one.
    mockResolve4.mockResolvedValue(['93.184.216.34', '127.0.0.1'])

    const { err } = await lookedUp('evil.example.com')

    expect(err!.message).toContain('127.0.0.1')
  })

  it('should allow safe public IPs', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    const { err, addresses } = await lookedUp('example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('should list IPv6 before IPv4 when both answer', async () => {
    // The order `getaddrinfo` would have produced (RFC 6724), and the order
    // `net.connect` races the addresses in.
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const { err, addresses } = await lookedUp('dual.example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([
      { address: '2606:2800:220::1', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ])
  })

  it('should check the IPv6 addresses too', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockResolvedValue(['::1'])

    const { err } = await lookedUp('dual.example.com')

    expect(err!.message).toContain('::1')
  })

  it('should allow private network IPs for intranet use', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.1'])

    const { err } = await lookedUp('intranet.local')

    expect(err).toBeNull()
  })

  it('should answer a single address when `all` is not asked for', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    const { err, addresses } = await lookedUp('example.com', {})

    expect(err).toBeNull()
    expect(addresses).toBe('93.184.216.34')
  })

  it('should return both families rather than dropping the slower one', async () => {
    // An earlier version gave the slower family a 50ms deadline and discarded
    // it — RFC 8305's resolution delay applied to the wrong thing. Measured
    // end-to-end, a name whose AAAA landed 60ms before its A then failed with
    // ENETUNREACH on an IPv4-only host, because the A records were gone by the
    // time `net.connect` saw the list.
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])
    mockResolve4.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(['93.184.216.34']), 60))
    )

    const { err, addresses } = await lookedUp('skewed.example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([
      { address: '2606:2800:220::1', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ])
  })

  it('should treat an empty answer array as no answer', async () => {
    // `resolve4` resolves to `[]` — it does not reject — when the name has a
    // CNAME and no A record, which is what a v6-only host behind a CNAME looks
    // like. Read as success it would hand back nothing at all.
    mockResolve4.mockResolvedValue([])
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const { err, addresses } = await lookedUp('cname-v6only.example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '2606:2800:220::1', family: 6 }])
  })

  it('should report a name nothing answered for as ENOTFOUND', async () => {
    mockResolve4.mockRejectedValue(dnsError('ENOTFOUND'))
    mockResolve6.mockRejectedValue(dnsError('ENODATA'))

    const { err } = await lookedUp('nowhere.example.com')

    expect((err as NodeJS.ErrnoException).code).toBe('ENOTFOUND')
  })

  it('should report a resolver that never answered as EAI_AGAIN', async () => {
    // Distinguished from the above so the health check can tell a dead link
    // from a resolver worth asking again.
    mockResolve4.mockRejectedValue(dnsError('ETIMEOUT'))
    mockResolve6.mockRejectedValue(dnsError('ETIMEOUT'))

    const { err } = await lookedUp('unresponsive.example.com')

    expect((err as NodeJS.ErrnoException).code).toBe('EAI_AGAIN')
  })

  it('should not ask for AAAA on a host with no IPv6 route', async () => {
    // AI_ADDRCONFIG, which `net.connect` asks for and c-ares has no equivalent
    // of. Without it the lookup hands back addresses that can only fail at
    // connect — and the worker's own VPC is IPv4-only.
    mockInterfaces.mockReturnValue(IPV4_ONLY)
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    const { err, addresses } = await lookedUp('dual.example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(mockResolve6).not.toHaveBeenCalled()
  })

  it('should still ask for the family the caller named, reachable or not', async () => {
    mockInterfaces.mockReturnValue(IPV4_ONLY)
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const { err, addresses } = await lookedUp('v6.example.com', { all: true, family: 6 })

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '2606:2800:220::1', family: 6 }])
    expect(mockResolve4).not.toHaveBeenCalled()
  })

  it('should ask both ways when no interface reports an address', async () => {
    mockInterfaces.mockReturnValue({})
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    const { err } = await lookedUp('example.com')

    expect(err).toBeNull()
    expect(mockResolve6).toHaveBeenCalled()
  })

  it('should still resolve when the interface list cannot be read', async () => {
    // `networkInterfaces()` raises a system error on some hosts. Deciding which
    // queries to skip is an optimisation, and it must not be able to stop the
    // lookup from happening.
    mockInterfaces.mockImplementation(() => {
      throw dnsError('ERR_SYSTEM_ERROR')
    })
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    const { err, addresses } = await lookedUp('example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(mockResolve6).toHaveBeenCalled()
  })

  it('should use IPv6 when there is no A record', async () => {
    mockResolve4.mockRejectedValue(dnsError('ENOTFOUND'))
    mockResolve6.mockResolvedValue(['2606:4700::1'])

    const { err, addresses } = await lookedUp('v6only.example.com')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '2606:4700::1', family: 6 }])
  })

  it('should ask once for a host it is asked about repeatedly', async () => {
    // The health check reads a batch of resource URLs that resolve to far fewer
    // hosts — measured at 458 across 34 — so without this it asks the same
    // question about ten times a host, every five minutes, of someone else's
    // servers.
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    for (let i = 0; i < 5; i++) await lookedUp('repeated.example.com')

    expect(mockResolve4).toHaveBeenCalledTimes(1)
  })

  it('should ask once for lookups that overlap', async () => {
    // Concurrency is what bunches them: the batch starts ten at a time, and
    // caching only settled answers would let all ten miss.
    mockResolve4.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(['93.184.216.34']), 20))
    )

    const answers = await Promise.all(
      Array.from({ length: 10 }, () => lookedUp('concurrent.example.com'))
    )

    expect(mockResolve4).toHaveBeenCalledTimes(1)
    expect(answers.every((a) => a.err === null)).toBe(true)
  })

  it('should not answer one host from another entry', async () => {
    // Two lookups, two hosts: without the name in the key the second is
    // answered with the first's addresses, and every test that looks up one
    // host at a time passes anyway.
    mockResolve4.mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['198.51.100.7'])

    const first = await lookedUp('one.example.com')
    const second = await lookedUp('two.example.com')

    expect(first.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(second.addresses).toEqual([{ address: '198.51.100.7', family: 4 }])
  })

  it('should remember that a host does not exist', async () => {
    // A name the resolver answered about is worth holding: a dead host has
    // every one of its URLs in the batch, and each would otherwise wait out the
    // resolver's deadline to be told the same thing.
    mockResolve4.mockRejectedValue(dnsError('ENOTFOUND'))

    for (let i = 0; i < 3; i++) await lookedUp('gone.example.com')

    expect(mockResolve4).toHaveBeenCalledTimes(1)
  })

  it('should hand back the whole list on a cache hit', async () => {
    // Not a formality. Returning a subset is the same weakening as skipping the
    // check: a name answering with a public address beside a loopback one is
    // refused only if both are seen, and an earlier version of this test used a
    // single-address answer, which every such weakening satisfies.
    // Both families on purpose: a hit that relabelled every address as IPv4
    // would be invisible against an all-IPv4 answer.
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const first = await lookedUp('two-addresses.example.com')
    const second = await lookedUp('two-addresses.example.com')

    expect(second.addresses).toEqual(first.addresses)
    expect(second.addresses).toEqual([
      { address: '2606:2800:220::1', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ])
    expect(mockResolve4).toHaveBeenCalledTimes(1)
  })

  it('should still refuse a mixed answer on the second lookup', async () => {
    // The rebinding case, through the cache. Seeing only the first address
    // would allow this for the rest of the TTL with the check still running.
    mockResolve4.mockResolvedValue(['93.184.216.34', '127.0.0.1'])

    const first = await lookedUp('mixed-cached.example.com')
    const second = await lookedUp('mixed-cached.example.com')

    expect(first.err!.message).toContain('127.0.0.1')
    expect(second.err!.message).toContain('127.0.0.1')
    expect(mockResolve4).toHaveBeenCalledTimes(1)
  })

  it('should hold answers for longer than a batch and less than the gap between batches', () => {
    // Expiry itself is not observable here: `lru-cache` reads the `performance`
    // it captured when it loaded, so vitest's fake clock does not reach it, and
    // waiting out a real minute is not a test. What is worth pinning is the
    // constant, because both ends are wrong in ways that look reasonable.
    //
    // Zero especially: `lru-cache` reads it as no expiry at all, so a name would
    // be pinned for the life of the process and a host that moved would never be
    // followed — the opposite of what the constant is documented to do.
    const batch = (HEALTH_CHECK_BATCH_SIZE / HEALTH_CHECK_CONCURRENCY) * 300
    expect(DNS_CACHE_TTL_MS).toBeGreaterThan(batch)
    expect(DNS_CACHE_TTL_MS).toBeLessThan(5 * 60_000)
  })

  it('should keep the families asked about out of one entry', async () => {
    // The reachable families are part of the question, so they belong in the
    // key: one lookup that asked both ways must not answer a later one that
    // asked for IPv4 only.
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const both = await lookedUp('families.example.com')
    const v4 = await lookedUp('families.example.com', { all: true, family: 4 })

    expect(both.addresses).toEqual([
      { address: '2606:2800:220::1', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ])
    expect(v4.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('should not let a machine with no IPv6 inherit an earlier lookups answer', async () => {
    // `reachableFamilies` is read per lookup on purpose, and `networkInterfaces`
    // raising once makes that lookup ask both ways. Cached without the question,
    // that one mistake hands an AAAA-first list to every URL of the host for the
    // rest of the TTL — the ENETUNREACH this module documents.
    mockInterfaces.mockImplementationOnce(() => {
      throw dnsError('ERR_SYSTEM_ERROR')
    })
    mockInterfaces.mockReturnValue(IPV4_ONLY)
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockResolvedValue(['2606:2800:220::1'])

    const guessed = await lookedUp('addrconfig.example.com')
    const known = await lookedUp('addrconfig.example.com')

    expect(guessed.addresses).toHaveLength(2)
    expect(known.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('should hold more names than one batch reaches', async () => {
    // A batch was measured at 34 distinct hosts. Below that the entries evict
    // each other and the caching silently stops happening — so the filler count
    // is that number, not one derived from the capacity being tested.
    const HOSTS_IN_A_BATCH = 34
    expect(RESOLUTION_CACHE_MAX).toBeGreaterThan(HOSTS_IN_A_BATCH)
    mockResolve4.mockResolvedValue(['93.184.216.34'])

    await lookedUp('kept.example.com')
    for (let i = 0; i < HOSTS_IN_A_BATCH; i++) await lookedUp(`filler${i}.example.com`)
    mockResolve4.mockClear()
    await lookedUp('kept.example.com')

    expect(mockResolve4).not.toHaveBeenCalled()
  })

  it('should not hold a name the resolver never answered for', async () => {
    // It already cost this lookup the full DNS_TRIES budget, so holding it saves
    // nothing a retry would not — and takes that retry from every other URL of
    // the host, each of which the health check writes down as a dead link.
    mockResolve4.mockRejectedValue(dnsError('ETIMEOUT'))
    mockResolve6.mockRejectedValue(dnsError('ETIMEOUT'))

    const first = await lookedUp('flaky.example.com')
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    const second = await lookedUp('flaky.example.com')

    expect((first.err as NodeJS.ErrnoException).code).toBe('EAI_AGAIN')
    expect(second.err).toBeNull()
  })

  it('should pass an IP literal through without resolving it', async () => {
    const { err, addresses } = await lookedUp('93.184.216.34')

    expect(err).toBeNull()
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(mockResolve4).not.toHaveBeenCalled()
  })
})

describe('safeFetch', () => {
  beforeEach(() => {
    forgetResolutions()
    mockUndiciFetch.mockReset()
    mockResolve4.mockReset()
    mockResolve6.mockReset()
    mockInterfaces.mockReset()
    mockInterfaces.mockReturnValue(DUAL_STACK)
    // Default: DNS resolves to a safe public IP
    mockResolve4.mockResolvedValue(['93.184.216.34'])
    mockResolve6.mockRejectedValue(dnsError('ENOTFOUND'))
  })

  describe('URL string-level checks', () => {
    it('should reject loopback and link-local IPv4 literals', async () => {
      await expect(safeFetch('http://169.254.169.254/')).rejects.toThrow('Unsafe URL')
      await expect(safeFetch('http://127.0.0.1/')).rejects.toThrow('Unsafe URL')
    })

    it('should allow private network IPv4 for intranet use', async () => {
      mockUndiciFetch.mockResolvedValue(new Response('ok', { status: 200 }))
      const response = await safeFetch('http://10.0.0.1/data')
      expect(response.status).toBe(200)
    })

    it('should reject localhost', async () => {
      await expect(safeFetch('http://localhost/')).rejects.toThrow('Unsafe URL')
    })

    it('should reject non-http(s) schemes', async () => {
      await expect(safeFetch('ftp://example.com/')).rejects.toThrow('Unsupported protocol')
      await expect(safeFetch('file:///etc/passwd')).rejects.toThrow('Unsupported protocol')
    })

    it('should reject IPv6 loopback and link-local', async () => {
      await expect(safeFetch('http://[::1]/')).rejects.toThrow('Unsafe URL')
      await expect(safeFetch('http://[fe80::1]/')).rejects.toThrow('Unsafe URL')
    })
  })

  describe('redirect handling', () => {
    /** Where hop `n` was actually sent. */
    const hop = (n: number) => mockUndiciFetch.mock.calls[n - 1][0] as string
    /** What hop `n` was asked with. */
    const sent = (n: number) => mockUndiciFetch.mock.calls[n - 1][1] as RequestInit
    const headersOf = (n: number) => new Headers(sent(n).headers)
    /** A hop, with a body — which is what real undici gives even for a bare
     *  302, and what makes the release below observable. */
    const redirect = (status: number, location: string) =>
      new Response('a body nobody reads', { status, headers: { location } })
    const ok = () => new Response('ok', { status: 200 })

    it('should reject redirect to internal URL', async () => {
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'http://169.254.169.254/latest/'))

      await expect(safeFetch('https://example.com/redirect')).rejects.toThrow(
        'Redirect target is unsafe'
      )
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1)
    })

    it('should follow safe redirects', async () => {
      mockUndiciFetch.mockResolvedValueOnce(redirect(301, 'https://cdn.example.com/d.csv'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      const response = await safeFetch('https://example.com/data')

      expect(response.status).toBe(200)
      expect(mockUndiciFetch).toHaveBeenCalledTimes(2)
      // Which URL the second hop went to, not merely that there was one: a
      // version that refetched the original passed without this.
      expect(hop(2)).toBe('https://cdn.example.com/d.csv')
    })

    it('should resolve a relative Location against the hop it came from', async () => {
      // Two hops on purpose. With one, the hop and the original URL are the
      // same string, so resolving against either passes — which is what the
      // first version of this test did.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://other.example.com/a/b'))
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, '../c/data.csv'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/start')

      expect(hop(3)).toBe('https://other.example.com/c/data.csv')
    })

    it('should check a relative Location for safety once resolved', async () => {
      // The string alone says nothing — only the resolved URL has a host.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, '//169.254.169.254/latest/'))

      await expect(safeFetch('https://example.com/data')).rejects.toThrow(
        'Redirect target is unsafe'
      )
    })

    it('should refuse a Location that is not a URL', async () => {
      // Unguarded this escapes as a bare `TypeError: Invalid URL`, which the
      // health check records against the resource — naming the stored URL when
      // the broken party is the server that answered.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'http://['))

      await expect(safeFetch('https://example.com/data')).rejects.toThrow('Location is not a URL')
    })

    it('should refuse a downgrade from https to http', async () => {
      // The catalog goes on showing the https URL the user entered.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'http://example.com/data'))

      await expect(safeFetch('https://example.com/data')).rejects.toThrow('https downgraded')
    })

    it('should allow http to stay http', async () => {
      // The counterweight: refusing every scheme change would pass the above.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'http://cdn.example.com/data'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await expect(safeFetch('http://example.com/data')).resolves.toMatchObject({ status: 200 })
    })

    it.each([
      [301, 'GET', undefined],
      [302, 'GET', undefined],
      [303, 'GET', undefined],
      [307, 'POST', 'a=1'],
      [308, 'POST', 'a=1'],
    ])('should send a POST through a %i as %s', async (status, method, body) => {
      mockUndiciFetch.mockResolvedValueOnce(redirect(status, 'https://example.com/moved'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', { method: 'POST', body: 'a=1' })

      expect(sent(2).method).toBe(method)
      expect(sent(2).body).toBe(body)
    })

    it('should leave HEAD alone across a 303', async () => {
      // The health check sends HEAD. Rewritten to GET, a 303 would start
      // downloading bodies on every pass (RFC 9110 §15.4.4 exempts HEAD).
      mockUndiciFetch.mockResolvedValueOnce(redirect(303, 'https://example.com/result'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/data', { method: 'HEAD' })

      expect(sent(2).method).toBe('HEAD')
    })

    it.each(['PUT', 'DELETE', 'PATCH'])('should leave %s alone across a 301', async (method) => {
      // Fetch and RFC 9110 rewrite POST and nothing else on 301/302.
      mockUndiciFetch.mockResolvedValueOnce(redirect(301, 'https://example.com/moved'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', { method, body: 'a=1' })

      expect(sent(2).method).toBe(method)
      expect(sent(2).body).toBe('a=1')
    })

    it('should recognise a lowercase method', async () => {
      // 301 on purpose: its rule names POST exactly, so an unnormalised `post`
      // matches nothing and the rewrite silently stops happening. Under 303 the
      // rule is "not GET or HEAD", which `post` satisfies either way — a test
      // there says nothing about case.
      mockUndiciFetch.mockResolvedValueOnce(redirect(301, 'https://example.com/moved'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', { method: 'post', body: 'a=1' })

      expect(sent(2).method).toBe('GET')
    })

    it('should drop every header that describes the body it dropped', async () => {
      mockUndiciFetch.mockResolvedValueOnce(redirect(303, 'https://example.com/result'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', {
        method: 'POST',
        body: 'a=1',
        headers: {
          'content-type': 'text/csv',
          'content-length': '3',
          'content-encoding': 'gzip',
          'content-language': 'ja',
          'content-location': '/orig',
          accept: 'text/csv',
        },
      })

      for (const gone of [
        'content-type',
        'content-length',
        'content-encoding',
        'content-language',
        'content-location',
      ]) {
        expect(headersOf(2).get(gone)).toBeNull()
      }
      // And what survives, so that stripping everything does not pass.
      expect(headersOf(2).get('accept')).toBe('text/csv')
    })

    it('should strip credentials when the origin changes', async () => {
      // Granted to the host the caller named; a redirect is where an attacker
      // names a different one. Measured before the fix: all three arrived.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://evil.example.net/collect'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/data', {
        headers: {
          authorization: 'Bearer SECRET',
          cookie: 'session=abc',
          'proxy-authorization': 'Basic P',
          accept: 'text/csv',
        },
      })

      expect(headersOf(2).get('authorization')).toBeNull()
      expect(headersOf(2).get('cookie')).toBeNull()
      expect(headersOf(2).get('proxy-authorization')).toBeNull()
      expect(headersOf(2).get('accept')).toBe('text/csv')
    })

    it('should keep credentials within the same origin', async () => {
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com/elsewhere'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/data', { headers: { authorization: 'Bearer SECRET' } })

      expect(headersOf(2).get('authorization')).toBe('Bearer SECRET')
    })

    it('should strip credentials on a 307, which keeps the body', async () => {
      // The worst pairing: body and credentials replayed verbatim to a host the
      // attacker chose. An earlier version returned `init` by identity here, so
      // nothing was stripped at all.
      mockUndiciFetch.mockResolvedValueOnce(redirect(307, 'https://evil.example.net/collect'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', {
        method: 'POST',
        body: 'a=1',
        headers: { authorization: 'Bearer SECRET' },
      })

      expect(sent(2).method).toBe('POST')
      expect(sent(2).body).toBe('a=1')
      expect(headersOf(2).get('authorization')).toBeNull()
    })

    it('should carry the abort signal across hops', async () => {
      // Both callers pass `AbortSignal.timeout`, which is the whole chain's
      // deadline. Dropped, a redirecting host gets unlimited time.
      const signal = AbortSignal.timeout(5_000)
      mockUndiciFetch.mockResolvedValueOnce(redirect(303, 'https://example.com/result'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', { method: 'POST', body: 'a=1', signal })

      expect(sent(2).signal).toBe(signal)
    })

    it('should not modify the init it was given', async () => {
      const init: RequestInit = { method: 'POST', body: 'a=1', headers: { authorization: 'B' } }
      mockUndiciFetch.mockResolvedValueOnce(redirect(303, 'https://evil.example.net/r'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', init)

      expect(init).toEqual({ method: 'POST', body: 'a=1', headers: { authorization: 'B' } })
    })

    it('should rewrite from the previous hop, not the original request', async () => {
      // Two rewriting hops: the second must see what the first produced. Built
      // from the original each time, the credential comes back.
      mockUndiciFetch.mockResolvedValueOnce(redirect(303, 'https://evil.example.net/a'))
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://evil.example.net/b'))
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/submit', {
        method: 'POST',
        body: 'a=1',
        headers: { authorization: 'Bearer SECRET' },
      })

      expect(sent(3).method).toBe('GET')
      expect(sent(3).body).toBeUndefined()
      expect(headersOf(3).get('authorization')).toBeNull()
    })

    it('should refuse a hop whose body claims to be huge', async () => {
      // A hop's body is discarded, so `MAX_FETCH_SIZE` never looked at it and
      // each one arrived until the cancel landed. Nothing legitimate needs a
      // 3xx to carry megabytes.
      mockUndiciFetch.mockResolvedValueOnce(
        new Response('x', {
          status: 302,
          headers: {
            location: 'https://example.com/moved',
            'content-length': String(MAX_REDIRECT_BODY + 1),
          },
        })
      )

      await expect(safeFetch('https://example.com/start')).rejects.toThrow(
        'Redirect body too large'
      )
      // Refused before the next request, which is the point.
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1)
    })

    it('should allow a hop body at the bound', async () => {
      // The counterweight: refusing every hop with a body would pass the above.
      mockUndiciFetch.mockResolvedValueOnce(
        new Response('x', {
          status: 302,
          headers: {
            location: 'https://example.com/moved',
            'content-length': String(MAX_REDIRECT_BODY),
          },
        })
      )
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await expect(safeFetch('https://example.com/start')).resolves.toMatchObject({ status: 200 })
    })

    describe('per-host slots', () => {
      it('should ask for a slot for each new host the chain reaches', async () => {
        // The rate limit read the URL a user registered and nothing after it,
        // so a redirect bought requests to any other host for free.
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://second.example.net/a'))
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://third.example.org/b'))
        mockUndiciFetch.mockResolvedValueOnce(ok())
        const onHost = vi.fn().mockResolvedValue(true)

        await safeFetch('https://example.com/start', undefined, { onHost })

        expect(onHost.mock.calls.map((c) => c[0])).toEqual([
          'second.example.net',
          'third.example.org',
        ])
      })

      it('should not ask again for a host the chain is already using', async () => {
        // The pipeline's limit is one request per host per interval, so a
        // chain redirecting within one host — http to https, a missing trailing
        // slash — would be refused by the slot its own first request took.
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com/a'))
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com/b'))
        mockUndiciFetch.mockResolvedValueOnce(ok())
        const onHost = vi.fn().mockResolvedValue(true)

        await expect(
          safeFetch('https://example.com/start', undefined, { onHost })
        ).resolves.toMatchObject({ status: 200 })
        expect(onHost).not.toHaveBeenCalled()
      })

      it('should not ask twice for a host it returns to', async () => {
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://second.example.net/a'))
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com/back'))
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://second.example.net/c'))
        mockUndiciFetch.mockResolvedValueOnce(ok())
        const onHost = vi.fn().mockResolvedValue(true)

        await safeFetch('https://example.com/start', undefined, { onHost })

        expect(onHost.mock.calls.map((c) => c[0])).toEqual(['second.example.net'])
      })

      it('should treat a trailing dot as the same host', async () => {
        // `URL` folds case and punycode and stops there, so `example.com.` is a
        // different string and the same name to a resolver. Left alone it is a
        // second host with a slot of its own — a limit anyone can step around
        // by alternating the two spellings.
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com./a'))
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://EXAMPLE.com/b'))
        mockUndiciFetch.mockResolvedValueOnce(ok())
        const onHost = vi.fn().mockResolvedValue(true)

        await safeFetch('https://example.com/start', undefined, { onHost })

        expect(onHost).not.toHaveBeenCalled()
      })

      it('should ask for the normalized name, not the one the server wrote', async () => {
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://Second.Example.NET./a'))
        mockUndiciFetch.mockResolvedValueOnce(ok())
        const onHost = vi.fn().mockResolvedValue(true)

        await safeFetch('https://example.com/start', undefined, { onHost })

        expect(onHost).toHaveBeenCalledWith('second.example.net')
      })

      it('should not spend a slot on the hop past the redirect limit', async () => {
        // The chain ends here, so that request is never sent. Asked anyway, it
        // spends a host's allowance on nothing — and a busy host answering no
        // turns "too many redirects" into a `deferred`, which retries a
        // redirect loop rather than reporting it.
        for (let i = 0; i < 11; i++) {
          mockUndiciFetch.mockResolvedValueOnce(redirect(302, `https://hop-${i}.example.net/`))
        }
        const onHost = vi.fn().mockResolvedValue(true)

        await expect(safeFetch('https://example.com/start', undefined, { onHost })).rejects.toThrow(
          'Too many redirects'
        )

        // Ten hops were followed; the eleventh was not asked about.
        expect(onHost).toHaveBeenCalledTimes(10)
        expect(onHost).not.toHaveBeenCalledWith('hop-10.example.net')
      })

      it('should stop the chain when a host is refused', async () => {
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://victim.example.net/a'))
        const onHost = vi.fn().mockResolvedValue(false)

        await expect(safeFetch('https://example.com/start', undefined, { onHost })).rejects.toThrow(
          HopRefusedError
        )
        // The refused host is never asked for bytes.
        expect(mockUndiciFetch).toHaveBeenCalledTimes(1)
      })

      it('should not spend a slot on a target it was going to refuse anyway', async () => {
        // Safety first: an unsafe target consuming the victim host's slot would
        // let an attacker exhaust it without ever reaching the host.
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'http://169.254.169.254/latest/'))
        const onHost = vi.fn().mockResolvedValue(true)

        await expect(safeFetch('https://example.com/start', undefined, { onHost })).rejects.toThrow(
          'unsafe'
        )
        expect(onHost).not.toHaveBeenCalled()
      })

      it('should follow redirects unchanged when no hook is given', async () => {
        // The health check passes none, and must keep working.
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://second.example.net/a'))
        mockUndiciFetch.mockResolvedValueOnce(ok())

        await expect(safeFetch('https://example.com/start')).resolves.toMatchObject({
          status: 200,
        })
      })
    })

    it('should release the body of a hop it follows', async () => {
      // The Agent is shared by every fetch, and a hop body still arriving pins
      // its pooled connection.
      const hopResponse = redirect(302, 'https://example.com/moved')
      mockUndiciFetch.mockResolvedValueOnce(hopResponse)
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/start')

      expect(hopResponse.bodyUsed).toBe(true)
    })

    it('should release the body of a hop it refuses', async () => {
      // The branch an attacker picks. Measured before the fix: 200 sockets held
      // from a single health-check pass.
      const hopResponse = redirect(302, 'http://169.254.169.254/latest/')
      mockUndiciFetch.mockResolvedValueOnce(hopResponse)

      await expect(safeFetch('https://example.com/start')).rejects.toThrow('unsafe')

      expect(hopResponse.bodyUsed).toBe(true)
    })

    it('should release the body of a 3xx with nowhere to go', async () => {
      // Nothing can follow it and no caller reads it — both treat a non-2xx as
      // an error and throw. Left alone it holds a connection on the shared
      // Agent, which is what every other release here exists to prevent.
      const stuck = new Response('a body nobody reads', { status: 302 })
      mockUndiciFetch.mockResolvedValueOnce(stuck)

      const response = await safeFetch('https://example.com/start')

      expect(response.status).toBe(302)
      expect(stuck.bodyUsed).toBe(true)
    })

    it('should hand back the body of the response it returns', async () => {
      // The other side of the release: cancelling before the redirect check
      // destroys the final body too, and the pipeline reads it.
      mockUndiciFetch.mockResolvedValueOnce(redirect(302, 'https://example.com/moved'))
      mockUndiciFetch.mockResolvedValueOnce(new Response('the resource', { status: 200 }))

      const response = await safeFetch('https://example.com/start')

      await expect(response.text()).resolves.toBe('the resource')
    })

    it('should hand back a 3xx that names nowhere to go, so the caller can report it', async () => {
      // The status is what a caller needs — both record it and treat it as an
      // error. The body is released rather than handed over (see below): it is
      // going nowhere, and this is the function that knows that.
      mockUndiciFetch.mockResolvedValueOnce(new Response('no location here', { status: 302 }))

      const response = await safeFetch('https://example.com/start')

      expect(response.status).toBe(302)
    })

    it('should follow exactly ten redirects', async () => {
      // The boundary from the allowed side: the original request is not a
      // redirect, so ten hops is eleven requests.
      for (let i = 0; i < 10; i++) {
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, `https://example.com/hop-${i}`))
      }
      mockUndiciFetch.mockResolvedValueOnce(ok())

      const response = await safeFetch('https://example.com/start')

      expect(response.status).toBe(200)
      expect(mockUndiciFetch).toHaveBeenCalledTimes(11)
    })

    it('should refuse the eleventh redirect', async () => {
      // Exactly one more than the limit allows. Queueing extras lets a wrong
      // limit throw for the wrong reason, which is how 10-vs-11 went unnoticed.
      for (let i = 0; i < 11; i++) {
        mockUndiciFetch.mockResolvedValueOnce(redirect(302, `https://example.com/hop-${i}`))
      }

      await expect(safeFetch('https://example.com/start')).rejects.toThrow('Too many redirects')
      expect(mockUndiciFetch).toHaveBeenCalledTimes(11)
    })

    it('should pass through RequestInit options with redirect: manual', async () => {
      mockUndiciFetch.mockResolvedValueOnce(ok())

      await safeFetch('https://example.com/api', { method: 'HEAD' })

      // Spread order matters: a caller must not be able to displace either.
      expect(sent(1).method).toBe('HEAD')
      expect(sent(1).redirect).toBe('manual')
      expect((sent(1) as { dispatcher?: unknown }).dispatcher).toBeDefined()
    })
  })
})
