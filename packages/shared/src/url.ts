/**
 * Which addresses a resource URL may point at.
 *
 * One list, used twice: the API refuses a URL at input time, and the worker
 * refuses the address it resolves to at connect time. Those are different
 * checks — a hostname says nothing until it is resolved — but they answer to
 * the same policy, and the policy has to read the same in both places. It did
 * not: the two were written separately and drifted, so the worker refused
 * `::ffff:127.0.0.1` and `fd00:ec2::254` while the API still accepted them.
 *
 * Isomorphic, because this module is reachable from `'use client'` components
 * through the package barrel. That rules out `net.BlockList`, which the worker
 * used. It also rules out `ip-address` — already in the lockfile transitively,
 * isomorphic, and a drop-in for everything below — on size: 78 KB of dependency
 * where the hand-written form is 3 KB, in the one module whose reason for being
 * isomorphic is the browser bundle. (`zod` cannot stand in either: its `ipv6()`
 * regex rejects embedded dotted-quads and zone identifiers, which are two of
 * the cases that drifted.)
 */

/** A prefix, and how many of its leading bits an address has to match. */
interface Subnet {
  prefix: readonly number[]
  bits: number
}

/** `'fe80::/10'` as bytes. IPv4 prefixes stay 4 bytes wide, IPv6 16. */
function cidr(text: string): Subnet {
  const [address, bits] = text.split('/')
  const prefix = parseIPv4(address) ?? parseIPv6(address)
  if (!prefix) throw new Error(`Not a CIDR block: ${text}`)
  return { prefix, bits: Number(bits) }
}

// Private ranges — 10/8, 172.16/12, 192.168/16 and the rest of ULA — are
// deliberately absent: intranet and on-premises deployments keep resources on
// them.
const BLOCKED_V4 = [
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, including AWS IMDS
  '0.0.0.0/8', // unspecified
].map(cidr)

const BLOCKED_V6 = [
  '::1/128', // loopback
  '::/96', // unspecified, and IPv4-compatible (`::127.0.0.1`)
  'fe80::/10', // link-local
  'fd00:ec2::/32', // AWS IMDS over IPv6, inside the ULA range allowed above
].map(cidr)

/**
 * Prefixes that carry an IPv4 address, and the byte it starts at.
 *
 * Judged on what they carry rather than blocked outright: `64:ff9b::/96` is how
 * a NAT64 network reaches IPv4 at all, so refusing the prefix refuses the
 * internet.
 *
 * NAT64 is matched at /32 rather than the /96 of the well-known prefix, so that
 * RFC 8215's local-use `64:ff9b:1::/48` is covered too.
 */
const EMBEDS_IPV4: { subnet: Subnet; at: number }[] = [
  { subnet: cidr('::ffff:0:0/96'), at: 12 }, // IPv4-mapped
  { subnet: cidr('64:ff9b::/32'), at: 12 }, // NAT64 (RFC 6052, RFC 8215)
  { subnet: cidr('2002::/16'), at: 2 }, // 6to4 (RFC 3056) — its IPv4 sits higher up
]

const bitAt = (bytes: readonly number[], i: number) => (bytes[i >> 3] >> (7 - (i % 8))) & 1

function matches(bytes: readonly number[], { prefix, bits }: Subnet): boolean {
  for (let i = 0; i < bits; i++) {
    if (bitAt(bytes, i) !== bitAt(prefix, i)) return false
  }
  return true
}

