/**
 * KUKAN Analytics Service
 * Fetches access statistics from GA4 Data API with LRU caching
 */

import { BetaAnalyticsDataClient, protos } from '@google-analytics/data'

type IRunReportResponse = protos.google.analytics.data.v1beta.IRunReportResponse
type IRunReportRequest = protos.google.analytics.data.v1beta.IRunReportRequest
import { createCache } from '@kukan/shared'

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const CACHE_MAX = 500

export interface AnalyticsItem {
  label: string
  value: number
  href?: string
  meta?: Record<string, string>
}

export interface AnalyticsResult {
  items: AnalyticsItem[]
  total: number
}

export class AnalyticsService {
  private client: BetaAnalyticsDataClient
  private property: string
  private cache = createCache({ max: CACHE_MAX, ttlMs: CACHE_TTL_MS })

  constructor(propertyId: string, clientEmail: string, privateKey: string) {
    // .env stores \n as literal two-char sequence; convert to real newlines for PEM parsing
    const key = privateKey.replace(/\\n/g, '\n')
    this.client = new BetaAnalyticsDataClient({
      credentials: { client_email: clientEmail, private_key: key },
    })
    this.property = `properties/${propertyId}`
  }

  async getDatasetViews(
    startDate: string,
    endDate: string,
    offset: number,
    limit: number
  ): Promise<AnalyticsResult> {
    return this.runPageViewReport(
      'dataset-views',
      '^/dataset/[^/]+$',
      startDate,
      endDate,
      offset,
      limit,
      (pagePath) => {
        const name = pagePath.replace('/dataset/', '')
        return { label: name, href: `/dataset/${name}` }
      }
    )
  }

  async getResourceViews(
    startDate: string,
    endDate: string,
    offset: number,
    limit: number
  ): Promise<AnalyticsResult> {
    return this.runPageViewReport(
      'resource-views',
      '^/dataset/[^/]+/resource/[^/]+$',
      startDate,
      endDate,
      offset,
      limit,
      (pagePath) => {
        // /dataset/{datasetName}/resource/{resourceId}
        const parts = pagePath.split('/')
        const datasetName = parts[2] ?? ''
        const resourceId = parts[4] ?? ''
        return {
          label: `${datasetName} / ${resourceId}`,
          href: pagePath,
          meta: { datasetName, resourceId },
        }
      }
    )
  }

  async getDownloads(
    startDate: string,
    endDate: string,
    offset: number,
    limit: number
  ): Promise<AnalyticsResult> {
    return this.cachedReport(`downloads:${startDate}:${endDate}:${offset}:${limit}`, async () => {
      const [response] = await this.client.runReport({
        property: this.property,
        dateRanges: [{ startDate, endDate }],
        dimensions: [
          { name: 'customEvent:dataset_name' },
          { name: 'customEvent:resource_id' },
          { name: 'customEvent:format' },
        ],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            stringFilter: { matchType: 'EXACT', value: 'file_download' },
          },
        },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        offset,
        limit,
      })

      // Multi-dimension response requires manual mapping (unlike single-dimension mapResponse)
      const items: AnalyticsItem[] = (response.rows ?? []).map((row) => {
        const datasetName = row.dimensionValues?.[0]?.value ?? ''
        const resourceId = row.dimensionValues?.[1]?.value ?? ''
        const format = row.dimensionValues?.[2]?.value ?? ''
        const value = Number(row.metricValues?.[0]?.value ?? 0)
        const formatSuffix = format ? ` (${format})` : ''
        return {
          label: `${datasetName} / ${resourceId}${formatSuffix}`,
          value,
          href: resourceId ? `/dataset/${datasetName}/resource/${resourceId}` : undefined,
          meta: { datasetName, resourceId, format },
        }
      })

      return { items, total: response.rowCount ?? items.length }
    })
  }

  async getSearchTerms(
    startDate: string,
    endDate: string,
    offset: number,
    limit: number
  ): Promise<AnalyticsResult> {
    return this.cachedReport(
      `search-terms:${startDate}:${endDate}:${offset}:${limit}`,
      async () => {
        const [response] = await this.client.runReport({
          property: this.property,
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'searchTerm' }],
          metrics: [{ name: 'eventCount' }],
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          offset,
          limit,
        })

        return this.mapResponse(response, (searchTerm) => ({
          label: searchTerm,
          href: `/dataset?q=${encodeURIComponent(searchTerm)}`,
        }))
      }
    )
  }

  /** Run a page-view report filtered by pagePath regex, with caching */
  private async runPageViewReport(
    cachePrefix: string,
    pathRegex: string,
    startDate: string,
    endDate: string,
    offset: number,
    limit: number,
    mapDimension: (pagePath: string) => {
      label: string
      href?: string
      meta?: Record<string, string>
    }
  ): Promise<AnalyticsResult> {
    return this.cachedReport(
      `${cachePrefix}:${startDate}:${endDate}:${offset}:${limit}`,
      async () => {
        const [response] = await this.client.runReport({
          property: this.property,
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }],
          dimensionFilter: {
            filter: {
              fieldName: 'pagePath',
              stringFilter: { matchType: 'FULL_REGEXP', value: pathRegex },
            },
          },
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          offset,
          limit,
        } satisfies IRunReportRequest)

        return this.mapResponse(response, mapDimension)
      }
    )
  }

  /** Execute fn with LRU caching */
  private async cachedReport(
    cacheKey: string,
    fn: () => Promise<AnalyticsResult>
  ): Promise<AnalyticsResult> {
    const cached = this.cache.get(cacheKey) as AnalyticsResult | undefined
    if (cached) return cached
    const result = await fn()
    this.cache.set(cacheKey, result)
    return result
  }

  private mapResponse(
    response: IRunReportResponse,
    mapDimension: (dim: string) => { label: string; href?: string; meta?: Record<string, string> }
  ): AnalyticsResult {
    const items: AnalyticsItem[] = (response.rows ?? []).map((row) => {
      const dim = row.dimensionValues?.[0]?.value ?? ''
      const value = Number(row.metricValues?.[0]?.value ?? 0)
      return { ...mapDimension(dim), value }
    })
    const total = response.rowCount ?? items.length
    return { items, total }
  }
}
