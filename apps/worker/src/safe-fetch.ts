/**
 * SSRF-safe fetch with URL validation and DNS-pinned connections.
 *
 * Which addresses are refused lives in `@kukan/shared` — the API refuses a URL
 * at input time from the same list, and two copies of that policy drifted once
 * already. What is here is the enforcement: an undici Agent whose DNS lookup
 * checks the resolved addresses before the TCP connection is established, which
 * is what closes DNS rebinding.
 */

import { promises as dnsPromises, type LookupAddress, type LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent, fetch as undiciFetch } from 'undici'
import {
  checkUrlSafety,
  createCache,
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
} from '@kukan/shared'
import {
  DNS_CACHE_TTL_MS,
  DNS_TIMEOUT_MS,
  DNS_TRIES,
  MAX_ADDRESSES_PER_NAME,
  MAX_REDIRECT_BODY,
  RESOLUTION_CACHE_MAX,
} from '@/config'

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
async function resolveAddresses(hostname: string, ask: Families): Promise<LookupAddress[]> {
  const { v4: ask4, v6: ask6 } = ask
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

  // Trimmed here rather than at the cache, so an oversized answer is bounded
  // whether or not it is held.
  if (answers.length > 0) return answers.slice(0, MAX_ADDRESSES_PER_NAME)

  const err: NodeJS.ErrnoException = new Error(`Could not resolve ${hostname}`)
  // Distinguished so a caller can tell "this name does not exist" from "the
  // resolver did not say" — the health check records the first as a dead link
  // and the second is worth retrying. {@link resolveCached} keeps only the
  // first.
  err.code = unanswered ? 'EAI_AGAIN' : 'ENOTFOUND'
  throw err
}

/** Which families to ask about. */
interface Families {
  v4: boolean
  v6: boolean
}

/**
 * A caller that names a family gets exactly that — an explicit request is not a
 * guess to be second-guessed; otherwise ask for what this host can reach.
 */
function familiesToAsk(family: number): Families {
  if (family === 4 || family === 6) return { v4: family === 4, v6: family === 6 }
  return reachableFamilies()
}

/**
 * Answers being waited for, and answers recently given.
 *
 * The promise goes in before it settles, so the ten lookups the health check
 * starts at once for one host make one query rather than ten — which is most of
 * the duplication, since the batch's concurrency is what bunches them.
 *
 * Addresses are cached, not verdicts: the whole list is handed back and
 * {@link isBlockedAddress} runs over all of it on every lookup. Returning a
 * subset would be the same weakening as skipping the check, because a name that
 * answers with a public address beside a loopback one is refused only if both
 * are seen.
 */
const resolutions = createCache({ max: RESOLUTION_CACHE_MAX, ttlMs: DNS_CACHE_TTL_MS })

/**
 * The reachable families are part of the key, not just of the answer.
 *
 * `reachableFamilies` is read per lookup on purpose — an interface coming up
 * should not need a restart to be noticed, and `networkInterfaces()` raising a
 * system error makes one lookup ask both ways. Caching the answer without the
 * question would hold that one lookup's mistake for the whole TTL, handing an
 * AAAA-first list to every URL of a host on a machine with no IPv6 route.
 */
function cacheKey(hostname: string, ask: Families): string {
  return `${ask.v4 ? 4 : ''}${ask.v6 ? 6 : ''}|${hostname}`
}

function resolveCached(hostname: string, family: number): Promise<LookupAddress[]> {
  // Literals never reach a resolver, so an entry saves nothing and only takes a
  // slot another host could use.
  const literal = isIP(hostname)
  if (literal) return Promise.resolve([{ address: hostname, family: literal }])

  const ask = familiesToAsk(family)
  const key = cacheKey(hostname, ask)
  const pending = resolutions.get(key) as Promise<LookupAddress[]> | undefined
  if (pending) return pending

  const answer = resolveAddresses(hostname, ask)
  resolutions.set(key, answer)
  answer.catch((err: NodeJS.ErrnoException) => {
    // Only an authoritative "not there" is worth keeping. A resolver that did
    // not answer has already cost this lookup the full `DNS_TRIES` budget, so
    // holding it saves nothing a retry would not — and it would take that retry
    // away from every other URL of the same host, each of which the health
    // check then writes down as a dead link.
    if (!isNegativeAnswer(err)) resolutions.delete(key)
  })
  return answer
}

/**
 * Forget everything resolved so far.
 *
 * For tests: the cache is module state and outlives a test case, so without
 * this a second case naming a host the first already asked about is answered
 * from the first one's stub.
 */
