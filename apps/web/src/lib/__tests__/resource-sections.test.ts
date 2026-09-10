import { describe, it, expect } from 'vitest'
import {
  opensSection,
  dividerLanding,
  sectionRunEnd,
  sectionAfterDrop,
  headingTag,
  indentClass,
  dropRow,
  rowIndexById,
  anchorIndex,
  placeDivider,
  sectionDragId,
  pendingDragId,
  isSectionDragId,
  isPendingDragId,
  rowIdOfDragId,
  pendingIdOfDragId,
  sectionTrail,
} from '../resource-sections'
import { MAX_SECTION_DEPTH } from '@kukan/shared'

const row = (section: string | null) => ({ section })
const named = (id: string, section: string | null) => ({ id, section })
const labels = (rows: { section?: string | null }[]) => rows.map((r) => r.section ?? null)

describe('opensSection', () => {
  it('opens at the first resource of a section and not at the root', () => {
    expect(opensSection([row('docs')], 0)).toBe(true)
    expect(opensSection([row(null)], 0)).toBe(false)
  })

  it('does not reopen inside a run, does open on a seam and after a root row', () => {
    expect(opensSection([row('docs'), row('docs')], 1)).toBe(false)
    expect(opensSection([row('docs'), row('data')], 1)).toBe(true)
    expect(opensSection([row('docs'), row(null), row('docs')], 2)).toBe(true)
  })
})

describe('landing', () => {
  it('lands a divider above a heading, above a row going up and below it going down', () => {
    expect(dividerLanding(3, 1, true)).toBe(1)
    expect(dividerLanding(0, 2, true)).toBe(2)
    expect(dividerLanding(3, 1, false)).toBe(1)
    expect(dividerLanding(0, 2, false)).toBe(3)
  })
})

describe('sectionRunEnd', () => {
  it('ends where the label changes, and at a root row rather than the same name later', () => {
    expect(sectionRunEnd([row('docs'), row('docs'), row('data')], 0)).toBe(2)
    expect(sectionRunEnd([row('docs'), row(null), row('docs')], 0)).toBe(1)
    expect(sectionRunEnd([row('docs'), row('docs')], 0)).toBe(2)
  })
})

describe('sectionAfterDrop', () => {
  it('takes the section of the row above, and the root at the top or under a root row', () => {
    expect(sectionAfterDrop([row('docs'), row(null), row('docs')], 1)).toBe('docs')
    expect(sectionAfterDrop([row(null), row('docs')], 1)).toBeNull()
    expect(sectionAfterDrop([row('docs'), row('docs')], 0)).toBeNull()
    expect(sectionAfterDrop([row('docs'), row(null), row('docs')], 2)).toBeNull()
  })
})

describe('placeDivider', () => {
  it('hands the member it is moved down past to the section above — and only that one', () => {
    const rows = [named('x', null), named('a', 'docs'), named('b', 'docs'), named('c', 'docs')]
    const placed = placeDivider(rows, 'docs', 2, { lift: 1 })
    expect(placed).toMatchObject({ at: 2, claimed: 2 })
    expect(labels(placed.rows)).toEqual([null, null, 'docs', 'docs'])

    // Under another section, the row goes back to it rather than to the root
    const nested = [named('p', 'a'), named('a', 'docs'), named('b', 'docs'), named('c', 'docs')]
    expect(labels(placeDivider(nested, 'docs', 2, { lift: 1 }).rows)).toEqual([
      'a',
      'a',
      'docs',
      'docs',
    ])
  })

  it('takes in the root row it is moved up past', () => {
    const rows = [named('x', null), named('y', null), named('a', 'docs')]
    expect(labels(placeDivider(rows, 'docs', 1, { lift: 2 }).rows)).toEqual([null, 'docs', 'docs'])
  })

  it('takes in every root row below it when a new divider is set down among them', () => {
    const rows = [named('x', null), named('y', null), named('z', null)]
    const placed = placeDivider(rows, 'new', 1)
    expect(placed.claimed).toBe(2)
    expect(labels(placed.rows)).toEqual([null, 'new', 'new'])
  })

  it('reports nothing claimed when its last member is released', () => {
    const placed = placeDivider([named('a', 'docs'), named('b', 'docs')], 'docs', 2, { lift: 0 })
    expect(placed).toMatchObject({ at: 2, claimed: 0 })
    expect(labels(placed.rows)).toEqual([null, null])
  })

  it('splits a section it is set down inside, taking the rest of it', () => {
    const rows = [named('p', 'a'), named('q', 'a'), named('r', 'a')]
    expect(labels(placeDivider(rows, 'b', 1).rows)).toEqual(['a', 'b', 'b'])
  })

  it('takes nothing when set down on a heading — a section is never swallowed', () => {
    const placed = placeDivider([named('p', 'a'), named('q', 'a')], 'b', 0)
    expect(placed.claimed).toBe(0)
    expect(labels(placed.rows)).toEqual(['a', 'a'])
  })

  it('stops at the next heading when set down among root rows', () => {
    const rows = [named('x', null), named('y', null), named('p', 'a')]
    expect(labels(placeDivider(rows, 'b', 0).rows)).toEqual(['b', 'b', 'a'])
  })

  it('stops at the heading below when it steps down inside its own run', () => {
    // [a,a,b,b,c]: moving b down one hands its first row to a, keeps its
    // second, and does not reach into c
    const rows = ['a', 'a', 'b', 'b', 'c'].map((s, i) => named(String(i), s))
    expect(labels(placeDivider(rows, 'b', 3, { lift: 2 }).rows)).toEqual(['a', 'a', 'a', 'b', 'c'])
    expect(labels(placeDivider(rows, 'b', 2, { lift: 2 }).rows)).toEqual(['a', 'a', 'b', 'b', 'c'])
  })

  it('does not lift another run that happens to share the name', () => {
    // A pending "docs" standing above the real docs run has no run of its own
    const rows = [named('x', null), named('a', 'docs'), named('b', 'docs')]
    expect(labels(placeDivider(rows, 'docs', 2).rows)).toEqual([null, 'docs', 'docs'])
  })

  it('is a no-op when set down where it already stands', () => {
    const rows = [named('x', null), named('p', 'a'), named('q', 'a'), named('r', 'b')]
    expect(labels(placeDivider(rows, 'a', 1, { lift: 1 }).rows)).toEqual([null, 'a', 'a', 'b'])
  })

  it('never moves a row', () => {
    const rows = [named('x', null), named('a', 'docs'), named('b', 'docs')]
    for (const to of [0, 1, 2, 3]) {
      expect(placeDivider(rows, 'docs', to, { lift: 1 }).rows.map((r) => r.id)).toEqual([
        'x',
        'a',
        'b',
      ])
    }
  })
})

