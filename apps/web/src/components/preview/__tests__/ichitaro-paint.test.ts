import { describe, it, expect } from 'vitest'
import { paintPage, type JtdPage } from '../ichitaro-paint'

type Call = [string, ...unknown[]]

/**
 * A 2D context that records what was drawn. Glyphs measure `width` each,
 * so a test chooses whether a half-width glyph fits its cell.
 */
function recorder(width = 4) {
  const calls: Call[] = []
  const state = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 0 }
  const g = {
    ...state,
    textBaseline: '',
    fillRect: (...a: unknown[]) => calls.push(['fillRect', g.fillStyle, ...a]),
    fillText: (...a: unknown[]) => calls.push(['fillText', ...a]),
    measureText: () => ({ width }),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (...a: unknown[]) => calls.push(['translate', ...a]),
    scale: (...a: unknown[]) => calls.push(['scale', ...a]),
    setLineDash: (d: number[]) => calls.push(['setLineDash', d]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a: unknown[]) => calls.push(['moveTo', ...a]),
    lineTo: (...a: unknown[]) => calls.push(['lineTo', ...a]),
    stroke: () => calls.push(['stroke', g.lineWidth, g.strokeStyle]),
  }
  return { g: g as unknown as CanvasRenderingContext2D & typeof state, calls }
}

const page = (items: JtdPage['items']): JtdPage => ({ w: 100, h: 200, items })
const named = (calls: Call[], name: string) => calls.filter((c) => c[0] === name)

describe('paintPage', () => {
  it('stops a wavy line far past the page, its wave as wide as ever', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 0, x2: 1e7, y2: 0, w: 1, k: 12 }]))
    const lines = named(calls, 'lineTo')
    expect(lines).toHaveLength(3100)
    expect(lines[0]).toEqual(['lineTo', 2, 1.1])
    expect(lines.at(-1)).toEqual(['lineTo', 6200, -1.1])
  })

  it('whitens the page before drawing', () => {
    const { g, calls } = recorder()
    paintPage(g, page([]))
    expect(calls).toEqual([['fillRect', '#fff', 0, 0, 100, 200]])
  })

  it('sets the font from the run’s weight and slant, and its colour or the default', () => {
    const { g } = recorder()
    paintPage(g, page([{ t: 'Text', xs: [0], y: 10, s: '字', size: 12, b: true, i: true }]))
    expect(g.font).toMatch(/^italic bold 12px "Hiragino Mincho ProN"/)
    expect(g.fillStyle).toBe('#111')

    paintPage(g, page([{ t: 'Text', xs: [0], y: 10, s: '字', size: 12, color: '#f00' }]))
    expect(g.font).toMatch(/^12px /)
    expect(g.fillStyle).toBe('#f00')
  })

  it('draws a full-width character at its own left edge', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Text', xs: [5], y: 10, s: '字', size: 12 }]))
    expect(named(calls, 'fillText')).toEqual([['fillText', '字', 5, 10]])
  })

  it('centres a narrow half-width glyph in its cell, half-width kana included', () => {
    // Cell is 6 wide at size 12; a 4-wide glyph sits 1 in
    const { g, calls } = recorder(4)
    paintPage(g, page([{ t: 'Text', xs: [10, 16], y: 20, s: 'iｱ', size: 12 }]))
    expect(named(calls, 'fillText')).toEqual([
      ['fillText', 'i', 11, 20],
      ['fillText', 'ｱ', 17, 20],
    ])
    expect(named(calls, 'scale')).toEqual([])
  })

  it('squeezes a glyph wider than its half-width cell into it', () => {
    const { g, calls } = recorder(9)
    paintPage(g, page([{ t: 'Text', xs: [10], y: 20, s: 'W', size: 12 }]))
    expect(calls.slice(1)).toEqual([
      ['save'],
      ['translate', 10, 20],
      ['scale', 6 / 9, 1],
      ['fillText', 'W', 0, 0],
      ['restore'],
    ])
  })

  it('draws a plain line solid, in its colour and width', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 0, x2: 10, y2: 0, w: 2, color: '#00f' }]))
    expect(named(calls, 'setLineDash')).toEqual([['setLineDash', []]])
    expect(named(calls, 'stroke')).toEqual([['stroke', 2, '#00f']])
    expect(named(calls, 'moveTo')).toEqual([['moveTo', 0, 0]])
    expect(named(calls, 'lineTo')).toEqual([['lineTo', 10, 0]])
  })

  it('dashes a line by its type', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 0, x2: 10, y2: 0, w: 1, k: 9 }]))
    expect(named(calls, 'setLineDash')).toEqual([['setLineDash', [6, 2.5]]])
    expect(named(calls, 'stroke')).toEqual([['stroke', 1, '#111']])
  })

  it('draws a double line as two thin strokes either side of the centre', () => {
    const { g, calls } = recorder()
    // Horizontal, so the normal is vertical
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 5, x2: 10, y2: 5, w: 2, k: 7 }]))
    expect(named(calls, 'stroke')).toEqual([
      ['stroke', 0.5, '#111'],
      ['stroke', 0.5, '#111'],
    ])
    expect(named(calls, 'moveTo')).toEqual([
      ['moveTo', 0, 5 - 0.9],
      ['moveTo', 0, 5 + 0.9],
    ])
  })

  it('draws a wavy line as one zigzag, alternating about the centre', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 0, x2: 4, y2: 0, w: 1, k: 12 }]))
    expect(named(calls, 'stroke')).toHaveLength(1)
    expect(named(calls, 'moveTo')).toEqual([['moveTo', 0, -1.1]])
    expect(named(calls, 'lineTo')).toEqual([
      ['lineTo', 2, 1.1],
      ['lineTo', 4, -1.1],
    ])
  })

  it('draws a double wavy line as two thin zigzags', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 0, y1: 0, x2: 4, y2: 0, w: 1, k: 14 }]))
    expect(named(calls, 'stroke')).toEqual([
      ['stroke', 0.5, '#111'],
      ['stroke', 0.5, '#111'],
    ])
    // Each starts on the down-swing, offset 1 below and 1 above the centre
    const starts = named(calls, 'moveTo').map(([, , y]) => y as number)
    expect(starts).toHaveLength(2)
    expect(starts[0]).toBeCloseTo(-2.1)
    expect(starts[1]).toBeCloseTo(-0.1)
  })

  it('draws a zero-length line without dividing by zero', () => {
    const { g, calls } = recorder()
    paintPage(g, page([{ t: 'Line', x1: 3, y1: 3, x2: 3, y2: 3, w: 1, k: 7 }]))
    expect(named(calls, 'moveTo')).toEqual([
      ['moveTo', 3, 3],
      ['moveTo', 3, 3],
    ])
  })
})