export function forgetResolutions(): void {
  resolutions.clear()
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
 *
 * Blocked names are refused here as well as at the URL, so that the guarantee
 * belongs to the connection rather than to whoever remembered to check first.
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

  if (isBlockedHostname(hostname)) {
    done(new Error(`Blocked hostname: ${hostname}`), [])
    return
  }

  resolveCached(hostname, wantedFamily(options.family)).then(
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

/** The original request is not a hop, so ten redirects means eleven requests. */
const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Which methods each status rewrites to GET, and the clause that says so.
 *
 * A table rather than a chain of comparisons because the rule is per status and
 * reads that way in the RFC. 307 and 308 are absent: they exist precisely to be
 * the ones that keep the method (§15.4.8, §15.4.9).
 */
const REWRITES_TO_GET: Record<number, (method: string) => boolean> = {
  301: (m) => m === 'POST', // §15.4.2 — what clients do, which the RFC acknowledges
  302: (m) => m === 'POST', // §15.4.3 — likewise
  303: (m) => m !== 'GET' && m !== 'HEAD', // §15.4.4 — retrieve the result, do not resubmit
}

/**
 * Headers a credential lives in, which must not follow a redirect to another
 * origin: they were granted to the host the caller named, and a redirect is
 * where an attacker gets to name a different one. This is the Fetch standard's
 * cross-origin rule, and it is the half of redirect handling with a secret on
 * the other side of it.
 */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2']

/** Everything that describes a body, for when the body goes. `content-length`
 *  is derived rather than carried, which is why Fetch omits it from its own
 *  list and why it has to be named here anyway. */
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
]

/**
 * What the next hop is asked with.
 *
 * Two rules, and both have to run: the method rewrite above, and stripping
 * credentials when the origin changes. An earlier version did only the first,
 * which is worse than doing neither — it reads as though redirect semantics are
 * handled, so the missing half never gets audited. Measured before the fix: a
 * cross-origin 302 delivered `authorization`, `cookie` and `proxy-authorization`
 * verbatim to the second host, where undici's own redirect handling strips all
 * three.
 *
 * Neither caller sends a body or a credential today. That is why this is worth
 * having rather than why it is not: the next caller here is an authenticated
 * source fetch, and it would inherit whatever this function does.
 */
function nextHopInit(
  init: RequestInit | undefined,
  status: number,
  sameOrigin: boolean
): RequestInit | undefined {
  const method = (init?.method ?? 'GET').toUpperCase()
  const dropsBody = REWRITES_TO_GET[status]?.(method) ?? false
  // Nothing to rewrite and nothing to strip — the request goes on as it is.
  if (!dropsBody && sameOrigin) return init

  const { body, headers, ...rest } = init ?? {}
  const carried = new Headers(headers)
  if (!sameOrigin) for (const name of CREDENTIAL_HEADERS) carried.delete(name)
  if (dropsBody) for (const name of BODY_HEADERS) carried.delete(name)

  return dropsBody
    ? { ...rest, method: 'GET', headers: carried }
    : { ...rest, body, headers: carried }
}

/**
 * Let go of a body that is not going to be read.
 *
 * `cancel` destroys the connection rather than draining it, so this is not
 * about keeping it poolable — it is about not leaving bytes arriving on a
 * socket the shared Agent has pooled. Every fetch in the worker goes through
 * that one Agent, so a body nobody reads is a connection nobody else can have.
 *
 * Every path that ends without reading the body needs this, and the ones that
 * do are not only the interesting ones: a URL that answers 404 leaks exactly as
 * a hostile redirect does, and there are more of them. Measured on the branch
 * that skipped it once already: 200 held sockets from one health-check pass.
 */
export async function discardBody(response: Pick<Response, 'body'>): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Refused because the chain reached a host the caller would not allow it to.
 *
 * Its own type so the pipeline can tell this from a broken link: the URL is
 * fine and the server answered, this fetch simply may not go on right now, and
 * the run is worth retrying rather than recording against the resource.
 */
export class HopRefusedError extends Error {
  constructor(readonly hostname: string) {
    super(`Redirect to ${hostname} refused`)
    this.name = 'HopRefusedError'
  }
}

/** What the caller wants asked at each hop. */
export interface SafeFetchHooks {
  /**
   * Whether the chain may go on to `hostname`, asked once per host it has not
   * used yet.
   *
   * The rate limit was applied to the URL a user registered and to nothing
   * after it, so a redirect bought requests to any other host for free — the
   * limit could not see them, and neither could an operator auditing the
   * resource, since the third-party host appears nowhere on it.
   *
   * Asked once per host and not once per hop, because the limit the pipeline
   * applies is one request per host per interval: a chain that redirects within
   * one host — `http` to `https`, a missing trailing slash — would otherwise be
   * refused by the slot its own first request had just taken.
   */
  onHost?(hostname: string): Promise<boolean>
}

/**
 * Fetch a URL with SSRF protection.
 * - Validates URL hostname and protocol (string-level)
 * - Uses undici Agent with DNS-pinning to block private IP resolution
 * - Manually follows redirects with safety checks at each hop
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  hooks?: SafeFetchHooks
): Promise<Response> {
  const safetyError = checkUrlSafety(url)
  if (safetyError) {
    throw new Error(`Unsafe URL: ${safetyError.message}`)
  }

  let currentUrl = url
  let currentInit = init
  // Seeded with the host the caller named: it acquired that one itself, and
  // asking again would refuse the chain on its own first request. Normalized,
  // because this is the Set `normalizeHostname` was written for — untouched,
  // `example.com.` reads as a host of its own and buys a second slot.
  const usedHosts = new Set([normalizeHostname(new URL(url).hostname)])
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // undici fetch with SSRF-safe Agent; cast types for compatibility with global Response
    const response = (await undiciFetch(currentUrl, {
      ...(currentInit as Record<string, unknown>),
      redirect: 'manual',
      dispatcher: ssrfSafeAgent,
    })) as unknown as Response

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    // A redirect with nowhere to go is broken, not a hop: nothing can follow
    // it, and neither caller reads the body of a response it treats as an
    // error. Released here rather than left to them, since it is this function
    // that knows the body is going nowhere.
    if (!location) {
      await discardBody(response)
      return response
    }

    // Ahead of everything below that can throw. The refusal below is the branch
    // an attacker picks, and it used to be the one that skipped this.
    //
    // Deliberately not above the first return: that response belongs to the
    // caller, and the pipeline reads the body of the one it gets.
    await discardBody(response)

    // Read after the cancel — the header is already in hand, and the bytes are
    // what this is about. A hop's body is discarded, so it was measured by
    // nothing: `MAX_FETCH_SIZE` guards the response the caller keeps, and each
    // redirect streamed until the cancel took effect. Ten hops of that is real
    // transfer, on every run of the resource, paid for at the NAT gateway.
    //
    // Only what the server declares. A chunked hop states no length and is
    // still bounded solely by how fast the cancel lands — this refuses the
    // honest case and shortens nothing else.
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_REDIRECT_BODY) {
      throw new Error(`Redirect body too large: ${declared} bytes`)
    }

    // `currentUrl` has already passed `checkUrlSafety`, so it parses.
    const from = new URL(currentUrl)
    let next: URL
    try {
      // Resolved against the URL this hop was fetched from, because a
      // `Location` is allowed to be relative and most are.
      next = new URL(location, from)
    } catch {
      // Otherwise this escapes as a bare `TypeError: Invalid URL`, which the
      // health check records against the resource — pointing at the stored URL
      // when the broken party is the server that answered.
      throw new Error(`Redirect target is unusable: Location is not a URL`)
    }

    // A chain that starts under TLS must not finish outside it. The catalog goes
    // on showing the `https://` the user entered, so a downgrade publishes bytes
    // that travelled in the clear — and records a hash over whatever arrived —
    // with nothing on the resource to say so.
    if (from.protocol === 'https:' && next.protocol !== 'https:') {
      throw new Error(`Redirect target is unsafe: https downgraded to ${next.protocol}`)
    }

    const nextSafetyError = checkUrlSafety(next.href)
    if (nextSafetyError) {
      throw new Error(`Redirect target is unsafe: ${nextSafetyError.message}`)
    }

    // Before the slot below, because that is the first thing here with an
    // effect outside this process. Decided after it, the last hop of an
    // over-long chain spends a host's allowance on a request that is never
    // sent — and a busy host answering no turns a chain that should end here
    // into a `deferred`, which retries a redirect loop instead of reporting it.
    if (i === MAX_REDIRECTS) break

    // After the safety checks, so a refused target never spends a slot, and
    // before the request, so the slot is held when it goes out.
    const nextHost = normalizeHostname(next.hostname)
    if (!usedHosts.has(nextHost)) {
      if (hooks?.onHost && !(await hooks.onHost(nextHost))) {
        throw new HopRefusedError(nextHost)
      }
      usedHosts.add(nextHost)
    }

    currentInit = nextHopInit(currentInit, response.status, from.origin === next.origin)
    currentUrl = next.href
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
}
