import { describe, it, expect } from 'vitest'
import { ContentChunkCutter } from '../content-chunks'

/** The lines each chunk holds, as the cutter places them */
function chunksOf(lines: string[], max: number): string[][] {
  const cutter = new ContentChunkCutter(max)
  const chunks: string[][] = []
  let open = false
  for (const line of lines) {
    const { breakBefore, alone } = cutter.place(line)
    if (breakBefore || !open) chunks.push([])
    chunks.at(-1)!.push(line)
    open = !alone
  }
  return chunks
}

describe('ContentChunkCutter', () => {
  it('breaks at a line that would take a chunk past its bytes, counting the newline', () => {
    // 4 + 1 + 4 = 9 fits; another newline and line would be 14
    expect(chunksOf(['aaaa', 'bbbb', 'cccc'], 9)).toEqual([['aaaa', 'bbbb'], ['cccc']])
    expect(chunksOf(['aaaa', 'bbbb'], 8)).toEqual([['aaaa'], ['bbbb']])
  })

  it('counts bytes, not characters', () => {
    // あ is three bytes
    expect(chunksOf(['ああ', 'い'], 9)).toEqual([['ああ'], ['い']])
  })

  it('gives a line longer than a chunk one of its own, and starts another after it', () => {
    expect(chunksOf(['a', 'x'.repeat(20), 'b'], 10)).toEqual([['a'], ['x'.repeat(20)], ['b']])
  })

  it("counts the newline before a chunk's first line against it, as the index always has", () => {
    // 'bbbb' breaks with its newline counted (5), so 'ccc' (+4) no longer fits in 8 — counted
    // as 4, it would have
    expect(chunksOf(['aaaaaa', 'bbbb', 'ccc'], 8)).toEqual([['aaaaaa'], ['bbbb'], ['ccc']])
  })
})
