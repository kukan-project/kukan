import { describe, it, expect } from 'vitest'
import { inTurn } from '../in-turn'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe('inTurn', () => {
  it('runs one caller per key at a time, in the order they asked', async () => {
    const held = gate()
    const order: string[] = []
    const a = inTurn('k', async () => {
      order.push('a in')
      await held.opened
      order.push('a out')
    })
    const b = inTurn('k', async () => void order.push('b'))
    const c = inTurn('k', async () => void order.push('c'))

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['a in'])
    held.open()
    await Promise.all([a, b, c])
    expect(order).toEqual(['a in', 'a out', 'b', 'c'])
  })

  it('passes the turn on when a caller fails, and returns what one returns', async () => {
    const failed = inTurn('k', async () => {
      throw new Error('boom')
    })
    const next = inTurn('k', async () => 42)

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe(42)
  })

  it('runs callers for different keys side by side', async () => {
    const held = gate()
    const order: string[] = []
    const a = inTurn('a', async () => {
      await held.opened
      order.push('a')
    })
    const b = inTurn('b', async () => void order.push('b'))

    await b
    expect(order).toEqual(['b'])
    held.open()
    await a
  })
})
