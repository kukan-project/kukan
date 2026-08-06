/**
 * That the blocking is actually wired into the fetch.
 *
 * The sibling suite mocks `undici.fetch` wholesale, so the Agent never runs and
 * nothing there connects `safeFetch` to `ssrfSafeLookup`: deleting
 * `dispatcher: ssrfSafeAgent` leaves it green while `safeFetch` reaches
 * loopback. That is the shape of the incident this file exists to prevent — the
 * previous version of the check was inert in production for the same reason,
 * green tests over a path production never took.
 *
 * So: real `undici`, real `Agent`, real HTTP server on loopback. Only the
 * resolver is stubbed, and only so the test needs no external DNS — the
 * hostname is one nothing would resolve, which is also what makes the assertion
 * on the *reason* load-bearing. Remove the dispatcher and the fetch still
 * fails, but for the wrong reason, and this notices.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'

const answers = new Map<string, string[]>()
let onResolve: (() => void) | undefined
vi.mock('node:dns', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const promises = actual.promises as Record<string, unknown>
  return {
    ...actual,
    promises: {
      ...promises,
      Resolver: class {
        // Only A records: the suite's names are IPv4, and an unstubbed AAAA
        // would go to the real network.
        resolve4 = async (hostname: string) => {
          onResolve?.()
          const found = answers.get(hostname)
          if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
          return found
        }
        resolve6 = async () => {
          throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
        }
      },
    },
  }
})

const { safeFetch, forgetResolutions } = await import('../safe-fetch')

let server: Server
let port: number
let routes: (req: IncomingMessage, res: ServerResponse) => boolean

/**
 * A private address of this host. The blocklist allows private ranges on
 * purpose (intranet deployments), so this is an address a redirect chain is
 * permitted to reach — unlike loopback, which is what the refusals below use.
 */
const privateAddress = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .find((a) => !a.internal && a.family === 'IPv4')?.address

beforeAll(async () => {
  server = createServer((req, res) => {
    if (routes?.(req, res)) return
    res.end('SECRET-LOOPBACK-BODY')
  })
  // Bound to every interface so the chain below can reach it by the private
  // address as well as by loopback.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// Answers are held for a minute, so without this a case naming a host an
// earlier one asked about is answered from that one's stub — which is how this
// file's own rebinding case silently stopped testing anything when the cache
// was added.
beforeEach(forgetResolutions)

const causeOf = (err: unknown) =>
  ((err as { cause?: Error }).cause?.message ?? String(err)) as string

/** Whatever stopped the fetch — or how far it got, which is the failure case. */
const failureOf = (url: string, init?: RequestInit) =>
  safeFetch(url, init).then((r) => `REACHED ${r.status}`, causeOf)

describe('the SSRF-safe agent, end to end', () => {
  it('should refuse a hostname that resolves to loopback', async () => {
    answers.set('rebind.test', ['127.0.0.1'])

    // Reached at all, this returns the body above — so a failure here is not
    // "the server was unreachable", it is the block doing its job.
    const err = await failureOf(`http://rebind.test:${port}/`)

    expect(err).toContain('DNS resolved to private address: 127.0.0.1')
  })

  it('should refuse a hostname that resolves to the IMDS address', async () => {
    answers.set('imds.test', ['169.254.169.254'])

    const err = await failureOf(`http://imds.test:${port}/latest/meta-data/`)

    expect(err).toContain('169.254.169.254')
  })

  it('should refuse when only one of several answers is private', async () => {
    // Rebinding through a mixed RRset: connecting to the public one and
    // dropping the rest would still let the private one be chosen on a retry.
    answers.set('mixed.test', ['93.184.216.34', '127.0.0.1'])

    const err = await failureOf(`http://mixed.test:${port}/`)

    expect(err).toContain('127.0.0.1')
  })

  it('should let an allowed address through to the connection', async () => {
    // The counterweight: without it, a check that blocked everything would pass
    // the three above. Private ranges are deliberately allowed for intranet
    // deployments, so this one is expected to get past the check and out to the
    // network — where nothing is listening, which is a different failure and
    // the one being asserted.
    answers.set('intranet.test', ['10.255.255.1'])

    const err = await failureOf(`http://intranet.test:${port}/`, {
      // Nothing answers at 10.x and the connect never errors, so only the abort
      // ends it — this is dead wait, and it was 2s of a 2.4s project run. The
      // block it is distinguished from reports in 1-10ms.
      signal: AbortSignal.timeout(150),
    })

    expect(err).not.toContain('private address')
  })
})

describe('following a redirect, end to end', () => {
  // The mocked suite stubs `undici.fetch`, so nothing there exercises a real
  // hop: the Agent — and therefore the address check — never runs on hops 2..n.
  // A `Location` naming a *hostname* that resolves somewhere blocked is the
  // realistic shape of SSRF-by-redirect, and it is invisible to a string-level
  // check, which is the only kind the mocked tests can reach.

  it('should follow a real chain and hand back a readable body', async () => {
    if (!privateAddress) return // no non-loopback interface to reach the server by
    answers.set('chain.test', [privateAddress])
    routes = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/deep/next' }).end('hop body nobody reads')
        return true
      }
      if (req.url === '/deep/next') {
        res.writeHead(303, { location: '../final' }).end('another hop body')
        return true
      }
      if (req.url === '/final') {
        res.end('THE RESOURCE')
        return true
      }
      return false
    }

    const response = await safeFetch(`http://chain.test:${port}/start`, { method: 'POST' })

    // The body has to survive: the pipeline reads it straight into storage, and
    // a release applied one line too early would leave this empty.
    await expect(response.text()).resolves.toBe('THE RESOURCE')
  })

  it('should refuse a Location naming a host that resolves to loopback', async () => {
    answers.set('start.test', [privateAddress ?? '127.0.0.1'])
    answers.set('rebind-hop.test', ['127.0.0.1'])
    routes = (req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: `http://rebind-hop.test:${port}/` }).end()
        return true
      }
      return false
    }

    const err = await safeFetch(`http://start.test:${port}/go`).then(
      (r) => `REACHED ${r.status}`,
      (e: unknown) => causeOf(e)
    )

    expect(err).toContain('private address')
  })
})

describe('reusing an answer, end to end', () => {
  it('should resolve a host once across several fetches', async () => {
    // The health check is the reason the cache exists — 458 URLs across 34
    // hosts, every five minutes — and nothing else here drives it through the
    // real Agent.
    let asked = 0
    answers.set('reused.test', [privateAddress ?? '127.0.0.1'])
    onResolve = () => asked++
    routes = (req, res) => {
      if (req.url === '/data') {
        res.end('ok')
        return true
      }
      return false
    }

    for (let i = 0; i < 4; i++) {
      await safeFetch(`http://reused.test:${port}/data`).then((r) => r.text())
    }

    expect(asked).toBe(1)
  })
})
