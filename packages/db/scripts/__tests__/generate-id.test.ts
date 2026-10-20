import { describe, it, expect, vi } from 'vitest'

const bytes = vi.hoisted(() => ({ next: [] as number[][] }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => Buffer.from(bytes.next.shift() ?? actual.randomBytes(size)),
  }
})

const { generateId } = await import('../generate-id')

describe('generateId', () => {
  it('gives an alphanumeric id of the asked length', () => {
    expect(generateId()).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(generateId(8)).toHaveLength(8)
  })

  it('skips the bytes a modulo would fold onto the first characters', () => {
    // 62 characters: 248 and above would map to a–h a second time
    bytes.next.push([248, 255, 0, 61], [1, 2])
    expect(generateId(4)).toBe('a9bc')
  })
})
