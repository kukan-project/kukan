import { describe, it, expect } from 'vitest'
import { foldMatched, MATCHED_ROWS_SHOWN } from '../matched-resources'

const onSection = (id: string, section: string) => ({
  id,
  name: `${id}.pdf`,
  section,
  matchedOn: ['section' as const],
})

describe('foldMatched', () => {
  it('folds each section matched on its name alone into one row, in order of first appearance', () => {
    const { shown } = foldMatched([onSection('a', 'x'), onSection('b', 'y'), onSection('c', 'x')])
    expect(shown).toEqual([
      { resource: onSection('a', 'x'), folded: true, others: 1 },
      { resource: onSection('b', 'y'), folded: true, others: 0 },
    ])
  })

  it('keeps a resource that matched on its own name or description, section or not', () => {
    const named = { ...onSection('b', 'minutes'), matchedOn: ['name' as const, 'section' as const] }
    const { shown } = foldMatched([onSection('a', 'minutes'), named, onSection('c', 'minutes')])
    expect(shown.map((r) => [r.resource.id, r.folded, r.others])).toEqual([
      ['a', true, 1],
      ['b', false, 0],
    ])
  })

  it('leaves rows alone when the adapter did not say what matched', () => {
    const plain = [
      { id: 'a', name: 'a.pdf', section: 'minutes' },
      { id: 'b', name: 'b.pdf', section: 'minutes' },
    ]
    expect(foldMatched(plain).shown.map((r) => r.folded)).toEqual([false, false])
  })

  it('shows the first rows and counts the rest', () => {
    const many = Array.from({ length: MATCHED_ROWS_SHOWN + 3 }, (_, i) => ({ id: `r${i}` }))
    expect(foldMatched(many)).toMatchObject({ hidden: 3, atLeast: false })
    expect(foldMatched(many).shown).toHaveLength(MATCHED_ROWS_SHOWN)
    expect(foldMatched([]).hidden).toBe(0)
  })

  it('counts every resource a hidden folded row stood for', () => {
    // Six sections of ten: the sixth is hidden whole, so ten resources are, not one row
    const sixOfTen = Array.from({ length: 60 }, (_, i) => onSection(`r${i}`, `s${i % 6}`))
    expect(foldMatched(sixOfTen)).toMatchObject({ hidden: 10, atLeast: false })
  })

  it('counts what the adapter did not carry among the hidden, as the floor the adapter gave', () => {
    const carried = Array.from({ length: 100 }, (_, i) => onSection(`r${i}`, 'minutes'))
    const { shown, hidden, atLeast } = foldMatched(carried, { total: 150, atLeast: true })
    expect(shown).toEqual([{ resource: carried[0], folded: true, others: 99 }])
    expect(hidden).toBe(50)
    expect(atLeast).toBe(true)
  })
})
