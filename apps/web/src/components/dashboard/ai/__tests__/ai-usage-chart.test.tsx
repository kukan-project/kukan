import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UsageChart, type UsageColumn, type UsageSeries } from '../ai-usage-chart'

const series: UsageSeries[] = [
  { key: 'summarize', label: 'Summaries', color: 'red' },
  { key: 'embed', label: 'Embeddings', color: 'blue' },
]

const notes = { lifted: 'lifted.', legend: 'legend.', excluded: 'excluded.' }

function column(start: string, values: Record<string, number>): UsageColumn {
  return { start, label: start, values }
}

function draw(columns: UsageColumn[], { shown = series, hide = [] as string[] } = {}) {
  const { container } = render(
    <UsageChart
      series={shown}
      columns={columns}
      format={(v) => String(v)}
      tickLabel={(c) => c.label}
      ariaLabel="usage"
      notes={notes}
    />
  )
  for (const label of hide) fireEvent.click(screen.getByRole('button', { name: label }))
  // The coloured segments: those inside a column's clip group
  return [...container.querySelectorAll('g[clip-path] > rect')].map((r) => ({
    fill: r.getAttribute('fill'),
    height: Number(r.getAttribute('height')),
  }))
}

describe('UsageChart', () => {
  beforeEach(() => {
    // jsdom has no layout; the chart draws nothing at width 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws a column far below the largest at a least height, in its largest part', () => {
    const rects = draw([
      column('a', { summarize: 1000 }),
      column('b', { summarize: 0.001, embed: 0.002 }),
      column('c', {}),
    ])
    expect(rects).toHaveLength(2)
    expect(rects[1]).toEqual({ fill: 'blue', height: 3 })
    expect(screen.getByText('lifted. legend.')).toBeInTheDocument()
  })

  it('leaves the legend out of the note when there is no legend', () => {
    draw([column('a', { embed: 1000 }), column('b', { embed: 0.001 })], { shown: [series[1]] })
    expect(screen.getByText('lifted.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says nothing of a least height when every column is drawn to scale', () => {
    const rects = draw([column('a', { summarize: 10, embed: 5 }), column('b', { summarize: 8 })])
    expect(rects.map((r) => r.fill)).toEqual(['red', 'blue', 'red'])
    expect(screen.queryByText(/lifted/)).not.toBeInTheDocument()
  })

  it('sets a stacked column on the baseline, with the gap above each lower segment', () => {
    draw([column('a', { summarize: 1000, embed: 500 }), column('b', { summarize: 800 })])
    const [lower, upper, alone] = [...document.querySelectorAll('g[clip-path] > rect')].map(
      (r) => ({ y: Number(r.getAttribute('y')), height: Number(r.getAttribute('height')) })
    )
    expect(lower.y + lower.height).toBe(alone.y + alone.height)
    expect(lower.y - (upper.y + upper.height)).toBe(2)
  })

  it('keeps a segment thinner than the gap between segments', () => {
    const rects = draw([column('a', { embed: 10, summarize: 1000 })])
    expect(rects[1].fill).toBe('blue')
    expect(rects[1].height).toBeGreaterThan(0)
  })

  it('scales to the series shown, so the smaller ones fill the axis', () => {
    const columns = [column('a', { summarize: 1000 }), column('b', { embed: 0.002 })]
    const rects = draw(columns, { hide: ['Summaries'] })
    expect(rects).toEqual([{ fill: 'blue', height: expect.any(Number) }])
    expect(rects[0].height).toBeGreaterThan(100)
  })

  it('toggles a series in the legend, and keeps the last one shown from being hidden', () => {
    expect(draw([column('a', { summarize: 10, embed: 5 })], { hide: ['Summaries'] })).toHaveLength(
      1
    )
    const summaries = screen.getByRole('button', { name: 'Summaries' })
    expect(summaries).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Embeddings' })).toBeDisabled()
    fireEvent.click(summaries)
    expect(summaries).toHaveAttribute('aria-pressed', 'true')
  })

  it('toggles what the legend shows after every hidden series is drawn again', () => {
    const queries: UsageSeries = { key: 'query', label: 'Queries', color: 'green' }
    const chart = (shown: UsageSeries[]) => (
      <UsageChart
        series={shown}
        columns={[column('a', { summarize: 10, embed: 5, query: 1 })]}
        format={(v) => String(v)}
        tickLabel={(c) => c.label}
        ariaLabel="usage"
        notes={notes}
      />
    )
    const { rerender } = render(chart(series))
    fireEvent.click(screen.getByRole('button', { name: 'Summaries' }))
    rerender(chart([series[1], queries]))
    fireEvent.click(screen.getByRole('button', { name: 'Embeddings' }))
    // Both of these are hidden, so both are drawn
    rerender(chart(series))

    fireEvent.click(screen.getByRole('button', { name: 'Summaries' }))
    expect(screen.getByRole('button', { name: 'Summaries' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Embeddings' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
