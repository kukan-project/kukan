import { afterEach, describe, expect, it, vi } from 'vitest'

// No cgroup by default, as in a Web Function: every limit file is missing
const limits = vi.hoisted(() => new Map<string, string>())
vi.mock('node:fs', () => ({
  readFileSync: (path: string) => {
    const limit = limits.get(path)
    if (limit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return limit
  },
}))
// What a 2 GB Web Function reported (ADR-068), with 1000 MiB in use
vi.mock('node:os', () => ({
  totalmem: () => 2460024 * 1024,
  freemem: () => (2460024 - 1000 * 1024) * 1024,
}))

const { containerAnonMb, processMemory } = await import('../process-memory')

afterEach(() => {
  vi.unstubAllEnvs()
  limits.clear()
})

describe('processMemory without a cgroup', () => {
  it("takes a Web Function's configured memory, not the larger total it reports", () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '2048')

    expect(processMemory()).toEqual({ memoryMb: 2048, source: 'web-function' })
  })

  it('leaves a readable cgroup limit first', () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '2048')
    limits.set('/sys/fs/cgroup/memory.max', String(512 * 1024 * 1024))

    expect(processMemory()).toEqual({ memoryMb: 512, source: 'cgroup-v2' })
  })

  it("falls back to the host's memory elsewhere", () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '')

    expect(processMemory().source).toBe('host')
  })
})

describe('containerAnonMb', () => {
  it('reads what a Web Function cannot reclaim', async () => {
    expect(await containerAnonMb('web-function')).toBe(1000)
  })

  it('has nothing to read on a host', async () => {
    expect(await containerAnonMb('host')).toBeNull()
  })
})
