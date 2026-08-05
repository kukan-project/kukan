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

import { promises as dnsPromises, type LookupAddress, type LookupOptions } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent, fetch as undiciFetch } from 'undici'
import { DNS_TIMEOUT_MS, DNS_TRIES } from '@/config'

// ---------------------------------------------------------------------------
// Blocklist definitions
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

/**
 * Addresses no resource URL may resolve to.
 *
 * `net.BlockList` rather than matched text: it parses to bytes once, and on its
 * own it covers what four hand-written special cases used to — zone identifiers
 * (`::1%lo`), uncompressed spellings, and IPv4-mapped addresses in both the
 * dotted and the hex form `URL` normalises between. Matching the text is how
 * those gaps arrived in the first place.
 *
 * Private ranges (10/8, 172.16/12, 192.168/16, and the rest of ULA) are
 * deliberately absent: intranet and on-premises deployments keep resources on
 * them.
 */
const BLOCKED = new BlockList()
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4') // link-local, including AWS IMDS
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4') // unspecified
BLOCKED.addSubnet('::1', 128, 'ipv6') // loopback
BLOCKED.addSubnet('::', 96, 'ipv6') // unspecified, and IPv4-compatible (`::127.0.0.1`)
BLOCKED.addSubnet('fe80::', 10, 'ipv6') // link-local
// AWS IMDS over IPv6 — the counterpart of 169.254.169.254, and it sits inside
// the ULA range allowed just above, so it has to be named.
BLOCKED.addSubnet('fd00:ec2::', 32, 'ipv6')

/**
 * Whether this address is off limits.
 *
 * Takes both what the resolver produces and what `URL.hostname` does, so it
 * strips the brackets the latter puts round IPv6 and answers `false` for
 * anything that is not an address at all — which is what lets
 * {@link checkUrlSafety} hand it a bare hostname.
 *
 * Exported for testing, and used by the Agent's lookup to reject private
 * addresses before the connection is made.
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '')
  const family = isIP(bare.split('%')[0])
  if (family === 0) return false
  return BLOCKED.check(bare, family === 4 ? 'ipv4' : 'ipv6')
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
  if (isBlockedAddress(hostname)) return 'URL points to a private or reserved IP address'

  return null
}

// ---------------------------------------------------------------------------
// SSRF-safe undici Agent
// ---------------------------------------------------------------------------

/** 4, 6, or 0 for "either" — `family` reaches here spelled both ways. */
function wantedFamily(family: LookupOptions['family']): number {
  if (family === 4 || family === 'IPv4') return 4
  if (family === 6 || family === 'IPv6') return 6
  return 0
}

// Not `address?:` — undici's `LookupFunction` requires it, so the error path
// passes an empty list nothing reads.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/** The resolver answered, and the answer was "no such name / no such record". */
function isNegativeAnswer(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOTFOUND' || code === 'ENODATA'
}

/**
 * A resolver with a deadline of its own.
 *
 * Left to itself c-ares is far more patient than the `getaddrinfo` this
 * replaces; {@link DNS_TIMEOUT_MS} carries the measurements and the budget it
 * has to fit inside.
 *
 * Module-level, because it holds c-ares' socket and server list: one per lookup
 * re-reads `resolv.conf` and measures 15x the rest of the path.
 */
const resolver = new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES })

/** How one family's query came out. */
interface FamilyAnswer {
  family: number
  addresses?: string[]
  error?: unknown
}

function settle(query: Promise<string[]>, family: number): Promise<FamilyAnswer> {
  return query.then(
    (addresses) => ({ family, addresses }),
    (error: unknown) => ({ family, error })
  )
}

/**
 * The families this host can actually reach.
 *
 * `getaddrinfo` does this as `AI_ADDRCONFIG`, and `net.connect` asks for it —
 * it passes `hints: ADDRCONFIG` — but c-ares has no equivalent, so asking for
 * AAAA on a host with no IPv6 route would return addresses that can only fail
 * at `connect` with `ENETUNREACH`. The worker's own VPC is IPv4-only, so this
 * is the ordinary case rather than a corner.
 *
 * Link-local addresses do not count: an interface with only `fe80::…` has no
 * route to a global destination, which is the judgement `getaddrinfo` makes.
 *
 * Read per lookup rather than cached — a thousand calls cost 16ms, and an
 * interface coming up should not need a restart to be noticed.
 *
 * Nothing to go on means both, so that an optimisation deciding which queries
 * to skip can never stop the lookup from happening — `networkInterfaces()`
 * raises a system error on some hosts.
 */
function reachableFamilies(): { v4: boolean; v6: boolean } {
  const UNKNOWN = { v4: true, v6: true }
  let v4 = false
  let v6 = false
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal) continue
        if (address.family === 'IPv4') v4 = true
        else if (!address.address.toLowerCase().startsWith('fe80:')) v6 = true
      }
    }
  } catch {
    return UNKNOWN
  }
  return v4 || v6 ? { v4, v6 } : UNKNOWN
}

