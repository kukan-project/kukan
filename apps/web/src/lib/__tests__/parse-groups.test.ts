import { describe, it, expect } from 'vitest'
import { parseGroups } from '../parse-groups'

describe('parseGroups', () => {
  it('should return empty array for undefined/empty', () => {
    expect(parseGroups(undefined)).toEqual([])
    expect(parseGroups('')).toEqual([])
  })

  it('should parse single group with name and title', () => {
    expect(parseGroups('demographics:Demographics')).toEqual([
      { name: 'demographics', title: 'Demographics' },
    ])
  })

  it('should parse multiple groups', () => {
    expect(parseGroups('demographics:Demographics,economy:Economy')).toEqual([
      { name: 'demographics', title: 'Demographics' },
      { name: 'economy', title: 'Economy' },
    ])
  })

  it('should use name as title when title is missing', () => {
    expect(parseGroups('demographics')).toEqual([{ name: 'demographics', title: 'demographics' }])
  })

  it('should handle title containing colons', () => {
    expect(parseGroups('test:Title:With:Colons')).toEqual([
      { name: 'test', title: 'Title:With:Colons' },
    ])
  })

  it('should filter empty segments', () => {
    expect(parseGroups('a:A,,b:B')).toEqual([
      { name: 'a', title: 'A' },
      { name: 'b', title: 'B' },
    ])
  })
})
