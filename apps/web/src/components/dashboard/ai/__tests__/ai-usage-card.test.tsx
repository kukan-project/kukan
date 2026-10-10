import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { clientFetch } from '@/lib/client-api'
import type { AiUsageReport } from '@kukan/shared/ai-usage'
import { AiUsageCard } from '../ai-usage-card'

vi.mock('@/lib/client-api', () => ({
  clientFetch: vi.fn(),
}))

const mockClientFetch = vi.mocked(clientFetch)

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response

function bucket(overrides: Partial<AiUsageReport['buckets'][number]>) {
  return {
    start: '2026-10-08T15:00:00.000Z',
    purpose: 'summarize' as const,
    provider: 'bedrock' as const,
    model: 'jp.anthropic.claude-haiku-5-5',
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    ...overrides,
  }
}

const report: AiUsageReport = {
  granularity: 'day',
  timeZone: 'Asia/Tokyo',
  periods: ['2026-10-08T15:00:00.000Z', '2026-10-09T15:00:00.000Z'],
  buckets: [
    bucket({ calls: 10, inputTokens: 1000, outputTokens: 100, costUsd: 2.5 }),
    bucket({
      start: '2026-10-09T15:00:00.000Z',
      purpose: 'embed-query',
      model: 'cohere.embed-v4:0',
      calls: 40,
      inputTokens: 400,
      costUsd: 0.000048,
    }),
    bucket({ purpose: 'suggest', model: 'some.unpriced', calls: 2, unpricedCalls: 2 }),
  ],
  month: { costUsd: 2.500048, calls: 52, unpricedCalls: 2, projectedUsd: 7.75 },
}

function serve(data: AiUsageReport) {
  mockClientFetch.mockImplementation(async () => ok(data))
}

describe('AiUsageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows the month's cost, its projection and its calls", async () => {
    serve(report)
    render(<AiUsageCard />)

    expect(await screen.findByText('$7.75')).toBeInTheDocument()
    expect(screen.getByText('Cost this month').nextSibling).toHaveTextContent('$2.50')
    expect(screen.getByText('Calls this month').nextSibling).toHaveTextContent('52')
    expect(
      screen.getByText(/this month with no known rate, not in the cost: 2/)
    ).toBeInTheDocument()
  })

  it('totals by purpose in a table, with a cost too small for cents still shown', async () => {
    serve(report)
    render(<AiUsageCard />)

    const row = (await screen.findByRole('cell', { name: 'Search query embeddings' })).closest(
      'tr'
    )!
    expect(within(row).getByText('40')).toBeInTheDocument()
    expect(within(row).getByText('$0.000048')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Total' }).closest('tr')).toHaveTextContent('52')
  })

  it('regroups by model, and asks again for another granularity', async () => {
    serve(report)
    render(<AiUsageCard />)
    await screen.findByRole('cell', { name: 'Writing AI descriptions' })

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Model' }))
    expect(await screen.findByRole('cell', { name: 'cohere.embed-v4:0' })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Hour' }))
    await waitFor(() =>
      expect(mockClientFetch).toHaveBeenCalledWith('/api/v1/admin/ai-usage?granularity=hour')
    )
  })

  it('holds the projection back until a day of the month has passed', async () => {
    serve({ ...report, month: { ...report.month, projectedUsd: null } })
    render(<AiUsageCard />)

    expect(await screen.findByText('Shown once a day of the month has passed')).toBeInTheDocument()
    expect(screen.getByText('Projected for the month').nextSibling).toHaveTextContent('—')
  })

  it('says so when the period has no calls', async () => {
    serve({ ...report, buckets: [], month: { ...report.month, calls: 0, unpricedCalls: 0 } })
    render(<AiUsageCard />)

    expect(await screen.findByText('No AI calls in this period.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('AiUsageCard while bulk work runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const reads = () => mockClientFetch.mock.calls.length

  it('reads nothing again while nothing runs', async () => {
    serve(report)
    render(<AiUsageCard />)
    await screen.findByText('$7.75')

    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(reads()).toBe(1)
  })

  it('follows it while it runs, reads once more when it ends, then stops', async () => {
    serve(report)
    const { rerender } = render(<AiUsageCard following />)
    await screen.findByText('$7.75')

    await act(() => vi.advanceTimersByTimeAsync(31_000))
    expect(reads()).toBeGreaterThanOrEqual(3)

    const before = reads()
    rerender(<AiUsageCard following={false} />)
    await waitFor(() => expect(reads()).toBe(before + 1))

    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(reads()).toBe(before + 1)
  })
})
