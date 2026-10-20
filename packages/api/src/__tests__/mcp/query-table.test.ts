import { describe, it, expect } from 'vitest'
import { toMarkdownTable } from '../../mcp/tools/query'

describe('toMarkdownTable', () => {
  it('keeps a value with a backslash before a pipe in its own cell', () => {
    const table = toMarkdownTable(['a', 'b'], [{ a: 'x\\|y', b: 'z' }])
    expect(table.split('\n')[2]).toBe('| x\\\\\\|y | z |')
  })

  it('escapes the column names too', () => {
    expect(toMarkdownTable(['a|b'], []).split('\n')[0]).toBe('| a\\|b |')
  })
})
