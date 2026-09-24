import { describe, it, expect, vi } from 'vitest'
import { createSpillRegistry } from '../spill'

const key = () => ({})

describe('createSpillRegistry', () => {
  it('does not settle retire() until the last session has let go', async () => {
    // What a shutdown awaits. Settling as soon as `retire` is called would let
    // the worker `process.exit` while a cron session still holds the
    // directory, and the removal that session would have triggered never runs.
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.open(k)

    let settled = false
    const retired = spills.retire(k).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(release).not.toHaveBeenCalled()

    await spills.close(k)
    await retired
    expect(settled).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('settles retire() only after the removal itself has finished', async () => {
    let finishRemoval!: () => void
    const release = vi.fn(() => new Promise<void>((r) => (finishRemoval = r)))
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)

    let settled = false
    const retired = spills.retire(k).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    finishRemoval()
    await retired
    expect(settled).toBe(true)
  })

  it('holds the directory while a session is still open', async () => {
    // The whole point: closing the instance does not stop the connections on
    // it, so a removal at that moment takes the spill files out from under a
    // scan that is still reading them.
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.open(k)

    spills.retire(k)
    expect(release).not.toHaveBeenCalled()

    spills.close(k)
    expect(release).toHaveBeenCalledOnce()
  })

  it('holds it until the last of several sessions closes', () => {
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.open(k)
    spills.open(k)
    spills.retire(k)

    spills.close(k)
    expect(release).not.toHaveBeenCalled()
    spills.close(k)
    expect(release).toHaveBeenCalledOnce()
  })

  it('removes it at once when nothing ever held it', () => {
    // Setup that failed partway: no session was opened on the instance.
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.retire(k)
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps it while the instance is still in service', () => {
    // Sessions come and go against a live instance; only retiring frees it.
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.open(k)
    spills.close(k)
    expect(release).not.toHaveBeenCalled()
    spills.retire(k)
    expect(release).toHaveBeenCalledOnce()
  })

  it('frees it once even if retired twice', () => {
    const release = vi.fn(async () => {})
    const k = key()
    const spills = createSpillRegistry<object>()
    spills.track(k, release)
    spills.retire(k)
    spills.retire(k)
    expect(release).toHaveBeenCalledOnce()
  })

  it('ignores a key it never tracked', () => {
    const spills = createSpillRegistry<object>()
    expect(() => {
      spills.open(key())
      spills.close(key())
      spills.retire(key())
    }).not.toThrow()
  })
})
