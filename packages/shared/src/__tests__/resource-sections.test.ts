import { describe, it, expect } from 'vitest'
import {
  opensBetween,
  sectionPath,
  headingsBetween,
  sectionLayout,
  MAX_SECTION_DEPTH,
} from '../resource-sections'

const heads = (above: string | null, own: string | null) =>
  headingsBetween(sectionPath(above), sectionPath(own))

describe('opensBetween', () => {
  it('opens on a non-null label that differs from the one above, and nowhere else', () => {
    expect(opensBetween(null, 'docs')).toBe(true)
    expect(opensBetween('data', 'docs')).toBe(true)
    expect(opensBetween('docs', 'docs')).toBe(false)
    expect(opensBetween('docs', null)).toBe(false)
    expect(opensBetween(undefined, undefined)).toBe(false)
  })
})

describe('sectionPath / headingsBetween', () => {
  it('opens the whole path on a first row, only its own under an open parent, nothing inside', () => {
    expect(heads(null, 'docs/raw')).toEqual([
      { depth: 1, label: 'docs' },
      { depth: 2, label: 'raw' },
    ])
    expect(heads('docs', 'docs/raw')).toEqual([{ depth: 2, label: 'raw' }])
    expect(heads('docs/raw', 'docs/raw')).toEqual([])
  })

  it('opens a sibling at its depth, and again after a root row; nothing for the root', () => {
    expect(heads('docs/a', 'docs/b')).toEqual([{ depth: 2, label: 'b' }])
    expect(heads(null, 'docs')).toEqual([{ depth: 1, label: 'docs' }])
    expect(heads('docs', null)).toEqual([])
    expect(sectionPath(null)).toEqual([])
  })

  it('draws three levels and folds the rest into the third, slashes and all', () => {
    expect(MAX_SECTION_DEPTH).toBe(3)
    expect(sectionPath('a/b/c')).toEqual(['a', 'b', 'c'])
    expect(sectionPath('a/b/c/d/e')).toEqual(['a', 'b', 'c/d/e'])
    expect(heads(null, 'a/b/c/d')).toEqual([
      { depth: 1, label: 'a' },
      { depth: 2, label: 'b' },
      { depth: 3, label: 'c/d' },
    ])
  })

  it('splits a highlighted label the same way, sparing the closing mark tag', () => {
    expect(sectionPath('a<mark>1</mark>/b<mark>1</mark>', { html: true })).toEqual([
      'a<mark>1</mark>',
      'b<mark>1</mark>',
    ])
  })
})

describe('sectionLayout', () => {
  it('places every row: headings above it as they open, and its depth', () => {
    const rows = [
      { section: null },
      { section: 'docs' },
      { section: 'docs/spec' },
      { section: null },
    ]
    expect(sectionLayout(rows)).toEqual([
      { depth: 0, headings: [] },
      { depth: 1, headings: [{ depth: 1, label: 'docs' }] },
      { depth: 2, headings: [{ depth: 2, label: 'spec' }] },
      { depth: 0, headings: [] },
    ])
  })
})