/**
 * Resolve through c-ares rather than `getaddrinfo`.
 *
 * `dns.lookup` runs `getaddrinfo` on the libuv threadpool — four threads for
 * the whole process — and a call already in flight cannot be cancelled, by an
 * `AbortSignal` or by anything else. A host whose AAAA never comes back
 * therefore costs a thread for the life of the process, and four such hosts
 * stop every name resolution the worker makes, including the ones that reach
 * Postgres. Measured against a real data source: A answered in 25ms while the
 * default lookup had still not returned after twelve seconds.
 *
 * c-ares runs its own sockets on the event loop, so a query that never answers
 * costs only the {@link resolver}'s deadline, and costs it to nobody else.
 *
 * Every family asked is waited for, and IPv6 is listed first when both answer.
 * An earlier version gave the slower family a deadline of its own — RFC 8305's
 * resolution delay — and *discarded* it when that expired. That is not what the
 * RFC describes: §3 delays starting a connection, and §5 appends the second
 * family's addresses when they arrive. Nothing there throws an answer away, and
 * throwing it away is worse than waiting for it: measured end-to-end, a name
 * whose AAAA arrived 60ms before its A failed outright with `ENETUNREACH` on an
 * IPv4-only host, because the A records were gone by the time `net.connect` saw
 * the list. A lookup hands over one list, once, so the only safe reading of
 * "prefer IPv6" is to ask for what this host can use and wait for it.
 *
 * The cost is `/etc/hosts` and the `search` list: c-ares queries the servers in
 * `resolv.conf` and nothing else, so names that live only in the hosts file, and
 * unqualified names that need a search domain appended, no longer resolve. Only
 * outbound fetches of resource URLs come through here, where both are already
 * unusual. An earlier version fell back to `dns.lookup` for names the resolver
 * called nonexistent, which did not hold: `getaddrinfo` issues its own queries
 * to the same server, so a name answered NXDOMAIN here and left unanswered
 * there put the threadpool back on an attacker-supplied path.
 */
async function resolveAddresses(hostname: string, family: number): Promise<LookupAddress[]> {
  const literal = isIP(hostname)
  if (literal) return [{ address: hostname, family: literal }]

  // A caller that names a family gets exactly that — an explicit request is not
  // a guess to be second-guessed; otherwise ask for what this host can reach.
  const reachable = family === 0 ? reachableFamilies() : { v4: false, v6: false }
  const ask6 = family === 0 ? reachable.v6 : family === 6
  const ask4 = family === 0 ? reachable.v4 : family === 4

  const queries: Promise<FamilyAnswer>[] = []
  if (ask6) queries.push(settle(resolver.resolve6(hostname), 6))
  if (ask4) queries.push(settle(resolver.resolve4(hostname), 4))

  const answers: LookupAddress[] = []
  // A query that timed out has not said the name is absent, and the difference
  // is worth keeping: one is a dead link, the other is worth asking again.
  let unanswered = false

  for (const { family: answered, addresses, error } of await Promise.all(queries)) {
    // An empty array is a negative answer spelled differently — `resolve4`
    // resolves to `[]` rather than rejecting when the name has a CNAME and no
    // record of the family asked for. Read as success it would return nothing.
    if (addresses?.length) {
      answers.push(...addresses.map((address) => ({ address, family: answered })))
    } else if (error && !isNegativeAnswer(error)) {
      unanswered = true
    }
  }

  if (answers.length > 0) return answers

  const err: NodeJS.ErrnoException = new Error(`Could not resolve ${hostname}`)
  // Distinguished so a caller can tell "this name does not exist" from "the
  // resolver did not say" — the health check records the first as a dead link
  // and the second is worth retrying.
  err.code = unanswered ? 'EAI_AGAIN' : 'ENOTFOUND'
  throw err
}

/**
 * DNS lookup callback that rejects private/reserved IPs.
 * Exported for testing — verifies the blocking logic is wired correctly.
 *
 * Every resolved address is checked, and one blocked address rejects the whole
 * name: a host that answers with a public address alongside a loopback one is
 * the rebinding this is here to stop, and picking the survivors would let it
 * through. `net.connect` asks for every address at once (`all`) so that it can
 * race the families, which is why this cannot check a single one and stop.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback
): void {
  // Answered outside the chain: `net.connect`'s lookup callback does real work
  // and can throw, and inside a `then` that throw becomes an unhandled
  // rejection — fatal in Node 24, but attributed here rather than to the
  // caller, and after this function has already reported success.
  const done = (...args: Parameters<LookupCallback>) => process.nextTick(callback, ...args)

  resolveAddresses(hostname, wantedFamily(options.family)).then(
    (addresses) => {
      const blocked = addresses.find((a) => isBlockedAddress(a.address))
      if (blocked) {
        done(new Error(`DNS resolved to private address: ${blocked.address}`), blocked.address)
      } else if (options.all) {
        done(null, addresses)
      } else {
        done(null, addresses[0].address, addresses[0].family)
      }
    },
    (err: NodeJS.ErrnoException) => {
      done(err, [])
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
