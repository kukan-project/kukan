import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the GA4 Data API client — vi.hoisted ensures variables are available in vi.mock factory
const { mockRunReport, mockConstructorArgs } = vi.hoisted(() => {
  const mockRunReport = vi.fn()
  const mockConstructorArgs: unknown[][] = []
  return { mockRunReport, mockConstructorArgs }
})

vi.mock('@google-analytics/data', () => {
  // Use a real function (not arrow) so it can be called with `new`
  function BetaAnalyticsDataClient(this: { runReport: typeof mockRunReport }, ...args: unknown[]) {
    mockConstructorArgs.push(args)
    this.runReport = mockRunReport
  }
  return { BetaAnalyticsDataClient, protos: {} }
})

import { AnalyticsService } from '../../services/analytics-service'

const CLIENT_EMAIL = 'test@test.iam.gserviceaccount.com'
const PRIVATE_KEY = 'fake-key'

function makeResponse(rows: Array<{ dims: string[]; metrics: string[] }>, rowCount?: number) {
  return [
    {
      rows: rows.map((r) => ({
        dimensionValues: r.dims.map((v) => ({ value: v })),
        metricValues: r.metrics.map((v) => ({ value: v })),
      })),
      rowCount: rowCount ?? rows.length,
    },
  ]
}

describe('AnalyticsService', () => {
  let service: AnalyticsService

  beforeEach(() => {
    mockRunReport.mockReset()
    mockConstructorArgs.length = 0
    service = new AnalyticsService('123456', CLIENT_EMAIL, PRIVATE_KEY)
  })

  describe('getDatasetViews', () => {
    it('returns mapped dataset items', async () => {
      mockRunReport.mockResolvedValue(
        makeResponse([
          { dims: ['/dataset/my-data'], metrics: ['100'] },
          { dims: ['/dataset/other'], metrics: ['50'] },
        ])
      )

      const result = await service.getDatasetViews('30daysAgo', 'today', 0, 20)

      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toEqual({
        label: 'my-data',
        value: 100,
        href: '/dataset/my-data',
      })
      expect(result.total).toBe(2)
    })

    it('returns cached result on second call', async () => {
      mockRunReport.mockResolvedValue(makeResponse([]))
      await service.getDatasetViews('7daysAgo', 'today', 0, 20)
      await service.getDatasetViews('7daysAgo', 'today', 0, 20)
      expect(mockRunReport).toHaveBeenCalledTimes(1)
    })
  })

  describe('getResourceViews', () => {
    it('returns mapped resource items with meta', async () => {
      mockRunReport.mockResolvedValue(
        makeResponse([{ dims: ['/dataset/ds1/resource/res1'], metrics: ['30'] }])
      )

      const result = await service.getResourceViews('30daysAgo', 'today', 0, 20)

      expect(result.items[0]).toEqual({
        label: 'ds1 / res1',
        value: 30,
        href: '/dataset/ds1/resource/res1',
        meta: { datasetName: 'ds1', resourceId: 'res1' },
      })
    })
  })

  describe('getDownloads', () => {
    it('returns download items with format suffix', async () => {
      mockRunReport.mockResolvedValue(
        makeResponse([{ dims: ['my-data', 'res-1', 'CSV'], metrics: ['10'] }])
      )

      const result = await service.getDownloads('30daysAgo', 'today', 0, 20)

      expect(result.items[0]?.label).toBe('my-data / res-1 (CSV)')
      expect(result.items[0]?.value).toBe(10)
    })
  })

  describe('getSearchTerms', () => {
    it('returns search terms with encoded href', async () => {
      mockRunReport.mockResolvedValue(makeResponse([{ dims: ['open data'], metrics: ['25'] }]))

      const result = await service.getSearchTerms('30daysAgo', 'today', 0, 20)

      expect(result.items[0]).toEqual({
        label: 'open data',
        value: 25,
        href: '/dataset?q=open%20data',
      })
    })
  })

  describe('pagination', () => {
    it('uses rowCount for total', async () => {
      mockRunReport.mockResolvedValue(
        makeResponse(
          [{ dims: ['/dataset/a'], metrics: ['5'] }],
          42 // total rows
        )
      )

      const result = await service.getDatasetViews('30daysAgo', 'today', 0, 1)
      expect(result.total).toBe(42)
      expect(result.items).toHaveLength(1)
    })
  })

  describe('error handling', () => {
    it('propagates GA4 API errors', async () => {
      mockRunReport.mockRejectedValue(new Error('PERMISSION_DENIED'))
      await expect(service.getDatasetViews('30daysAgo', 'today', 0, 20)).rejects.toThrow(
        'PERMISSION_DENIED'
      )
    })

    it('does not cache failed requests', async () => {
      mockRunReport.mockRejectedValueOnce(new Error('transient error'))
      mockRunReport.mockResolvedValueOnce(makeResponse([]))

      await expect(service.getDatasetViews('30daysAgo', 'today', 0, 20)).rejects.toThrow()
      const result = await service.getDatasetViews('30daysAgo', 'today', 0, 20)
      expect(result.items).toEqual([])
      expect(mockRunReport).toHaveBeenCalledTimes(2)
    })

    it('handles empty response rows gracefully', async () => {
      mockRunReport.mockResolvedValue([{ rows: null, rowCount: 0 }])
      const result = await service.getDatasetViews('30daysAgo', 'today', 0, 20)
      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })
  })

  describe('private key newline handling', () => {
    it('converts literal \\n to real newlines', () => {
      mockConstructorArgs.length = 0
      new AnalyticsService('123', 'test@test.com', 'BEGIN\\nMIDDLE\\nEND')
      expect(mockConstructorArgs.at(-1)?.[0]).toEqual({
        credentials: {
          client_email: 'test@test.com',
          private_key: 'BEGIN\nMIDDLE\nEND',
        },
      })
    })
  })
})
