import { describe, it, expect, afterEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ChildExitedError } from '@kukan/api/services/child/host'
import {
  HeavyProcess,
  HeavyShortOfMemoryError,
  HeavyTooLargeError,
  WorkerStoppingError,
  type HeavyLimits,
} from '../../heavy/process'
import type { HeavyRequest } from '../../heavy/protocol'

const here = dirname(new URL(import.meta.url).pathname)
const command = () => ({
  entry: join(here, 'fixture-child.ts'),
  execArgv: ['--import', 'tsx'],
  // Where `--import tsx` resolves from this package's devDependencies
  cwd: join(here, '../../..'),
})

const LIMITS: HeavyLimits = {
  budgetMb: 10_000,
  headroomMb: 0,
  pollMs: 20,
  restartMb: 10_000,
  idleMs: 60_000,
  checkMs: 20,
}

// The fixture's requests, which are not the worker's
const ask = (heavy: HeavyProcess, kind: string, check?: () => Promise<void>): Promise<unknown> =>
  heavy.ask({ kind } as unknown as HeavyRequest, check)

/** The fixture processes running now, this test file's and no other's. */
function fixtureChildren(): number[] {
  return readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => {
      try {
        return (
          readFileSync(`/proc/${p}/stat`, 'utf8').split(' ')[3] === String(process.pid) &&
          readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('fixture-child')
        )
      } catch {
        return false
      }
    })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('HeavyProcess', () => {
  let heavy: HeavyProcess
  afterEach(async () => {
    await heavy.stop()
  })

  it('answers one request after another from the same process', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const first = await ask(heavy, 'pid')
    expect(await ask(heavy, 'pid')).toBe(first)
  })

  it('keeps the process when the work fails, and says why', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const pid = await ask(heavy, 'pid')
    await expect(ask(heavy, 'fail')).rejects.toThrow('refused')
    expect(await ask(heavy, 'pid')).toBe(pid)
  })

  // Finds the processes through /proc
  it.skipIf(process.platform !== 'linux')(
    'takes a process the kernel killed during the request for one too large, and starts another',
    async () => {
      heavy = new HeavyProcess(command, LIMITS)
      const pid = (await ask(heavy, 'pid')) as number
      // The OOM killer's pick, which the process made itself — the reused one,
      // then the fresh one the request is run again in
      const killer = setInterval(() => {
        for (const p of fixtureChildren()) process.kill(p, 'SIGKILL')
      }, 100)
      await expect(ask(heavy, 'hang'))
        .rejects.toThrow(HeavyTooLargeError)
        .finally(() => clearInterval(killer))
      expect(await ask(heavy, 'pid')).not.toBe(pid)
    }
  )

  it('does not hold a process that exited for any other reason against the request', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const failure = ask(heavy, 'crash')
    await expect(failure).rejects.toThrow(ChildExitedError)
    await expect(failure).rejects.not.toThrow(HeavyTooLargeError)
    expect(await ask(heavy, 'pid')).toEqual(expect.any(Number))
  })

  it('starts another for a request when the one it kept went while it waited', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const pid = (await ask(heavy, 'pid')) as number
    // The OOM killer's pick, between two requests
    process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
    expect(await ask(heavy, 'pid')).not.toBe(pid)
  })

  it.skipIf(process.platform !== 'linux')(
    'kills the process once it passes its budget',
    async () => {
      // Any process at all is over this
      heavy = new HeavyProcess(command, { ...LIMITS, budgetMb: 1 })
      await expect(ask(heavy, 'hang')).rejects.toThrow(HeavyTooLargeError)
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'runs a request again in a fresh process when the one it reused passes its budget',
    async () => {
      let started = 0
      const limits = { ...LIMITS }
      heavy = new HeavyProcess(() => {
        started++
        return command()
      }, limits)
      await ask(heavy, 'pid')
      // What the reused process kept counts too; only a fresh one's going is the request's
      limits.budgetMb = 1
      await expect(ask(heavy, 'hang')).rejects.toThrow(HeavyTooLargeError)
      // The one it reused, then the fresh one the request was run again in
      expect(started).toBe(2)
    }
  )

  it('gives back what the worker can and runs a request again when the container was short', async () => {
    let started = 0
    const relieve = vi.fn(async () => {})
    heavy = new HeavyProcess(
      () => {
        started++
        return command()
      },
      LIMITS,
      { relieve }
    )
    // The container's bound, which a host has none of: stopped the same way
    const short = () => Promise.reject(new HeavyShortOfMemoryError())
    await expect(ask(heavy, 'hang', short)).rejects.toThrow(HeavyShortOfMemoryError)
    expect(relieve).toHaveBeenCalledOnce()
    // Once more, in a fresh process; short again, it is left to the next run
    expect(started).toBe(2)
  })

  it('gives back memory when the fresh process a reused one was replaced by meets a short container', async () => {
    let started = 0
    const relieve = vi.fn(async () => {})
    heavy = new HeavyProcess(
      () => {
        started++
        return command()
      },
      LIMITS,
      { relieve }
    )
    await ask(heavy, 'pid')
    // Each attempt stopped the way the next bound would: the reused process over
    // its budget, then the fresh one in a short container, then an end
    const stops = [new HeavyTooLargeError(), new HeavyShortOfMemoryError(), new Error('done')]
    const byAttempt = () => Promise.reject(stops[started - 1])
    await expect(ask(heavy, 'hang', byAttempt)).rejects.toThrow('done')
    expect(relieve).toHaveBeenCalledOnce()
    expect(started).toBe(3)
  })

  it('kills the process when the check says the work is no longer wanted', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const pid = (await ask(heavy, 'pid')) as number
    const lost = new Error('lost the claim')
    await expect(ask(heavy, 'hang', () => Promise.reject(lost))).rejects.toBe(lost)
    expect(alive(pid)).toBe(false)
  })

  it.skipIf(process.platform !== 'linux')(
    'starts afresh after a request that left the process large',
    async () => {
      heavy = new HeavyProcess(command, { ...LIMITS, restartMb: 1 })
      const pid = (await ask(heavy, 'pid')) as number
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
      expect(await ask(heavy, 'pid')).not.toBe(pid)
    }
  )

  it('kills the request under way at shutdown, and refuses the next', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const pid = (await ask(heavy, 'pid')) as number
    const running = ask(heavy, 'hang')
    await new Promise((r) => setTimeout(r, 100))
    const stopped = expect(running).rejects.toThrow(WorkerStoppingError)
    await heavy.shutdown()
    await stopped
    expect(alive(pid)).toBe(false)
    await expect(ask(heavy, 'pid')).rejects.toThrow(WorkerStoppingError)
  })

  it('runs nothing for a request whose process was starting when the worker shut down', async () => {
    heavy = new HeavyProcess(command, LIMITS)
    const starting = ask(heavy, 'pid')
    const stopped = expect(starting).rejects.toThrow(WorkerStoppingError)
    // While the process starts there is none to kill
    await heavy.shutdown()
    await stopped
  })

  it('stops the process once it has waited long enough for a request', async () => {
    heavy = new HeavyProcess(command, { ...LIMITS, idleMs: 100 })
    const pid = (await ask(heavy, 'pid')) as number
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
  })
})