describe('placeDivider onto a heading', () => {
  it('takes nothing when told a heading stands there the rows cannot show', () => {
    const rows = [named('a', 'docs'), named('b', null)]
    const placed = placeDivider(rows, 'docs', 1, { lift: 0, ontoHeading: true })
    expect(labels(placed.rows)).toEqual([null, null])
    expect(placed.claimed).toBe(0)
  })
})

describe('depth cap', () => {
  it('indents per depth and no further than the cap', () => {
    expect([0, 1, 2, 3, 9].map(indentClass)).toEqual(['', 'ml-2', 'ml-4', 'ml-6', 'ml-6'])
    expect([1, 2, 3, 9].map(headingTag)).toEqual(['h3', 'h4', 'h5', 'h5'])
  })

  it('has an indent and an element for every level it draws', () => {
    expect(indentClass(MAX_SECTION_DEPTH)).not.toBe('')
    expect(headingTag(MAX_SECTION_DEPTH)).toBe('h5')
  })
})

describe('dropRow', () => {
  const named = (id: string, section: string | null) => ({ id, section })

  it('joins the section of the row it lands under', () => {
    const rows = [named('x', null), named('a', 'docs'), named('b', 'docs')]
    const { rows: out, index } = dropRow(rows, 0, 1, false, null)
    expect(index).toBe(1)
    expect(out.map((r) => r.id)).toEqual(['a', 'x', 'b'])
    expect(out[1].section).toBe('docs')
  })

  it('becomes the first member when dropped on a heading, from above or below', () => {
    const rows = [named('x', null), named('a', 'docs'), named('b', 'docs')]
    // From above its own gap has already shifted the heading's place by one
    const fromAbove = dropRow(rows, 0, 1, true, 'docs')
    expect(fromAbove.index).toBe(0)
    expect(fromAbove.rows.map((r) => r.id)).toEqual(['x', 'a', 'b'])
    expect(fromAbove.rows[0].section).toBe('docs')
    const fromBelow = dropRow(rows, 2, 1, true, 'docs')
    expect(fromBelow.index).toBe(1)
    expect(fromBelow.rows.map((r) => r.id)).toEqual(['x', 'b', 'a'])
    expect(fromBelow.rows[1].section).toBe('docs')
  })
})

describe('anchors', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const index = rowIndexById(rows)

  it('stands at its row, past the end when there is none or it is gone', () => {
    expect(anchorIndex(index, 'b', 3)).toBe(1)
    expect(anchorIndex(index, null, 3)).toBe(3)
    expect(anchorIndex(index, 'gone', 3)).toBe(3)
  })
})

describe('drag ids', () => {
  it('names a heading after its first member and an empty heading after itself', () => {
    expect(sectionDragId('r2')).toBe('section:r2')
    expect(rowIdOfDragId('section:r2')).toBe('r2')
    expect(isSectionDragId('section:r2')).toBe(true)
    expect(isPendingDragId('section:r2')).toBe(false)

    expect(pendingDragId('p1')).toBe('section:pending:p1')
    expect(isSectionDragId('section:pending:p1')).toBe(true)
    expect(isPendingDragId('section:pending:p1')).toBe(true)
    expect(pendingIdOfDragId('section:pending:p1')).toBe('p1')
  })

  it('leaves a plain row id alone', () => {
    expect(isSectionDragId('r2')).toBe(false)
    expect(rowIdOfDragId('r2')).toBe('r2')
  })
})

describe('sectionTrail', () => {
  it('draws each level with a chevron, folded at the cap, highlighted or not', () => {
    expect(sectionTrail('docs')).toBe('docs')
    expect(sectionTrail('a/b/c/d')).toBe('a › b › c/d')
    expect(sectionTrail('a<mark>1</mark>/b<mark>1</mark>', { html: true })).toBe(
      'a<mark>1</mark> › b<mark>1</mark>'
    )
  })
})
