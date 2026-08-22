/**
 * The bounds every lake read from this container takes.
 *
 * What is tested here is the *ordering* between them — the part that is not
 * obvious from reading the calls, and where the leaks are: a stop that arrives
 * before there is a session to interrupt, and a close that must not land in the
 * same tick as the interrupt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openLakeSession } from '@kukan/lake'
import type { LakeSession } from '@kukan/lake'
import { RequestAbandonedError } from '@kukan/shared'
import { scanLake } from '../../services/query/lake-scan'
import { unreachableLake } from '../test-helpers/fixtures'

vi.mock('@kukan/lake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kukan/lake')>()
  return { ...actual, openLakeSession: vi.fn() }
})

/** A session that records what was asked of it and when. */
function fakeSession() {
  const events: string[] = []
  const session = {
    run: async () => {},
    rows: async () => [],
    interrupt: () => events.push('interrupt'),
    close: async () => {
      events.push('close')
    },
  } as unknown as LakeSession
  return { session, events }
}

/** Resolves once the microtask queue has drained a few times over. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scanLake', () => {
  it('stops a caller who leaves while the session is still opening', async () => {
    // The listener has to be attached before the open is awaited: a session
    // takes an extension load and a catalog ATTACH to come up, and a caller
    // that leaves during it would otherwise wait out the whole scan holding the
    // one slot every query shares.
    const { session, events } = fakeSession()
    let open!: () => void
    vi.mocked(openLakeSession).mockReturnValue(
      new Promise<LakeSession>((resolve) => {
        open = () => resolve(session)
      })
    )
    const scan = vi.fn().mockResolvedValue('rows')
    const abort = new AbortController()

    const running = scanLake(unreachableLake, 'Scan', scan, abort.signal)
    await settled()
    expect(openLakeSession).toHaveBeenCalled()
    abort.abort()

    await expect(running).rejects.toBeInstanceOf(RequestAbandonedError)
    expect(scan).not.toHaveBeenCalled()

    // And the session that lands afterwards is still closed rather than leaked.
    open()
    await settled()
    expect(events).toEqual(['close'])
  })

  it('interrupts a running scan, and closes only once it has unwound', async () => {
    // Disconnecting in the same tick as the interrupt leaves the driver's
    // promise pending forever (measured), so the close waits for the scan.
    const { session, events } = fakeSession()
    vi.mocked(openLakeSession).mockResolvedValue(session)
    let stopScan!: () => void
    const scan = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          stopScan = () => reject(new Error('INTERRUPT'))
        })
    )
    const abort = new AbortController()

    const running = scanLake(unreachableLake, 'Scan', scan, abort.signal)
    await settled()
    abort.abort()

    await expect(running).rejects.toBeInstanceOf(RequestAbandonedError)
    await settled()
    expect(events).toEqual(['interrupt'])

    stopScan()
    await settled()
    expect(events).toEqual(['interrupt', 'close'])
  })

  it('frees the slot when the session never opens', async () => {
    // With a cap of one, a failed ATTACH that kept its slot would wedge every
    // later scan and every ADR-032 query at 429 for the process's lifetime.
    vi.mocked(openLakeSession).mockRejectedValue(new Error('ATTACH failed'))
    await expect(scanLake(unreachableLake, 'Scan', async () => 'rows')).rejects.toThrow(
      'ATTACH failed'
    )

    const { session } = fakeSession()
    vi.mocked(openLakeSession).mockResolvedValue(session)
    await expect(scanLake(unreachableLake, 'Scan', async () => 'rows')).resolves.toBe('rows')
  })
})