/** The four octets, or null when this is not a dotted-quad. */
function parseIPv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    // `Number` would accept '', ' 1', '0x7f' and '1e2'; the URL parser has
    // already normalised those away, and anything left is not an address.
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/** One `:`-separated run, as bytes. A trailing dotted-quad counts as four. */
function expandGroups(part: string): number[] | null {
  if (part === '') return []
  const bytes: number[] = []
  const groups = part.split(':')
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    // A trailing dotted-quad, as in `::ffff:127.0.0.1`.
    if (group.includes('.')) {
      if (i !== groups.length - 1) return null
      const quad = parseIPv4(group)
      if (!quad) return null
      bytes.push(...quad)
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const value = parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

/**
 * The sixteen bytes, or null when this is not an IPv6 address.
 *
 * Written out because the platform has no isomorphic parser: `net.isIP` is
 * Node-only, and `new URL` accepts an address only inside a URL — which loses
 * the distinction between "not an address" and "not a URL", and returns RFC 5952
 * text that would still need parsing to bytes.
 */
function parseIPv6(host: string): number[] | null {
  // Nothing without a colon can be one, and most of what reaches here is a
  // hostname.
  if (host.indexOf(':') < 0) return null
  // A zone identifier is not part of the address, and left attached it defeats
  // every comparison — `::1%lo` is still loopback.
  const halves = host.split('%')[0].split('::')
  if (halves.length > 2) return null

  const head = expandGroups(halves[0])
  const tail = halves.length === 2 ? expandGroups(halves[1]) : []
  if (!head || !tail) return null

  if (halves.length === 1) return head.length === 16 ? head : null
  const gap = 16 - head.length - tail.length
  if (gap < 1) return null

  const bytes = new Array<number>(16).fill(0)
  for (let i = 0; i < head.length; i++) bytes[i] = head[i]
  for (let i = 0; i < tail.length; i++) bytes[16 - tail.length + i] = tail[i]
  return bytes
}

const isBlockedV4 = (bytes: readonly number[]) => BLOCKED_V4.some((s) => matches(bytes, s))

/**
 * Whether this address is off limits.
 *
 * Takes both what a resolver produces and what `URL.hostname` does, so it
 * strips the brackets the latter puts round IPv6, and answers `false` for
 * anything that is not an address at all — which is what lets
 * {@link checkUrlSafety} hand it a bare hostname.
 */
export function isBlockedAddress(address: string): boolean {
  // Brackets only ever arrive from `URL.hostname`, and only round IPv6, so the
  // rewrite is skipped for every dotted-quad and every hostname.
  const bare =
    address.charCodeAt(0) === 0x5b ? address.slice(1, -1).toLowerCase() : address.toLowerCase()

  const v4 = parseIPv4(bare)
  if (v4) return isBlockedV4(v4)

  const v6 = parseIPv6(bare)
  if (!v6) return false

  // Judged on what it carries, ahead of the list below so that
  // `::ffff:8.8.8.8` is not caught by `::/96`.
  for (const { subnet, at } of EMBEDS_IPV4) {
    if (matches(v6, subnet)) return isBlockedV4(v6.slice(at, at + 4))
  }
  return BLOCKED_V6.some((subnet) => matches(v6, subnet))
}

/** Why a URL may not be fetched. `reason` is what callers branch on; `message`
 *  is for logs and error text. */
export interface UrlSafetyProblem {
  reason: 'invalid' | 'protocol' | 'hostname' | 'address'
  message: string
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

/**
 * The form of a hostname to compare and to key on.
 *
 * `URL` folds case and punycode for us and stops there: a trailing dot is the
 * same name to a resolver and a different string to everything else. Anything
 * that decides "have I seen this host" — a blocklist, a rate limit, the set of
 * hosts a redirect chain has used — has to ask in one form, or `example.com.`
 * is a second host with a budget of its own.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

/**
 * A name refused whatever it resolves to.
 *
 * Separate from {@link checkUrlSafety} so the connection layer can ask it too:
 * the address check below cannot make this judgement for `localhost`, because
 * the worker resolves through c-ares, which never reads `/etc/hosts`. Without
 * this the name is refused only where the resolver happens to answer NXDOMAIN
 * or 127.0.0.1, which is not a property to rest a blocklist on.
 */
export function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(normalizeHostname(hostname))
}

/**
 * Why this URL may not be fetched, or null when it may.
 *
 * String level only: a hostname is judged by the resolver, not here. This is
 * the check that runs before anything is requested, and on each redirect hop.
 */
export function checkUrlSafety(url: string): UrlSafetyProblem | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { reason: 'invalid', message: 'Invalid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { reason: 'protocol', message: `Unsupported protocol: ${parsed.protocol}` }
  }

  const hostname = normalizeHostname(parsed.hostname)
  if (isBlockedHostname(hostname)) {
    return { reason: 'hostname', message: `Blocked hostname: ${hostname}` }
  }
  if (isBlockedAddress(hostname)) {
    return { reason: 'address', message: 'URL points to a private or reserved IP address' }
  }

  return null
}
