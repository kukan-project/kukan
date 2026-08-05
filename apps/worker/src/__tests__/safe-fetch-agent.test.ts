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
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const answers = new Map<string, string[]>()
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

const { safeFetch } = await import('../safe-fetch')

let server: Server
let port: number

beforeAll(async () => {
  server = createServer((_req, res) => res.end('SECRET-LOOPBACK-BODY'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

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
