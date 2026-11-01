import { describe, it, expect } from 'vitest'
import { readUpTo, TooLarge } from '../read-up-to'

const bytes = (n: number) => new Uint8Array(n)

describe('readUpTo', () => {
  it('gives back a body within the limit', async () => {
    const body = await readUpTo(new Response(bytes(10)), 10)
    expect(body.byteLength).toBe(10)
  })

  it('does not read a body that declares more', async () => {
    const res = new Response(bytes(1), { headers: { 'content-length': '11' } })
    await expect(readUpTo(res, 10)).rejects.toThrow(TooLarge)
  })

  it('stops reading a body that turns out to be more', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes(6))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readUpTo(new Response(stream), 10)).rejects.toThrow(TooLarge)
    expect(cancelled).toBe(true)
  })
})
