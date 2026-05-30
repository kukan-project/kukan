import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node:dns to control DNS resolution in the Agent's lookup callback
const mockLookup = vi.fn()
vi.mock('node:dns', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}))

// Mock undici fetch — the Agent is real (uses our mocked dns.lookup)
const mockUndiciFetch = vi.fn()
vi.mock('undici', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    fetch: (...args: unknown[]) => mockUndiciFetch(...args),
  }
})

const { safeFetch, isBlockedAddress, ssrfSafeLookup } = await import('../safe-fetch')

describe('isBlockedAddress', () => {
  describe('IPv4', () => {
    it.each(['127.0.0.1', '127.255.255.255', '169.254.169.254', '169.254.0.1', '0.0.0.0'])(
      'should block %s',
      (ip) => {
        expect(isBlockedAddress(ip, 4)).toBe(true)
      }
    )

    it.each(['10.0.0.1', '172.16.0.1', '192.168.1.1', '8.8.8.8', '203.0.113.1'])(
      'should allow %s',
      (ip) => {
        expect(isBlockedAddress(ip, 4)).toBe(false)
      }
    )
  })

  describe('IPv6', () => {
    it.each(['::1', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1'])(
      'should block %s',
      (ip) => {
        expect(isBlockedAddress(ip, 6)).toBe(true)
      }
    )

    it.each(['fc00::1', 'fd00::1', '2001:db8::1'])('should allow %s', (ip) => {
      expect(isBlockedAddress(ip, 6)).toBe(false)
    })
  })
})

describe('ssrfSafeLookup', () => {
  it('should reject when DNS resolves to loopback', async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: (...args: unknown[]) => void) =>
      cb(null, '127.0.0.1', 4)
    )

    const error = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('evil.example.com', {}, ((err: Error | null) => resolve(err)) as never)
    })

    expect(error).not.toBeNull()
    expect(error!.message).toContain('private address')
  })

  it('should reject when DNS resolves to link-local', async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: (...args: unknown[]) => void) =>
      cb(null, '169.254.169.254', 4)
    )

    const error = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('evil.example.com', {}, ((err: Error | null) => resolve(err)) as never)
    })

    expect(error).not.toBeNull()
    expect(error!.message).toContain('169.254.169.254')
  })

  it('should allow safe public IPs', async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: (...args: unknown[]) => void) =>
      cb(null, '93.184.216.34', 4)
    )

    const error = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('example.com', {}, ((err: Error | null) => resolve(err)) as never)
    })

    expect(error).toBeNull()
  })

  it('should allow private network IPs for intranet use', async () => {
    mockLookup.mockImplementation((_h: string, _o: unknown, cb: (...args: unknown[]) => void) =>
      cb(null, '10.0.0.1', 4)
    )

    const error = await new Promise<Error | null>((resolve) => {
      ssrfSafeLookup('intranet.local', {}, ((err: Error | null) => resolve(err)) as never)
    })

    expect(error).toBeNull()
  })
})

describe('safeFetch', () => {
  beforeEach(() => {
    mockUndiciFetch.mockReset()
    mockLookup.mockReset()
    // Default: DNS resolves to a safe public IP
    mockLookup.mockImplementation(
      (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(null, '93.184.216.34', 4)
      }
    )
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
    it('should reject redirect to internal URL', async () => {
      mockUndiciFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })
      )

      await expect(safeFetch('https://example.com/redirect')).rejects.toThrow(
        'Redirect target is unsafe'
      )
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1)
    })

    it('should follow safe redirects', async () => {
      mockUndiciFetch
        .mockResolvedValueOnce(
          new Response(null, {
            status: 301,
            headers: { location: 'https://cdn.example.com/data.csv' },
          })
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const response = await safeFetch('https://example.com/data')
      expect(response.status).toBe(200)
      expect(mockUndiciFetch).toHaveBeenCalledTimes(2)
    })

    it('should enforce max redirect limit', async () => {
      for (let i = 0; i < 12; i++) {
        mockUndiciFetch.mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: `https://example.com/hop-${i}` },
          })
        )
      }

      await expect(safeFetch('https://example.com/start')).rejects.toThrow('Too many redirects')
    })

    it('should pass through RequestInit options with redirect: manual', async () => {
      mockUndiciFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

      await safeFetch('https://example.com/api', { method: 'HEAD' })

      expect(mockUndiciFetch).toHaveBeenCalledWith(
        'https://example.com/api',
        expect.objectContaining({ method: 'HEAD', redirect: 'manual' })
      )
    })
  })
})
