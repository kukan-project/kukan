/**
 * SSRF-safe fetch with URL validation and DNS-pinned connections.
 *
 * Blocks:
 * - Loopback (127.0.0.0/8, ::1)
 * - Link-local / AWS IMDS (169.254.0.0/16, fe80::/10)
 * - Unspecified (0.0.0.0/8, ::)
 * - Known metadata hostnames (localhost, metadata.google.internal)
 *
 * Allows (for intranet/on-premises deployments):
 * - Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - ULA (fc00::/7)
 *
 * Uses undici Agent with a custom DNS lookup to validate resolved IPs
 * before the TCP connection is established, eliminating DNS rebinding.
 */

import { lookup as dnsLookup } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'

// ---------------------------------------------------------------------------
// Blocklist definitions
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

// Private ranges (10/8, 172.16/12, 192.168/16) are intentionally allowed
// for intranet/on-premises deployments where resources may be on private networks.
const BLOCKED_IPV4_RANGES: [number, number][] = [
  [0x7f000000, 0xff000000], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 (link-local, includes AWS IMDS)
  [0x00000000, 0xff000000], // 0.0.0.0/8
]

// ---------------------------------------------------------------------------
// IP parsing and matching
// ---------------------------------------------------------------------------

function parseIPv4(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let addr = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    addr = (addr << 8) | n
  }
  return addr >>> 0
}

function isBlockedIPv4(host: string): boolean {
  const addr = parseIPv4(host)
  if (addr === null) return false
  return BLOCKED_IPV4_RANGES.some(([prefix, mask]) => (addr & mask) >>> 0 === prefix >>> 0)
}

function isBlockedIPv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  // fe80::/10 — link-local (fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true
  const v4Dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Dotted) return isBlockedIPv4(v4Dotted[1])
  const v4Hex = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/)
  if (v4Hex) {
    const hi = parseInt(v4Hex[1], 16)
    const lo = parseInt(v4Hex[2], 16)
    const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
    return isBlockedIPv4(ipv4)
  }
  return false
}

/** Exported for testing — used by Agent's custom lookup to reject private IPs at connect time */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return isBlockedIPv4(address)
  if (family === 6) return isBlockedIPv6(address)
  return false
}

// ---------------------------------------------------------------------------
// URL string-level check
// ---------------------------------------------------------------------------

function checkUrlSafety(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Invalid URL'
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported protocol: ${parsed.protocol}`
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname)) return `Blocked hostname: ${hostname}`
  if (isBlockedIPv4(hostname)) return 'URL points to a private or reserved IP address'
  if (isBlockedIPv6(hostname)) return 'URL points to a private or reserved IP address'

  return null
}

// ---------------------------------------------------------------------------
// SSRF-safe undici Agent
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void

/**
 * DNS lookup callback that rejects private/reserved IPs.
 * Exported for testing — verifies the blocking logic is wired correctly.
 */
export function ssrfSafeLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(
    hostname,
    options,
    (err: NodeJS.ErrnoException | null, address: string, family: number) => {
      if (err) return callback(err, address, family)
      if (isBlockedAddress(address, family)) {
        return callback(new Error(`DNS resolved to private address: ${address}`), address, family)
      }
      callback(null, address, family)
    }
  )
}

function createSsrfSafeAgent(): Agent {
  return new Agent({ connect: { lookup: ssrfSafeLookup } })
}

// Module-level singleton — reuses connections across requests
const ssrfSafeAgent = createSsrfSafeAgent()

// ---------------------------------------------------------------------------
// Safe fetch
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a URL with SSRF protection.
 * - Validates URL hostname and protocol (string-level)
 * - Uses undici Agent with DNS-pinning to block private IP resolution
 * - Manually follows redirects with safety checks at each hop
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const safetyError = checkUrlSafety(url)
  if (safetyError) {
    throw new Error(`Unsafe URL: ${safetyError}`)
  }

  let currentUrl = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // undici fetch with SSRF-safe Agent; cast types for compatibility with global Response
    const response = (await undiciFetch(currentUrl, {
      ...(init as Record<string, unknown>),
      redirect: 'manual',
      dispatcher: ssrfSafeAgent,
    })) as unknown as Response

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) {
      return response
    }

    const nextUrl = new URL(location, currentUrl).href
    const nextSafetyError = checkUrlSafety(nextUrl)
    if (nextSafetyError) {
      throw new Error(`Redirect target is unsafe: ${nextSafetyError}`)
    }

    currentUrl = nextUrl
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
}
